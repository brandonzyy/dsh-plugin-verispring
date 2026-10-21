// host 进程内存看门狗：周期读 process.memoryUsage()，越过软阈值做可逆回收，越过硬阈值只告警。
//
// T2 为什么不退出：main.js 的 host 子进程 close 处理（抽取版 lib/main.js:3842-3849）对任何
// 退出码都走 this.fail(...)，exit 0 同样被当作 "dsh desktop host stopped"；
// DesktopBackendController（:7109-7260）只在 start() 被再次调用时拉起子进程。所以「优雅退出
// 触发宿主重启」在本宿主上不成立，硬阈值降级为 monitor 事件 + stderr 提示（提示写明人工重启）。
//
// 触达边界：subagents 运行时暴露 drainChildren(parent, childIds)（只释放同一活父代理名下指定
// 的常驻子代理，后续 send_message 冷恢复）。这里只放 status === "idle" 且 durable inbox 已清空
// 的子代理：running 的有活在跑，inbox 有排队的还有活要干，两者都不算「已完成」。宿主没有暴露
// 释放「被点开常驻的父会话」的 API——那部分只能靠重启，正是 T2 告警的意义；父会话的 fiber 卸载
// 才删 SessionStore（dsh-session/lib/index.js:1871-1893）。
//
// 软回收两类目标：
// - drain：agents 注册表里已完成（idle 且 inbox 清空）的子代理按父代理分组调 drainChildren；
// - recycle：dispatch-gate 与 scout-relay 的模块层只增索引按活会话剪枝（权威事实在
//   session-state 文件与会话日志里，剪掉的条目按需重建），不碰在用的条目。
//
// 烧堆是突发式的：实测堆能在两次 60s 采样之间从 <2.4GiB 跳到 4.06GiB，大头是巨型工具结果
// 全文进 Session.log（宿主 pruner 对 >8KB 的结果还会复制一份）。所以除周期采样外，还有一道
// 整读门（read-guard）在 tools/pre-execute 里拦住会整篇进结果的大文件读取：
// CASEOS_READ_GUARD=0 全关；CASEOS_READ_GUARD_MAX_BYTES 默认 2MiB；CASEOS_READ_GUARD_ALLOW
// 是逗号分隔的放行前缀。命中且 stat 超限才拒绝，stat 失败与任何解析歧义一律放行。
//
// 开关与阈值（CASEOS_* 惯例）：CASEOS_MEM_GUARD=0 全关；CASEOS_MEM_CHECK_MS 默认 15000；
// CASEOS_MEM_SOFT_BYTES / CASEOS_MEM_HARD_BYTES 默认按 V8 顶棚比例（60% / 80%，4GiB 顶棚即
// 2.4GiB / 3.2GiB）；显式设置时按 env 覆盖。drain/recycle 共享 5 分钟冷却；硬阈值不参与冷却
// （只告警，不改状态）。采样在 subagent/end 与 tools/post-execute 之后各即时补一次。
// 观测面：每 5 分钟一条 mem-guard-sample（不管阈值的增长曲线）；软阈值越线每 5 分钟一条
// mem-guard-soft（无论有没有可回收目标）。检查自身若卡在 await 上（drainChildren 等宿主释放
// 不返回），超过 max(2×checkMs, 60s) 记 skip=check-stuck 并把 checking 置回，避免之后所有
// 定时器 tick 都在 checking 守卫处静默 return——上一轮 56 分钟零事件、直到 4.0GiB OOM 的
// 唯一静默路径就是这里。
// 动作落 monitor：kind = mem-guard-boot（激活自报：heapLimitBytes / nodeArgv / pid /
// thresholdsSource / checkMs / readGuard）/ mem-guard-sample / mem-guard-soft / mem-guard-drain /
// mem-guard-recycle / mem-guard-skip / mem-guard-read-deny。
import fs from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import v8 from "node:v8";
import { monitorEvent } from "./monitor-log.js";
import { releaseIdleCaches as releaseDispatchCaches } from "./dispatch-gate.js";
import { releaseIdleCaches as releaseRelayCaches } from "./scout-relay.js";

const GUARD_ENV = "CASEOS_MEM_GUARD";
const CHECK_MS_ENV = "CASEOS_MEM_CHECK_MS";
const SOFT_BYTES_ENV = "CASEOS_MEM_SOFT_BYTES";
const HARD_BYTES_ENV = "CASEOS_MEM_HARD_BYTES";
const READ_GUARD_ENV = "CASEOS_READ_GUARD";
const READ_MAX_ENV = "CASEOS_READ_GUARD_MAX_BYTES";
const READ_ALLOW_ENV = "CASEOS_READ_GUARD_ALLOW";
const DEFAULT_CHECK_MS = 15000;
const DEFAULT_READ_MAX_BYTES = 2 * 1024 * 1024;
const READ_DENY_PATH_LIMIT = 200;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const FALLBACK_HEAP_LIMIT_BYTES = 4 * GIB;
const SOFT_RATIO = 0.6;
const HARD_RATIO = 0.8;
const COOLDOWN_MS = 5 * 60 * 1000;
const SAMPLE_MS = 5 * 60 * 1000;
const IDLE_MS = 90 * 1000;
// 宿主 workingDirectory.ensure 要求 AbortSignal；调用没带 signal 时给一个永不触发的。
const NO_SIGNAL = new AbortController().signal;

// 整读门的动词白名单：这些命令的默认输出就是文件全文（或多行转储），一次调用足以把整份
// 内容压进工具结果。head/tail 默认只输出 10 行、-n/-c 显式限量，属受控读取，不在此列 —
// 只有 tail -n +N / -c +N（从偏移读到 EOF）按整读检查。保守白名单：未列出的动词一律不查。
const WHOLE_FILE_VERBS = new Set([
  "cat",
  "less",
  "more",
  "most",
  "nl",
  "tac",
  "strings",
  "xxd",
  "hexdump",
  "od",
  "base64",
]);
// wc 不在此列：它只输出计数不倾倒内容，整读门拦它纯属误伤（想知道大小请用 stat/du）。
const WRAPPER_WORDS = new Set(["sudo", "env", "command", "time", "nohup", "nice", "exec"]);
const SED_LINE_RANGE = /^\d+(,\d+)?p$/;
const SED_TO_EOF = /^\d+,\$p$/;
// 重定向、命令替换、进程替换都会让操作数无法静态判定：整段放行。
const AMBIGUOUS_SHELL = /[<>`]|\$\(|<\(|>\(/;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// 少了「显式设置」与「未设置」的区分，比例阈值就无从判断该不该让位给 env。
function envNumberExplicit(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : void 0;
}

function expandHome(path) {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

// stat 拿不到大小（不存在、是目录、权限失败）一律放行：整读门只在能确定超限时拒绝。
function fileSizeBytes(path) {
  try {
    const info = fs.statSync(path, { throwIfNoEntry: false });
    return info?.isFile?.() === true ? info.size : void 0;
  } catch {
    return void 0;
  }
}

// 顶棚按进程实际读数取（V8 构建上限会吃掉过大的 --max-old-space-size，见 README）；
// 读不到时退回 4GiB，让阈值等价于旧行为而不是把看门狗整个拖垮。
export function heapLimitBytes() {
  try {
    const limit = v8.getHeapStatistics().heap_size_limit;
    if (Number.isFinite(limit) && limit > 0) return limit;
  } catch {}
  return FALLBACK_HEAP_LIMIT_BYTES;
}

// 比例阈值是纯函数：测试可直接核对 4GiB / 8GiB 顶棚的 60% / 80% 取值。
export function proportionalThresholds(limit) {
  return { softBytes: Math.floor(limit * SOFT_RATIO), hardBytes: Math.floor(limit * HARD_RATIO) };
}

// 短路顺序即处置优先级：未越软阈值不动作；越硬阈值只告警（忙闲决定 reason 与提示）；冷却
// 窗口内跳过；否则软回收。硬阈值不参与冷却，heapUsed 回落后也不需要额外状态。
export function memoryDecision({ heapUsed, softBytes, hardBytes, busy, lastActionAt, now }) {
  if (!(heapUsed >= softBytes)) return { kind: "below" };
  if (heapUsed >= hardBytes) return { kind: busy ? "hard-busy" : "hard-idle" };
  if (lastActionAt > 0 && now - lastActionAt < COOLDOWN_MS) {
    return { kind: "cooldown", remainingMs: COOLDOWN_MS - (now - lastActionAt) };
  }
  return { kind: "soft" };
}

// ---- read-guard 的命令解析（纯函数，测试直接喂字符串） --------------------------

// 按 shell 分隔符切段（引号内的分隔符不切），返回原文段。
function shellSegments(command) {
  const segments = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote !== "") {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      current += ch;
      quote = ch;
      continue;
    }
    if (";&|\n".includes(ch)) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

// 分词：引号不闭合返回 undefined（歧义放行）。
function shellWords(segment) {
  const words = [];
  let word = "";
  let quote = "";
  let escaped = false;
  let started = false;
  for (const ch of segment) {
    if (escaped) {
      word += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== "") {
      started = true;
      if (ch === quote) quote = "";
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    word += ch;
    started = true;
  }
  if (quote !== "") return void 0;
  if (started) words.push(word);
  return words;
}

// 跳过 env 赋值与包装命令，返回真正执行的命令名与其余参数；识别不出返回 undefined。
function commandOf(words) {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === "") return void 0;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    if (WRAPPER_WORDS.has(basename(word))) {
      index += 1;
      continue;
    }
    return { name: basename(word), rest: words.slice(index + 1) };
  }
  return void 0;
}

// 非选项词即文件操作数（`--` 之后全部按操作数；`-` 是 stdin）。选项带的值会被当成候选
// 路径，stat 失败即放行，不会误伤。
function pathOperands(rest) {
  const paths = [];
  let literal = false;
  for (const word of rest) {
    if (!literal && word === "--") {
      literal = true;
      continue;
    }
    if (!literal && word.startsWith("-") && word !== "-") continue;
    if (word === "" || word === "-") continue;
    paths.push(word);
  }
  return paths;
}

// sed：`-n` + 行范围脚本（a,bp / ap）是受控读取，返回 []；`1,$p` 读到 EOF、其他脚本按整读
// 检查；`-e`/`-f`/`-i` 的脚本来源与原地改写在静态上判不准，整体放行。
function sedPaths(rest) {
  let quiet = false;
  let script;
  const files = [];
  let literal = false;
  for (const word of rest) {
    if (literal) {
      files.push(word);
      continue;
    }
    if (word === "--") {
      literal = true;
      continue;
    }
    if (word === "-n") {
      quiet = true;
      continue;
    }
    if (word === "-e" || word === "-f" || word === "-i" || word.startsWith("--in-place")) return [];
    if (word.startsWith("-") && word !== "-") continue;
    if (script === void 0) {
      script = word;
      continue;
    }
    files.push(word);
  }
  if (script === void 0 || script === "-") return [];
  if (quiet && SED_LINE_RANGE.test(script) && !SED_TO_EOF.test(script)) return [];
  return files;
}

// `tail -n +N` / `-c +N` 从偏移读到 EOF = 整读；其余 tail 形态输出限量，受控放行（[]）。
function tailPaths(rest) {
  const paths = [];
  let toEnd = false;
  let literal = false;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (literal) {
      paths.push(word);
      continue;
    }
    if (word === "--") {
      literal = true;
      continue;
    }
    if (word === "-n" || word === "-c" || word === "--lines" || word === "--bytes") {
      if ((rest[index + 1] ?? "").startsWith("+")) toEnd = true;
      index += 1;
      continue;
    }
    if (/^--(lines|bytes)=\+/.test(word) || /^-[nc]\+/.test(word)) toEnd = true;
    if (word.startsWith("-") && word !== "-") continue;
    if (word === "" || word === "-") continue;
    paths.push(word);
  }
  return toEnd ? paths : [];
}

// 待检查的整读路径；[] = 放行（没命中读动词，或解析歧义）。
export function bashReadPaths(command) {
  if (typeof command !== "string" || command === "") return [];
  const paths = [];
  for (const segment of shellSegments(command)) {
    if (AMBIGUOUS_SHELL.test(segment)) continue;
    const words = shellWords(segment);
    if (words === void 0) continue;
    const invocation = commandOf(words);
    if (invocation === void 0) continue;
    if (WHOLE_FILE_VERBS.has(invocation.name)) paths.push(...pathOperands(invocation.rest));
    else if (invocation.name === "sed") paths.push(...sedPaths(invocation.rest));
    else if (invocation.name === "tail") paths.push(...tailPaths(invocation.rest));
  }
  return paths;
}

// read 工具只在调用方没给 offset/limit 时才是整读：宿主默认 limit 是行数上限，对超大文件
// 仍会把整份内容拉进后端并写进结果。
export function readToolReadPath(name, args) {
  if (name !== "read" || args === void 0 || args === null) return void 0;
  if (args.offset !== void 0 || args.limit !== void 0) return void 0;
  const path = args.file_path;
  return typeof path === "string" && path !== "" ? path : void 0;
}

// 拒绝文案直接给出正确读法：模型看得到这句话，下一次调用才会分段读。
export function readDenyReason(path, size, maxBytes) {
  const megabytes = (bytes) => (bytes / MIB).toFixed(1);
  return `整读被拒：${path} 有 ${megabytes(size)} MB，超过整读上限 ${megabytes(maxBytes)} MB。`
    + "请用 read 的 offset/limit 或 `sed -n 'a,bp'` 分段读——整读会把全文永久写进会话日志"
    + `（宿主 >8KB 还会复制一份）；只想知道大小就用 stat/du。`;
}

export default {
  name: "caseos-memory-guard",
  // 只硬依赖 profileContext（落盘根）：agents/subagents 用 ctx.get 惰性取，缺了也照样做缓存
  // 回收与硬阈值告警，不会因为某个宿主服务缺失就整个看门狗不激活。
  inject: ["profileContext"],
  apply(ctx) {
    // 整体开关：关掉即不注册定时器、不挂监听，host 回到无治理状态。
    if (process.env[GUARD_ENV] === "0") return;

    const dshHome = ctx.profileContext?.home ?? process.env.DSH_HOME ?? `${homedir()}/.dsh`;
    const checkMs = envNumber(CHECK_MS_ENV, DEFAULT_CHECK_MS);
    const limit = heapLimitBytes();
    const proportional = proportionalThresholds(limit);
    const softEnv = envNumberExplicit(SOFT_BYTES_ENV);
    const hardEnv = envNumberExplicit(HARD_BYTES_ENV);
    const softBytes = softEnv ?? proportional.softBytes;
    const hardBytes = hardEnv ?? proportional.hardBytes;
    const thresholdsSource = softEnv === void 0 && hardEnv === void 0 ? "proportional" : "env";
    const readGuardOff = process.env[READ_GUARD_ENV] === "0";
    const readGuardMaxBytes = envNumber(READ_MAX_ENV, DEFAULT_READ_MAX_BYTES);
    // 放行前缀按逗号分隔；相对前缀按命令里的原样文本比较，绝对前缀（含 ~）按解析后的路径比较。
    const readAllowPrefixes = (process.env[READ_ALLOW_ENV] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const root = ctx.root ?? ctx;

    // 顶棚与阈值来源是后续一切实证的锚点：宿主换了堆上限（或哪天上游抬了顶）这里能直接看出来。
    monitorEvent(dshHome, {
      kind: "mem-guard-boot",
      heapLimitBytes: limit,
      softBytes,
      hardBytes,
      thresholdsSource,
      checkMs,
      readGuard: !readGuardOff,
      readGuardMaxBytes: readGuardOff ? void 0 : readGuardMaxBytes,
      pid: process.pid,
      nodeArgv: process.execArgv,
    });

    // 服务只在用时现取：面板改配置会重跑 apply，闭包里读到的旧作用域会失活。
    const service = (name) => {
      try {
        const value = root.get?.(name);
        if (value !== void 0) return value;
      } catch {}
      try {
        return root[name];
      } catch {
        return void 0;
      }
    };
    const liveAgents = () => {
      try {
        return service("agents")?.list?.() ?? [];
      } catch {
        return [];
      }
    };

    // 相对路径的基准是会话自己的工作目录（与 bash/read 工具同源）；拿不到就按「解析不出」放行。
    const sessionCwd = async (exec) => {
      const workingDirectory = service("workingDirectory");
      if (exec?.agent === void 0 || typeof workingDirectory?.ensure !== "function") return void 0;
      try {
        return await workingDirectory.ensure(exec.agent, exec.signal ?? NO_SIGNAL);
      } catch {
        return void 0;
      }
    };

    const allowListed = (raw, target) => readAllowPrefixes.some((entry) => {
      const prefix = expandHome(entry);
      if (!isAbsolute(prefix)) return raw === prefix || raw.startsWith(`${prefix}/`);
      const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
      return target === base || target.startsWith(`${base}/`);
    });

    // 整读门：命中整读形态、stat 到大小且超限才拒绝。stat 失败、相对路径拿不到基准、
    // 放行前缀命中、以及本函数自身的任何异常都放行——宁漏勿误伤，非读类命令完全不经这里。
    const readGuardDenial = async (exec) => {
      if (readGuardOff) return void 0;
      try {
        const name = exec?.name;
        const targets = name === "bash"
          ? bashReadPaths(exec?.arguments?.command)
          : [readToolReadPath(name, exec?.arguments)].filter((path) => path !== void 0);
        if (targets.length === 0) return void 0;
        const cwd = targets.some((raw) => !isAbsolute(expandHome(raw))) ? await sessionCwd(exec) : void 0;
        for (const raw of targets) {
          const expanded = expandHome(raw);
          const target = isAbsolute(expanded) ? resolve(expanded) : cwd === void 0 ? void 0 : resolve(cwd, expanded);
          if (target === void 0 || allowListed(raw, target)) continue;
          const size = fileSizeBytes(target);
          if (size === void 0 || size <= readGuardMaxBytes) continue;
          monitorEvent(dshHome, {
            kind: "mem-guard-read-deny",
            gate: "read-guard",
            tool: name,
            session: exec?.agent?.session?.header?.id,
            path: target.slice(0, READ_DENY_PATH_LIMIT),
            size,
          });
          return { kind: "deny", reason: readDenyReason(target, size, readGuardMaxBytes) };
        }
      } catch {
        return void 0;
      }
      return void 0;
    };

    let lastToolAt = Date.now();
    let lastActionAt = 0;
    // 一次回收可能跨多个采样周期（drainChildren 等宿主释放完成），定时器与即时检查不得叠加。
    let checking = false;
    // 卡死自愈与观测节流：sample 是增长曲线，soft 是越线心跳，二者都按 5 分钟一条。
    const stuckMs = Math.max(checkMs * 2, 60 * 1000);
    let checkStartedAt = 0;
    let checkToken = 0;
    let lastSampleAt = 0;
    let lastSoftReportAt = 0;

    // 已排队待跑的输入（宿主 durable inbox 投影）：这样的空闲子代理还有活要干，不能当「已完成」。
    // inbox 属 agent-loop 的内部面，取不到就按「有活」保守处理，只放确认清空的。
    const hasPendingInput = (agent) => {
      try {
        return agent?.inbox?.hasPending !== false;
      } catch {
        return true;
      }
    };

    // 近 90s 有工具活动或仍有运行中子代理都算忙：硬阈值只在这种空闲态告警。
    const isBusy = (now) => {
      if (now - lastToolAt < IDLE_MS) return true;
      return liveAgents().some(
        (agent) => agent?.session?.header?.origin === "subagent" && agent?.status === "running",
      );
    };

    const drainIdleChildren = async () => {
      const subagents = service("subagents");
      const agents = service("agents");
      if (typeof subagents?.drainChildren !== "function" || typeof agents?.list !== "function") {
        return { released: 0 };
      }
      const live = agents.list();
      const byId = new Map(live.map((agent) => [agent?.id, agent]));
      const byParent = new Map();
      for (const agent of live) {
        const header = agent?.session?.header ?? {};
        if (header.origin !== "subagent" || agent.status !== "idle") continue;
        if (hasPendingInput(agent)) continue;
        const parent = byId.get(header.parentSession);
        if (!parent) continue;
        const ids = byParent.get(parent.id) ?? [];
        ids.push(agent.id);
        byParent.set(parent.id, ids);
      }
      let released = 0;
      for (const [parentId, ids] of byParent) {
        try {
          await subagents.drainChildren(byId.get(parentId), ids);
          // 宿主按 activation 释放，非驻留 id 是 no-op：只数已从注册表卸载的。
          released += ids.filter((id) => agents.get?.(id) === void 0).length;
        } catch (error) {
          monitorEvent(dshHome, {
            kind: "mem-guard-skip",
            reason: "drain-failed",
            parent: parentId,
            children: ids.length,
            error: String(error?.message ?? error).slice(0, 200),
          });
        }
      }
      return { released };
    };

    const recycleCaches = () => {
      const live = liveAgents();
      let released = 0;
      for (const [cache, release] of [["dispatch-gate", releaseDispatchCaches], ["scout-relay", releaseRelayCaches]]) {
        try {
          released += release(live);
        } catch (error) {
          monitorEvent(dshHome, {
            kind: "mem-guard-skip",
            reason: "recycle-failed",
            cache,
            error: String(error?.message ?? error).slice(0, 200),
          });
        }
      }
      return released;
    };

    const runCheck = async () => {
      const now = Date.now();
      let heapUsed;
      try {
        const usage = process.memoryUsage();
        heapUsed = usage.heapUsed;
        // 先落 sample 再看 checking：即使回收卡在 await 上，增长曲线也不会整段消失。
        if (now - lastSampleAt >= SAMPLE_MS) {
          lastSampleAt = now;
          monitorEvent(dshHome, {
            kind: "mem-guard-sample",
            heapUsed,
            rss: usage.rss,
            heapTotal: usage.heapTotal,
            external: usage.external,
            arrayBuffers: usage.arrayBuffers,
            heapLimitBytes: limit,
          });
        }
      } catch (error) {
        monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "check-failed", error: String(error?.message ?? error).slice(0, 200) });
        return;
      }
      if (checking) {
        const stuckFor = now - checkStartedAt;
        if (stuckFor < stuckMs) return;
        // 回收 await 不返回时不能永远占着 checking：否则之后每次 tick 都在这里静默 return。
        monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "check-stuck", stuckMs: stuckFor, heapUsed });
        checkToken += 1;
        checking = false;
      }
      const token = ++checkToken;
      checking = true;
      checkStartedAt = now;
      try {
        const decision = memoryDecision({ heapUsed, softBytes, hardBytes, busy: isBusy(now), lastActionAt, now });
        if (decision.kind === "below") return;
        if (decision.kind === "soft" || decision.kind === "cooldown") {
          // 越软阈值就留一条心跳；无论有没有可回收目标、是否在冷却，5 分钟限流一条。
          if (now - lastSoftReportAt >= SAMPLE_MS) {
            lastSoftReportAt = now;
            monitorEvent(dshHome, {
              kind: "mem-guard-soft",
              reason: "soft-threshold",
              decision: decision.kind,
              heapUsed,
              softBytes,
              ...(decision.kind === "cooldown" ? { remainingMs: decision.remainingMs } : {}),
            });
          }
        }
        if (decision.kind === "cooldown") {
          monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "cooldown", heapUsed, remainingMs: decision.remainingMs });
          return;
        }
        if (decision.kind === "hard-busy") {
          monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "hard-threshold-busy", heapUsed, hardBytes });
          return;
        }
        if (decision.kind === "hard-idle") {
          monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "hard-threshold-no-auto-restart", heapUsed, hardBytes });
          process.stderr.write(
            `caseos-memory-guard: heapUsed ${(heapUsed / GIB).toFixed(1)}GiB 越过硬阈值 ${(hardBytes / GIB).toFixed(1)}GiB 且当前空闲；`
            + "宿主不会自动重启 host（exit 0 也算失败停止），请人工重启 DSH\n",
          );
          return;
        }
        lastActionAt = now;
        const drain = await drainIdleChildren();
        const recycled = recycleCaches();
        if (drain.released > 0) {
          monitorEvent(dshHome, { kind: "mem-guard-drain", reason: "soft-threshold", heapUsed, released: drain.released });
        }
        if (recycled > 0) {
          monitorEvent(dshHome, { kind: "mem-guard-recycle", reason: "soft-threshold", heapUsed, released: recycled });
        }
        if (drain.released === 0 && recycled === 0) {
          monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "soft-threshold-no-targets", heapUsed });
        }
      } catch (error) {
        monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "check-failed", error: String(error?.message ?? error).slice(0, 200) });
      } finally {
        if (checkToken === token) checking = false;
      }
    };

    // 工具活动标记开始与结束：长工具执行期间同样算忙。整读门在这里拦下会把全文写进会话
    // 日志的超大读取；根 ctx 的监听器收到全部 agent 的调用（子代理会话同样经过这里，
    // 宿主按 scopeTarget 派发：未打作用域标记的监听器就是全局监听器）。
    ctx.on("tools/pre-execute", async (exec, next) => {
      lastToolAt = Date.now();
      try {
        const denial = await readGuardDenial(exec);
        if (denial !== void 0) return denial;
        if (typeof next !== "function") return;
        return await next();
      } finally {
        lastToolAt = Date.now();
      }
    });
    // 子代理收尾是内存回落/跃升的关键时刻，不等下一轮定时器。
    root.on("subagent/end", () => {
      void runCheck();
    });
    // 工具结果落地就是突发进入 Session.log 的瞬间：15s 定时器可能整整错过一次跃升，
    // 所以每次结果之后立即补一次检查。不 await，工具结果不因看门狗变慢；并发仍由
    // runCheck 的 checking 防抖与冷却收口。
    root.on("tools/post-execute", (exec, result, next) => {
      void runCheck();
      return typeof next === "function" ? next() : void 0;
    });

    const timer = setInterval(runCheck, checkMs);
    if (typeof timer?.unref === "function") timer.unref();
    ctx.effect(() => () => clearInterval(timer), "caseos-memory-guard: interval");
  },
};
