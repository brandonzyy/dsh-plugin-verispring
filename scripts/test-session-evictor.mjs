#!/usr/bin/env node
// session-evictor 行为测试：纯 node、无依赖、无 sleep。mock 的宿主语义与 rc.2 源码对齐：
// - AgentRegistry.resume 是原型方法（dsh-agent/lib/index.js:466-470），返回 { agent, dispose }
//   的 handle（dsh-agent-loop/lib/index.js:1795-1806）；调用方丢掉 dispose 是泄漏根因
//   （dsh-api-session-controller/lib/index.js:396-403）。
// - dispose = unregister agent + remove session（dsh-agent:544、dsh-session:1886-1893），
//   之后 agents.get(sessionId) 为 undefined。
// - follow 是 AsyncGenerator，挂在 sessionController.history 上；closeFollowers 是全局 Set，
//   不按会话归属（dsh-api-session-controller/lib/index.js:1440-1467、:1523-1528）。
// - 冷观察缓存是 sessionQuery._observations.cache，条目带 refs（dsh-session-query/lib/index.js:
//   327-341、:449-475）；refs > 0 不得清退。
// 定时器、Date.now、process.memoryUsage、v8.getHeapStatistics 全部替身化，用例不存在等待。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import plugin, { evictionBlockers } from "../gates/session-evictor.js";

const GIB = 1024 ** 3;
const ENV_KEYS = ["CASEOS_EVICT", "CASEOS_EVICT_SCAN_MS", "CASEOS_EVICT_IDLE_MS"];
const realMemoryUsage = process.memoryUsage;
const realGetHeapStatistics = v8.getHeapStatistics;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realNow = Date.now;

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function makeHarness(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "session-evictor-home-"));
  for (const key of ENV_KEYS) delete process.env[key];
  if (options.disabled === true) process.env.CASEOS_EVICT = "0";
  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = String(value);

  const clock = { base: realNow(), offset: 0 };
  const heap = { value: options.heapUsed ?? 1 * GIB };
  const limit = options.heapLimitBytes ?? 4 * GIB;
  Date.now = () => clock.base + clock.offset;
  process.memoryUsage = () => ({ heapUsed: heap.value, rss: heap.value + 64 * 1024 ** 2, external: 0, arrayBuffers: 0 });
  v8.getHeapStatistics = () => ({ heap_size_limit: limit });

  const intervals = [];
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms, cleared: false });
    return intervals.length;
  };
  globalThis.clearInterval = (handle) => {
    const entry = intervals[handle - 1];
    if (entry) entry.cleared = true;
  };

  const specs = new Map(Object.entries(options.specs ?? {}).map(([id, spec]) => [id, { ...spec }]));
  const registryAgents = new Map();
  const sessionStore = new Map();
  const disposeCalls = [];
  const disposeFailures = new Set();

  class MockRegistry {
    get(id) {
      return registryAgents.get(id);
    }
    list() {
      return [...registryAgents.values()];
    }
    async resume(resumeOptions) {
      const sessionId = resumeOptions.resumeSessionId;
      const spec = specs.get(sessionId) ?? {};
      const session = {
        id: sessionId,
        header: {
          id: sessionId,
          origin: spec.origin ?? "user",
          ...(spec.parentSession === undefined ? {} : { parentSession: spec.parentSession }),
        },
        snapshotEvents: () => [],
      };
      const agent = {
        id: sessionId,
        session,
        status: spec.status ?? "idle",
        inbox: { hasPending: spec.inboxPending ?? false },
      };
      registryAgents.set(sessionId, agent);
      sessionStore.set(sessionId, session);
      return {
        agent,
        dispose: async () => {
          disposeCalls.push({ sessionId, at: Date.now() });
          if (disposeFailures.has(sessionId)) throw new Error(`dispose failed for ${sessionId}: ${"x".repeat(300)}`);
          registryAgents.delete(sessionId);
          sessionStore.delete(sessionId);
        },
      };
    }
  }
  const registry = new MockRegistry();
  const originalResume = MockRegistry.prototype.resume;

  // 激活前就存在的 Agent（例如 UI 在插件激活前 promote 的会话）：只有 agent/session，没有
  // handle，卸载器不能动它们，只能在 boot 自报里列出来。
  for (const spec of options.preAgents ?? []) {
    const sessionId = spec.id;
    const session = {
      id: sessionId,
      header: { id: sessionId, origin: spec.origin ?? "user" },
      snapshotEvents: () => [],
    };
    const agent = { id: sessionId, session, status: "idle", inbox: { hasPending: false } };
    registryAgents.set(sessionId, agent);
    sessionStore.set(sessionId, session);
  }

  const closeFollowers = new Set();
  const history = {
    closeFollowers,
    async *follow(_request, signal) {
      const close = () => {};
      this.closeFollowers.add(close);
      try {
        yield { type: "snapshot" };
        // 宿主 follow 的循环条件是 !signal.aborted（dsh-api-session-controller/lib/index.js:1596），
        // 已经中止就直接结束，不再挂 abort 监听。
        if (signal?.aborted === true) return;
        if (signal === undefined) await new Promise(() => {});
        else await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      } finally {
        this.closeFollowers.delete(close);
      }
    },
  };
  const originalFollow = history.follow;
  const sessionController = { history, agents: { resumes: new Map(), claims: new Map() } };
  const observationCache = options.observationCache ?? new Map();
  const coldLogMemo = options.coldLogMemo ?? new Map();
  const sessionQuery = { _observations: { cache: observationCache } };
  const subagents = { resident: new Map() };
  const services = {
    agents: registry,
    sessions: { get: (id) => sessionStore.get(id) },
    sessionController,
    sessionQuery,
    sessionPersistence: { coldLogMemo },
    subagents,
    profileContext: { home },
  };
  const listeners = new Map();
  const disposers = [];
  const toolNextCalls = { count: 0 };
  const ctx = {
    profileContext: { home },
    agents: registry,
    sessions: services.sessions,
    get: (name) => services[name],
    on: (name, callback) => {
      listeners.set(name, [...(listeners.get(name) ?? []), callback]);
      return () => {};
    },
    effect: (factory) => {
      const disposer = factory();
      if (typeof disposer === "function") disposers.push(disposer);
    },
  };
  ctx.root = ctx;

  plugin.apply(ctx);

  return {
    registry,
    history,
    sessionController,
    intervals,
    disposers,
    disposeCalls,
    originalResume,
    originalFollow,
    disabled: options.disabled === true,
    resume: async (sessionId, spec = {}) => {
      specs.set(sessionId, { ...(specs.get(sessionId) ?? {}), ...spec });
      return registry.resume({ resumeSessionId: sessionId });
    },
    agent: (id) => registryAgents.get(id),
    failDispose: (id) => disposeFailures.add(id),
    clearDisposeFailure: (id) => disposeFailures.delete(id),
    setHeap: (bytes) => {
      heap.value = bytes;
    },
    advance: (ms) => {
      clock.offset += ms;
    },
    tick: async () => {
      const interval = intervals.at(-1);
      assert.ok(interval, "apply 应注册扫描定时器");
      await interval.fn();
    },
    disposeScope: () => {
      for (const disposer of disposers) disposer();
    },
    emit: async (name, payload) => {
      for (const callback of listeners.get(name) ?? []) await callback(payload);
    },
    preTool: async (exec) => {
      let called = false;
      for (const callback of listeners.get("tools/pre-execute") ?? []) {
        await callback(exec, () => {
          called = true;
          return { kind: "allow" };
        });
      }
      if (called) toolNextCalls.count += 1;
      return called;
    },
    postTool: async (exec, result) => {
      let downstream = result;
      for (const callback of listeners.get("tools/post-execute") ?? []) {
        const next = () => downstream;
        downstream = await callback(exec, result, next);
      }
      return downstream;
    },
    toolNextCalls,
    monitor: () => readJsonl(`${home}/verispring-monitor.jsonl`),
    events: () => readJsonl(`${home}/verispring-monitor.jsonl`).filter((entry) => entry.kind !== "mem-guard-evict-boot"),
    boot: () => readJsonl(`${home}/verispring-monitor.jsonl`).find((entry) => entry.kind === "mem-guard-evict-boot"),
  };
}

function restoreGlobals() {
  process.memoryUsage = realMemoryUsage;
  v8.getHeapStatistics = realGetHeapStatistics;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  Date.now = realNow;
  for (const key of ENV_KEYS) delete process.env[key];
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("判据纯函数：空条目、subagent、运行中、pending inbox、follower 都有明确阻塞名", () => {
  const agent = { status: "idle", inbox: { hasPending: false }, session: {} };
  const base = {
    now: 1000,
    threshold: 100,
    agents: { get: () => agent },
    sessions: { get: () => agent.session },
    followerBlocks: () => false,
    descendantLive: () => false,
    claimInFlight: () => false,
  };
  assert.deepEqual(evictionBlockers(void 0, base), ["no-entry"]);
  assert.deepEqual(
    evictionBlockers({ sessionId: "s", agent, lastActive: 950 }, base),
    ["recent-activity"],
    "未到阈值不得卸载",
  );
  assert.deepEqual(
    evictionBlockers(
      { sessionId: "s", agent, lastActive: 0, subagent: true },
      { ...base, agents: { get: () => void 0 }, sessions: { get: () => void 0 } },
    ),
    ["subagent", "agent-not-live", "session-not-attached"],
  );
  const busyAgent = { ...agent, status: "running", inbox: { hasPending: true } };
  assert.deepEqual(
    evictionBlockers(
      { sessionId: "s", agent: busyAgent, lastActive: 0 },
      {
        ...base,
        agents: { get: () => busyAgent },
        followerBlocks: () => true,
        descendantLive: () => true,
        claimInFlight: () => true,
      },
    ),
    ["running", "pending-inbox", "live-descendant", "operation-in-flight", "followed"],
  );
});

test("resume 包装：捕获 handle，空闲阈值后 dispose；再次 promote 再次捕获", async () => {
  const harness = makeHarness();
  await harness.resume("session-1");
  assert.equal(harness.disposeCalls.length, 0, "promote 不应立即卸载");

  harness.advance(10 * 60 * 1000 - 1);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 0, "差 1ms 也不得提前卸载");

  harness.advance(1);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 1, "到阈值应卸载");
  assert.equal(harness.agent("session-1"), void 0, "dispose 后注册表应无该 agent");
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 1, "条目已随 dispose 清除，不重复卸载");
  const evicted = harness.events().find((entry) => entry.kind === "mem-guard-evict");
  assert.equal(evicted?.session, "session-1");
  assert.ok(evicted.idleMs >= 10 * 60 * 1000);
  assert.equal(typeof evicted.heapUsedBefore, "number");
  assert.equal(evicted.pressure, false);

  // 卸载后 session-controller 的 resolve 会重新 promote；包装必须再次捕获。
  await harness.resume("session-1");
  harness.advance(10 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 2, "重新 promote 的 handle 应再次被捕获");
});

test("活动跟踪：session/event 与工具调用都会刷新 lastActive", async () => {
  const harness = makeHarness();
  await harness.resume("session-1");
  harness.advance(9 * 60 * 1000);
  await harness.emit("session/event", { id: "session-1", type: "user/message" });
  harness.advance(9 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 0, "9 分钟前的会话事件应续命");

  const called = await harness.preTool({ agent: harness.agent("session-1"), name: "bash", arguments: { command: "true" } });
  assert.equal(called, true, "pre-execute 监听器必须把 next() 放行下去");
  assert.equal(harness.toolNextCalls.count, 1);
  await harness.postTool({ agent: harness.agent("session-1"), name: "bash" }, { value: "ok" });
  harness.advance(9 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 0, "工具调用后同样续命");

  harness.advance(1 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 1, "最后一次活动满 10 分钟后卸载");
});

test("堆压力：门槛降到 2 分钟，并按 LRU 先卸最久未活动的会话", async () => {
  const harness = makeHarness({ heapUsed: 2.2 * GIB, heapLimitBytes: 4 * GIB });
  await harness.resume("older");
  harness.advance(3 * 60 * 1000);
  await harness.resume("newer");
  harness.advance(3 * 60 * 1000);
  await harness.tick();
  assert.deepEqual(
    harness.disposeCalls.map((call) => call.sessionId),
    ["older", "newer"],
    "压力下 2 分钟即可卸，且按 lastActive 从旧到新",
  );
  assert.ok(harness.events().filter((entry) => entry.kind === "mem-guard-evict").every((entry) => entry.pressure === true));
});

test("堆压力在扫描时动态读取：低堆 9 分钟不卸，抬到 50% 后按 2 分钟门槛卸", async () => {
  const harness = makeHarness({ heapUsed: 1 * GIB });
  await harness.resume("session-1");
  harness.advance(9 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 0, "低堆时按 10 分钟门槛，9 分钟不卸");

  harness.setHeap(2.2 * GIB);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 1, "抬到 50% 顶棚后同一次扫描按 2 分钟门槛卸");
  assert.equal(harness.events().find((entry) => entry.kind === "mem-guard-evict")?.pressure, true);
});

test("有 follower 的会话不卸；其他空闲会话照卸；follow 结束后可卸", async () => {
  const harness = makeHarness();
  await harness.resume("watched");
  await harness.resume("other");
  const controller = new AbortController();
  const stream = harness.history.follow({ address: { kind: "session", sessionId: "watched" } }, controller.signal);
  await stream.next();
  harness.advance(10 * 60 * 1000);

  await harness.tick();
  assert.deepEqual(harness.disposeCalls.map((call) => call.sessionId), ["other"], "被跟随的会话不能卸");
  assert.equal(harness.agent("watched")?.id, "watched");

  controller.abort();
  await stream.next();
  await harness.tick();
  assert.deepEqual(
    harness.disposeCalls.map((call) => call.sessionId),
    ["other", "watched"],
    "follow 结束后 watched 变成可卸",
  );
});

test("运行中 / durable inbox 有 pending / 有活子代：都不卸；解除后只卸安全的", async () => {
  const harness = makeHarness();
  await harness.resume("running", { status: "running" });
  await harness.resume("pending", { inboxPending: true });
  await harness.resume("parent");
  await harness.resume("child", { origin: "subagent", parentSession: "parent", status: "running" });
  harness.advance(11 * 60 * 1000);
  await harness.tick();
  assert.deepEqual(harness.disposeCalls, [], "有任一阻塞条件都不得卸载");

  const running = harness.agent("running");
  running.status = "idle";
  harness.agent("pending").inbox.hasPending = false;
  harness.agent("child").status = "idle";
  await harness.tick();
  assert.deepEqual(
    harness.disposeCalls.map((call) => call.sessionId).sort(),
    ["pending", "running"],
    "父会话仍有活子代不卸；subagent 会话本身不归卸载器管",
  );
});

test("dispose 失败：落 mem-guard-evict-fail（错误截 200），30 分钟内不再尝试", async () => {
  const harness = makeHarness();
  await harness.resume("session-1");
  harness.failDispose("session-1");
  harness.advance(10 * 60 * 1000);
  await harness.tick();
  const failure = harness.events().find((entry) => entry.kind === "mem-guard-evict-fail");
  assert.equal(failure?.session, "session-1");
  assert.equal(failure.error.length, 200, "错误必须截到 200 字符");
  assert.equal(harness.disposeCalls.length, 1);

  harness.advance(29 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 1, "退避窗口内不得重试");

  harness.clearDisposeFailure("session-1");
  harness.advance(1 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 2, "30 分钟后退避结束，重试成功");
  assert.equal(harness.agent("session-1"), void 0);
});

test("session-controller 有在途 resume/claim：不卸；在途结束后可卸", async () => {
  const harness = makeHarness();
  await harness.resume("session-1");
  harness.sessionController.agents.claims.set("session-1", Promise.resolve());
  harness.advance(10 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 0, "有在途操作时不能拔掉会话");

  harness.sessionController.agents.claims.delete("session-1");
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 1);
});

test("dispose 后清冷缓存：observation refs=0 才清，coldLogMemo 按 id 清", async () => {
  const cache = new Map([["session-1", { refs: 0 }], ["session-2", { refs: 1 }]]);
  const coldLogMemo = new Map([["session-1", { events: [] }], ["session-2", { events: [] }]]);
  const harness = makeHarness({ observationCache: cache, coldLogMemo });
  await harness.resume("session-1");
  await harness.resume("session-2");
  harness.advance(10 * 60 * 1000);
  await harness.tick();
  assert.equal(cache.has("session-1"), false, "refs=0 的冷观察缓存应被点名清退");
  assert.equal(cache.has("session-2"), true, "仍有 lease 的缓存不能删");
  assert.equal(coldLogMemo.has("session-1"), false, "persistence 解码缓存按 id 清一条");
  assert.equal(coldLogMemo.has("session-2"), false, "两个会话都可卸，各自的 coldLogMemo 都清");
  const events = harness.events().filter((entry) => entry.kind === "mem-guard-evict");
  assert.equal(events.find((entry) => entry.session === "session-1")?.observationEvicted, true);
  assert.equal(events.find((entry) => entry.session === "session-2")?.observationEvicted, false);
  assert.equal(events.find((entry) => entry.session === "session-1")?.coldLogEvicted, true);
});

test("agent/disposed 清条目：宿主已释放的会话不会被卸载器再 dispose 一次", async () => {
  const harness = makeHarness();
  await harness.resume("session-1");
  await harness.emit("agent/disposed", { agent: harness.agent("session-1") });
  harness.advance(10 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 0, "条目已随 agent/disposed 删除");
});

test("subagent 会话不归卸载器管：即使空闲也不 dispose", async () => {
  const harness = makeHarness();
  await harness.resume("child", { origin: "subagent" });
  harness.advance(30 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 0);
});

test("找不到 follower 探针：保守不卸，并落带原因的 skip（5 分钟限流）", async () => {
  const harness = makeHarness();
  // 删掉 history 后 ensureFollowerProbe 无法归属任何 follow，只能保守拒绝。
  harness.sessionController.history = void 0;
  await harness.resume("session-1");
  harness.advance(10 * 60 * 1000);
  await harness.tick();
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 0);
  const skips = harness.events().filter((entry) => entry.kind === "mem-guard-evict-skip" && entry.reason === "follower-unknown");
  assert.equal(skips.length, 1, "同一原因 5 分钟内只记一条");
});

test("CASEOS_EVICT=0：不包装 resume、不装定时器、不落任何事件", async () => {
  const harness = makeHarness({ disabled: true });
  assert.equal(harness.intervals.length, 0);
  assert.equal(harness.disposers.length, 0);
  assert.deepEqual(harness.monitor(), []);
  assert.equal(harness.registry.resume, harness.originalResume);
  await harness.resume("session-1");
  harness.advance(30 * 60 * 1000);
  assert.equal(harness.disposeCalls.length, 0);
});

test("作用域释放：恢复 resume/follow 原方法、清定时器与条目", async () => {
  const harness = makeHarness();
  await harness.resume("session-1");
  harness.advance(10 * 60 * 1000);
  harness.disposeScope();
  assert.equal(harness.registry.resume, harness.originalResume, "原型上的 resume 必须恢复原方法");
  assert.equal(harness.history.follow, harness.originalFollow, "history.follow 必须恢复原方法");
  assert.equal(harness.intervals.at(-1).cleared, true);
  assert.equal(harness.disposeCalls.length, 0, "释放后条目清空，不再卸载");
});

test("启动自报：激活前已 promote 的会话进 untracked（只上报不动）", async () => {
  const harness = makeHarness({ preAgents: [{ id: "pre-promoted", origin: "user" }] });
  const boot = harness.boot();
  assert.equal(boot?.kind, "mem-guard-evict-boot");
  assert.equal(boot.tracked, 0);
  assert.equal(boot.untrackedTotal, 1);
  assert.deepEqual(boot.untracked, ["pre-promoted"]);
  assert.equal(boot.followerProbe, "session-controller");
  assert.equal(boot.resumePatched, true);
  assert.equal(typeof boot.scanMs, "number");
  assert.equal(typeof boot.idleMs, "number");

  harness.advance(30 * 60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 0, "没有 handle 的会话只上报、不卸载");
});

test("env 覆盖扫描间隔与空闲阈值", async () => {
  const harness = makeHarness({ env: { CASEOS_EVICT_SCAN_MS: 5000, CASEOS_EVICT_IDLE_MS: 60 * 1000 } });
  assert.equal(harness.intervals.at(-1).ms, 5000);
  assert.equal(harness.boot().scanMs, 5000);
  assert.equal(harness.boot().idleMs, 60 * 1000);
  await harness.resume("session-1");
  harness.advance(60 * 1000);
  await harness.tick();
  assert.equal(harness.disposeCalls.length, 1);
});

let failed = 0;
for (const { name, fn } of tests) {
  let failure;
  try {
    await fn();
  } catch (error) {
    failure = error;
  } finally {
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
console.log(`session-evictor: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
