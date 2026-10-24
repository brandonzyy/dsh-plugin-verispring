#!/usr/bin/env node
// 主会话空闲自动压缩（gates/idle-compact.js）的行为测试：纯 node、无依赖。
// 用假时钟 + 假定时器 + mock ctx 驱动门禁真实实现，不复制宿主压缩逻辑。
//
// 覆盖：时间边界（54:59 / 55:00）、子会话、非 idle、token 等于/低于/高于阈值、达标仅一次、
// compactNow 返回 null 不重复、新请求后重新具备资格、压缩期间排入的新请求纪元不被吞、
// compactNow 自身不产生 agent/request、inflight 重入、失败冷却 10 分钟、取消、配置关闭、
// 环境总开关、dispose 清 timer/abort、agent/request waterfall 必须调用 next()。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import idleCompact, {
  COOLDOWN_MS,
  DEFAULT_IDLE_MINUTES,
  DEFAULT_MIN_TOKENS,
  ENABLED_ENV,
  MINUTE_MS,
  TICK_MS,
  createIdleCompactor,
  isSubagent,
  lastEventTime,
  normalizeSettings,
  readSettings,
} from "../gates/idle-compact.js";

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function monitorEvents(home) {
  try {
    return readFileSync(join(home, "verispring-monitor.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function makeAgent(options = {}) {
  const {
    id = "main",
    subagent = false,
    status = "idle",
    lastEvent,
    tokens = DEFAULT_MIN_TOKENS + 1,
    onCompact,
  } = options;
  let measureCalls = 0;
  let compactCalls = 0;
  let injectCalls = 0;
  const requestListeners = [];
  const agent = {
    id,
    status,
    session: {
      id,
      header: subagent ? { origin: "subagent" } : { id },
      log: lastEvent === undefined ? [] : [{ time: lastEvent }],
    },
    // 真实 web 宿主：compaction 只挂在 preset 的隔离 realm 上，由根 ctx 的
    // agentPresets.serviceFor(agent, 'compaction') 取；agent.ctx.get 默认拿不到。
    __agentCompaction: false,
    __agentTokenMeter: false,
  };
  const compaction = {
    compactNow: async (target, signal) => {
      compactCalls += 1;
      if (onCompact !== undefined) return onCompact({ agent: target, signal, call: compactCalls });
      return { ok: true };
    },
  };
  const tokenMeter = {
    measure: (session) => {
      measureCalls += 1;
      assert.equal(session, agent.session, "measure 必须读本会话的 session");
      return { totalTokens: agent.tokens };
    },
  };
  agent.tokens = tokens;
  agent.presetServices = { compaction };
  agent.tokenMeter = tokenMeter;
  agent.ctx = {
    get: (name) => {
      // 仅老宿主/无 preset 兜底测试显式打开；默认模拟真实层级（agent ctx 不含 compaction）。
      if (name === "compaction" && agent.__agentCompaction === true) return compaction;
      if (name === "tokenMeter" && agent.__agentTokenMeter === true) return tokenMeter;
      return void 0;
    },
    on: (event, handler) => {
      if (event !== "agent/request") return () => {};
      requestListeners.push(handler);
      return () => {
        const index = requestListeners.indexOf(handler);
        if (index >= 0) requestListeners.splice(index, 1);
      };
    },
    // 旧实现会在这里永久 pending；现在必须完全不再调用，调用即判失败。
    inject: async () => {
      injectCalls += 1;
      throw new Error("agent.ctx.inject 不得再被调用（真实宿主会永久挂起）");
    },
  };
  return {
    agent,
    measureCalls: () => measureCalls,
    compactCalls: () => compactCalls,
    injectCalls: () => injectCalls,
    listeners: () => requestListeners.length,
    async fireRequest() {
      let calls = 0;
      let result;
      const next = () => "request-config";
      for (const handler of [...requestListeners]) {
        calls += 1;
        result = await handler({ turn: 1, step: 1, signal: new AbortController().signal }, next);
      }
      return { calls, result };
    },
  };
}

function makeHarness(options = {}) {
  const {
    agents = [],
    config = undefined,
    start = 1_700_000_000_000,
    presets = true,
    rootCompaction = false,
    rootTokenMeter = true,
  } = options;
  let clock = start;
  let configReads = 0;
  const serviceForCalls = [];
  const home = mkdtempSync(join(tmpdir(), "idle-compact-"));
  const rootListeners = new Map();
  const rootPlaneTokenMeter = {
    measure(session) {
      const target = agents.find((candidate) => candidate?.session === session);
      if (target === undefined) throw new Error("root tokenMeter: unknown session");
      return target.tokenMeter.measure(session);
    },
  };
  const ctx = {
    get(name) {
      if (name === "agents") return { list: () => agents };
      if (name === "profileContext") return { home };
      if (name === "tokenMeter") return rootTokenMeter ? rootPlaneTokenMeter : void 0;
      if (name === "agentPresets") {
        if (!presets) return void 0;
        return {
          serviceFor(target, service) {
            serviceForCalls.push({ agent: target, name: service });
            if (service !== "compaction") return void 0;
            return target?.presetServices?.compaction;
          },
        };
      }
      if (name === "compaction") {
        if (!rootCompaction) return void 0;
        return {
          compactNow: (target, signal) => target.presetServices.compaction.compactNow(target, signal),
        };
      }
      if (name === "configEditor") {
        if (config === undefined) return void 0;
        return {
          configuration() {
            configReads += 1;
            return [{
              entry: { options: { id: "verispring-config", config: {} } },
              inherited: {},
              override: config,
            }];
          },
        };
      }
      return void 0;
    },
    on(event, handler) {
      const list = rootListeners.get(event) ?? [];
      list.push(handler);
      rootListeners.set(event, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect() {
      throw new Error("工厂不注册 effect");
    },
  };
  ctx.root = ctx;
  const intervals = [];
  const cleared = [];
  const timers = {
    setInterval(fn, ms) {
      const handle = {
        fn,
        ms,
        unrefCalled: false,
        unref() {
          handle.unrefCalled = true;
        },
      };
      intervals.push(handle);
      return handle;
    },
    clearInterval(handle) {
      cleared.push(handle);
    },
  };
  const compactor = createIdleCompactor(ctx, { now: () => clock, timers, dshHome: home });
  return {
    ctx,
    home,
    compactor,
    intervals,
    cleared,
    configReads: () => configReads,
    serviceForCalls: () => serviceForCalls,
    now: () => clock,
    advance(ms) {
      clock += ms;
      return clock;
    },
    async create(agent) {
      const listeners = rootListeners.get("agent/created") ?? [];
      for (const handler of [...listeners]) await handler({ agent });
    },
  };
}

// —— 配置收口 ——

test("默认设置：开启、55 分钟、50000 tokens", () => {
  assert.deepEqual(normalizeSettings(undefined), {
    enabled: true,
    idleMs: DEFAULT_IDLE_MINUTES * MINUTE_MS,
    minTokens: DEFAULT_MIN_TOKENS,
  });
  assert.equal(DEFAULT_IDLE_MINUTES, 55);
  assert.equal(DEFAULT_MIN_TOKENS, 50000);
});

test("配置禁止 NaN/负数/零：非法值回落默认，合法正数生效", () => {
  const fallback = normalizeSettings({});
  for (const bad of ["abc", "", -5, 0, "0", null, void 0, Number.NaN, Infinity]) {
    const settings = normalizeSettings({ idleCompactMinutes: bad, idleCompactMinTokens: bad });
    assert.deepEqual(settings, fallback, `非法值 ${String(bad)} 必须回落默认`);
  }
  assert.deepEqual(normalizeSettings({ idleCompactMinutes: "75", idleCompactMinTokens: "60000" }), {
    enabled: true,
    idleMs: 75 * MINUTE_MS,
    minTokens: 60000,
  });
  assert.equal(normalizeSettings({ idleCompactEnabled: false }).enabled, false);
});

test("configEditor 缺失时 readSettings 回落默认", () => {
  assert.deepEqual(readSettings({ get: () => void 0 }), normalizeSettings(undefined));
});

test("configEditor 只暴露 entries() 或抛错时仍能读值/回落默认", () => {
  const viaEntries = readSettings({
    get: (name) => (name === "configEditor"
      ? {
        configuration: () => [],
        entries: () => [{ options: { id: "verispring-config", config: { idleCompactMinutes: 90 } } }],
      }
      : void 0),
  });
  assert.equal(viaEntries.idleMs, 90 * MINUTE_MS);

  const broken = readSettings({
    get: (name) => (name === "configEditor"
      ? {
        configuration() {
          throw new Error("profile unavailable");
        },
      }
      : void 0),
  });
  assert.deepEqual(broken, normalizeSettings(undefined), "配置读取失败必须回落默认");
});

// —— 时间边界 ——

test("未到 55 分钟不压，恰好 55:00 压一次", async () => {
  const h = makeHarness();
  const m = makeAgent();
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();

  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS - 1);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 0, "54:59 不得压缩");
  assert.equal(m.measureCalls(), 0, "未到时间连 measure 都不该做");

  h.advance(1);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1, "55:00 必须压缩");
  assert.equal(h.compactor.stateOf(m.agent).compactedEpoch, 1);
});

// —— 会话筛选 ——

test("子会话永不压缩，也不 measure", async () => {
  const h = makeHarness({ start: 1_700_000_000_000 });
  const m = makeAgent({ id: "child", subagent: true, lastEvent: h.now() - 3 * 60 * MINUTE_MS, tokens: 500000 });
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  h.advance(120 * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.measureCalls(), 0);
  assert.equal(m.compactCalls(), 0);
  assert.equal(h.compactor.stateOf(m.agent), void 0, "子会话不得被登记状态");
  assert.equal(isSubagent(m.agent), true);
});

test("非 idle 会话不压；转回 idle 后才具备资格", async () => {
  const h = makeHarness();
  const m = makeAgent({ status: "running" });
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  h.compactor.adoptAgent(m.agent);
  await m.fireRequest();
  h.advance(2 * DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.measureCalls(), 0);
  assert.equal(m.compactCalls(), 0);

  m.agent.status = "idle";
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1);
});

// —— 服务层级（真实隔离 preset） ——

test("真实层级：agent.ctx 无 compaction，仅 agentPresets.serviceFor 可用时仍压下且不用 inject", async () => {
  const h = makeHarness();
  const m = makeAgent({ id: "isolated-preset" });
  h.ctx.get("agents").list().push(m.agent);
  assert.equal(m.agent.ctx.get("compaction"), void 0, "前置：agent ctx 必须拿不到 compaction（web 宿主）");
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();

  assert.equal(m.compactCalls(), 1, "只有 serviceFor 提供 compaction 时也必须压缩");
  assert.equal(m.measureCalls(), 1);
  assert.equal(m.injectCalls(), 0, "agent.ctx.inject 必须完全不再被调用");
  const calls = h.serviceForCalls();
  assert.deepEqual(calls.map((call) => call.name), ["compaction"]);
  assert.equal(calls[0].agent, m.agent, "serviceFor 必须以同一个 agent 调用");
  assert.equal(calls[0].name, "compaction");
});

test("老宿主兜底：无 agentPresets 时 agent.ctx.get('compaction') 仍可压缩，inject 不调用", async () => {
  const h = makeHarness({ presets: false });
  const m = makeAgent();
  m.agent.__agentCompaction = true;
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();

  assert.equal(m.compactCalls(), 1);
  assert.equal(h.serviceForCalls().length, 0);
  assert.equal(m.injectCalls(), 0);
});

test("兜底顺序：root ctx.get('compaction') + agent.ctx.get('tokenMeter')", async () => {
  const h = makeHarness({ presets: false, rootCompaction: true, rootTokenMeter: false });
  const m = makeAgent();
  m.agent.__agentTokenMeter = true;
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();

  assert.equal(m.measureCalls(), 1);
  assert.equal(m.compactCalls(), 1);
  assert.equal(m.injectCalls(), 0);
});

test("服务完全未绑定：按 fail + 10 分钟冷却，不 measure、冷却后才重试", async () => {
  const h = makeHarness({ presets: false });
  const m = makeAgent();
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();

  assert.equal(m.measureCalls(), 0, "服务装载失败不得 measure");
  assert.equal(m.compactCalls(), 0);
  assert.equal(m.injectCalls(), 0);
  const firstFail = monitorEvents(h.home).find((event) => event.kind === "idle-compact-fail");
  assert.ok(firstFail !== void 0);
  assert.match(firstFail.error, /compaction\.compactNow unavailable/);

  await h.compactor.tick();
  assert.equal(monitorEvents(h.home).filter((event) => event.kind === "idle-compact-fail").length, 1, "冷却内不得重试");

  h.advance(COOLDOWN_MS);
  await h.compactor.tick();
  assert.equal(monitorEvents(h.home).filter((event) => event.kind === "idle-compact-fail").length, 2, "冷却后应重试");
  assert.equal(m.measureCalls(), 0);
});

// —— token 阈值 ——

test("token 等于/低于阈值不压，严格高于才压", async () => {
  for (const [tokens, expected] of [
    [DEFAULT_MIN_TOKENS, 0],
    [DEFAULT_MIN_TOKENS - 1, 0],
    [DEFAULT_MIN_TOKENS + 1, 1],
  ]) {
    const h = makeHarness();
    const m = makeAgent({ tokens });
    h.ctx.get("agents").list().push(m.agent);
    h.compactor.start();
    await m.fireRequest();
    h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
    await h.compactor.tick();
    assert.equal(m.compactCalls(), expected, `tokens=${tokens} 的压缩次数`);
    if (expected === 0) {
      assert.equal(h.compactor.stateOf(m.agent).compactedEpoch, 0, "阈值不够不得消耗纪元");
    }
  }
});

// —— 防重复 / 失败冷却 ——

test("达标只压一次：空闲继续也不重复", async () => {
  const h = makeHarness();
  const m = makeAgent();
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1);
  for (let i = 0; i < 3; i += 1) {
    h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
    await h.compactor.tick();
  }
  assert.equal(m.compactCalls(), 1, "无新请求不得重复压缩");
  assert.equal(h.compactor.stateOf(m.agent).epoch, 1);
});

test("compactNow 返回 null 同样算本轮完成，不重复压", async () => {
  const h = makeHarness();
  const m = makeAgent({ onCompact: () => null });
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1);
  assert.equal(h.compactor.stateOf(m.agent).compactedEpoch, 1, "null 也必须记为已完成");
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1);
  const done = monitorEvents(h.home).filter((event) => event.kind === "idle-compact-done");
  assert.equal(done.length, 1);
  assert.equal(done[0].compacted, false);
});

test("新请求后重新具备资格", async () => {
  const h = makeHarness();
  const m = makeAgent();
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1);

  await m.fireRequest(); // 第二个真实请求 -> epoch 2
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 2);
  assert.equal(h.compactor.stateOf(m.agent).epoch, 2);
});

test("压缩期间排入的新请求纪元不被吞掉", async () => {
  let m;
  let h;
  h = makeHarness();
  m = makeAgent({
    async onCompact() {
      // 压缩（宿主 maintenance）期间真实新请求排队：epoch 应继续前进。
      await m.fireRequest();
      return { ok: true };
    },
  });
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(h.compactor.stateOf(m.agent).epoch, 2);
  assert.equal(h.compactor.stateOf(m.agent).compactedEpoch, 1, "只记触发时的 epoch");

  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 2, "压缩期间排入的新请求必须仍具备资格");
});

test("失败后按 agent 冷却 10 分钟，冷却结束再试", async () => {
  const h = makeHarness();
  let calls = 0;
  const m = makeAgent({
    onCompact() {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("boom"), { code: "boom" });
      return { ok: true };
    },
  });
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1);

  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1, "失败后同一时刻不得重试");

  h.advance(COOLDOWN_MS - 1);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1, "冷却未满不得重试");

  h.advance(1);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 2, "冷却满 10 分钟必须重试");

  const fail = monitorEvents(h.home).filter((event) => event.kind === "idle-compact-fail");
  assert.equal(fail.length, 1);
  assert.equal(fail[0].code, "boom");
});

// —— compactNow 与请求纪元正交 ——

test("compactNow 自身不产生 agent/request：压缩后请求次数不变", async () => {
  const h = makeHarness();
  const m = makeAgent();
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  const first = await m.fireRequest();
  assert.equal(first.calls, 1);
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1);
  assert.equal(h.compactor.stateOf(m.agent).epoch, 1, "压缩不得推进请求纪元");
});

// —— 重入 / dispose ——

test("inflight 重入：压缩进行中第二个 tick 不 measure 不重压", async () => {
  const h = makeHarness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const m = makeAgent({ onCompact: () => gate });
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);

  const first = h.compactor.tick();
  await new Promise((resolve) => setImmediate(resolve));
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1);
  assert.equal(m.measureCalls(), 1, "inflight 期间不得再次 measure");

  release({ ok: true });
  await first;
  assert.equal(h.compactor.inflightCount(), 0);
});

test("dispose：清 interval、abort 进行中的压缩、后续 tick 不再触发", async () => {
  const h = makeHarness();
  let aborted = false;
  const m = makeAgent({
    onCompact: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("cancelled"), { code: "cancelled", name: "ManualCompactionError" }));
      }, { once: true });
    }),
  });
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  assert.equal(h.intervals.length, 1);
  assert.equal(h.intervals[0].ms, TICK_MS);
  assert.equal(h.intervals[0].unrefCalled, true, "定时器必须 unref");
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);

  const pending = h.compactor.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(m.compactCalls(), 1);
  h.compactor.stop();
  assert.equal(h.cleared.length, 1, "dispose 必须 clearInterval");
  assert.equal(aborted, true, "dispose 必须 abort 进行中的压缩");
  assert.equal(m.listeners(), 0, "dispose 必须摘掉 agent/request 监听");
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  const before = m.measureCalls();
  await h.compactor.tick();
  assert.equal(h.compactor.stopped(), true);
  assert.equal(m.measureCalls(), before, "dispose 后不得再 measure");
  const cancelled = monitorEvents(h.home).filter((event) => event.kind === "idle-compact-cancelled");
  assert.equal(cancelled.length, 1);
});

test("waterfall：agent/request 监听调用 next() 并推进单调纪元", async () => {
  const h = makeHarness();
  const m = makeAgent();
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  const first = await m.fireRequest();
  const second = await m.fireRequest();
  assert.equal(first.result, "request-config", "监听必须 return next()");
  assert.equal(second.result, "request-config");
  assert.equal(h.compactor.stateOf(m.agent).epoch, 2);
  assert.equal(h.compactor.stateOf(m.agent).lastRequestAt, h.now());
});

// —— 装载初始化 ——

test("装载时用末会话事件时间保守初始化，之后不按 tick 刷新空闲计时", async () => {
  const start = 1_700_000_000_000;
  const h = makeHarness({ start });
  const lastEvent = start - 2 * 60 * MINUTE_MS;
  const m = makeAgent({ lastEvent });
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();

  assert.equal(h.compactor.stateOf(m.agent).lastRequestAt, lastEvent);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 0, "重启后没有真实请求不得立即压缩");

  // 会话里有后台事件（末事件时间很近）也不得刷新空闲计时。
  m.agent.session.log.push({ time: h.now() });
  await h.compactor.tick();
  assert.equal(h.compactor.stateOf(m.agent).lastRequestAt, lastEvent, "tick 不得读会话末事件");
  assert.equal(m.compactCalls(), 0);

  await m.fireRequest();
  assert.equal(h.compactor.stateOf(m.agent).lastRequestAt, h.now());
  m.agent.session.log.push({ time: h.now() + 10 * MINUTE_MS });
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1, "空闲计时只认真实请求时间");
});

test("lastEventTime 读数字/ISO 时间，读不到返回 undefined", () => {
  assert.equal(lastEventTime({ log: [{ time: 1234 }] }), 1234);
  assert.equal(lastEventTime({ log: [{ time: "2026-01-02T03:04:05.000Z" }] }), Date.parse("2026-01-02T03:04:05.000Z"));
  assert.equal(lastEventTime({ log: [] }), void 0);
  assert.equal(lastEventTime({}), void 0);
  assert.equal(lastEventTime(void 0), void 0);
});

// —— 配置 / 环境开关 ——

test("面板关闭配置后 tick 不 measure 不压", async () => {
  const h = makeHarness({ config: { idleCompactEnabled: false } });
  const m = makeAgent();
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(2 * DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.measureCalls(), 0);
  assert.equal(m.compactCalls(), 0);
  assert.ok(h.configReads() > 0, "每次 tick 应读面板配置");
});

test("面板阈值生效：75 分钟配置下 55 分钟不压、75 分钟才压", async () => {
  const h = makeHarness({ config: { idleCompactMinutes: 75 } });
  const m = makeAgent();
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 0);
  h.advance(20 * MINUTE_MS);
  await h.compactor.tick();
  assert.equal(m.compactCalls(), 1);
});

test("环境总开关 CASEOS_IDLE_COMPACT=0：apply 不注册 effect、tick 不动作", async () => {
  const previous = process.env[ENABLED_ENV];
  process.env[ENABLED_ENV] = "0";
  try {
    let effectCalls = 0;
    let touched = false;
    idleCompact.apply({
      get() {
        touched = true;
        return void 0;
      },
      effect() {
        effectCalls += 1;
      },
    });
    assert.equal(effectCalls, 0, "环境关闭时不得注册 effect/定时器");
    assert.equal(touched, false, "环境关闭时不应访问宿主服务");

    const h = makeHarness();
    const m = makeAgent();
    h.ctx.get("agents").list().push(m.agent);
    h.compactor.start();
    await m.fireRequest();
    h.advance(2 * DEFAULT_IDLE_MINUTES * MINUTE_MS);
    await h.compactor.tick();
    assert.equal(m.measureCalls(), 0);
    assert.equal(m.compactCalls(), 0);
  } finally {
    if (previous === void 0) delete process.env[ENABLED_ENV];
    else process.env[ENABLED_ENV] = previous;
  }
});

test("监控区分 start/done/fail 且只带安全元数据", async () => {
  const h = makeHarness();
  const m = makeAgent({ id: "session-monitor" });
  h.ctx.get("agents").list().push(m.agent);
  h.compactor.start();
  await m.fireRequest();
  h.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await h.compactor.tick();
  const events = monitorEvents(h.home);
  const start = events.find((event) => event.kind === "idle-compact-start");
  const done = events.find((event) => event.kind === "idle-compact-done");
  assert.ok(start !== void 0 && done !== void 0);
  assert.equal(start.agent, "session-monitor");
  assert.equal(start.totalTokens, DEFAULT_MIN_TOKENS + 1);
  assert.equal(start.idleMinutes, DEFAULT_IDLE_MINUTES);
  for (const event of [start, done]) {
    assert.equal(Object.hasOwn(event, "prompt"), false);
    assert.equal(Object.hasOwn(event, "messages"), false);
    assert.equal(Object.hasOwn(event, "text"), false);
  }

  const failing = makeHarness();
  const f = makeAgent({ id: "session-fail", onCompact: () => { throw Object.assign(new Error("nope"), { code: "busy" }); } });
  failing.ctx.get("agents").list().push(f.agent);
  failing.compactor.start();
  await f.fireRequest();
  failing.advance(DEFAULT_IDLE_MINUTES * MINUTE_MS);
  await failing.compactor.tick();
  const fail = monitorEvents(failing.home).find((event) => event.kind === "idle-compact-fail");
  assert.equal(fail.code, "busy");
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(String(error?.stack ?? error));
  }
}
console.log(`test-idle-compact: ${tests.length - failed}/${tests.length} passed`);
process.exit(failed > 0 ? 1 : 0);
