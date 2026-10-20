#!/usr/bin/env node
// leader-guard 行为测试：纯 node、无依赖。宿主工具面用 mock ctx 注入
// （tools.guard 收集守卫、agents 注册表提供运行中子代理、on 收集 session/event）。
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
  };
}

const running = () => createHarness([child]);
const idle = () => createHarness([]);
const sleep = (seconds) => ({ command: `sleep ${seconds}` });

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push(`  ok   ${label}`);
  } catch (error) {
    results.push(`  FAIL ${label}: ${error.message}`);
    process.exitCode = 1;
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
check("write 到 .project-map.md 放行", () => {
  allow(running().call("write", { file_path: join(home, "repo", ".project-map.md"), content: "x" }), ".project-map.md");
});
check("write 到 /reports/ 放行、到 ~/.dsh/AGENTS.md 放行", () => {
  allow(running().call("write", { file_path: join(home, "repo", "reports", "a.md"), content: "x" }), "/reports/");
  allow(running().call("write", { file_path: "~/.dsh/AGENTS.md", content: "x" }), "~/.dsh/AGENTS.md");
});
check("写 gates/x.js 被拒", () => {
  denyWith(running().call("edit", { file_path: join(home, "repo", "gates", "x.js"), old_string: "a", new_string: "b" }), "领导不亲自改码");
});
check("CASEOS_LEADER_WRITE_ALLOW 前缀追加放行", () => {
  const previous = process.env.CASEOS_LEADER_WRITE_ALLOW;
  process.env.CASEOS_LEADER_WRITE_ALLOW = join(home, "repo", "notes");
  try {
    allow(running().call("write", { file_path: join(home, "repo", "notes", "a.md"), content: "x" }), "白名单前缀");
    denyWith(running().call("write", { file_path: join(home, "repo", "notes2", "a.md"), content: "x" }), "领导不亲自改码");
  } finally {
    if (previous === undefined) delete process.env.CASEOS_LEADER_WRITE_ALLOW;
    else process.env.CASEOS_LEADER_WRITE_ALLOW = previous;
  }
});
check("git commit 被拒、git diff --stat 放行", () => {
  denyWith(running().call("bash", { command: "git commit -F /tmp/msg -- gates/a.js" }), "领导不亲自改码");
  denyWith(running().call("bash", { command: "git -C /repo push origin main" }), "领导不亲自改码");
  denyWith(running().call("bash", { command: "git reset --hard HEAD~1" }), "领导不亲自改码");
  allow(running().call("bash", { command: "git diff --stat 3e44ecf" }), "git diff --stat");
  allow(running().call("bash", { command: "git status --short && git log --oneline -1" }), "git status/log");
});
check("git stash list/show 放行，其余 stash 子命令被拒", () => {
  allow(running().call("bash", { command: "git stash list" }), "git stash list");
  allow(running().call("bash", { command: "git stash show -p stash@{0}" }), "git stash show");
  allow(running().call("bash", { command: "git -C /repo stash list" }), "git -C stash list");
  for (const command of [
    "git stash",
    "git stash push -m wip",
    "git stash pop",
    "git stash apply stash@{0}",
    "git stash drop stash@{0}",
    "git stash clear",
  ]) {
    denyWith(running().call("bash", { command }), "领导不亲自改码");
  }
});
check("sed -i / perl -i / rm -rf 被拒", () => {
  denyWith(running().call("bash", { command: "sed -i '' 's/a/b/' gates/x.js" }), "领导不亲自改码");
  denyWith(running().call("bash", { command: "perl -pi -e 's/a/b/' gates/x.js" }), "领导不亲自改码");
  denyWith(running().call("bash", { command: "rm -rf build" }), "领导不亲自改码");
});
check("npm/pnpm publish 与 install 被拒", () => {
  denyWith(running().call("bash", { command: "npm publish" }), "领导不亲自改码");
  denyWith(running().call("bash", { command: "pnpm install --frozen-lockfile" }), "领导不亲自改码");
});
check("echo x > /tmp/a 放行、echo x > src/a.js 被拒", () => {
  allow(running().call("bash", { command: "echo x > /tmp/a" }), "/tmp 重定向");
  allow(running().call("bash", { command: "node scripts/test.mjs > /dev/null 2>&1" }), "/dev/null 重定向");
  denyWith(running().call("bash", { command: "echo x > src/a.js" }), "领导不亲自改码");
  denyWith(running().call("bash", { command: "echo x >> src/a.js" }), "领导不亲自改码");
});
check("只读核验命令照常放行", () => {
  const harness = idle();
  for (const command of ["ls -la", "wc -l gates/leader-guard.js", "node --check gates/leader-guard.js", "pnpm smoke", "pnpm -s test"]) {
    allow(harness.call("bash", { command }), command);
  }
});
check("子代理会话不受任何限制", () => {
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
  }
});
check("CASEOS_LEADER_GUARD=0 时全部放行", () => {
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
  for (const rule of ["sleep-long", "sleep-in-loop", "sleep-background", "list-agents-repeat", "write-whitelist", "git-mutation", "workspace-redirect"]) {
    assert.ok(rules.has(rule), `缺少规则 ${rule} 的记录`);
  }
  assert.ok(records.every((row) => typeof row.summary === "string" && row.summary.length <= 200), "摘要未截断到 200 字符");
});

rmSync(home, { recursive: true, force: true });
console.log("test-leader-guard:");
for (const line of results) console.log(line);
const failed = results.filter((line) => line.includes("FAIL")).length;
console.log(`test-leader-guard: ${results.length - failed}/${results.length} passed`);
