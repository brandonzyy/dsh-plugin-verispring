// 提交门禁：bash 调用里 git 的子命令为 commit 时，必须先读过 ~/.dsh/specs/代码写作规范.md
// （按主目录解析）。判定"已读"：read/bash 结果内容里出现规范唯一首行标记（"# 代码写作规范"），
// 或调用参数路径指向该文件。状态按会话隔离（WeakMap<session>）。
// 设计同 dispatch-gate：拒绝必须可满足（先拒、指路、重试放行）。
// exec 的参数字段是 arguments（实测：keys=[token,callId,rootCallId,name,signal,agent,
// deferContext,concludeTurn,arguments]），bash 命令在 exec.arguments.command。
const MARKER = "# 代码写作规范";
const SPEC_FRAGMENT = "specs/代码写作规范.md";

import { homedir } from "node:os";

const SPEC_PATH = `${homedir()}/.dsh/specs/代码写作规范.md`;
const DENY_REASON =
  `提交代码前必读 ${SPEC_PATH}：先用 read 工具读取该规范，然后重新发起本次 git commit。`;

// git 的全局选项：-c/-C 类带一个值令牌，其余旗标单令牌。子命令判定必须跳过它们，
// 否则 `git -C commit status`（目录名恰为 commit）会把选项值误判成子命令。
const GIT_OPTS_WITH_VALUE = new Set(["-c", "-C", "--exec-path", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);

// 复合命令按 shell 分隔符切段后逐段判定；bash -c 的内层命令递归。
function isGitCommitCommand(command) {
  for (const segment of String(command).split(/(?:&&|\|\||;|\n|\(|\))/)) {
    const tokens = segment.trim().replace(/^[('"` ]+/, "").split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (i >= tokens.length) continue;
    if (tokens[i] === "bash" || tokens[i] === "sh") {
      const joined = tokens.slice(i).join(" ");
      const inner = /-c\s+(.+)$/s.exec(joined);
      if (inner && isGitCommitCommand(inner[1].replace(/^['"]|['"]$/g, ""))) return true;
      continue;
    }
    if (tokens[i] !== "git") continue;
    i++;
    while (i < tokens.length) {
      const t = tokens[i];
      if (GIT_OPTS_WITH_VALUE.has(t)) { i += 2; continue; }
      if (t.startsWith("-")) { i++; continue; }
      break;
    }
    if (tokens[i] === "commit") return true;
  }
  return false;
}

function pathMatches(value) {
  if (typeof value !== "string") return false;
  const expanded = value.startsWith("~/") ? homedir() + value.slice(1) : value;
  return expanded.includes(SPEC_FRAGMENT);
}

const plugin = {
  inject: ["tools"],
  apply(ctx) {
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
      if (text.includes(MARKER) || pathMatches(pathArg)) {
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
      if (readSessions.get(exec.agent?.session)) return undefined;
      return DENY_REASON;
    });
  },
};

export default plugin;
