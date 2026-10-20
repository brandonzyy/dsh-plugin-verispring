// 领导会话的代码级门禁：把「回执制、不轮询」与「领导不亲自执行」从提示词约束
// 变成运行时拒绝。只对领导会话（根会话 agent）生效，子代理会话不受限；
// CASEOS_LEADER_GUARD=0 在装配时整体关闭。
// 运行中的子代理以宿主注册表为准（与 list_agents 读同一 status 字段）；归属认运行时
// owner 与持久 session 血缘两条。事件计数不可用：subagent/start 的监听器只收到子代理
// 身份，父代理只作为 dispatch 接收者出现，拿不到它去归属。
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { monitorEvent } from "./monitor-log.js";

const OFF = "0";
const WRITE_ALLOW_ENV = "CASEOS_LEADER_WRITE_ALLOW";
const SLEEP_LIMIT_SECONDS = 30;
const SUMMARY_LIMIT = 200;
const PAUSE_TEXT = "请结束本回合等回执，回执会自动唤醒本会话；不要用 sleep/循环等待";
const REPEAT_REASON = "本回合已查过状态；请结束回合等回执";
const SLEEP_UNITS = new Map([["s", 1], ["m", 60], ["h", 3600], ["d", 86400]]);
const GIT_MUTATIONS = new Set(["commit", "push", "merge", "rebase", "cherry-pick", "restore", "stash"]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const WRAPPERS = new Set(["sudo", "time", "nohup", "command", "exec", "env"]);
const WHITELIST_TEXT = [".project-map.md", "路径含 /reports/", "~/.dsh/AGENTS.md"];

function argsOf(exec) {
  try {
    return exec?.arguments ?? {};
  } catch {
    return {};
  }
}

// 领导 = 根会话 agent（口径同 leader-scope.js）：子代理的 header 带 origin=subagent
// 或 parentSession。header 缺失时按领导处理——门禁宁严不松。
function isLeaderAgent(agent) {
  try {
    const header = agent?.session?.header;
    if (header === undefined) return agent?.session !== undefined;
    return header.origin !== "subagent" && header.parentSession === undefined;
  } catch {
    return false;
  }
}

// 运行中的子代理以宿主注册表为准（status 与 list_agents 读同一字段）；归属用运行时
// owner 与持久 session 血缘两条都认——恢复的会话里子代理未必还有 owner。事件计数不可用：
// subagent/start 的监听器只收到子代理身份，父代理只作为 dispatch 接收者出现，拿不到归属。
function runningChildCount(agents, leader) {
  if (agents === undefined || typeof agents.list !== "function") return 0;
  const leaderSession = leader?.session?.header?.id;
  let count = 0;
  for (const candidate of agents.list()) {
    if (candidate === undefined || candidate === leader) continue;
    if (candidate.status !== "running") continue;
    const owned = agents.isOwnedBy?.(candidate.id, leader) === true;
    const lineage = leaderSession !== undefined && candidate.session?.header?.parentSession === leaderSession;
    if (owned || lineage) count += 1;
  }
  return count;
}

function expandHome(value) {
  return value.startsWith("~") ? join(homedir(), value.slice(1)) : value;
}

function sleepSecondsOf(command) {
  let total = 0;
  for (const match of String(command).matchAll(/\bsleep\b([^;&|\n]*)/g)) {
    for (const part of match[1].matchAll(/(\d+(?:\.\d+)?)([smhd])?/g)) {
      total += Number(part[1]) * (SLEEP_UNITS.get(part[2]) ?? 1);
    }
  }
  return total;
}

// 循环体里含 sleep 就是轮询等待。判定按 shell 形状走：循环关键字 → do → done，
// 只认落在这一段里的 sleep；循环之后的 sleep 交给时长规则，`grep "while ... do"`
// 这类引号里的字面量先剔除，不算循环。
function sleepsInLoop(command) {
  const text = String(command).replace(/"[^"]*"|'[^']*'/g, " ");
  const loop = /\b(?:while|until|for)\b/.exec(text);
  if (loop === null) return false;
  const doMatch = /\bdo\b/.exec(text.slice(loop.index + loop[0].length));
  if (doMatch === null) return false;
  const bodyStart = loop.index + loop[0].length + doMatch.index + doMatch[0].length;
  const done = text.slice(bodyStart).search(/\bdone\b/);
  const body = done === -1 ? text.slice(bodyStart) : text.slice(bodyStart, bodyStart + done);
  return /\bsleep\b/.test(body);
}

// 去掉 sleep、时长、; && | true 与引号后什么都不剩 = 纯等待命令。
function isPureSleep(command) {
  return (
    String(command)
      .replace(/\bsleep\b/g, " ")
      .replace(/\b\d+(?:\.\d+)?(?:[smhd])?\b/g, " ")
      .replace(/\btrue\b/g, " ")
      .replace(/[;&|]/g, " ")
      .replace(/["'`]/g, " ")
      .replace(/\s+/g, " ")
      .trim() === ""
  );
}

function segmentsOf(command) {
  return String(command)
    .split(/[\n;]|&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function commandTokens(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 0) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens.shift();
      continue;
    }
    if (WRAPPERS.has(tokens[0])) {
      tokens.shift();
      continue;
    }
    break;
  }
  return tokens;
}

function gitMutation(tokens) {
  if (tokens[0] !== "git") return false;
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    const flag = tokens[index];
    index += GIT_OPTIONS_WITH_VALUE.has(flag) ? 2 : 1;
  }
  const subcommand = tokens[index];
  if (subcommand === undefined) return false;
  if (GIT_MUTATIONS.has(subcommand)) return true;
  const rest = tokens.slice(index + 1);
  if (subcommand === "reset") return rest.includes("--hard");
  if (subcommand === "checkout") return rest.includes("--");
  return false;
}

function packageMutation(tokens) {
  if (tokens[0] !== "npm" && tokens[0] !== "pnpm") return false;
  return ["publish", "install", "add", "i"].includes(tokens[1]);
}

function inPlaceEdit(tokens, name) {
  if (tokens[0] !== name) return false;
  return tokens.slice(1).some((token) => token === "--in-place" || token.startsWith("--in-place=") || /^-[A-Za-z]*i/.test(token));
}

function recursiveRemove(tokens) {
  if (tokens[0] !== "rm") return false;
  return tokens.slice(1).some((token) => token === "--recursive" || /^-[A-Za-z]*[rR]/.test(token));
}

function isHarmlessRedirect(target) {
  const expanded = expandHome(target);
  if (expanded === "/dev/null" || expanded.startsWith("/dev/")) return true;
  const absolute = resolve(expanded);
  if (absolute.startsWith("/tmp/") || absolute.startsWith("/private/tmp/")) return true;
  return basename(absolute) === ".project-map.md";
}

// 引号里的 `>`（`--grep="a>b"`、node -e 的比较表达式）不是重定向：逐字符走、
// 跳过引号段，只收集真正在 shell 顶层出现的 `>` / `>>` 目标。
function redirectTargets(command) {
  const text = String(command);
  const targets = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const end = text.indexOf(char, index + 1);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    if (char === "<") {
      index += 1;
      while (index < text.length && (text[index] === "&" || text[index] === " ")) index += 1;
      while (index < text.length && !/[\s;&|<>]/.test(text[index])) index += 1;
      continue;
    }
    if (char !== ">") {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    if (text[cursor] === ">") cursor += 1;
    if (text[cursor] === "|") cursor += 1; // >| 是 noclobber 覆盖写，仍写目标文件
    while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
    if (text[cursor] === "&") {
      // >&2 / >&1：复制文件描述符，不写文件
      index = cursor + 1;
      continue;
    }
    const start = cursor;
    if (text[cursor] === '"' || text[cursor] === "'") {
      const quote = text[cursor];
      const end = text.indexOf(quote, cursor + 1);
      const stop = end === -1 ? text.length : end;
      targets.push(text.slice(cursor + 1, stop));
      index = stop + 1;
      continue;
    }
    while (cursor < text.length && !/[\s;&|<>]/.test(text[cursor])) cursor += 1;
    if (cursor > start) targets.push(text.slice(start, cursor));
    index = cursor;
  }
  return targets;
}

function redirectRule(command) {
  return redirectTargets(command).some((target) => !isHarmlessRedirect(target)) ? "workspace-redirect" : undefined;
}

// 只读核验（git status/diff/log、ls、wc、测试、node/pnpm 跑脚本）不命中任何规则。
function bashMutationRule(command) {
  for (const segment of segmentsOf(command)) {
    const tokens = commandTokens(segment);
    if (gitMutation(tokens)) return "git-mutation";
    if (packageMutation(tokens)) return "package-mutation";
    if (inPlaceEdit(tokens, "sed") || inPlaceEdit(tokens, "perl")) return "in-place-edit";
    if (recursiveRemove(tokens)) return "recursive-remove";
  }
  return redirectRule(command);
}

function configuredWritePrefixes() {
  const raw = process.env[WRITE_ALLOW_ENV] ?? "";
  return raw
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(expandHome(entry)));
}

function allowsWrite(rawPath, policy) {
  if (typeof rawPath !== "string" || rawPath === "") return false;
  const target = resolve(expandHome(rawPath));
  if (basename(target) === ".project-map.md") return true;
  if (target.includes("/reports/")) return true;
  if (policy.agentInstructions.has(target)) return true;
  return policy.writePrefixes.some((prefix) => target === prefix || target.startsWith(`${prefix}/`));
}

const plugin = {
  inject: ["tools", "agents", "profileContext"],
  apply(ctx) {
    if (process.env.CASEOS_LEADER_GUARD === OFF) {
      process.stderr.write("leader-guard: 已由 CASEOS_LEADER_GUARD=0 关闭\n");
      return;
    }
    const home = ctx.profileContext?.home ?? process.env.DSH_HOME ?? `${homedir()}/.dsh`;
    // 白名单写的是 ~/.dsh/AGENTS.md；profile home 可能是别的目录（DSH_HOME、面板 profile），
    // 两处指向同一份会话规范，所以两个落点都认。
    const policy = {
      agentInstructions: new Set([resolve(join(home, "AGENTS.md")), resolve(homedir(), ".dsh", "AGENTS.md")]),
      writePrefixes: configuredWritePrefixes(),
    };
    const writeReason =
      `领导不亲自改码：请派执行子代理（subagent）完成；白名单：${[...WHITELIST_TEXT, ...policy.writePrefixes].join("、")}`;
    const turns = new WeakMap();
    const lastListTurn = new WeakMap();
    // 回合边界 = 领导会话自己的 turn/start：用户消息与回执唤醒都会开新回合，
    // 运行中子代理开停不会（否则中途派遣会把限流白白重置）。
    ctx.on("session/event", (session, event) => {
      if (event?.type !== "turn/start") return;
      turns.set(session, event.data?.turn ?? (turns.get(session) ?? 0) + 1);
    });
    const deny = (exec, rule, reason, summary) => {
      monitorEvent(home, {
        kind: "leader-guard-deny",
        gate: "leader-guard",
        rule,
        tool: exec.name,
        session: exec.agent?.session?.header?.id,
        summary: String(summary ?? "").slice(0, SUMMARY_LIMIT),
      });
      return reason;
    };
    // 服务从活上下文现取（面板改配置会重跑 apply，apply 闭包里的旧作用域会失活）。
    const liveAgents = (exec) => {
      try {
        return exec?.agent?.ctx?.agents ?? ctx.agents;
      } catch {
        return ctx.agents;
      }
    };
    ctx.tools.guard((exec) => {
      if (!isLeaderAgent(exec?.agent)) return undefined;
      const args = argsOf(exec);
      if (exec.name === "list_agents") {
        const session = exec.agent.session;
        const turn = turns.get(session) ?? 0;
        if (lastListTurn.get(session) === turn) return deny(exec, "list-agents-repeat", REPEAT_REASON, "list_agents");
        lastListTurn.set(session, turn);
        return undefined;
      }
      if (exec.name === "edit" || exec.name === "write") {
        const path = args.file_path ?? args.path ?? args.file;
        if (allowsWrite(path, policy)) return undefined;
        return deny(exec, "write-whitelist", writeReason, String(path ?? "(无路径)"));
      }
      if (exec.name !== "bash") return undefined;
      const command = typeof args.command === "string" ? args.command : "";
      const mutation = bashMutationRule(command);
      if (mutation !== undefined) return deny(exec, mutation, writeReason, command);
      const running = runningChildCount(liveAgents(exec), exec.agent);
      if (running === 0) return undefined;
      const pauseReason = `有子代理在运行（${running} 个）：${PAUSE_TEXT}`;
      if (sleepsInLoop(command)) return deny(exec, "sleep-in-loop", pauseReason, command);
      if (sleepSecondsOf(command) > SLEEP_LIMIT_SECONDS) return deny(exec, "sleep-long", pauseReason, command);
      if (args.run_in_background === true && isPureSleep(command)) {
        return deny(exec, "sleep-background", pauseReason, command);
      }
      return undefined;
    });
  },
};

export default plugin;
