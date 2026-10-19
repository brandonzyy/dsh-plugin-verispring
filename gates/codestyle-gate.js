// 提交门禁：bash 调用里 git 的子命令为 commit 时，必须先读过 ~/.dsh/specs/代码写作规范.md
// （按主目录解析）。判定"已读"：read/bash 结果内容里出现规范唯一首行标记（"# 代码写作规范"），
// 或调用参数路径指向该文件。状态按会话隔离（WeakMap<session>）。
// 设计同 dispatch-gate：拒绝必须可满足（先拒、指路、重试放行）。
// exec 的参数字段是 arguments（实测：keys=[token,callId,rootCallId,name,signal,agent,
// deferContext,concludeTurn,arguments]），bash 命令在 exec.arguments.command。
const MARKER = "# 代码写作规范";
const SPEC_FRAGMENT = "specs/代码写作规范.md";

import { homedir } from "node:os";
import { monitorEvent } from "./monitor-log.js";
const SHAPE_REASON =
  "提交门禁要求使用 `git commit -F <提交信息文件> -- <显式路径...>`；禁止 -a/-am、-m 或省略显式路径。";

// git 的全局选项：-c/-C 类带一个值令牌，其余旗标单令牌。子命令判定必须跳过它们，
// 否则 `git -C commit status`（目录名恰为 commit）会把选项值误判成子命令。
const GIT_OPTS_WITH_VALUE = new Set(["-c", "-C", "--exec-path", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);

// 常见包装命令：`timeout 1500 git commit`、`env FOO=1 git commit` 这类必须穿透到内层 git，
// 否则提交门禁对它们完全失明（实测 caseos 里执行者就用 timeout 给 commit 兜底）。
const COMMIT_WRAPPERS = new Set(["timeout", "nice", "env", "nohup", "stdbuf", "command", "time"]);
const WRAPPER_FLAGS_WITH_VALUE = new Set(["-u", "-S", "-n", "--adjustment", "-k", "--kill-after", "-s", "--signal"]);

// 跳过 git 之前的包装命令及其参数，返回可能是 git 的下标。
function skipWrapperTokens(tokens, i) {
  while (i < tokens.length && COMMIT_WRAPPERS.has(tokens[i])) {
    const wrapper = tokens[i];
    i++;
    let durationConsumed = false;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.startsWith("-")) {
        const flagTakesValue = WRAPPER_FLAGS_WITH_VALUE.has(t) &&
          i + 1 < tokens.length && tokens[i + 1] !== "git" && !COMMIT_WRAPPERS.has(tokens[i + 1]);
        i += flagTakesValue ? 2 : 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
      // timeout 的时长只消费一个裸令牌，否则 `timeout 1500 bash -c "git commit…"` 会把 bash 吞掉
      if (wrapper === "timeout" && !durationConsumed && t !== "git" && !COMMIT_WRAPPERS.has(t)) {
        durationConsumed = true;
        i++;
        continue;
      }
      break;
    }
  }
  return i;
}

function nextGitIndex(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  return skipWrapperTokens(tokens, i);
}

// 复合命令按 shell 分隔符切段后逐段判定；bash -c 的内层命令递归。
function isGitCommitCommand(command) {
  for (const segment of String(command).split(/(?:&&|\|\||;|\n|\(|\))/)) {
    const tokens = segment.trim().replace(/^[('"` ]+/, "").split(/\s+/).filter(Boolean);
    const i = nextGitIndex(tokens);
    if (i >= tokens.length) continue;
    if (tokens[i] === "bash" || tokens[i] === "sh") {
      const joined = tokens.slice(i).join(" ");
      const inner = /-c\s+(.+)$/s.exec(joined);
      if (inner && isGitCommitCommand(inner[1].replace(/^['"]|['"]$/g, ""))) return true;
      continue;
    }
    if (tokens[i] !== "git") continue;
    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j];
      if (GIT_OPTS_WITH_VALUE.has(t)) { j += 2; continue; }
      if (t.startsWith("-")) { j++; continue; }
      break;
    }
    if (tokens[j] === "bash" || tokens[j] === "sh") {
      const inner = /-c\s+(.+)$/s.exec(tokens.slice(j).join(" "));
      if (inner) return hasSafeCommitShape(inner[1].replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (tokens[j] === "commit") return true;
  }
  return false;
}

function hasSafeCommitShape(command) {
  for (const segment of String(command).split(/(?:&&|\|\||;|\n|\(|\))/)) {
    const tokens = segment.trim().replace(/^[('"` ]+/, "").split(/\s+/).filter(Boolean);
    const i = nextGitIndex(tokens);
    if (tokens[i] !== "git") continue;
    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j];
      if (GIT_OPTS_WITH_VALUE.has(t)) { j += 2; continue; }
      if (t.startsWith("-")) { j++; continue; }
      break;
    }
    if (tokens[j] !== "commit") continue;
    const args = tokens.slice(j + 1);
    const separator = args.indexOf("--");
    const messageIndex = args.findIndex((token) => token === "-F" || token === "--file");
    return separator >= 0 && messageIndex >= 0 && messageIndex + 1 < separator && separator + 1 < args.length &&
      !args.slice(0, separator).some((token) => token === "-a" || token === "--all" || token === "-am" || token === "-m" || token.startsWith("-m"));
  }
  return true;
}

function pathMatches(value, dshHome) {
  if (typeof value !== "string") return false;
  const expanded = value.startsWith("~/") ? dshHome + value.slice(1) : value;
  return expanded.includes(SPEC_FRAGMENT);
}

const plugin = {
  inject: ["tools", "profileContext"],
  apply(ctx) {
    const dshHome = ctx.profileContext?.home ?? process.env.DSH_HOME ?? `${homedir()}/.dsh`;
    const specPath = `${dshHome}/specs/代码写作规范.md`;
    const denyReason =
      `提交代码前必读 ${specPath}：先用 read 工具读取该规范，然后重新发起本次 git commit。`;
    const readSessions = new WeakMap();
    ctx.on("tools/result", (exec, result) => {
      if (!exec || result?.isError) return;
      if (exec.name !== "read" && exec.name !== "bash") return;
      const session = exec.agent?.session;
      const text = (result?.content ?? []).map((block) => block?.text ?? "").join("\n");
      let pathArg;
      try {
        pathArg = exec.arguments?.path ?? exec.arguments?.file;
      } catch {}
      if (text.includes(MARKER) || pathMatches(pathArg, dshHome)) {
        readSessions.set(session, true);
      }
    });
    ctx.tools.guard((exec) => {
      if (exec.name !== "bash") return undefined;
      let command = "";
      try {
        command = typeof exec.arguments?.command === "string" ? exec.arguments.command : "";
      } catch {}
      if (!isGitCommitCommand(command)) return undefined;
      const deny = (reason) => {
        monitorEvent(dshHome, {
          kind: "gate-deny",
          gate: "codestyle",
          tool: exec.name,
          session: exec.agent?.session?.header?.id,
          reason: reason.slice(0, 160),
        });
        return reason;
      };
      if (!hasSafeCommitShape(command)) return deny(SHAPE_REASON);
      if (readSessions.get(exec.agent?.session)) return undefined;
      return deny(denyReason);
    });
  },
};

export { isGitCommitCommand, hasSafeCommitShape };

export default plugin;
