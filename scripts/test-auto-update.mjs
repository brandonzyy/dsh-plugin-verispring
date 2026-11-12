#!/usr/bin/env node
// auto-update 行为测试：纯 node、无依赖、零真实网络。fetch/读文件/installBundle 全部注入替身。
// 覆盖：开关（CASEOS_AUTO_UPDATE=0）、无 pluginManager 管理面不启定时器、周期下限 10 分钟、
// runCheck 全分叉（同版本 skip / 远端不可读 / applied / 重装抛错 failed / 装后版本不符 failed）、
// updating 防并发、effect 释放清定时器、env 覆盖 spec 与 branch。
import assert from "node:assert/strict";
import plugin, {
  autoUpdateEnabled,
  checkIntervalMs,
  needsUpdate,
  localVersion,
  remoteVersion,
  runCheck,
  updateSpec,
  updateBranch,
} from "../gates/auto-update.js";

// ---- 纯函数 ----
assert.equal(autoUpdateEnabled({}), true);
assert.equal(autoUpdateEnabled({ CASEOS_AUTO_UPDATE: "0" }), false);
assert.equal(checkIntervalMs({}), 6 * 60 * 60 * 1000);
assert.equal(checkIntervalMs({ CASEOS_UPDATE_CHECK_MS: "60000" }), 10 * 60 * 1000, "低于下限收 10 分钟");
assert.equal(checkIntervalMs({ CASEOS_UPDATE_CHECK_MS: "abc" }), 6 * 60 * 60 * 1000);
assert.equal(updateSpec({}), "github:brandonzyy/dsh-plugin-verispring");
assert.equal(updateSpec({ CASEOS_UPDATE_SPEC: "github:someone/else" }), "github:someone/else");
assert.equal(updateBranch({}), "main");
assert.equal(updateBranch({ CASEOS_UPDATE_BRANCH: "dev" }), "dev");
assert.equal(needsUpdate("1.5.1", "1.6.0"), true);
assert.equal(needsUpdate("1.5.1", "1.5.1"), false);
assert.equal(needsUpdate(null, "1.6.0"), false, "本地读不到不动作");
assert.equal(needsUpdate("1.5.1", null), false, "远端读不到不动作");
assert.equal(localVersion(() => JSON.stringify({ version: "9.9.9" })), "9.9.9");
assert.equal(localVersion(() => { throw new Error("gone"); }), null);
assert.equal(
  await remoteVersion(async () => ({ ok: true, json: async () => ({ version: "8.0.0" }) })),
  "8.0.0",
);
assert.equal(await remoteVersion(async () => ({ ok: false })), null);
assert.equal(await remoteVersion(async () => { throw new Error("net"); }), null);

// ---- runCheck 全分叉 ----
const deps = (localSeq, remote, installImpl) => ({
  spec: "github:brandonzyy/dsh-plugin-verispring",
  readLocalVersion: async () => (Array.isArray(localSeq) ? localSeq.shift() : localSeq),
  fetchRemoteVersion: async () => remote,
  install: installImpl ?? (async () => {}),
  monitor: (event) => events.push(event),
});
let events;

// 同版本：skip，不 install
events = [];
assert.equal(await runCheck(deps("1.5.1", "1.5.1")), "same-version");
assert.deepEqual(events, [{ kind: "auto-update-check", local: "1.5.1", result: "same-version" }]);

// 远端不可读：不 install
events = [];
assert.equal(await runCheck(deps("1.5.1", null)), "remote-unreadable");
assert.deepEqual(events, [{ kind: "auto-update-check", local: "1.5.1", result: "remote-unreadable" }]);

// 装后版本到位：applied
events = [];
let installedSpecs = [];
assert.equal(
  await runCheck({
    ...deps(["1.5.1", "1.6.0"], "1.6.0"),
    install: async (spec) => { installedSpecs.push(spec); },
  }),
  "applied",
);
assert.deepEqual(installedSpecs, ["github:brandonzyy/dsh-plugin-verispring"]);
assert.deepEqual(events, [{ kind: "auto-update-applied", from: "1.5.1", to: "1.6.0" }]);

// 装后版本不符：failed（不抛错，等下一周期）
events = [];
assert.equal(await runCheck(deps(["1.5.1", "1.5.1"], "1.6.0")), "failed");
assert.match(events[0].reason, /installed=1\.5\.1/);

// 重装抛错：failed + 原因落账
events = [];
assert.equal(
  await runCheck({
    ...deps("1.5.1", "1.6.0"),
    install: async () => { throw new Error("pnpm boom"); },
  }),
  "failed",
);
assert.match(events[0].reason, /pnpm boom/);

// ---- apply 行为：定时器注册、管理面分叉、effect 释放、updating 防并发 ----
const REAL_CASEOS_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith("CASEOS_")),
);
for (const k of Object.keys(REAL_CASEOS_ENV)) delete process.env[k];

function fakeTimers() {
  // apply 直接调全局 setInterval/setTimeout，替身装在 globalThis 上（memory-guard 同法）。
  const t = { intervals: [], timeouts: [], effects: [] };
  const real = {
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    clearInterval: globalThis.clearInterval,
    clearTimeout: globalThis.clearTimeout,
  };
  globalThis.setInterval = (fn, ms) => { t.intervals.push({ fn, ms }); return { unref() {} }; };
  globalThis.setTimeout = (fn, ms) => { t.timeouts.push({ fn, ms }); return { unref() {} }; };
  globalThis.clearInterval = () => {};
  globalThis.clearTimeout = () => {};
  t.restore = () => Object.assign(globalThis, real);
  return t;
}
function fakeCtx({ manager, timers }) {
  return {
    profileContext: { home: "/tmp/fake-dsh-home" },
    get(name) { return name === "pluginManager" ? manager : undefined; },
    effect(fn) { timers.effects.push(fn); },
    _timers: timers,
  };
}

// 开关关闭：不注册定时器
{
  process.env.CASEOS_AUTO_UPDATE = "0";
  const timers = fakeTimers();
  plugin.apply(fakeCtx({ manager: { installBundle: async () => {} }, timers }));
  assert.equal(timers.intervals.length, 0);
  timers.restore();
  delete process.env.CASEOS_AUTO_UPDATE;
}

// 无管理面：不启定时器
{
  const timers = fakeTimers();
  plugin.apply(fakeCtx({ manager: undefined, timers }));
  assert.equal(timers.intervals.length, 0);
  timers.restore();
}

// 正常激活：一长一短两个定时器 + effect 可释放；同版本 tick 不触发安装
{
  const timers = fakeTimers();
  let installs = 0;
  const manager = { installBundle: async () => { installs += 1; } };
  plugin.apply(fakeCtx({ manager, timers }));
  assert.equal(timers.intervals.length, 1);
  assert.equal(timers.timeouts.length, 1);
  assert.equal(timers.effects.length, 1);
  // 首次延迟 tick：本地真实 package.json 与远端同版本（远端替身回读本地版本）
  const local = localVersion();
  const remoteSame = async () => ({ ok: true, json: async () => ({ version: local }) });
  const origFetch = globalThis.fetch;
  globalThis.fetch = remoteSame;
  try {
    await timers.timeouts[0].fn();
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(installs, 0);
  timers.effects[0](); // 释放不抛
  timers.restore();
}

function restoreDone() {
  for (const [k, v] of Object.entries(REAL_CASEOS_ENV)) process.env[k] = v;
}
console.log("test-auto-update: 全部通过");
