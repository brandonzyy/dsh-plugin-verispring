#!/usr/bin/env node
// leader-guard 行为测试：纯 node、无依赖。宿主工具面用 mock ctx 注入
// （tools.guard 收集守卫、agents 注册表提供运行中子代理、on 收集 session/event 与
// tools/post-execute）。两组不变量：
// - 拒绝类：有子代理运行时的 sleep/循环等待、同回合第二次 list_agents 被拒；
// - 提示类（v1.3.66）：edit/write 越白名单与 bash 变更命令不再拒绝，调用照常执行，结果后
//   追加一段提示（additionalContexts），同一回合只提示一次，落 monitor leader-write-hint。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "leader-guard-"));
process.env.DSH_HOME = home;
delete process.env.CASEOS_LEADER_GUARD;
delete process.env.CASEOS_LEADER_WRITE_ALLOW;

const { default: plugin } = await import("../gates/leader-guard.js");

const leader = { id: "leader-1", status: "running", session: { header: { id: "leader-1" } } };
const child = { id: "child-1", status: "running", session: { header: { id: "child-1", origin: "subagent", parentSession: "leader-1" } } };

function createHarness(children) {
  const listeners = new Map();
  let guard;
  const ctx = {
    profileContext: { home },
    tools: { guard: (fn) => { guard = fn; return () => {}; } },
    agents: {
      list: () => [leader, ...children],
      isOwnedBy: (id, owner) => owner === leader && children.some((candidate) => candidate.id === id),
    },
    on: (name, listener) => {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => {};
    },
  };
  plugin.apply(ctx);
  return {
    guard,
    turn(session, turn) {
      for (const listener of listeners.get("session/event") ?? []) listener(session, { type: "turn/start", data: { turn } });
    },
    call(name, args, agent = leader) {
      if (guard === undefined) return undefined;
      return guard({ name, arguments: args, agent });
    },
    /** 跑一遍宿主 tools/post-execute 瀑布：返回最终决定（含 additionalContexts） */
    async post(name, args, agent = leader, upstream = { kind: "accept" }) {
      const handler = (listeners.get("tools/post-execute") ?? [])[0];
      if (handler === undefined) return upstream;
      return await handler({ name, arguments: args, agent }, { isError: false }, async () => upstream);
    },
  };
}

const running = () => createHarness([child]);
const idle = () => createHarness([]);
const sleep = (seconds) => ({ command: `sleep ${seconds}` });

const results = [];
const checks = [];
function check(label, fn) {
  checks.push({ label, fn });
}
// 用例逐条 await（提示路径是 tools/post-execute 的 async 瀑布，顺序也要可复现）。
async function runChecks() {
  for (const { label, fn } of checks) {
    try {
      await fn();
      results.push(`  ok   ${label}`);
    } catch (error) {
      results.push(`  FAIL ${label}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
const denyWith = (reason, fragment) => {
  assert.equal(typeof reason, "string", `期望拒绝，实际放行：${fragment}`);
  assert.ok(reason.includes(fragment), `拒绝文案缺「${fragment}」：${reason}`);
};
const allow = (reason, label) => assert.equal(reason, undefined, `期望放行，实际被拒（${label}）：${reason}`);

check("有子代理运行时 sleep 600 被拒", () => {
  const harness = running();
  denyWith(harness.call("bash", sleep(600)), "有子代理在运行（1 个）");
});
check("sleep 10 放行（有子代理运行）", () => allow(running().call("bash", sleep(10)), "sleep 10"));
check("sleep 30 边界放行", () => allow(running().call("bash", sleep(30)), "sleep 30"));
check("sleep 5m 按单位换算被拒", () => denyWith(running().call("bash", { command: "sleep 5m" }), "有子代理在运行"));
check("同一条命令多个 sleep 累加被拒", () => {
  denyWith(running().call("bash", { command: "sleep 20 && sleep 20" }), "有子代理在运行");
});
check("无子代理运行时 sleep 600 放行", () => allow(idle().call("bash", sleep(600)), "sleep 600"));
check("while true; do …; sleep 5; done 被拒", () => {
  denyWith(running().call("bash", { command: "while true; do date; sleep 5; done" }), "有子代理在运行");
});
check("for 循环体里 sleep 被拒", () => {
  denyWith(running().call("bash", { command: "for i in 1 2 3; do echo $i; sleep 5; done" }), "有子代理在运行");
});
check("纯 sleep 配 run_in_background 被拒", () => {
  denyWith(running().call("bash", { command: "sleep 5", run_in_background: true }), "有子代理在运行");
});
check("sleep 5 前台放行", () => allow(running().call("bash", { command: "sleep 5" }), "前台 sleep 5"));
check("同回合第二次 list_agents 被拒，跨回合放行", () => {
  const harness = running();
  harness.turn(leader.session, 1);
  allow(harness.call("list_agents", {}), "本回合第一次");
  denyWith(harness.call("list_agents", {}), "本回合已查过状态；请结束回合等回执");
  harness.turn(leader.session, 2);
  allow(harness.call("list_agents", {}), "下一回合第一次");
});
check("write 到 .project-map.md 不提示", async () => {
  allow(running().call("write", { file_path: join(home, "repo", ".project-map.md"), content: "x" }), ".project-map.md");
  const decision = await running().post("write", { file_path: join(home, "repo", ".project-map.md"), content: "x" });
  assert.equal(decision.additionalContexts, void 0, "白名单内的写入不该有提示");
});
check("write 到 /reports/ 不提示、到 ~/.dsh/AGENTS.md 不提示", async () => {
  allow(running().call("write", { file_path: join(home, "repo", "reports", "a.md"), content: "x" }), "/reports/");
  allow(running().call("write", { file_path: "~/.dsh/AGENTS.md", content: "x" }), "~/.dsh/AGENTS.md");
  for (const file_path of [join(home, "repo", "reports", "a.md"), "~/.dsh/AGENTS.md"]) {
    const decision = await running().post("write", { file_path, content: "x" });
    assert.equal(decision.additionalContexts, void 0, `${file_path} 白名单内不该提示`);
  }
});
check("写 gates/x.js 不再拒绝，改为结果后的提示（含规则名与文案）", async () => {
  const harness = running();
  const args = { file_path: join(home, "repo", "gates", "x.js"), old_string: "a", new_string: "b" };
  allow(harness.call("edit", args), "写 gates/x.js 应放行");
  const decision = await harness.post("edit", args);
  assert.equal(decision.kind, "accept", "提示是非阻断的：决定仍是 accept");
  const [hint] = decision.additionalContexts ?? [];
  assert.ok(hint, "越白名单写入必须追加提示");
  assert.equal(hint.role, "user");
  assert.equal(hint.source.kind, "verispring-leader-write-hint");
  assert.equal(hint.source.summary, "write-whitelist");
  assert.match(hint.content[0].text, /提示：有明确边界的代码和写作任务，请交给执行子代理（subagent）/);
  assert.match(hint.content[0].text, /小修正、地图、报告和验收所需的写入/);
});
check("CASEOS_LEADER_WRITE_ALLOW 前缀不提示，前缀之外提示", async () => {
  const previous = process.env.CASEOS_LEADER_WRITE_ALLOW;
  process.env.CASEOS_LEADER_WRITE_ALLOW = join(home, "repo", "notes");
  try {
    const harness = running();
    allow(harness.call("write", { file_path: join(home, "repo", "notes", "a.md"), content: "x" }), "白名单前缀");
    const inside = await harness.post("write", { file_path: join(home, "repo", "notes", "a.md"), content: "x" });
    assert.equal(inside.additionalContexts, void 0, "白名单前缀内不该提示");
    allow(harness.call("write", { file_path: join(home, "repo", "notes2", "a.md"), content: "x" }), "前缀之外放行");
    const outside = await harness.post("write", { file_path: join(home, "repo", "notes2", "a.md"), content: "x" });
    assert.ok(outside.additionalContexts?.length, "前缀之外应提示");
  } finally {
    if (previous === undefined) delete process.env.CASEOS_LEADER_WRITE_ALLOW;
    else process.env.CASEOS_LEADER_WRITE_ALLOW = previous;
  }
});
check("git 变更命令不再拒绝，只读命令不提示", async () => {
  for (const command of [
    "git commit -F /tmp/msg -- gates/a.js",
    "git -C /repo push origin main",
    "git reset --hard HEAD~1",
  ]) {
    const harness = running();
    allow(harness.call("bash", { command }), command);
    const decision = await harness.post("bash", { command });
    assert.equal(decision.additionalContexts?.[0]?.source.summary, "git-mutation", `git 变更应提示：${command}`);
  }
  for (const command of ["git diff --stat 3e44ecf", "git status --short && git log --oneline -1"]) {
    const harness = running();
    allow(harness.call("bash", { command }), command);
    const decision = await harness.post("bash", { command });
    assert.equal(decision.additionalContexts, void 0, `只读命令不该提示：${command}`);
  }
});
check("git stash list/show 不提示，其余 stash 子命令提示", async () => {
  for (const command of ["git stash list", "git stash show -p stash@{0}", "git -C /repo stash list"]) {
    allow(running().call("bash", { command }), command);
    assert.equal((await running().post("bash", { command })).additionalContexts, void 0, `只读 stash 不该提示：${command}`);
  }
  for (const command of [
    "git stash",
    "git stash push -m wip",
    "git stash pop",
    "git stash apply stash@{0}",
    "git stash drop stash@{0}",
    "git stash clear",
  ]) {
    const harness = running();
    allow(harness.call("bash", { command }), command);
    assert.equal((await harness.post("bash", { command })).additionalContexts?.[0]?.source.summary, "git-mutation", command);
  }
});
check("sed -i / perl -i / rm -rf 不再拒绝，改为提示", async () => {
  const cases = [
    ["sed -i '' 's/a/b/' gates/x.js", "in-place-edit"],
    ["perl -pi -e 's/a/b/' gates/x.js", "in-place-edit"],
    ["rm -rf build", "recursive-remove"],
  ];
  for (const [command, rule] of cases) {
    const harness = running();
    allow(harness.call("bash", { command }), command);
    assert.equal((await harness.post("bash", { command })).additionalContexts?.[0]?.source.summary, rule, command);
  }
});
check("npm/pnpm publish 与 install 不再拒绝，改为提示", async () => {
  for (const command of ["npm publish", "pnpm install --frozen-lockfile"]) {
    const harness = running();
    allow(harness.call("bash", { command }), command);
    assert.equal((await harness.post("bash", { command })).additionalContexts?.[0]?.source.summary, "package-mutation", command);
  }
});
check("echo x > /tmp/a 与 > /dev/null 不提示，echo x > src/a.js 提示", async () => {
  for (const command of ["echo x > /tmp/a", "node scripts/test.mjs > /dev/null 2>&1"]) {
    allow(running().call("bash", { command }), command);
    assert.equal((await running().post("bash", { command })).additionalContexts, void 0, `无害重定向不该提示：${command}`);
  }
  for (const command of ["echo x > src/a.js", "echo x >> src/a.js"]) {
    const harness = running();
    allow(harness.call("bash", { command }), command);
    assert.equal((await harness.post("bash", { command })).additionalContexts?.[0]?.source.summary, "workspace-redirect", command);
  }
});
check("同一回合只提示一次，下一回合重新提示", async () => {
  const harness = running();
  harness.turn(leader.session, 1);
  const first = await harness.post("bash", { command: "git commit -F /tmp/m -- a.js" });
  assert.equal(first.additionalContexts?.length, 1, "本回合首次应提示");
  const second = await harness.post("write", { file_path: join(home, "repo", "gates", "y.js"), content: "x" });
  assert.equal(second.additionalContexts, void 0, "同一回合第二次不再提示");
  harness.turn(leader.session, 2);
  const next = await harness.post("write", { file_path: join(home, "repo", "gates", "y.js"), content: "x" });
  assert.equal(next.additionalContexts?.length, 1, "新回合重新提示");
});
check("只读核验命令照常放行且不提示", async () => {
  const harness = idle();
  for (const command of ["ls -la", "wc -l gates/leader-guard.js", "node --check gates/leader-guard.js", "pnpm smoke", "pnpm -s test"]) {
    allow(harness.call("bash", { command }), command);
    assert.equal((await harness.post("bash", { command })).additionalContexts, void 0, `只读命令不该提示：${command}`);
  }
});
check("子代理会话不受任何限制、也没有提示", async () => {
  const harness = running();
  harness.turn(child.session, 1);
  for (const [name, args] of [
    ["bash", sleep(600)],
    ["bash", { command: "while true; do sleep 5; done" }],
    ["bash", { command: "git commit -F /tmp/m -- a.js" }],
    ["bash", { command: "echo x > src/a.js" }],
    ["write", { file_path: join(home, "repo", "gates", "x.js"), content: "x" }],
    ["list_agents", {}],
    ["list_agents", {}],
  ]) {
    allow(harness.call(name, args, child), `${name} ${JSON.stringify(args)}`);
    const decision = await harness.post(name, args, child);
    assert.equal(decision.additionalContexts, void 0, `子代理不该收到领导提示：${name}`);
  }
});
check("CASEOS_LEADER_GUARD=0 时全部放行、无提示", async () => {
  process.env.CASEOS_LEADER_GUARD = "0";
  try {
    const harness = running();
    assert.equal(harness.guard, undefined, "关闭后不应注册守卫");
    for (const [name, args] of [
      ["bash", sleep(600)],
      ["bash", { command: "git commit -F /tmp/m -- a.js" }],
      ["write", { file_path: join(home, "repo", "gates", "x.js"), content: "x" }],
      ["list_agents", {}],
    ]) {
      allow(harness.call(name, args), `${name} ${JSON.stringify(args)}`);
      assert.equal((await harness.post(name, args)).additionalContexts, void 0, "关闭后不该有提示");
    }
  } finally {
    delete process.env.CASEOS_LEADER_GUARD;
  }
});
check("拒绝都记 leader-guard-deny（含规则名与截断摘要）", () => {
  const log = readFileSync(join(home, "verispring-monitor.jsonl"), "utf8");
  const records = log.trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.kind === "leader-guard-deny");
  assert.ok(records.length > 0, "没有 leader-guard-deny 记录");
  const rules = new Set(records.map((row) => row.rule));
  for (const rule of ["sleep-long", "sleep-in-loop", "sleep-background", "list-agents-repeat"]) {
    assert.ok(rules.has(rule), `缺少规则 ${rule} 的记录`);
  }
  assert.ok(
    !["write-whitelist", "git-mutation", "package-mutation", "in-place-edit", "recursive-remove", "workspace-redirect"]
      .some((rule) => rules.has(rule)),
    "写入与变更命令不该再记拒绝",
  );
  assert.ok(records.every((row) => typeof row.summary === "string" && row.summary.length <= 200), "摘要未截断到 200 字符");
});
check("提示都记 leader-write-hint（规则名 + 截断摘要）", () => {
  const log = readFileSync(join(home, "verispring-monitor.jsonl"), "utf8");
  const hints = log.trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.kind === "leader-write-hint");
  assert.ok(hints.length > 0, "没有 leader-write-hint 记录");
  const rules = new Set(hints.map((row) => row.rule));
  for (const rule of ["write-whitelist", "git-mutation", "package-mutation", "in-place-edit", "recursive-remove", "workspace-redirect"]) {
    assert.ok(rules.has(rule), `缺少规则 ${rule} 的提示记录`);
  }
  assert.ok(hints.every((row) => typeof row.summary === "string" && row.summary.length <= 200), "摘要未截断到 200 字符");
  assert.ok(hints.every((row) => row.gate === "leader-guard" && row.tool !== void 0), "提示记录应带 gate 与 tool");
});

await runChecks();
rmSync(home, { recursive: true, force: true });
console.log("test-leader-guard:");
for (const line of results) console.log(line);
const failed = results.filter((line) => line.includes("FAIL")).length;
console.log(`test-leader-guard: ${results.length - failed}/${results.length} passed`);
