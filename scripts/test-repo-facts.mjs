#!/usr/bin/env node
// repo-facts 行为测试：纯 node、无依赖，全部用本地临时仓（bare 当 origin），不碰真实远端与真实仓。
// 覆盖：defaultBranch 的 origin/HEAD 主路径与 main/master 回退、无 origin；fetchOrigin 成功后
// originHead 前进、无 remote、指向不存在路径（返回对象不含路径原文）；migrationMax 数值比较、
// 多目录字典序与 5 项截断；worktreeList 截断与失败空串。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBranch, fetchOrigin, originHead, migrationMax, worktreeList } from "../gates/repo-facts.js";

const GIT_CONFIG = ["-c", "user.email=gate@test", "-c", "user.name=gate", "-c", "core.hooksPath=/dev/null"];
const roots = [];
let commitSeq = 0;

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...GIT_CONFIG, ...args], { encoding: "utf8" }).trim();
}

function commitFile(cwd, name) {
  mkdirSync(join(cwd, name, ".."), { recursive: true });
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, ["add", "--", name]);
  commitSeq += 1;
  const message = join(cwd, ".git", `msg-${commitSeq}`);
  writeFileSync(message, `add ${name}\n`);
  git(cwd, ["commit", "-q", "-F", message, "--", name]);
}

// 夹具：bare 仓当 origin，donor 推种子提交后再 clone，origin/HEAD 由 clone 正常建立。
function makeFixture(branch) {
  const root = mkdtempSync(join(tmpdir(), `repo-facts-${branch}-`));
  roots.push(root);
  const bare = join(root, "origin.git");
  git(root, ["init", "-q", "--bare", "-b", branch, bare]);
  const donor = join(root, "donor");
  git(root, ["init", "-q", "-b", branch, donor]);
  commitFile(donor, "seed.md");
  git(donor, ["push", "-q", bare, branch]);
  const work = join(root, "work");
  git(root, ["clone", "-q", bare, work]);
  return { root, bare, work };
}

function makePlain() {
  const plain = mkdtempSync(join(tmpdir(), "repo-facts-plain-"));
  roots.push(plain);
  git(plain, ["init", "-q", "-b", "main", "."]);
  commitFile(plain, "a.md");
  return plain;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("defaultBranch：origin/HEAD 主路径、main/master 回退、无 origin 为 undefined", () => {
  const { work } = makeFixture("main");
  assert.equal(defaultBranch(work), "main");
  git(work, ["update-ref", "--no-deref", "-d", "refs/remotes/origin/HEAD"]);
  assert.equal(defaultBranch(work), "main", "无 origin/HEAD 时应回退 origin/main");
  const master = makeFixture("master");
  git(master.work, ["update-ref", "--no-deref", "-d", "refs/remotes/origin/HEAD"]);
  assert.equal(defaultBranch(master.work), "master", "无 origin/HEAD 时应回退 origin/master");
  const plain = makePlain();
  assert.equal(defaultBranch(plain), void 0);
  assert.equal(originHead(plain), void 0);
});

test("fetchOrigin 成功后 originHead 前进到第二个 clone 推的新提交", () => {
  const { root, bare, work } = makeFixture("main");
  const before = originHead(work);
  assert.ok(before, "clone 后 originHead 必须可取");
  assert.equal(before.branch, "main");
  assert.match(before.sha, /^[0-9a-f]{40}$/);
  const work2 = join(root, "work2");
  git(root, ["clone", "-q", bare, work2]);
  commitFile(work2, "advance.md");
  git(work2, ["push", "-q", "origin", "main"]);
  assert.equal(originHead(work).sha, before.sha, "未 fetch 前不得前进");
  assert.deepEqual(fetchOrigin(work), { ok: true });
  assert.equal(originHead(work).sha, originHead(work2).sha);
  assert.notEqual(originHead(work).sha, before.sha);
});

test("fetchOrigin：无 remote 返回 no-remote，不存在路径返回 failed 且不带路径原文", () => {
  const plain = makePlain();
  assert.deepEqual(fetchOrigin(plain), { ok: false, reason: "no-remote" });
  const { root, work } = makeFixture("main");
  const missing = join(root, "missing-origin.git");
  git(work, ["remote", "set-url", "origin", missing]);
  const result = fetchOrigin(work);
  assert.deepEqual(result, { ok: false, reason: "failed" });
  assert.equal(JSON.stringify(result).includes(missing), false, "返回对象不得携带路径原文");
});

test("migrationMax：数值比较 9/10、嵌套目录不误判、多目录字典序、最多 5 项", () => {
  const { work } = makeFixture("main");
  for (const name of [
    "backend/migrations/9_a.sql",
    "backend/migrations/10_b.sql",
    "backend/migrations/readme.md",
    "alembic/versions/0002_x.py",
    "alembic/versions/0001_y.py",
    "app/migrations/versions/nested.sql",
    "docs/notes.md",
  ]) commitFile(work, name);
  assert.deepEqual(migrationMax(work, "HEAD"), [
    { dir: "alembic/versions", max: 2, count: 2 },
    { dir: "backend/migrations", max: 10, count: 2 },
  ]);
  const dirs = ["a/migrations", "b/migrations", "c/migrations", "d/migrations", "e/migrations", "f/migrations"];
  dirs.forEach((dir, i) => commitFile(work, `${dir}/${i + 1}_init.sql`));
  const capped = migrationMax(work, "HEAD");
  assert.equal(capped.length, 5);
  assert.deepEqual(capped.map((row) => row.dir), [
    "a/migrations",
    "alembic/versions",
    "b/migrations",
    "backend/migrations",
    "c/migrations",
  ]);
  assert.deepEqual(migrationMax(makePlain(), "HEAD"), []);
});

test("worktreeList：原文、截断追加行数、失败返回空串", () => {
  const { root, work } = makeFixture("main");
  git(work, ["worktree", "add", "-q", "-b", "wt1", join(root, "wt1")]);
  const full = worktreeList(work);
  assert.equal(full.split("\n").length, 2);
  assert.equal(full.includes("…（另有"), false);
  assert.equal(worktreeList(work, 1), `${full.split("\n")[0]}\n…（另有 1 行）`);
  const nonRepo = mkdtempSync(join(tmpdir(), "repo-facts-nongit-"));
  roots.push(nonRepo);
  assert.equal(worktreeList(nonRepo), "");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(String(error?.stack ?? error).split("\n").slice(0, 6).join("\n"));
  }
}
console.log(`repo-facts: ${tests.length - failed}/${tests.length} passed`);
for (const root of roots) rmSync(root, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
