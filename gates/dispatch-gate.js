// Verispring 派遣门禁（七条代码级强制 + 监控）：
// 1 规范门：subagent / subagent_fork 调用前，本会话必须出现过《子代理派遣规范》首行标记
//   （read/bash 结果内容判定，增量扫描会话事件；会话日志是唯一事实源，跨进程重启不丢）。
// 2 测绘身份（由派遣意图判定）：description 以「测绘智能体」或「scout」开头 = 测绘派遣，
//   其余 = 执行派遣；可达性只决定能否派，不改变角色——没有可达测绘时执行派遣被拒
//   （scout-missing），绝不把它偷偷改写成测绘。测绘派遣总是先注入测绘职责与仓库根地图
//   全文（只做增量校对）。当前测绘 id 落 ~/.dsh/caseos/session-state/<会话id>.json
//   （{version:1, scoutId}；本门唯一写入方，harness 拒绝含未知类型的会话日志），只有测绘
//   派遣成功启动才写。常驻的判据是可达：子代理每次应询结束都会 settle 成 completed 并移出
//   resident，send_message 走冷恢复，所以 finished/inactive 都不算失联；只有该 id 的
//   subagent/end stopReason 不是 completed，或领导 send_message 回报 unavailable /
//   NOT_RESUMABLE，才判定不可达。测绘子代理 deny edit/write。
//   子代理自身的角色同样落盘（同目录 <子会话id>.json {role}）：重载后 childPlan 优先读
//   落盘角色，其次按标题自愈（label 已写为标题），最后只按「本子代理是不是父会话登记的
//   测绘」兜底——否则常驻测绘会在内存路由表清空后被静默重归类为执行（v1.3.58 实测事故）。
// 3 地图前置 + 新鲜度：非测绘派遣要求 <会话工作区>/.project-map.md 存在——cwd 取会话
//   header 的 cwd（桌面宿主进程目录不是项目根），且 .git 或 .manon 在场才认定项目根，否则
//   放行（fail-open）。没有地图先派测绘（建图 + 入口表），由领导 write 落盘后重派；
//   write/edit 该文件时把当前 HEAD 登记为新鲜度基准（caseos/map-baselines.json，目标路径
//   resolve 后比较），此后 main 再前进就拒绝执行派遣，指路测绘增量校对 + 重写地图登记新
//   基准；地图已在却没有基准同样拒绝（不再 fail-open）。git 读不到 HEAD 与 CASEOS_SCOUT=0
//   时放行。
// 4 模型路由：测绘与执行分别读取面板配置（verispring.json），运行时按角色强制注入，
//   调用里显式写的 provider/model 一律忽略。fork 拒绝（三智能体架构唯一入口是 spawn）。
// 5 子代理 preset：spawn 通过 agentPreset 显式选择 verispring-subagent；创建事件只负责
//   记录组合结果，不再发送 0.2.1-rc.1 已移除的 persona/toolFilter 请求字段。
//   subagent-base 只在领导会话层隐藏（root 层 restrict 必然抛错：宿主要求 scoped ctx），
//   路由执行体异常时模型应无路可走，而非退回裸派遣。
// 6 监控只写事实：门禁拦截、角色漂移、子代理 start/start-failed/end/error（角色 + 路由 +
//   子代理 id + 报错 message/code）追加落盘 ~/.dsh/verispring-monitor.jsonl
//   （gates/monitor-log.js）；start 只在 spawn 成功后才记。
// 7 任务书与并发（只约束执行派遣）：任务书命中调研型措辞即拒绝（清单见 BRIEF_LINT_TERMS，
//   CASEOS_BRIEF_LINT=0 关闭）——调研是常驻测绘的职责，执行任务书只写改哪里、改成什么、
//   怎么验证；同一领导会话里运行中的执行子代理数达上限即拒绝（CASEOS_MAX_EXECUTORS，默认 8；
//   测绘不计入）。测绘派遣（description 带测绘前缀）直接放行（第 3 条与本节都跳过，建图与
//   调研正是它要做的事）；没有可达测绘时的执行派遣按 scout-missing 拒绝。任务书、地图门禁与
//   本节的拒绝都记 kind=dispatch-deny 并带规则名，与既有 gate-deny 分开，便于审计哪条规则在
//   拦。派遣回执保留 "started subagent <id>" 前缀原样（宿主与 client.js 的解析契约），追加
//   路由、角色与测绘接替事实。
// 规范目录按主目录解析（~/.dsh/specs/），搬家无需改码。
const MARKER = "# 子代理派遣规范";
const SPEC_FRAGMENT = "specs/子代理派遣规范.md";
const GATE_TOOLS = new Set(["subagent", "subagent_fork"]);
const MAP_FILE = ".project-map.md";
const MAP_WRITE_TOOLS = new Set(["write", "edit"]);
const SUBAGENT_PRESET = "verispring-subagent";
const BASE_SUBAGENT_TOOL = "subagent-base";
const LEADER_SUBAGENT_TOOL = "subagent";
const ROUTES_UPDATED_EVENT = "verispring/routes-updated";
// 新派遣默认走 llm-deepseek 版（verispring-ds）：只有这个适配器会把思考档位发成
// output_config.effort，网关也只从那儿读 effort。pi-ai 的 verispring 只剩两类用途：
// claude-opus-5-5，以及切换前已在途、仍钉在 pi-ai deepseek-flash 上的老会话。
const DEFAULT_ROUTES = {
  scout: { provider: "verispring-ds", model: "deepseek-flash", reasoningEffort: "high" },
  executor: { provider: "verispring-ds", model: "deepseek-flash", reasoningEffort: "high" },
};
// 调研型措辞：执行任务书里出现即拒绝（调研是常驻测绘的职责，执行者只做已查实的事）。
// 集中一处，环境变量 CASEOS_BRIEF_LINT=0 整表关闭。
const BRIEF_LINT_TERMS = [
  "先调研",
  "调研后再",
  "先查清",
  "查清楚再",
  "先摸清",
  "读源码确认",
  "通读",
  "先读懂",
  "拿不准先读",
  "自行调研",
  "先排查根因再",
  "investigate first",
  "research first",
  "read the source to figure out",
];
// 并发上限的缺省值：环境变量 CASEOS_MAX_EXECUTORS 是唯一来源，缺省/非法回落 8。
const EXECUTOR_CAP_DEFAULT = 8;
// 用户配置文件（配置面板写入）：{ scout: {...}, executor: {...} }。
// 读取失败/缺省回落常量，门禁永不因配置文件崩。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SLIM_DESC, slimSchema } from "./leader-scope.js";
import { monitorEvent } from "./monitor-log.js";

function loadRoutes(configFile) {
  try {
    const cfg = JSON.parse(readFileSync(configFile, "utf8"));
    const route = (name) => {
      const configured = cfg?.[name];
      if (!configured?.provider || !configured?.model) return DEFAULT_ROUTES[name];
      return {
        ...DEFAULT_ROUTES[name],
        ...configured,
        reasoningEffort: configured.reasoningEffort || DEFAULT_ROUTES[name].reasoningEffort,
      };
    };
    return { scout: route("scout"), executor: route("executor") };
  } catch (error) {
    // 配置文件是唯一事实源；损坏时恢复默认结构，避免每次启动继续运行在不可见的旧路由上。
    try {
      const temp = `${configFile}.tmp-${process.pid}`;
      mkdirSync(`${configFile.slice(0, configFile.lastIndexOf("/"))}`, { recursive: true });
      writeFileSync(temp, `${JSON.stringify(DEFAULT_ROUTES, null, 2)}\n`);
      renameSync(temp, configFile);
      process.stderr.write(`caseos-dispatch-gate: verispring.json 已按默认路由自愈: ${String(error)}\n`);
    } catch (repairError) {
      process.stderr.write(`caseos-dispatch-gate: verispring.json 自愈失败: ${String(repairError)}\n`);
    }
  }
  return DEFAULT_ROUTES;
}

function isScoutDescription(description) {
  const value = String(description ?? "").trim().toLowerCase();
  return value.startsWith("测绘智能体") || value.startsWith("scout");
}

// 否定豁免：命中词前 6 个字符以内出现否定词，就是在要求「别这么做」，不构成命中
// （「不要通读实现」「禁止先调研」「do not investigate first」都应放行）。距离按否定词
// 结尾到命中词开头算，多字否定词（do not）才不会因自身长度被挤出窗口。同一词出现
// 多次时任一处未被否定即拒。
const BRIEF_LINT_NEGATIONS = ["不", "禁止", "勿", "别", "无需", "不要", "不必", "严禁", "don't", "don’t", "do not", "never"];
const BRIEF_LINT_NEGATION_WINDOW = 6;

function negatedAt(text, at) {
  const head = text.slice(0, at);
  return BRIEF_LINT_NEGATIONS.some((negation) => {
    const found = head.lastIndexOf(negation);
    return found !== -1 && at - (found + negation.length) <= BRIEF_LINT_NEGATION_WINDOW;
  });
}

// 任务书里的调研型措辞：命中即拒（回填命中词用于拒绝文案）。英文按小写匹配。
function briefLintTerm(prompt) {
  const text = String(prompt ?? "").toLowerCase();
  for (const term of BRIEF_LINT_TERMS) {
    const needle = term.toLowerCase();
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      if (!negatedAt(text, at)) return term;
    }
  }
  return void 0;
}

function briefLintEnabled() {
  return process.env.CASEOS_BRIEF_LINT !== "0";
}

// 执行子代理并发上限：环境变量唯一来源，缺省/非法回落默认值（缺省行为明确，不猜用户意图）。
function executorCapLimit() {
  const parsed = Number.parseInt(String(process.env.CASEOS_MAX_EXECUTORS ?? "").trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : EXECUTOR_CAP_DEFAULT;
}

// 活上下文的 agents 注册表：失活作用域读取会抛 inactive context，读不到就按无运行中子代理
// 处理（门禁不因读服务失败而崩，与 childPlan 的活 ctx 取法一致）。
function liveAgentsOf(agent, root) {
  try {
    return agent?.ctx?.get?.("agents") ?? root?.get?.("agents");
  } catch {
    try {
      return root?.get?.("agents");
    } catch {
      return void 0;
    }
  }
}

// 本领导会话里正在运行的执行子代理：宿主注册表 status 为准，归属认运行时 owner 与持久
// session 血缘两条（恢复的会话里子代理未必还有 owner）。测绘身份不计入上限——它常驻是常态。
function runningExecutors(agents, leader, scoutId, stateDir) {
  const list = typeof agents?.list === "function" ? agents.list() : [];
  const leaderSession = sessionIdOf(leader?.session);
  const running = [];
  for (const candidate of list) {
    if (!candidate || candidate === leader || candidate.status !== "running") continue;
    const owned = agents.isOwnedBy?.(candidate.id, leader) === true;
    const lineage = leaderSession !== void 0 && candidate.session?.header?.parentSession === leaderSession;
    if (!owned && !lineage) continue;
    if (candidate.id === scoutId) continue;
    if (readChildRole(stateDir, candidate.session) === "scout") continue;
    running.push(candidate.id);
  }
  return running;
}

// 子代理角色持久化：spawn 时落盘（stateDir/<子会话id>.json {version, role}），
// childPlan 永远优先读它——进程重载后内存路由表清空也不能让常驻测绘被重新归类为执行。
function childRoleFile(stateDir, session) {
  const id = sessionIdOf(session);
  return id ? `${stateDir}/${id}.json` : void 0;
}

function readChildRole(stateDir, session) {
  const file = childRoleFile(stateDir, session);
  if (!file) return void 0;
  try {
    const role = JSON.parse(readFileSync(file, "utf8")).role;
    return role === "scout" || role === "executor" ? role : void 0;
  } catch {}
  return void 0;
}

function writeChildRole(stateDir, session, role) {
  const file = childRoleFile(stateDir, session);
  if (!file || (role !== "scout" && role !== "executor")) return;
  if (readChildRole(stateDir, session) === role) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ version: 1, role })}\n`);
  } catch (error) {
    process.stderr.write(`caseos-dispatch-gate: 子代理角色落盘失败: ${String(error)}\n`);
  }
}

// 会话标题自愈：spawn 时 label（含 " · scout|executor · "）已写为标题；标题是最早的
// 角色事实，历史子代理（修复前创建、无角色文件）据此恢复真实角色。
function roleFromTitle(sessionTitle, session) {
  if (!sessionTitle?.get) return void 0;
  try {
    const title = sessionTitle.get(session)?.title ?? "";
    if (title.includes(" · scout · ")) return "scout";
    if (title.includes(" · executor · ")) return "executor";
  } catch {}
  return void 0;
}

// git HEAD 读取（地图新鲜度门用）：非仓库/git 缺失一律返回 undefined 并放行（fail-open）。
function gitHead(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 3000, encoding: "utf8" }).trim() || void 0;
  } catch {}
  return void 0;
}

function gitOutput(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { timeout: 3000, encoding: "utf8" }).trim();
  } catch {}
  return void 0;
}

// 地图过期时的读数：落后提交数与区间改动文件数。任一取不到就省略该段（git 不可判定不猜）。
function mapDrift(cwd, baseline, head) {
  const range = `${baseline}..${head}`;
  const countText = gitOutput(cwd, ["rev-list", "--count", range]);
  const filesText = gitOutput(cwd, ["diff", "--name-only", range]);
  const commits = countText === void 0 ? void 0 : Number(countText);
  return {
    commits: Number.isInteger(commits) ? commits : void 0,
    files: filesText === void 0 ? void 0 : filesText.split("\n").filter(Boolean).length,
  };
}

const MAP_BASELINES_FILE = "caseos/map-baselines.json";

// 地图目标路径归一：展开 ~、按会话工作区解析相对路径，再与工作区地图比较（write 与 edit
// 都可能拿到相对路径或 ~ 路径）。
function mapPathOf(cwd, value) {
  if (typeof value !== "string" || !value) return void 0;
  const expanded = value === "~"
    ? homedir()
    : value.startsWith("~/") ? `${homedir()}${value.slice(1)}` : value;
  return resolve(cwd ?? process.cwd(), expanded);
}

function mapFileOf(cwd) {
  return resolve(cwd ?? process.cwd(), MAP_FILE);
}

function loadMapBaseline(dshHome, cwd) {
  try {
    const commit = JSON.parse(readFileSync(`${dshHome}/${MAP_BASELINES_FILE}`, "utf8"))[resolve(cwd)]?.commit;
    return typeof commit === "string" && commit ? commit : void 0;
  } catch {}
  return void 0;
}

function saveMapBaseline(dshHome, cwd, commit) {
  if (!cwd || !commit) return;
  let all = {};
  try { all = JSON.parse(readFileSync(`${dshHome}/${MAP_BASELINES_FILE}`, "utf8")); } catch {}
  all[resolve(cwd)] = { commit, at: new Date().toISOString() };
  try {
    mkdirSync(`${dshHome}/caseos`, { recursive: true });
    const temp = `${dshHome}/${MAP_BASELINES_FILE}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(temp, `${dshHome}/${MAP_BASELINES_FILE}`);
  } catch (error) {
    process.stderr.write(`caseos-dispatch-gate: 地图基准落盘失败: ${String(error)}\n`);
  }
}

// 作用域已不可用的两种形态：宿主的 agents 服务只在活跃 fiber 上解析（inactive context），
// 而宿主 cordis 只允许在声明过 inject 的作用域上属性取服务（cannot get property "<name>"
// without inject）。两者都说明「这个作用域取不到服务」，换下一个作用域重试即可。
function isInactiveContext(error) {
  return /inactive context|without inject/i.test(String(error?.message ?? error));
}

// 取宿主服务的唯一读法：作用域 `get()` 不要求 inject 声明，是宿主给的正当入口；属性读取
// 只在声明过该依赖的作用域上合法。两者都可能因作用域失活/未声明而抛，最终回落 root。
function serviceOf(scope, name, root) {
  try {
    const value = scope?.get?.(name);
    if (value !== void 0) return value;
  } catch {}
  for (const candidate of [scope, root]) {
    try {
      const value = candidate?.[name];
      if (value !== void 0) return value;
    } catch {}
  }
  return void 0;
}

// 派遣的唯一启动取法：作用域的 `inject` 面（cordis 的依赖声明；未声明的属性读取会被宿主
// 直接拒绝）。派遣发生在领导/子代理作用域上，这些作用域继承 agent-loop 的 inject（tools、
// agents 一类），subagents 不在其中——v1.3.65 的 `liveCtx.subagents.startActivation` 因此让
// 全部派遣失败。这里建一个只注入所需服务的临时作用域，取到服务即调用，随后释放，不长期
// 持有任何作用域。
function withInjected(scope, names, run) {
  return new Promise((resolve, reject) => {
    let fiber;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve(value);
      else reject(error);
      try { Promise.resolve(fiber?.dispose?.()).catch(() => {}); } catch {}
    };
    // 服务缺失时宿主的注入作用域根本不会启动、回调永不执行：先判在不在，缺了当场失败。
    let present;
    try { present = scope?.get?.(names[0]); } catch { present = void 0; }
    if (present === void 0) {
      finish(new Error(`cannot get property "${names[0]}" without inject`));
      return;
    }
    if (typeof scope?.inject !== "function") {
      finish(new Error(`cannot get property "${names[0]}" without inject`));
      return;
    }
    try {
      fiber = scope.inject(names, (rtc) => {
        Promise.resolve()
          .then(() => run(rtc))
          .then((value) => finish(undefined, value), (error) => finish(error));
      });
    } catch (error) {
      finish(error);
      return;
    }
    Promise.resolve(fiber).catch((error) => finish(error));
  });
}

function routeText(route) {
  return `${route.provider}/${route.model}${route.reasoningEffort ? `@${route.reasoningEffort}` : ""}`;
}

// 派遣回执：前缀 "started subagent <id>" 是宿主与 client.js 的解析契约，必须原样保留；
// 路由、角色与测绘接替事实一律追加在后。
function startedReceipt(value) {
  const id = value?.subagentId;
  let text = `started subagent ${id}`;
  if (value?.route) text += `（路由：${value.route} · 角色：${value.role}）`;
  if (value?.replacedScoutId) text += `；已接替不可达测绘 ${value.replacedScoutId}`;
  return text;
}

function pathMatches(value, dshHome) {
  if (typeof value !== "string") return false;
  const expanded = value.startsWith("~/") ? dshHome + value.slice(1) : value;
  return expanded.includes(SPEC_FRAGMENT);
}

// 会话状态（规范已读 + 测绘可达）：规范已读增量扫描会话事件日志（WeakMap 缓存扫描
// 位点）；测绘身份与其可达性落在状态文件（跨进程、跨重启一致）。
const sessionStates = new WeakMap();
function sessionIdOf(session) {
  return session?.header?.id ?? session?.header?.sessionId ?? session?.id ?? session?.sessionId ?? void 0;
}

// 领导 send_message 的失败是测绘不可达的第二条事实来源：宿主冷恢复不可用时报
// NOT_RESUMABLE（"subagent \"…\" is unavailable"）。
function sendMessageFailure(result) {
  if (!result?.isError) return void 0;
  const message = String(result.error?.message ?? "");
  const code = String(result.error?.info?.code ?? "");
  if (code === "NOT_RESUMABLE" || /unavailable|NOT_RESUMABLE/i.test(message)) {
    return code || "NOT_RESUMABLE";
  }
  return void 0;
}

function readStateFile(sessionId, stateDir) {
  if (!sessionId) return {};
  try {
    return JSON.parse(readFileSync(`${stateDir}/${sessionId}.json`, "utf8")) ?? {};
  } catch {}
  return {};
}

function scoutIdIn(state) {
  const scoutId = state?.scoutId;
  return typeof scoutId === "string" && scoutId ? scoutId : void 0;
}

// 测绘身份只有一个事实源：会话状态文件里的 scoutId；不可达是外部事实（end 的 stopReason、
// send_message 的失败）推出的投影，与 scoutId 同写一个文件、同一次原子写。
function writeScoutState(sessionId, next, stateDir) {
  if (!sessionId) return;
  const current = readStateFile(sessionId, stateDir);
  const scoutId = next.scoutId !== undefined ? next.scoutId : scoutIdIn(current);
  const unreachable = next.unreachable !== undefined ? next.unreachable : current.scoutUnreachable;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      `${stateDir}/${sessionId}.json`,
      `${JSON.stringify({ version: 1, ...(scoutId ? { scoutId } : {}), ...(unreachable ? { scoutUnreachable: unreachable } : {}) })}\n`,
    );
  } catch (error) {
    process.stderr.write(`caseos-dispatch-gate: 状态文件写入失败: ${String(error)}\n`);
  }
}

// 常驻判据=可达，不是标题前缀：completed 只是应询结束（send_message 走冷恢复），仍算常驻；
// 只有 end 的 stopReason 非 completed，或 send_message 回报 NOT_RESUMABLE 一类错误才失联。
function reachableScoutId(sessionId, stateDir) {
  const state = readStateFile(sessionId, stateDir);
  if (state.scoutUnreachable) return void 0;
  return scoutIdIn(state);
}

// 只对当前这一任测绘生效：旧测绘迟到的 end 不得把刚接替的新测绘判成失联。
function markScoutUnreachable(sessionId, scoutId, reason, stateDir) {
  const state = readStateFile(sessionId, stateDir);
  if (!scoutId || state.scoutId !== scoutId || state.scoutUnreachable) return false;
  writeScoutState(sessionId, { unreachable: reason }, stateDir);
  return true;
}

// subagent/end 只带子代理 id（宿主把 parent 用作作用域键，不传给监听器），而可达性记在
// 父会话的状态文件里：这份索引把子代理 id 映射回会话 id。写入 scoutId 时填充；进程重启后
// 按状态目录懒重建（状态文件是唯一事实源）。
const scoutSessionIndex = new Map();
const indexedStateDirs = new Set();

// 键带状态目录：同一进程可能换 profile（DSH_HOME 变），子代理 id 只在各自目录内有意义。
const scoutKey = (stateDir, scoutId) => `${stateDir}\u0000${scoutId}`;

function rememberScoutOwner(scoutId, sessionId, stateDir) {
  if (scoutId && sessionId) scoutSessionIndex.set(scoutKey(stateDir, scoutId), sessionId);
}

function scoutOwnerOf(scoutId, stateDir) {
  if (!scoutId) return void 0;
  const key = scoutKey(stateDir, scoutId);
  const known = scoutSessionIndex.get(key);
  if (known) return known;
  if (!indexedStateDirs.has(stateDir)) {
    indexedStateDirs.add(stateDir);
    let names = [];
    try { names = readdirSync(stateDir); } catch {}
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sessionId = name.slice(0, -5);
      const owner = scoutIdIn(readStateFile(sessionId, stateDir));
      if (owner) rememberScoutOwner(owner, sessionId, stateDir);
    }
  }
  return scoutSessionIndex.get(key);
}

// 测绘任务书前缀：测绘身份由领导在 description 里明确标注，这里交底职责与现状——上任测绘
// 为何不可达、仓库地图全文（只做增量校对）。不含任何角色转换；执行派遣永远拿不到它。
function scoutBriefingPrefix({ previous, reason, cwd }) {
  const mapPath = `${cwd}/${MAP_FILE}`;
  const lines = [
    "【测绘智能体】领导以 description 的测绘前缀把本笔派遣标为测绘：只做定位、事实与建图，产出入口表 ≤20 行；"
      + "只读：不要 edit/write，地图由领导 write 落盘。",
  ];
  if (previous) lines.push(`上任测绘 ${previous} 已不可达（${reason}），本笔是接替派遣。`);
  let text = lines.join("\n");
  try {
    text += `\n仓库已有地图（${mapPath}），只做增量校对：只核对变化部分并回报入口表 ≤20 行，不必重头建图。\n\n`
      + readFileSync(mapPath, "utf8");
  } catch {}
  return `${text}\n\n`;
}

function sessionState(session) {
  let st = sessionStates.get(session);
  if (!st) {
    st = { scanned: 0, specRead: false };
    sessionStates.set(session, st);
  }
  const total = typeof session?.seq === "number" ? session.seq : 0;
  for (let i = st.scanned; i < total; i++) {
    let e;
    try { e = session.eventAt(i); } catch { break; }
    if (!e) break;
    if (e.type === "tool/result" && !st.specRead) {
      const content = e.data?.message?.content;
      const text = Array.isArray(content) ? content.map((block) => block?.text ?? "").join("\n") : "";
      if (text.includes(MARKER)) {
        st.specRead = true;
        process.stderr.write("caseos-dispatch-gate: spec read detected\n");
      }
    }
  }
  st.scanned = Math.max(st.scanned, total);
  return st;
}

const pendingRoutePlans = new Map();
// 跨重载状态：面板改一次模型配置，cordis 就重跑一次 apply、旧作用域失活。这些状态
// 必须放在模块层才能跨重载延续（WeakSet 按对象、Map 按 id，重载不丢）。
const leaderToolInstalled = new WeakSet();
const leaderToolInstalling = new WeakSet();
const childRoutePlans = new Map();

function queueRoutePlan(parent, plan) {
  if (!parent) return;
  const queue = pendingRoutePlans.get(parent) ?? [];
  queue.push(plan);
  pendingRoutePlans.set(parent, queue);
}

function takeRoutePlan(parent) {
  if (!parent) return undefined;
  const queue = pendingRoutePlans.get(parent);
  const plan = queue?.shift();
  if (!queue?.length) pendingRoutePlans.delete(parent);
  return plan;
}

function renameChildTitle(ctx, childId, title) {
  const sessionTitle = ctx?.get?.("sessionTitle");
  const child = ctx?.get?.("agents")?.get(childId);
  if (!sessionTitle || !child?.session) return;
  try { sessionTitle.rename(child.session, title); }
  catch (error) { process.stderr.write(`caseos-dispatch-gate: 子代理标题写入失败: ${String(error)}\n`); }
}

function renameChildTitleAfterAutoTitle(ctx, childId, title) {
  for (const delay of [0, 1500, 5000, 10000]) {
    setTimeout(() => renameChildTitle(ctx, childId, title), delay);
  }
}

const plugin = {
  // subagents 故意不在这里：它是每笔派遣现注入的服务（见 withInjected），声明成插件依赖会让
  // 整个门禁在缺少该服务的宿主上永不激活。sessionController 同理——它只用于写子代理模型
  // 选择，缺了照常派遣（applyChildRoute 已容错），不该拖住派遣门禁本身。
  inject: ["tools", "agents", "sessionTitle", "profileContext"],
  apply(ctx) {
    const dshHome = ctx.profileContext?.home ?? process.env.DSH_HOME ?? `${homedir()}/.dsh`;
    const configFile = `${dshHome}/verispring.json`;
    const stateDir = `${dshHome}/caseos/session-state`;
    const specPath = `${dshHome}/specs/子代理派遣规范.md`;
    const denyReason =
      `派遣前必读 ${specPath}：先用 read 工具读取该规范（含任务书模板与派发前自查），然后重新发起本次调用。`;
    let routes = loadRoutes(configFile);
    // 子代理生命周期落监控：不再需要解压会话日志就能审计"谁、什么角色、什么路由、怎么结束的"。
    // end 也入账可达性：completed 只是应询结束（send_message 冷恢复），其余 stopReason 才算失联。
    ctx.root.on("subagent/end", (info) => {
      const cause = info?.error ?? info?.cause;
      monitorEvent(dshHome, {
        kind: "subagent-end",
        child: info?.id,
        provider: info?.provider,
        stopReason: info?.stopReason,
        parent: scoutOwnerOf(info?.id, stateDir),
        ...(cause ? { error: String(cause?.message ?? cause) } : {}),
        ...(cause?.code ? { code: String(cause.code) } : {}),
      });
      if (info?.stopReason === "completed") return;
      const owner = scoutOwnerOf(info?.id, stateDir);
      if (owner && markScoutUnreachable(owner, info?.id, `end=${info?.stopReason}`, stateDir)) {
        process.stderr.write(`caseos-dispatch-gate: 测绘 ${info?.id} 不可达（${info?.stopReason}），已标不可达\n`);
      }
    });
    // 子代理自身报错：agent/error 带 agent 与 error，直接记为一条事实（end 只带子代理 id）。
    ctx.root.on("agent/error", ({ agent, error }) => {
      if (agent?.session?.header?.origin !== "subagent") return;
      monitorEvent(dshHome, {
        kind: "subagent-error",
        child: agent.id,
        parent: agent.session?.header?.parentSession,
        message: String(error?.message ?? error).slice(0, 300),
        ...(error?.code ? { code: String(error.code) } : {}),
      });
    });
    ctx.root.on(ROUTES_UPDATED_EVENT, () => {
      routes = loadRoutes(configFile);
      process.stderr.write(`caseos-dispatch-gate: routes reloaded (${routeText(routes.scout)}; ${routeText(routes.executor)})\n`);
    });
    process.stderr.write(
      `caseos-dispatch-gate: plugin activated (测绘: ${routeText(routes.scout)}; 执行: ${routeText(routes.executor)})\n`,
    );
    let globalLeaderToolInstalled = false;

    // 服务一律从活上下文现取（agent.ctx 随会话存活），不碰 apply 闭包 ctx：面板改配置会
    // 重跑 apply、旧作用域失活，闭包 ctx 一读就是 inactive context 事故。
    const liveOf = (agent) => {
      try {
        return agent?.ctx ?? ctx.root;
      } catch {
        return ctx.root;
      }
    };

    const applyChildRoute = (agent, plan, live) => {
      if (!agent || !plan) {
        return;
      }
      // 角色漂移是 v1.3.58 之前的真实事故（重载后测绘被重归类为执行并长期跑错路由）：
      // 这里既落盘角色（根治），也把任何同 id 换角色的迹象写进监控（兜底告警）。
      const previous = childRoutePlans.get(agent.id);
      if (previous?.role && plan.role && previous.role !== plan.role) {
        monitorEvent(dshHome, { kind: "role-route-mismatch", agent: agent.id, from: previous.role, to: plan.role });
        process.stderr.write(`caseos-dispatch-gate: 角色漂移告警 ${agent.id} ${previous.role} -> ${plan.role}\n`);
      }
      childRoutePlans.set(agent.id, plan);
      writeChildRole(stateDir, agent.session, plan.role);
      try {
        // 服务从活上下文现取（get 优先，属性只在声明过的层上合法）：sessionController 不在
        // 领导作用域的 inject 链里，直取属性就会抛 without inject。
        const controller = serviceOf(live ?? liveOf(agent), "sessionController", ctx.root);
        controller?.agents?.selectForNextRequest(agent, {
          provider: plan.route.provider,
          model: plan.route.model,
          ...(plan.route.reasoningEffort ? { reasoningEffort: plan.route.reasoningEffort } : {}),
        });
      } catch (error) {
        process.stderr.write(`caseos-dispatch-gate: 子代理模型选择写入失败: ${String(error)}\n`);
      }
    };

    const executeRouted = async (args, exec, rtc) => {
      // 重载安全（v1.3.61）：面板改模型配置会重跑 apply、旧作用域失活，而已注册的派遣
      // 入口持有的可能是旧作用域。服务一律从活上下文现取——会话层入口传注入时的 rtc，
      // 静态入口按 exec.agent.ctx 现取，两者都不碰 apply 闭包的 ctx，否则就是 inactive
      // context 事故（旧作用域读服务直接抛错）。
      const live = rtc ?? exec.agent?.ctx ?? ctx.root;
      const session = exec.agent?.session;
      const sessionId = sessionIdOf(session);
      // 角色只看领导写在 description 里的派遣意图：测绘前缀 = 测绘派遣，其余 = 执行派遣。
      // 可达性不改变角色——旧设计在没有可达测绘时把执行派遣偷换成测绘，已废除（guard 会拒）。
      const role = isScoutDescription(args.description) ? "scout" : "executor";
      routes = loadRoutes(configFile);
      const route = routes[role];
      const label = String(args.description ?? "").trim();
      const roleLabel = `${routeText(route)} · ${role} · ${label}`;
      // 测绘派遣一律交底职责与现状；只有上一任已不可达时才带接替事实（回执同源）。
      const previousState = role === "scout" ? readStateFile(sessionId, stateDir) : {};
      const previousScout = role === "scout" && previousState.scoutUnreachable
        ? scoutIdIn(previousState)
        : void 0;
      const scoutPrefix = role === "scout"
        ? scoutBriefingPrefix({
          previous: previousScout,
          reason: previousState.scoutUnreachable,
          cwd: session?.header?.cwd ?? process.cwd(),
        })
        : "";
      const routedPrompt = `【实际路由：${role} · ${routeText(route)}】\n${scoutPrefix}${String(args.prompt ?? "")}`;
      process.stderr.write(`caseos-dispatch-gate: 强制 ${role} 子代理 ${routeText(route)}\n`);
      const request = {
        label: roleLabel,
        prompt: [{ type: "text", text: routedPrompt }],
        parent: exec.agent,
        agentPreset: SUBAGENT_PRESET,
        agentOptions: { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort },
        maxDepth: 1,
      };
      queueRoutePlan(sessionId, { label: roleLabel, route, role });
      let child;
      try {
        child = await startActivation(live, exec, { provider: "spawn", label: roleLabel, request, signal: exec.signal, delivery: "parent" });
      } catch (error) {
        takeRoutePlan(sessionId);
        monitorEvent(dshHome, {
          kind: "subagent-start-failed",
          role,
          route: routeText(route),
          parent: sessionId,
          label: label.slice(0, 120),
          error: String(error?.message ?? error).slice(0, 300),
          ...(error?.code ? { code: String(error.code) } : {}),
        });
        if (isInactiveContext(error)) {
          throw new Error("宿主 agents 服务不可用（会话上下文已失效），请刷新会话后重派");
        }
        throw error;
      }
      monitorEvent(dshHome, {
        kind: "subagent-start",
        role,
        route: routeText(route),
        parent: sessionId,
        child: child.childId,
        label: label.slice(0, 120),
      });
      applyChildRoute(serviceOf(live, "agents", ctx.root)?.get(child.childId), { label: roleLabel, route, role }, live);
      renameChildTitleAfterAutoTitle(live, child.childId, roleLabel);
      if (role === "scout") {
        rememberScoutOwner(child.childId, sessionId, stateDir);
        writeScoutState(sessionId, { scoutId: child.childId, unreachable: "" }, stateDir);
      }
      // 回执把路由与角色写成事实：宿主与 client.js 只认 "started subagent <id>" 前缀，追加
      // 内容一律排在后面。测绘接替时补一句被接替的旧测绘 id。
      return {
        kind: "activation",
        subagentId: child.childId,
        route: routeText(route),
        role,
        ...(previousScout ? { replacedScoutId: previousScout } : {}),
      };
    };

    // startActivation 是唯一启动入口。服务只能经注入拿：领导/子代理作用域的 inject 链里没有
    // subagents，属性直取会被宿主以 "cannot get property "subagents" without inject" 拒绝
    // （v1.3.65 全部派遣失败的原因）。先按本次调用给的作用域注入，失败（作用域失活或服务
    // 缺失）再换 exec.agent.ctx / root 重试一次。
    const startActivation = async (liveCtx, exec, spec) => {
      const attempts = [];
      for (const scope of [liveCtx, exec.agent?.ctx, liveCtx?.root]) {
        if (scope !== void 0 && !attempts.includes(scope)) attempts.push(scope);
      }
      let last;
      for (const scope of attempts) {
        try {
          return await withInjected(scope, ["subagents"], (rtc) => rtc.subagents.startActivation(spec));
        } catch (error) {
          last = error;
          if (!isInactiveContext(error)) throw error;
        }
      }
      throw last ?? new Error('cannot get property "subagents" without inject');
    };

    const staticSubagentBase = {
      name: BASE_SUBAGENT_TOOL,
      description: SLIM_DESC.subagent,
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          description: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["description", "prompt"],
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: startedReceipt(value) }],
      },
    };
    const staticRoutedTool = {
      ...staticSubagentBase,
      name: LEADER_SUBAGENT_TOOL,
      __caseosRouted: true,
      // 不传 rtc：执行体按 exec.agent.ctx 现取活上下文，静态入口同样不持有闭包 ctx。
      async execute(args, exec) { return executeRouted(args, exec); },
    };
    try {
      ctx.root.tools.register(staticRoutedTool);
      globalLeaderToolInstalled = true;
    } catch (error) {
      process.stderr.write(`caseos-dispatch-gate: 全局 subagent 入口注册失败: ${String(error)}\n`);
    }

    // 子代理的 provider/model/角色是运行时契约，不能依赖模型是否记得在 tool call 里填写。
    // 官方 tool-subagent 先以 subagent-base 挂载，领导层只暴露本插件的 subagent 入口；
    // 这样不在官方同名工具作用域上重复注册，角色由领导的 description 前缀决定。
    const installLeaderTool = async (agent) => {
      if (!agent || agent.session?.header?.origin === "subagent") return;
      if (leaderToolInstalled.has(agent) || leaderToolInstalling.has(agent)) return;
      leaderToolInstalling.add(agent);
      try {
        await agent.ctx.inject(["tools", "subagents"], (rtc) => {
        if (globalLeaderToolInstalled) {
          try { rtc.tools.restrict({ deny: [BASE_SUBAGENT_TOOL] }); }
          catch {}
          leaderToolInstalled.add(agent);
          return;
        }
        // 按领导自己的视图取官方基座；它只作为执行实现，不直接暴露给模型。
        const current = rtc.tools.get(BASE_SUBAGENT_TOOL, agent);
        if (!current) {
          // 基座已被会话层 restrict 藏掉（见下）：取不到是正常态，只要本插件的路由入口
          // （__caseosRouted）也在，派遣就有着落，别再重复装配。
          const existing = rtc.tools.get(LEADER_SUBAGENT_TOOL, agent);
          if (existing?.__caseosRouted) leaderToolInstalled.add(agent);
          return;
        }
        // 领导层的 subagent 只此一处注册：瘦身文案来自 leader-scope，执行体是本文件的路由强制。
        // 其他插件（如 leader-scope）不得再注册同名工具，否则同层重复注册会抛错。
        if (current.__caseosRouted) {
          leaderToolInstalled.add(agent);
          return;
        }
        const wrapped = { ...current, name: LEADER_SUBAGENT_TOOL, __caseosRouted: true,
          description: SLIM_DESC.subagent ?? current.description,
          parameters: slimSchema(current.parameters ?? {}),
          // 回执文案按本插件的路由事实渲染（会话层入口与全局入口同一份契约）。
          ...(current.output ? { output: { ...current.output, render: (_args, value) => [{ type: "text", text: startedReceipt(value) }] } } : {}),
          execute: (args, exec) => executeRouted(args, exec, rtc) };
        let registered = globalLeaderToolInstalled;
        if (!registered) {
          try {
            ctx.root.tools.register(wrapped);
            globalLeaderToolInstalled = true;
            registered = true;
            process.stderr.write("caseos-dispatch-gate: 全局 subagent 入口已绑定强制路由\n");
          } catch (error) {
            try {
              rtc.tools.register(wrapped);
              registered = true;
              process.stderr.write("caseos-dispatch-gate: 领导 subagent 入口已绑定强制路由\n");
            } catch (scopedError) {
              process.stderr.write(`caseos-dispatch-gate: subagent 入口注册失败: ${String(scopedError)}; 全局尝试: ${String(error)}\n`);
            }
          }
        }
        if (registered) {
          // 基座只供本插件保留，领导模型只看到路由入口。
          try { rtc.tools.restrict({ deny: [BASE_SUBAGENT_TOOL] }); }
          catch (error) { process.stderr.write(`caseos-dispatch-gate: 官方基座隐藏失败: ${String(error)}\n`); }
          leaderToolInstalled.add(agent);
        }
        });
      } catch (error) {
        process.stderr.write(`caseos-dispatch-gate: 领导 subagent 入口注入失败: ${String(error)}\n`);
      } finally {
        leaderToolInstalling.delete(agent);
      }
    };

    // 新建子代理会话仍空白，走 select（写 agent-preset/selected，冷读按日志重建组合）；
    // 冷恢复时 harness 又让子代理接回父会话 preset，按会话投影记录的 preset 重新组合。
    // 失败只记日志：agent/created 监听器抛错会让整个子代理创建回滚。
    const composeSubagentPreset = async (agent) => {
      const live = liveOf(agent);
      const presets = live.get("agentPresets");
      if (presets === void 0 || presets.composedPreset(agent.ctx) === SUBAGENT_PRESET) return;
      try {
        const recorded = live.get("sessionProjections")?.stateOf(agent.session, "agentPreset");
        if (recorded === SUBAGENT_PRESET) await presets.recompose(agent.ctx, SUBAGENT_PRESET);
        else await presets.select(agent, SUBAGENT_PRESET);
        process.stderr.write(`caseos-dispatch-gate: 子代理 ${agent.id} 已挂载 preset ${SUBAGENT_PRESET}\n`);
      } catch (error) {
        process.stderr.write(`caseos-dispatch-gate: 子代理 ${agent.id} 挂载 ${SUBAGENT_PRESET} 失败，沿用继承的 preset: ${String(error)}\n`);
      }
    };

    const hideBaseSubagentTool = async (agent) => {
      if (!agent) return;
      try {
        await agent.ctx.inject(["tools"], (rtc) => {
          const deny = [BASE_SUBAGENT_TOOL, LEADER_SUBAGENT_TOOL]
            .filter((name) => rtc.tools.get(name, agent) !== void 0);
          if (deny.length) rtc.tools.restrict({ deny });
        });
      } catch (error) {
        process.stderr.write(`caseos-dispatch-gate: 子代理基座工具隐藏失败: ${String(error)}\n`);
      }
    };

    const childPlan = (agent) => {
      if (!agent || agent.session?.header?.origin !== "subagent") return undefined;
      const live = liveOf(agent);
      const agents = live.get("agents");
      const parent = agent.parent ?? agent.parentAgent
        ?? agents?.list().find((candidate) => agents.isOwnedBy?.(agent.id, candidate));
      // 角色判定顺序：本次派遣的队列计划 > 持久化角色文件 > 标题自愈 > 身份事实兜底。
      // 前两者是修复 v1.3.58 测绘路由漂移的根治面：任何重载后都先回到 spawn 时的角色。
      // 兜底只问「本子代理是不是父会话登记的那只测绘」，不按可达性推导——旧设计会把执行
      // 派遣兜成测绘（本笔修的就是这个转换）。
      const recordedScout = scoutIdIn(readStateFile(sessionIdOf(parent?.session), stateDir));
      const derivedRole = recordedScout !== void 0 && recordedScout === agent.id ? "scout" : "executor";
      const role = readChildRole(stateDir, agent.session)
        ?? roleFromTitle(live.get("sessionTitle"), agent.session)
        ?? derivedRole;
      routes = loadRoutes(configFile);
      const route = routes[role];
      const queued = takeRoutePlan(agent.session.header.parentSession);
      return queued ?? { label: `${routeText(route)} · ${role}`, route, role };
    };

    for (const agent of liveOf().get("agents")?.list() ?? []) void installLeaderTool(agent);
    ctx.root.on("agent/created", async ({ agent }) => {
      if (agent?.session?.header?.origin === "subagent") {
        const plan = childPlan(agent);
        applyChildRoute(agent, plan, liveOf(agent));
        await composeSubagentPreset(agent);
        await hideBaseSubagentTool(agent);
        const title = plan?.label;
        const sessionTitle = liveOf(agent).get("sessionTitle");
        if (title && sessionTitle) {
          try { sessionTitle.rename(agent.session, title); }
          catch (error) { process.stderr.write(`caseos-dispatch-gate: 子代理标题写入失败: ${String(error)}\n`); }
        }
      } else await installLeaderTool(agent);
    });

    // 新建主会话的首个回合可能在 agent/created 返回后立刻开始；在正式生成
    // 回合前再绑定一次，确保模型拿到的是本插件的强制路由入口，而不是原始工具。
    ctx.root.on("agent/pre-step", async ({ agent }, next) => {
      if (agent?.session?.header?.origin === "subagent") {
        const cached = childRoutePlans.get(agent.id) ?? childPlan(agent);
        if (cached) {
          // 角色终身不变（缓存/落盘为准），路由每回合现读面板配置：模型变更对进行中的
          // 常驻测绘与执行子代理下一回合即生效，不必重派、不必重启。
          const route = loadRoutes(configFile)[cached.role] ?? cached.route;
          if (routeText(route) !== routeText(cached.route)) {
            const suffix = cached.label.split(" · ").slice(2).join(" · ");
            const label = `${routeText(route)} · ${cached.role}${suffix ? ` · ${suffix}` : ""}`;
            monitorEvent(dshHome, { kind: "child-route-updated", agent: agent.id, role: cached.role, to: routeText(route) });
            applyChildRoute(agent, { ...cached, route, label }, liveOf(agent));
            renameChildTitleAfterAutoTitle(liveOf(agent), agent.id, label);
          } else applyChildRoute(agent, cached, liveOf(agent));
        }
      }
      await installLeaderTool(agent);
      return next();
    });

    // 领导续接测绘失败=该测绘不可达（第二事实源）：解除常驻，重派测绘要带测绘前缀。
    ctx.on("tools/result", (exec, result) => {
      if (!exec || !result?.isError || exec.name !== "send_message") return;
      const failure = sendMessageFailure(result);
      const scoutId = String(exec.arguments?.agent_id ?? "");
      const sessionId = sessionIdOf(exec.agent?.session) ?? scoutOwnerOf(scoutId, stateDir);
      if (!failure || !sessionId || !scoutId) return;
      if (markScoutUnreachable(sessionId, scoutId, failure, stateDir)) {
        monitorEvent(dshHome, { kind: "scout-unreachable", session: sessionId, child: scoutId, reason: failure });
        process.stderr.write(`caseos-dispatch-gate: 测绘 ${scoutId} send_message 失败（${failure}），已标不可达\n`);
      }
    });

    // 规范已读的路径判定补充：read/bash 结果内容不含首行标记（如被截断）但调用路径
    // 指向规范文件时，同样计入。内容判定由 sessionState 的增量扫描覆盖。
    ctx.on("tools/result", (exec, result) => {
      if (!exec || result?.isError) return;
      if (exec.name === "read" || exec.name === "bash") {
        let args = {};
        try { args = exec.arguments ?? {}; } catch {}
        if (pathMatches(args.path, dshHome) || pathMatches(args.file, dshHome)) {
          const st = sessionState(exec.agent?.session);
          if (!st.specRead) {
            st.specRead = true;
            process.stderr.write("caseos-dispatch-gate: spec read detected (path)\n");
          }
        }
      }
      // 地图基准登记：领导 write/edit .project-map.md 成功即把当前 HEAD 记为该工作区的新鲜度
      // 基准。write 走绝对路径，edit 可能拿到相对路径或 ~ 路径：先归一再与工作区地图比较。
      if (MAP_WRITE_TOOLS.has(exec.name)) {
        let args = {};
        try { args = exec.arguments ?? {}; } catch {}
        const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
        const target = mapPathOf(cwd, args.file_path ?? args.path ?? args.file);
        if (target && target === mapFileOf(cwd)) {
          const head = gitHead(cwd);
          if (head) saveMapBaseline(dshHome, cwd, head);
        }
      }
    });

    ctx.tools.guard((exec) => {
      if (!GATE_TOOLS.has(exec.name)) return undefined;
      const deny = (reason, rule) => {
        monitorEvent(dshHome, {
          kind: rule ? "dispatch-deny" : "gate-deny",
          gate: "dispatch",
          ...(rule ? { rule } : {}),
          tool: exec.name,
          session: sessionIdOf(exec.agent?.session),
          reason: reason.slice(0, 160),
        });
        return reason;
      };
      if (exec.name === "subagent_fork") {
        return deny("本插件统一使用 subagent spawn 入口；subagent_fork 不属于三智能体架构。");
      }
      const description = exec.arguments?.description;
      const prompt = exec.arguments?.prompt;
      const session = exec.agent?.session;
      const state = sessionState(session);
      if (!state.specRead) return deny(denyReason);
      const sessionId = sessionIdOf(session);
      const activeScout = reachableScoutId(sessionId, stateDir);
      // 角色由领导写在 description 里的前缀定：测绘前缀 = 测绘派遣，其余 = 执行派遣。可达性
      // 只决定能不能派，不再改变角色——旧设计在没有可达测绘时把执行派遣偷换成测绘，已废除。
      if (isScoutDescription(description)) {
        // 有可达测绘时再派测绘才拒绝（应询结束显示 finished/inactive 属正常：send_message
        // 会冷恢复它）。测绘派遣不受地图前置/新鲜度/任务书/并发约束——建图与调研正是它要
        // 做的事；上一任已不可达时放行，按接替派遣处理。
        if (!activeScout) return undefined;
        return deny(
          `测绘 ${activeScout} 仍可达（应询结束显示 finished/inactive 属正常），用 send_message ${activeScout} 续接；`
          + "只有它真的不可达（end 非 completed，或 send_message 报 unavailable）时才重派：description 用「测绘智能体」或「scout:」开头，插件会按测绘派遣注入职责与地图。",
        );
      }
      // 执行派遣没有可达测绘：拒绝并指路，绝不把本笔派遣悄悄改写成测绘（新规则
      // scout-missing）。CASEOS_SCOUT=0 关闭测绘架构时不做这条判定。
      if (!activeScout && process.env.CASEOS_SCOUT !== "0") {
        const scoutState = readStateFile(sessionId, stateDir);
        const previous = scoutIdIn(scoutState);
        const situation = previous
          ? `本会话没有可达测绘：上一任 ${previous} ${scoutState.scoutUnreachable || "已不可用"}`
          : "本会话没有可达测绘（还没有派过测绘）";
        return deny(
          `${situation}，执行派遣不会被改写成测绘，已拒绝。三条路：`
          + `① 上一任测绘只是应询结束（finished/inactive 属正常）时，用 send_message ${previous ?? "<测绘 id>"} 续接；`
          + "② 上一任已不可达或从没有过，就用 subagent 派一只测绘：description 以「测绘智能体」或「scout:」开头，插件会注入测绘职责与仓库地图；"
          + "③ 仓库尚无地图或地图过期时，先让测绘建图/增量校对，你用 write 落盘 .project-map.md 登记基准后再派执行者。",
          "scout-missing",
        );
      }
      // 以下只约束执行派遣：调研交给常驻测绘，执行任务书只写改哪里、改成什么、怎么验证。
      if (briefLintEnabled()) {
        const term = briefLintTerm(prompt);
        if (term) {
          process.stderr.write(`caseos-dispatch-gate: 任务书调研措辞拦截（${term}）\n`);
          const scoutHint = activeScout
            ? `send_message ${activeScout}`
            : "本会话没有可达测绘，先派一只测绘";
          return deny(
            `任务书含调研型措辞『${term}』：调研交给常驻测绘（${scoutHint}），`
            + "把它查实的事实写进任务书；执行任务书只写改哪里、改成什么、怎么验证",
            "brief-lint",
          );
        }
      }
      // 地图前置：cwd 取会话工作区（桌面宿主进程目录不是项目根）。
      const cwd = session?.header?.cwd ?? process.cwd();
      const isProjectRoot = existsSync(`${cwd}/.git`) || existsSync(`${cwd}/.manon`);
      if (isProjectRoot && !existsSync(`${cwd}/${MAP_FILE}`)) {
        process.stderr.write("caseos-dispatch-gate: 地图前置拦截（.project-map.md 不存在）\n");
        return deny(`派执行智能体前必须先有项目地图：${cwd}/${MAP_FILE} 不存在。先派测绘智能体（按系统提示的 manon-kg 调用前缀 sync 建图并回报入口表 ≤20 行），用 write 把入口表落盘为该文件，然后重新派遣。`);
      }
      // 地图新鲜度：main 自上次地图登记后又前进过，先让常驻测绘增量校对并重新落盘地图。
      // 基准在 write/edit .project-map.md 时登记（见 tools/result 监听）；地图在而基准缺失
      // 是登记漏了，不再 fail-open——否则陈旧地图会永久放行。git 读不到 HEAD 时仍放行。
      if (isProjectRoot && process.env.CASEOS_SCOUT !== "0") {
        const head = gitHead(cwd);
        if (head) {
          const baseline = loadMapBaseline(dshHome, cwd);
          if (!baseline) {
            process.stderr.write("caseos-dispatch-gate: 地图无基准拦截（.project-map.md 存在但未登记）\n");
            return deny(
              "地图尚无基准登记：请先让测绘增量校对，再用 write 重写 .project-map.md 登记基准",
              "map-baseline-missing",
            );
          }
          if (baseline !== head) {
            const drift = mapDrift(cwd, baseline, head);
            const behind = drift.commits === void 0 ? "" : `落后 ${drift.commits} 个提交`;
            const files = drift.files === void 0 ? "" : `，区间改动 ${drift.files} 个文件`;
            const readout = behind ? `（${behind}${files}）` : "";
            process.stderr.write(`caseos-dispatch-gate: 地图过期拦截（HEAD 前进于登记基准）${readout}\n`);
            return deny(
              `项目地图已过期：main 自上次地图登记后又前进了${readout}（登记基准 ${baseline.slice(0, 8)} → 当前 HEAD ${head.slice(0, 8)}）。`
              + `先 send_message 常驻测绘智能体做增量校对（manon-kg sync + 结构增量回报）；收到回报后用 write 更新 ${cwd}/${MAP_FILE}（即使结构无变化也原样落盘一次以登记新基准），然后重新派遣。`,
              "map-stale",
            );
          }
        }
      }
      // 执行子代理并发上限：同一领导会话里运行中的执行子代理已达上限就拒绝，等回执再派。
      const limit = executorCapLimit();
      const live = liveAgentsOf(exec.agent, ctx.root);
      const running = runningExecutors(live, exec.agent, activeScout, stateDir);
      if (running.length >= limit) {
        process.stderr.write(`caseos-dispatch-gate: 执行并发上限拦截（${running.length}/${limit}）\n`);
        return deny(
          `执行子代理并发已达上限 ${limit}（运行中：${running.join("、")}）：请结束本回合等回执后再派`,
          "executor-cap",
        );
      }
      return undefined;
    });
  },
};

export default plugin;
