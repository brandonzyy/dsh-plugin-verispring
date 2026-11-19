// 可机读的 git 事实（地图新鲜度闸、测绘转交共用）：全部由工作区的真实 git 输出计算，模型
// 不得凭记忆填写。失败口径同 dispatch-gate 的 gitHead/gitOutput：取不到即 undefined / "" / []，
// 绝不抛出。fetch 的 reason 只用枚举——stderr 与远端 URL 可能内嵌令牌，一律不出本模块。
import { execFileSync } from "node:child_process";

const GIT_TIMEOUT_MS = 3000;
const FETCH_TIMEOUT_MS = 8000;
const LS_TREE_MAX_BUFFER = 32 * 1024 * 1024;
const MIGRATION_DIR = /(^|\/)(migrations|alembic\/versions)$/;
const MIGRATION_MAX_ROWS = 5;

function gitOptions(cwd, timeoutMs) {
  return {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: LS_TREE_MAX_BUFFER,
  };
}

function gitOutput(cwd, args, timeoutMs = GIT_TIMEOUT_MS) {
  try {
    return execFileSync("git", args, gitOptions(cwd, timeoutMs)).trim();
  } catch {}
  return void 0;
}

function defaultBranch(cwd) {
  const symbolic = gitOutput(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const branch = symbolic === void 0 ? "" : symbolic.replace(/^origin\//, "");
  if (branch) return branch;
  for (const candidate of ["main", "master"]) {
    if (gitOutput(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]) !== void 0) {
      return candidate;
    }
  }
  return void 0;
}

function fetchOrigin(cwd, timeoutMs = FETCH_TIMEOUT_MS) {
  if (gitOutput(cwd, ["remote", "get-url", "origin"]) === void 0) return { ok: false, reason: "no-remote" };
  try {
    execFileSync("git", ["fetch", "--quiet", "origin"], gitOptions(cwd, timeoutMs));
    return { ok: true };
  } catch (error) {
    const timedOut = error?.killed === true || error?.code === "ETIMEDOUT";
    return { ok: false, reason: timedOut ? "timeout" : "failed" };
  }
}

function originHead(cwd) {
  const branch = defaultBranch(cwd);
  if (branch === void 0) return void 0;
  const sha = gitOutput(cwd, ["rev-parse", `refs/remotes/origin/${branch}`]);
  if (sha === void 0 || /^[0-9a-f]{40}$/.test(sha) === false) return void 0;
  return { branch, sha };
}

function migrationMax(cwd, ref) {
  const listing = gitOutput(cwd, ["ls-tree", "-r", "--name-only", ref]);
  if (listing === void 0) return [];
  const rows = new Map();
  for (const path of listing.split("\n")) {
    const split = path.lastIndexOf("/");
    const dir = split === -1 ? "" : path.slice(0, split);
    if (MIGRATION_DIR.test(dir) === false) continue;
    const numeric = /^\d+/.exec(path.slice(split + 1));
    if (numeric === null) continue;
    const row = rows.get(dir) ?? { dir, max: 0, count: 0 };
    const number = Number(numeric[0]);
    if (number > row.max) row.max = number;
    row.count += 1;
    rows.set(dir, row);
  }
  return [...rows.values()]
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
    .slice(0, MIGRATION_MAX_ROWS);
}

function worktreeList(cwd, maxLines = 40) {
  const text = gitOutput(cwd, ["worktree", "list"]);
  if (text === void 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join("\n")}\n…（另有 ${lines.length - maxLines} 行）`;
}

export { defaultBranch, fetchOrigin, originHead, migrationMax, worktreeList };
