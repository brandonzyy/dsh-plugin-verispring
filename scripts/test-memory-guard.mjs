#!/usr/bin/env node
// memory-guard 行为测试：纯 node、无依赖，mock ctx 只提供 apply() 实际用到的服务面。
// 定时器用替身（globalThis.setInterval 记录回调，不发真实定时器），内存读数用
// process.memoryUsage 替身，时间用 Date.now 替身推进——用例里没有 sleep。
// 覆盖：软阈值触发/不触发、只放空闲且 inbox 清空的子代理、缓存回收、5 分钟冷却、忙闲判定（运行中子代理 /
// 近 90s 工具活动）、硬阈值降级（宿主不自动重启，只落 monitor + stderr）、env 覆盖、
// subagent/end 即时检查、CASEOS_MEM_GUARD=0 全关、作用域释放时清定时器。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { memoryDecision } from "../gates/memory-guard.js";
import scoutRelay, { releaseIdleCaches as releaseRelayCaches } from "../gates/scout-relay.js";

const GIB = 1024 ** 3;
const ENV_KEYS = [
  "CASEOS_MEM_GUARD",
  "CASEOS_MEM_CHECK_MS",
  "CASEOS_MEM_SOFT_BYTES",
  "CASEOS_MEM_HARD_BYTES",
  "CASEOS_SCOUT_RELAY",
  "CASEOS_ASK_SCOUT_TIMEOUT_MS",
];
const realMemoryUsage = process.memoryUsage;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realNow = Date.now;
const realStderrWrite = process.stderr.write;

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function restoreGlobals() {
  process.memoryUsage = realMemoryUsage;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  Date.now = realNow;
  process.stderr.write = realStderrWrite;
  for (const key of ENV_KEYS) delete process.env[key];
}

function makeHarness(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "memory-guard-home-"));
  for (const key of ENV_KEYS) delete process.env[key];
  if (options.guard === false) process.env.CASEOS_MEM_GUARD = "0";
  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = String(value);

  const listeners = new Map();
  const intervals = [];
  const stderr = [];
  const disposers = [];
  const agentsMap = new Map();
  const resident = new Set();
  const drained = [];
  const heap = { value: options.heapUsed ?? 1 * GIB };
  const clock = { base: Date.now(), offset: 0 };

  process.memoryUsage = () => ({
    heapUsed: heap.value,
    rss: heap.value,
    external: 0,
    arrayBuffers: 0,
  });
  Date.now = () => clock.base + clock.offset;
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms, cleared: false });
    return intervals.length;
  };
  globalThis.clearInterval = (handle) => {
    const entry = intervals[handle - 1];
    if (entry) entry.cleared = true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };

  const agents = {
    get: (id) => agentsMap.get(id),
    list: () => [...agentsMap.values()],
  };
  // 与宿主 drainChildren 同语义：只释放同一父代理名下的常驻子代理，非常驻 id 是 no-op，
  // 父代理不匹配直接 UNAUTHORIZED。
  const subagents = {
    async drainChildren(parent, childIds) {
      if (!parent || !parent.session) throw new Error("parent missing");
      for (const id of childIds) {
        const target = agentsMap.get(id);
        if (target && target.session?.header?.parentSession !== parent.id) {
          throw new Error(`subagent "${id}" is not a direct child of agent "${parent.id}"`);
        }
      }
      for (const id of childIds) {
        if (!resident.has(id)) continue;
        resident.delete(id);
        agentsMap.delete(id);
        drained.push(id);
      }
    },
  };
  const services = { agents, subagents };

  const emitListeners = async (name, payload) => {
    await Promise.all((listeners.get(name) ?? []).map((callback) => callback(payload)));
  };
  const ctx = {
    profileContext: { home },
    get: (name) => services[name],
    on: (name, callback) => listeners.set(name, [...(listeners.get(name) ?? []), callback]),
    effect: (factory) => {
      disposers.push(factory());
    },
    tools: { register: () => {} },
    systemPrompt: { getSectionOrder: () => 100, section: () => {} },
  };
  ctx.root = ctx;

  plugin.apply(ctx);
  if (options.withRelay === true) scoutRelay.apply(ctx);

  return {
    home,
    intervals,
    stderr,
    disposers,
    drained,
    agents,
    setHeap: (bytes) => {
      heap.value = bytes;
    },
    advance: (ms) => {
      clock.offset += ms;
    },
    // 子代理落进 agents 注册表；resident 标记它还有常驻 activation。
    // inboxPending 模拟宿主 durable inbox 里还有排队待跑的输入。
    primeAgent: (id, { origin, parentSession, status = "idle", inboxPending = false } = {}) => {
      const agent = {
        id,
        status,
        inbox: { hasPending: inboxPending },
        session: {
          header: {
            id,
            ...(origin ? { origin } : {}),
            ...(parentSession ? { parentSession } : {}),
          },
          snapshotEvents: () => [],
        },
      };
      agentsMap.set(id, agent);
      return agent;
    },
    dropAgent: (id) => agentsMap.delete(id),
    makeResident: (id) => resident.add(id),
    emit: emitListeners,
    tick: async () => {
      const interval = intervals.at(-1);
      assert.ok(interval, "apply 应注册定时器");
      await interval.fn();
    },
    monitor: () => readJsonl(`${home}/verispring-monitor.jsonl`),
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("阈值判定：软阈值以下不动作，软/硬阈值边界与冷却、忙闲分支", () => {
  const base = { softBytes: 100, hardBytes: 200, lastActionAt: 0, now: 0 };
  assert.equal(memoryDecision({ ...base, heapUsed: 99, busy: false }).kind, "below");
  assert.equal(memoryDecision({ ...base, heapUsed: 100, busy: false }).kind, "soft");
  assert.equal(memoryDecision({ ...base, heapUsed: 200, busy: true }).kind, "hard-busy");
  assert.equal(memoryDecision({ ...base, heapUsed: 200, busy: false }).kind, "hard-idle");
  // 硬阈值优先于冷却：3.2GiB 以上只告警，不因冷却窗口吞掉提示
  assert.equal(memoryDecision({ ...base, heapUsed: 200, busy: true, lastActionAt: 0 + 1, now: 1 }).kind, "hard-busy");

  const cooling = memoryDecision({ ...base, heapUsed: 150, busy: false, lastActionAt: 1000, now: 1000 + 4 * 60 * 1000 });
  assert.equal(cooling.kind, "cooldown");
  assert.equal(cooling.remainingMs, 60 * 1000);
  assert.equal(memoryDecision({ ...base, heapUsed: 150, busy: false, lastActionAt: 1000, now: 1000 + 5 * 60 * 1000 }).kind, "soft");
});

test("软阈值以下：tick 与 subagent/end 都不产生动作与监控", async () => {
  const harness = makeHarness({ heapUsed: 1 * GIB });
  const leader = harness.primeAgent("leader-1");
  harness.primeAgent("child-idle", { origin: "subagent", parentSession: leader.id });
  harness.makeResident("child-idle");
  await harness.tick();
  await harness.emit("subagent/end", { id: "child-idle" });
  assert.equal(harness.monitor().length, 0);
  assert.deepEqual(harness.drained, []);
});

test("软阈值：只释放空闲子代理的常驻 activation，落 mem-guard-drain", async () => {
  const harness = makeHarness({ heapUsed: 2.5 * GIB });
  const leader = harness.primeAgent("leader-1");
  harness.primeAgent("child-idle", { origin: "subagent", parentSession: leader.id, status: "idle" });
  harness.primeAgent("child-running", { origin: "subagent", parentSession: leader.id, status: "running" });
  harness.makeResident("child-idle");
  harness.makeResident("child-running");

  await harness.tick();

  assert.deepEqual(harness.drained, ["child-idle"], "只放空闲子代理");
  assert.ok(harness.agents.get("child-running"), "运行中子代理必须保留");
  const line = harness.monitor().find((entry) => entry.kind === "mem-guard-drain");
  assert.ok(line, "应落 mem-guard-drain");
  assert.equal(line.released, 1);
  assert.equal(line.reason, "soft-threshold");
  assert.equal(typeof line.heapUsed, "number");
});

test("软阈值：inbox 还有排队输入的 idle 子代理不释放（有活要干）", async () => {
  const harness = makeHarness({ heapUsed: 2.5 * GIB });
  const leader = harness.primeAgent("leader-1");
  harness.primeAgent("child-idle", { origin: "subagent", parentSession: leader.id });
  harness.primeAgent("child-queued", {
    origin: "subagent",
    parentSession: leader.id,
    status: "idle",
    inboxPending: true,
  });
  harness.makeResident("child-idle");
  harness.makeResident("child-queued");

  await harness.tick();

  assert.deepEqual(harness.drained, ["child-idle"], "只放 inbox 已清空的子代理");
  assert.ok(harness.agents.get("child-queued"), "排队中的子代理必须保留");
});

test("软阈值：剪掉 scout-relay 里失联的 error 草稿，保留活会话的草稿", async () => {
  const harness = makeHarness({ heapUsed: 2.5 * GIB, withRelay: true });
  harness.primeAgent("leader-1");
  const live = harness.primeAgent("child-live", { origin: "subagent", parentSession: "leader-1" });
  const orphan = harness.primeAgent("child-orphan", { origin: "subagent", parentSession: "leader-gone" });
  await harness.emit("agent/error", { agent: live, error: { message: "仍在跑" } });
  await harness.emit("agent/error", { agent: orphan, error: { message: "end 丢了" } });
  // end 丢失后 agent 已卸载：这条草稿就是回收目标
  harness.dropAgent("child-orphan");

  await harness.tick();

  const line = harness.monitor().find((entry) => entry.kind === "mem-guard-recycle");
  assert.ok(line, "应落 mem-guard-recycle");
  assert.ok(line.released >= 1);
  assert.equal(line.reason, "soft-threshold");
  // 在用条目不得被剪：活子代理的草稿还在（下一次 end 取用）
  assert.equal(releaseRelayCaches([live]), 0);
  // scout-relay 的草稿是模块层状态：本用例收尾时清空，避免污染后续用例
  releaseRelayCaches([]);
});

test("5 分钟冷却：窗口内重复越阈值只记 cooldown，窗口过后重新尝试", async () => {
  const harness = makeHarness({ heapUsed: 2.5 * GIB });
  harness.primeAgent("leader-1");

  await harness.tick();
  assert.ok(harness.monitor().some((entry) => entry.kind === "mem-guard-skip" && entry.reason === "soft-threshold-no-targets"));

  await harness.tick();
  const cooldown = harness.monitor().find((entry) => entry.kind === "mem-guard-skip" && entry.reason === "cooldown");
  assert.ok(cooldown, "冷却窗口内应记 skip=cooldown");
  assert.ok(cooldown.remainingMs > 0 && cooldown.remainingMs <= 5 * 60 * 1000);

  harness.advance(5 * 60 * 1000);
  await harness.tick();
  const attempts = harness.monitor().filter((entry) => entry.kind === "mem-guard-skip" && entry.reason === "soft-threshold-no-targets");
  assert.equal(attempts.length, 2, "冷却过后应再尝试一次");
});

test("硬阈值 + 有运行中子代理：不退出，记 skip=hard-threshold-busy", async () => {
  const harness = makeHarness({ heapUsed: 3.3 * GIB });
  harness.primeAgent("leader-1");
  harness.primeAgent("child-run", { origin: "subagent", parentSession: "leader-1", status: "running" });
  await harness.tick();
  const line = harness.monitor().find((entry) => entry.kind === "mem-guard-skip");
  assert.equal(line.reason, "hard-threshold-busy");
  assert.equal(line.hardBytes, Math.round(3.2 * GIB));
});

test("硬阈值 + 近 90s 有工具活动：同样算忙，只记 skip", async () => {
  const harness = makeHarness({ heapUsed: 3.3 * GIB });
  harness.primeAgent("leader-1");
  await harness.emit("tools/pre-execute", { name: "bash" });
  await harness.tick();
  const line = harness.monitor().find((entry) => entry.kind === "mem-guard-skip");
  assert.equal(line.reason, "hard-threshold-busy");
});

test("硬阈值 + 空闲：降级为 monitor 事件 + stderr 提示，不退出进程", async () => {
  const harness = makeHarness({ heapUsed: 3.3 * GIB });
  harness.primeAgent("leader-1");
  harness.advance(2 * 60 * 1000); // 近 90s 无工具活动

  await harness.tick();

  const line = harness.monitor().find((entry) => entry.kind === "mem-guard-skip");
  assert.equal(line.reason, "hard-threshold-no-auto-restart");
  assert.ok(harness.stderr.some((text) => text.includes("请人工重启")), "应有可操作的重启提示");
});

test("env 覆盖：检查间隔与软/硬阈值按 CASEOS_MEM_* 生效", async () => {
  const soft = makeHarness({
    heapUsed: 2048,
    env: { CASEOS_MEM_CHECK_MS: 1000, CASEOS_MEM_SOFT_BYTES: 2048, CASEOS_MEM_HARD_BYTES: 4096 },
  });
  assert.equal(soft.intervals.at(-1).ms, 1000);
  await soft.tick();
  assert.ok(soft.monitor().some((entry) => entry.kind === "mem-guard-skip" && entry.reason === "soft-threshold-no-targets"),
    "soft 阈值被 env 降到 2048 时应触发回收尝试");

  const hard = makeHarness({
    heapUsed: 5000,
    env: { CASEOS_MEM_SOFT_BYTES: 2048, CASEOS_MEM_HARD_BYTES: 4096 },
  });
  hard.advance(2 * 60 * 1000);
  await hard.tick();
  assert.equal(hard.monitor().find((entry) => entry.kind === "mem-guard-skip")?.reason, "hard-threshold-no-auto-restart");
});

test("subagent/end 即时检查：不等下一轮定时器", async () => {
  const harness = makeHarness({ heapUsed: 1 * GIB });
  const leader = harness.primeAgent("leader-1");
  harness.primeAgent("child-idle", { origin: "subagent", parentSession: leader.id });
  harness.makeResident("child-idle");
  harness.setHeap(2.5 * GIB);

  await harness.emit("subagent/end", { id: "child-idle" });

  assert.deepEqual(harness.drained, ["child-idle"]);
});

test("CASEOS_MEM_GUARD=0：不装定时器、不挂监听、不留监控", async () => {
  const harness = makeHarness({ guard: false, heapUsed: 3.5 * GIB });
  assert.equal(harness.intervals.length, 0);
  assert.equal(harness.disposers.length, 0);
  await harness.emit("subagent/end", { id: "child-x" });
  await harness.emit("tools/pre-execute", { name: "bash" });
  assert.equal(harness.monitor().length, 0);
});

test("作用域释放时清掉定时器", () => {
  const harness = makeHarness({});
  assert.equal(harness.disposers.length, 1);
  harness.disposers[0]();
  assert.equal(harness.intervals.at(-1).cleared, true);
});

let failed = 0;
for (const { name, fn } of tests) {
  let failure;
  try {
    await fn();
  } catch (error) {
    failure = error;
  } finally {
    // 先复位替身再打印：被测代码改过 process.stderr.write，错误输出不能被它吞掉。
    restoreGlobals();
  }
  if (failure === void 0) {
    console.log(`ok - ${name}`);
  } else {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(String(failure?.stack ?? failure).split("\n").slice(0, 8).join("\n"));
  }
}
console.log(`memory-guard: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
