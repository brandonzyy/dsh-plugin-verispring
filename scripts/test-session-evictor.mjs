#!/usr/bin/env node
// session-evictor 行为测试：纯 node、无依赖、无 sleep。mock 的宿主语义与 rc.2 源码对齐：
// - AgentRegistry.resume 是原型方法（dsh-agent/lib/index.js:466-470），返回 { agent, dispose }
//   的 handle（dsh-agent-loop/lib/index.js:1795-1806）；调用方丢掉 dispose 是泄漏根因
//   （dsh-api-session-controller/lib/index.js:396-403）。
// - 本版没有任何自动卸载：resume 包装只捕获 handle，定时扫描只数遥测；释放只发生在主会话
//   调用 release_subagent 时。
// - dispose = unregister agent + remove session（dsh-agent:544、dsh-session:1886-1893）。
// - 宿主 drainChildren(parent, childIds) 要求 exact live parent，且目标必须是直接子代理
//   （dsh-subagent/lib/index.js:1372-1383）；resident 在 manager 上（:2984、:2996-3003），
//   在途续接/投递经 ChildLock.tails（:1121-1140、:2090-2095）。冷续接走
//   sendMessage → coldResume → materialize → agents.resume，会再次经过 resume 包装。
// - follow 是 AsyncGenerator，挂在 sessionController.history 上；closeFollowers 是全局 Set，
//   元素是 follow 生成器体里创建的裸闭包，只能按「包装时登记的是哪个会话」归属。
// - 冷观察缓存是 sessionQuery._observations.cache，条目带 refs（dsh-session-query/lib/index.js:
//   327-341）；refs > 0 不得清退。persistence coldLogMemo 按会话 id 点名清。
// 定时器、Date.now、process.memoryUsage 全部替身化，用例不存在等待。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { descendsFrom, releaseBlockers } from "../gates/session-evictor.js";

const ENV_KEYS = ["CASEOS_EVICT", "CASEOS_EVICT_SCAN_MS"];
const realMemoryUsage = process.memoryUsage;
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

function makeSession(id, spec = {}) {
  return {
    id,
    header: {
      id,
      origin: spec.origin ?? "user",
      ...(spec.parentSession === undefined ? {} : { parentSession: spec.parentSession }),
    },
    snapshotEvents: () => [],
  };
}

function makeAgent(sessionId, spec, session) {
  return {
    id: sessionId,
    session,
    status: spec.status ?? "idle",
    inbox: { hasPending: spec.inboxPending ?? false },
  };
}

function makeHarness(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "session-evictor-home-"));
  for (const key of ENV_KEYS) delete process.env[key];
  if (options.disabled === true) process.env.CASEOS_EVICT = "0";
  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = String(value);

  const clock = { base: realNow(), offset: 0 };
  Date.now = () => clock.base + clock.offset;
  process.memoryUsage = () => ({ heapUsed: 1 * 1024 ** 3, rss: 1 * 1024 ** 3, external: 0, arrayBuffers: 0 });

  const intervals = [];
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms, cleared: false });
    return intervals.length;
  };
  globalThis.clearInterval = (handle) => {
    const entry = intervals[handle - 1];
    if (entry) entry.cleared = true;
  };

  const specs = new Map();
  const registryAgents = new Map();
  const sessionStore = new Map();
  const disposeCalls = [];
  const disposeFailures = new Set();

  const disposeFor = async (sessionId) => {
    disposeCalls.push({ sessionId, at: Date.now() });
    if (disposeFailures.has(sessionId)) {
      throw new Error(`dispose failed for ${sessionId}: ${"x".repeat(300)}`);
    }
    registryAgents.delete(sessionId);
    sessionStore.delete(sessionId);
  };

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
      const session = makeSession(sessionId, spec);
      const agent = makeAgent(sessionId, spec, session);
      registryAgents.set(sessionId, agent);
      sessionStore.set(sessionId, session);
      return { agent, dispose: () => disposeFor(sessionId) };
    }
  }
  const registry = new MockRegistry();
  const originalResume = MockRegistry.prototype.resume;

  // 激活前就存在的 Agent（没有 handle，卸载器只能上报）。
  for (const spec of options.preAgents ?? []) {
    const session = makeSession(spec.id, spec);
    registryAgents.set(spec.id, makeAgent(spec.id, { status: "idle" }, session));
    sessionStore.set(spec.id, session);
  }
  // 未加载但可授权判定的目标：会话头还在 sessions 服务里，但没有 agent/handle。
  const seedSession = (id, spec = {}) => {
    const session = makeSession(id, spec);
    sessionStore.set(id, session);
    return session;
  };

  const closeFollowers = new Set();
  const history = {
    closeFollowers,
    async *follow(_request, signal) {
      const close = () => {};
      this.closeFollowers.add(close);
      try {
        yield { type: "snapshot" };
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

  const resident = new Map();
  const locks = { tails: new Map() };
  const drainCalls = [];
  const sendCalls = [];
  const drainChildren = async (parent, childIds) => {
    drainCalls.push({ parentId: parent?.id, childIds: [...childIds] });
    if (parent === void 0 || registryAgents.get(parent.id) !== parent) {
      throw new Error("selected child teardown requires the exact live parent agent (UNAUTHORIZED)");
    }
    for (const id of childIds) {
      const activation = resident.get(id);
      if (activation === void 0) continue;
      if (activation.parent?.id !== parent.id) {
        throw new Error(`subagent "${id}" is not a direct child of agent "${parent.id}" (UNAUTHORIZED)`);
      }
    }
    for (const id of childIds) {
      if (!resident.has(id)) continue;
      resident.delete(id);
      await disposeFor(id);
    }
  };
  const sendMessage = async (parent, childId, messages) => {
    sendCalls.push({
      parentId: parent?.id,
      childId,
      text: messages?.map((message) => message?.text ?? "").join("\n") ?? "",
    });
    if (parent === void 0 || registryAgents.get(parent.id) !== parent) {
      throw new Error("message delivery requires the exact live sender agent (UNAUTHORIZED)");
    }
    if (registryAgents.get(childId) === void 0) {
      // manager coldResume：先 observe，再 agents.resume（再次经过 resume 包装）。
      await registry.resume({ resumeSessionId: childId });
    }
    const parentId = specs.get(childId)?.parentSession ?? parent.id;
    resident.set(childId, { childId, parent: registryAgents.get(parentId) ?? { id: parentId }, ancestry: new Set([parent]) });
    return "message-1";
  };
  const manager = { resident, locks };
  const subagents = { manager, drainChildren, sendMessage };

  const tools = new Map();
  const restrictCalls = [];
  const toolsService = {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
      tools.set(definition.name, definition);
    },
    get(name) {
      return tools.get(name);
    },
    schemas() {
      return [...tools.values()];
    },
    restrict(spec) {
      restrictCalls.push(spec);
    },
  };

  const services = {
    agents: registry,
    sessions: { get: (id) => sessionStore.get(id) },
    sessionQuery,
    sessionPersistence: { coldLogMemo },
    subagents,
    tools: toolsService,
    profileContext: { home },
  };
  if (options.sessionControllerLate !== true) services.sessionController = sessionController;
  const listeners = new Map();
  const disposers = [];
  const injectRequests = [];
  const ctx = {
    profileContext: { home },
    agents: registry,
    sessions: services.sessions,
    tools: toolsService,
    get: (name) => services[name],
    on: (name, callback) => {
      listeners.set(name, [...(listeners.get(name) ?? []), callback]);
      return () => {};
    },
    effect: (factory) => {
      const disposer = factory();
      if (typeof disposer === "function") disposers.push(disposer);
    },
    inject: (names, callback) => {
      const request = { names, callback, active: true };
      injectRequests.push(request);
      if (names.every((name) => services[name] !== void 0)) callback({ tools: toolsService });
      return {
        dispose: () => {
          request.active = false;
        },
      };
    },
  };
  ctx.root = ctx;

  plugin.apply(ctx);

  const agentOf = (id) => registryAgents.get(id);
  return {
    registry,
    history,
    sessionController,
    intervals,
    disposers,
    disposeCalls,
    drainCalls,
    sendCalls,
    originalResume,
    originalFollow,
    tool: () => tools.get("release_subagent"),
    provideSessionController: async () => {
      services.sessionController = sessionController;
      await Promise.resolve();
      for (const request of injectRequests) {
        if (request.active && request.names.every((name) => services[name] !== void 0)) {
          request.callback({ tools: toolsService });
        }
      }
    },
    resume: async (sessionId, spec = {}) => {
      specs.set(sessionId, { ...(specs.get(sessionId) ?? {}), ...spec });
      return registry.resume({ resumeSessionId: sessionId });
    },
    seedSession,
    agent: agentOf,
    dropAgent: (id) => {
      registryAgents.delete(id);
      sessionStore.delete(id);
    },
    failDispose: (id) => disposeFailures.add(id),
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
    residentSet: () => resident,
    makeResident: (id, parentId) => {
      resident.set(id, {
        childId: id,
        parent: registryAgents.get(parentId) ?? { id: parentId },
        ancestry: new Set([registryAgents.get(parentId)].filter(Boolean)),
      });
    },
    beginManagerOp: (id) => locks.tails.set(id, Promise.resolve()),
    release: async (ids, callerId) => {
      const tool = tools.get("release_subagent");
      assert.ok(tool, "应注册 release_subagent");
      return tool.execute({ agent_ids: ids }, { agent: registryAgents.get(callerId) });
    },
    // 模拟 manager 的 sendMessage → coldResume（宿主会重建 agent 并再次经过 resume 包装）。
    send: async (parentId, childId) => sendMessage(registryAgents.get(parentId), childId, [{ type: "text", text: "续接" }]),
    monitor: () => readJsonl(`${home}/verispring-monitor.jsonl`),
    events: () => readJsonl(`${home}/verispring-monitor.jsonl`).filter((entry) => entry.kind !== "mem-guard-evict-boot"),
    boot: () => readJsonl(`${home}/verispring-monitor.jsonl`).find((entry) => entry.kind === "mem-guard-evict-boot"),
    releases: () => readJsonl(`${home}/verispring-monitor.jsonl`).filter((entry) => entry.kind === "mem-guard-release"),
  };
}

function restoreGlobals() {
  process.memoryUsage = realMemoryUsage;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  Date.now = realNow;
  for (const key of ENV_KEYS) delete process.env[key];
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("判据纯函数：运行中、pending inbox、在途操作、活后代、follower 都有明确阻塞名", () => {
  const idle = { status: "idle", inbox: { hasPending: false } };
  const base = {
    followerBlocks: () => false,
    descendantLive: () => false,
    claimInFlight: () => false,
    subagentOperationInFlight: () => false,
  };
  assert.deepEqual(releaseBlockers(void 0, base), ["no-target"]);
  assert.deepEqual(releaseBlockers({ sessionId: "s", agent: idle }, base), []);
  assert.deepEqual(
    releaseBlockers({ sessionId: "s", agent: { ...idle, status: "running", inbox: { hasPending: true } } }, base),
    ["running", "pending-inbox"],
  );
  assert.deepEqual(
    releaseBlockers({ sessionId: "s", agent: idle }, { ...base, claimInFlight: () => true, subagentOperationInFlight: () => true }),
    ["operation-in-flight", "subagent-operation-in-flight"],
  );
  assert.deepEqual(
    releaseBlockers(
      { sessionId: "s", agent: idle },
      { ...base, descendantLive: () => true, followerBlocks: () => "follower-untracked" },
    ),
    ["live-descendant", "follower-untracked"],
  );
  // inbox 读取失败按「有活」保守处理
  assert.deepEqual(
    releaseBlockers({ sessionId: "s", agent: { status: "idle", get inbox() { throw new Error("closed"); } } }, base),
    ["pending-inbox"],
  );
});

test("后代判定纯函数：沿 parentSession 链可达才算，环路与缺链不误判", () => {
  const parents = new Map([["g", "c"], ["c", "leader"], ["other", "leader-b"]]);
  const parentOf = (id) => parents.get(id);
  assert.equal(descendsFrom("c", "leader", parentOf), true);
  assert.equal(descendsFrom("g", "leader", parentOf), true);
  assert.equal(descendsFrom("other", "leader", parentOf), false);
  assert.equal(descendsFrom("leader", "leader", parentOf), true, "自身在链首即命中（调用方另有主会话拒绝）");
  parents.set("loop", "loop");
  assert.equal(descendsFrom("loop", "leader", parentOf), false, "坏日志成环只访问一次");
});

test("自动卸载已关闭：root 与 subagent 空闲任意久都不 dispose", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  harness.advance(24 * 60 * 60 * 1000);
  for (let index = 0; index < 10; index += 1) await harness.tick();
  assert.deepEqual(harness.disposeCalls, [], "没有任何定时器可以 dispose 会话");
  assert.equal(harness.agent("leader-1")?.id, "leader-1");
  assert.equal(harness.agent("child-1")?.id, "child-1");
  assert.equal(harness.events().some((entry) => entry.kind === "mem-guard-evict"), false, "旧的自动卸载事件不再出现");
  assert.equal(harness.events().some((entry) => entry.kind === "mem-guard-evict-fail"), false);
});

test("resume 包装仍捕获 handle：release 能拿到 dispose 路径；作用域释放恢复原型", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  assert.equal(harness.boot().tracked, 0, "boot 早于任何 promote，tracked 如实报 0");
  const result = await harness.release(["child-1"], "leader-1");
  assert.equal(result.results[0].result, "released");
  assert.equal(result.results[0].mode, "dispose");
  harness.disposeScope();
  assert.equal(harness.registry.resume, harness.originalResume, "原型上的 resume 必须恢复原方法");
  assert.equal(harness.history.follow, harness.originalFollow, "history.follow 必须恢复原方法");
  assert.equal(harness.intervals.at(-1).cleared, true);
});

test("授权：子代理调用 release_subagent 一律拒绝，且不释放任何目标", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  await harness.resume("grandchild", { origin: "subagent", parentSession: "child-1" });
  await assert.rejects(
    harness.release(["grandchild"], "child-1"),
    /只给主会话/,
    "子代理无权释放子代理",
  );
  assert.deepEqual(harness.disposeCalls, []);
  const refusal = harness.releases().at(-1);
  assert.equal(refusal.mode, "refused");
  assert.equal(refusal.reason, "not-leader");
  assert.equal(refusal.caller, "child-1");
});

test("授权：目标不是调用方后代 → refused(not-descendant)；目标是主会话 → refused(main-session)", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("leader-2");
  await harness.resume("child-2", { origin: "subagent", parentSession: "leader-2" });
  const foreign = await harness.release(["child-2"], "leader-1");
  assert.equal(foreign.results[0].result, "refused");
  assert.equal(foreign.results[0].reason, "not-descendant");

  const self = await harness.release(["leader-1"], "leader-1");
  assert.equal(self.results[0].result, "refused");
  assert.equal(self.results[0].reason, "main-session");
  const otherMain = await harness.release(["leader-2"], "leader-1");
  assert.equal(otherMain.results[0].reason, "main-session");
  assert.deepEqual(harness.disposeCalls, []);
});

test("安全判据逐项拒绝：running / pending inbox / 在途锁 / follow / 活后代 / 在途 claim", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("running", { origin: "subagent", parentSession: "leader-1", status: "running" });
  await harness.resume("pending", { origin: "subagent", parentSession: "leader-1", inboxPending: true });
  await harness.resume("locked", { origin: "subagent", parentSession: "leader-1" });
  await harness.resume("followed", { origin: "subagent", parentSession: "leader-1" });
  await harness.resume("claimed", { origin: "subagent", parentSession: "leader-1" });
  await harness.resume("parent-of-live", { origin: "subagent", parentSession: "leader-1" });
  await harness.resume("live-child", { origin: "subagent", parentSession: "parent-of-live" });
  harness.makeResident("live-child", "parent-of-live");
  harness.beginManagerOp("locked");
  harness.sessionController.agents.claims.set("claimed", Promise.resolve());
  const controller = new AbortController();
  const stream = harness.history.follow({ address: { kind: "session", sessionId: "followed" } }, controller.signal);
  await stream.next();

  const result = await harness.release(["running", "pending", "locked", "followed", "parent-of-live", "claimed"], "leader-1");
  const reasons = Object.fromEntries(result.results.map((row) => [row.id, row.reason]));
  assert.match(reasons.running, /running/);
  assert.match(reasons.pending, /pending-inbox/);
  assert.match(reasons.locked, /subagent-operation-in-flight/);
  assert.match(reasons.followed, /followed/);
  assert.match(reasons["parent-of-live"], /live-descendant/);
  assert.match(reasons.claimed, /operation-in-flight/);
  assert.ok(result.results.every((row) => row.result === "refused"));
  assert.deepEqual(harness.disposeCalls, [], "任一安全判据不满足都不得释放");

  controller.abort();
  await stream.next();
});

test("drain 路径：resident 目标走 drainChildren(exact live parent)，释放后清冷缓存", async () => {
  const cache = new Map([["child-1", { refs: 0 }], ["child-2", { refs: 1 }]]);
  const coldLogMemo = new Map([["child-1", { events: [] }], ["child-2", { events: [] }]]);
  const harness = makeHarness({ observationCache: cache, coldLogMemo });
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  await harness.resume("child-2", { origin: "subagent", parentSession: "leader-1" });
  harness.makeResident("child-1", "leader-1");
  harness.makeResident("child-2", "leader-1");

  const result = await harness.release(["child-1"], "leader-1");

  assert.equal(result.results[0].result, "released");
  assert.equal(result.results[0].mode, "drain");
  assert.deepEqual(harness.drainCalls, [{ parentId: "leader-1", childIds: ["child-1"] }]);
  assert.equal(harness.agent("child-1"), void 0, "drain 后注册表里没有该 agent");
  assert.equal(harness.residentSet().has("child-1"), false);
  assert.equal(cache.has("child-1"), false, "refs=0 的冷观察缓存应被点名清退");
  assert.equal(cache.has("child-2"), true, "仍有 lease 的缓存不能删");
  assert.equal(coldLogMemo.has("child-1"), false, "persistence 解码缓存按 id 清一条");
  assert.equal(coldLogMemo.has("child-2"), true, "其他会话的缓存不动");
  const line = harness.releases().at(-1);
  assert.equal(line.caller, "leader-1");
  assert.equal(line.child, "child-1");
  assert.equal(line.mode, "drain");
  assert.equal(line.observationEvicted, true);
  assert.equal(line.coldLogEvicted, true);
  assert.equal(typeof line.heapUsedBefore, "number");
  assert.equal(typeof line.heapUsedAfter, "number");
});

test("dispose 路径：已在内存但非 resident 的目标走捕获的 handle.dispose", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  assert.equal(harness.agent("child-1")?.status, "idle");
  const result = await harness.release(["child-1"], "leader-1");
  assert.equal(result.results[0].mode, "dispose");
  assert.deepEqual(harness.disposeCalls.map((call) => call.sessionId), ["child-1"]);
  assert.deepEqual(harness.drainCalls, []);
  assert.equal(harness.agent("child-1"), void 0);
  assert.equal(harness.releases().at(-1).mode, "dispose");
});

test("not-loaded：本就不在内存的目标按成功无操作返回 noop，重复释放也幂等", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  await harness.release(["child-1"], "leader-1");
  assert.equal(harness.agent("child-1"), void 0);

  const again = await harness.release(["child-1"], "leader-1");
  assert.equal(again.results[0].result, "not-loaded", "已释放的后代仍靠 lineage 记忆通过授权");
  assert.equal(again.results[0].mode, "noop");
  assert.equal(harness.releases().at(-1).mode, "noop");

  harness.seedSession("never-loaded", { origin: "subagent", parentSession: "leader-1" });
  const seed = await harness.release(["never-loaded"], "leader-1");
  assert.equal(seed.results[0].result, "not-loaded");
  assert.deepEqual(harness.disposeCalls.map((call) => call.sessionId), ["child-1"]);
});

test("孙代：调用方是祖父时，用孙代的直接父（exact live parent）走 drain", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  await harness.resume("grandchild", { origin: "subagent", parentSession: "child-1" });
  harness.makeResident("grandchild", "child-1");

  const result = await harness.release(["grandchild"], "leader-1");

  assert.equal(result.results[0].mode, "drain");
  assert.deepEqual(harness.drainCalls, [{ parentId: "child-1", childIds: ["grandchild"] }], "宿主要求 exact live parent");
  assert.equal(harness.agent("grandchild"), void 0);
});

test("释放后 send_message 仍可续接：coldResume 重建 agent 并被 resume 包装重新捕获", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  harness.makeResident("child-1", "leader-1");
  await harness.release(["child-1"], "leader-1");
  assert.equal(harness.agent("child-1"), void 0);

  const messageId = await harness.send("leader-1", "child-1");
  assert.equal(messageId, "message-1");
  assert.equal(harness.agent("child-1")?.id, "child-1", "coldResume 重建了子代理");
  assert.ok(harness.residentSet().has("child-1"), "续接后重新成为 resident");
  assert.equal(harness.sendCalls.length, 1);

  // 重新捕获的 handle 能被再次释放（drain 路径），证明包装对冷续接生效。
  const again = await harness.release(["child-1"], "leader-1");
  assert.equal(again.results[0].mode, "drain", "重建后的 resident 仍可释放");
  assert.equal(harness.agent("child-1"), void 0);
});

test("drain 失败 / dispose 失败：目标保持存活，落 refused 并带原因", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  harness.failDispose("child-1");
  const result = await harness.release(["child-1"], "leader-1");
  assert.equal(result.results[0].result, "refused");
  assert.match(result.results[0].reason, /dispose-failed/);
  assert.equal(harness.agent("child-1")?.id, "child-1", "失败不当作已释放");
  assert.equal(harness.releases().at(-1).mode, "refused");
});

test("follower 探针缺失：release 保守拒绝，不猜「没人在看」", async () => {
  const harness = makeHarness();
  harness.sessionController.history = void 0;
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  const result = await harness.release(["child-1"], "leader-1");
  assert.equal(result.results[0].result, "refused");
  assert.match(result.results[0].reason, /followed|follower-untracked/);
  assert.deepEqual(harness.disposeCalls, []);
});

test("工具注册与 schema：release_subagent 挂在主会话工具面，参数是 agent_ids 数组", async () => {
  const harness = makeHarness();
  const tool = harness.tool();
  assert.ok(tool, "apply 时应注册 release_subagent");
  assert.equal(tool.parameters.type, "object");
  assert.equal(tool.parameters.properties.agent_ids.type, "array");
  assert.equal(tool.parameters.properties.agent_ids.items.type, "string");
  assert.deepEqual(tool.parameters.required, ["agent_ids"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.ok(tool.description.includes("只给主会话"));
  assert.equal(typeof tool.output?.render, "function");
  const boot = harness.boot();
  assert.equal(boot.releaseTool, true);
});

test("子代理工具面：agent/created 时摘掉 release_subagent", async () => {
  const harness = makeHarness();
  const restricted = [];
  const shell = {
    id: "sub-shell",
    session: { header: { id: "sub-shell", origin: "subagent", parentSession: "leader-1" } },
    ctx: {
      inject: (names, callback) => {
        assert.deepEqual(names, ["tools"]);
        callback({ tools: { restrict: (spec) => restricted.push(spec) } });
      },
    },
  };
  await harness.emit("agent/created", { agent: shell });
  assert.deepEqual(restricted, [{ deny: ["release_subagent"] }]);
});

test("扫描遥测：candidates 只数可由主会话释放的已结束子代理，无自动动作", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("idle-child", { origin: "subagent", parentSession: "leader-1" });
  await harness.resume("running-child", { origin: "subagent", parentSession: "leader-1", status: "running" });
  harness.advance(30 * 60 * 1000);
  await harness.tick();
  const scan = harness.events().find((entry) => entry.kind === "mem-guard-evict-scan");
  assert.ok(scan, "首次扫描就落汇总");
  assert.equal(scan.tracked, 3);
  assert.equal(scan.candidates, 1, "只数 idle 且无阻塞的子代理");
  assert.equal(scan.evicted, void 0, "遥测不再报自动卸载");
  assert.equal(scan.blockers, void 0);
  assert.equal(scan.followerProbe, "session-controller");
  assert.equal(scan.subagentProbe, true);
  assert.equal(typeof scan.heapUsed, "number");
  assert.deepEqual(harness.disposeCalls, []);
});

test("启动自报：无 idle/pressure 阈值，仍报 scanMs/tracked/untracked/probe/releaseTool", async () => {
  const harness = makeHarness({ preAgents: [{ id: "pre-promoted", origin: "user" }] });
  const boot = harness.boot();
  assert.equal(boot?.kind, "mem-guard-evict-boot");
  assert.equal(boot.tracked, 0);
  assert.equal(boot.untrackedTotal, 1);
  assert.deepEqual(boot.untracked, ["pre-promoted"]);
  assert.equal(boot.followerProbe, "session-controller");
  assert.equal(boot.resumePatched, true);
  assert.equal(boot.subagentProbe, true);
  assert.equal(boot.releaseTool, true);
  assert.equal(typeof boot.scanMs, "number");
  assert.equal(boot.idleMs, void 0, "空闲阈值已删除");
});

test("inject 补装 follow 包装：session-controller 晚 provide 也不影响首条 follow 归属", async () => {
  const harness = makeHarness({ sessionControllerLate: true });
  assert.equal(harness.history.follow, harness.originalFollow, "provide 之前没有 history 可包装");
  assert.equal(harness.boot().followerProbe, "deferred");
  await harness.provideSessionController();
  assert.notEqual(harness.history.follow, harness.originalFollow);
  const install = harness.events().find((entry) => entry.kind === "mem-guard-evict-follow");
  assert.equal(install?.source, "inject");

  await harness.resume("leader-1");
  await harness.resume("watched", { origin: "subagent", parentSession: "leader-1" });
  const controller = new AbortController();
  const stream = harness.history.follow({ address: { kind: "session", sessionId: "watched" } }, controller.signal);
  await stream.next();
  const result = await harness.release(["watched"], "leader-1");
  assert.match(result.results[0].reason, /followed/);
  controller.abort();
  await stream.next();
  const after = await harness.release(["watched"], "leader-1");
  assert.equal(after.results[0].result, "released", "follow 结束后可释放");
});

test("CASEOS_EVICT=0：不包装 resume、不装定时器、不注册工具、不落任何事件", async () => {
  const harness = makeHarness({ disabled: true });
  assert.equal(harness.intervals.length, 0);
  assert.equal(harness.disposers.length, 0);
  assert.deepEqual(harness.monitor(), []);
  assert.equal(harness.registry.resume, harness.originalResume);
  assert.equal(harness.tool(), void 0, "关闭后工具也不注册");
  await harness.resume("session-1");
  harness.advance(30 * 60 * 1000);
  assert.equal(harness.disposeCalls.length, 0);
});

test("env 只覆盖扫描间隔（CASEOS_EVICT_SCAN_MS），不再有空闲阈值项", () => {
  const harness = makeHarness({ env: { CASEOS_EVICT_SCAN_MS: 5000 } });
  assert.equal(harness.intervals.at(-1).ms, 5000);
  assert.equal(harness.boot().scanMs, 5000);
  assert.equal(harness.boot().idleMs, void 0);
});

test("agent/disposed 清条目：宿主已释放的会话不会被重复 dispose", async () => {
  const harness = makeHarness();
  await harness.resume("leader-1");
  await harness.resume("child-1", { origin: "subagent", parentSession: "leader-1" });
  const child = harness.agent("child-1");
  harness.dropAgent("child-1");
  await harness.emit("agent/disposed", { agent: child });
  const result = await harness.release(["child-1"], "leader-1");
  assert.equal(result.results[0].result, "not-loaded", "条目已随 agent/disposed 删除");
  assert.equal(result.results[0].mode, "noop");
  assert.deepEqual(harness.disposeCalls, []);
});

test("活着但未捕获 handle（激活前已 promote）：拒绝 not-captured，不谎报 not-loaded", async () => {
  const harness = makeHarness({ preAgents: [{ id: "pre-child", origin: "subagent", parentSession: "leader-1" }] });
  await harness.resume("leader-1");
  const result = await harness.release(["pre-child"], "leader-1");
  assert.equal(result.results[0].result, "refused");
  assert.match(result.results[0].reason, /not-captured/);
  assert.equal(harness.agent("pre-child")?.id, "pre-child", "未捕获的会话不能动");
  assert.deepEqual(harness.disposeCalls, []);
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
