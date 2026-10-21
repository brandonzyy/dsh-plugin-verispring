#!/usr/bin/env node
// memory-guard 行为测试：纯 node、无依赖，mock ctx 只提供 apply() 实际用到的服务面。
// 定时器用替身（globalThis.setInterval 记录回调，不发真实定时器），内存读数用
// process.memoryUsage 替身，V8 顶棚用 v8.getHeapStatistics 替身，文件大小用 fs.statSync
// 替身，时间用 Date.now 替身推进——用例里没有 sleep、没有真实 IO。覆盖：启动自报
// （mem-guard-boot：heapLimitBytes/nodeArgv/pid/阈值来源/readGuard）、
// 比例阈值（4GiB→2.4/3.2GiB、8GiB→4.8/6.4GiB、env 覆盖）与顶棚读数兜底、软阈值触发/不触发、
// 只放空闲且 inbox 清空的子代理、缓存回收、5 分钟冷却、忙闲判定（运行中子代理 / 近 90s 工具
// 活动）、硬阈值降级（宿主不自动重启，只落 monitor + stderr）、15s 默认采样与 env 覆盖、
// subagent/end 与 tools/post-execute 即时检查、整读门（read 与 bash 整读动词的 deny、
// 受控形态放行、白名单、开关、stat/路径解析失败放行、子代理会话同样受检）、
// CASEOS_MEM_GUARD=0 全关、作用域释放时清定时器。
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import v8 from "node:v8";
import plugin, {
  bashReadPaths,
  heapLimitBytes,
  memoryDecision,
  proportionalThresholds,
  readToolReadPath,
} from "../gates/memory-guard.js";
import scoutRelay, { releaseIdleCaches as releaseRelayCaches } from "../gates/scout-relay.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const ENV_KEYS = [
  "CASEOS_MEM_GUARD",
  "CASEOS_MEM_CHECK_MS",
  "CASEOS_MEM_SOFT_BYTES",
  "CASEOS_MEM_HARD_BYTES",
  "CASEOS_READ_GUARD",
  "CASEOS_READ_GUARD_MAX_BYTES",
  "CASEOS_READ_GUARD_ALLOW",
  "CASEOS_SCOUT_RELAY",
  "CASEOS_ASK_SCOUT_TIMEOUT_MS",
];
const realMemoryUsage = process.memoryUsage;
const realGetHeapStatistics = v8.getHeapStatistics;
const realStatSync = fs.statSync;
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
  v8.getHeapStatistics = realGetHeapStatistics;
  fs.statSync = realStatSync;
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
  const limit = options.heapLimitBytes ?? 4 * GIB;
  // 顶棚替身：默认 4GiB（与 Electron 实测顶棚 4.09GiB 的档位一致），断掉对测试机真实堆上限的依赖。
  v8.getHeapStatistics = () => {
    if (options.heapLimitUnknown === true) throw new Error("v8 heap statistics unavailable");
    return { heap_size_limit: limit };
  };
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
  // 文件大小替身：只有 files 里登记过的路径是普通文件，其余按不存在处理（throwIfNoEntry:false
  // 返回 undefined，等价于 stat 失败）。statThrows 模拟权限/异常路径。
  const statCalls = [];
  const files = new Map(Object.entries(options.files ?? {}));
  fs.statSync = (path, statOptions) => {
    statCalls.push(path);
    if (options.statThrows === true) throw new Error(`stat failed: ${path}`);
    if (!files.has(path)) {
      if (statOptions?.throwIfNoEntry === false) return void 0;
      const error = new Error(`ENOENT: no such file or directory, stat '${path}'`);
      error.code = "ENOENT";
      throw error;
    }
    return { isFile: () => true, size: files.get(path) };
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
  const cwd = options.cwd ?? "/workspace";
  const workingDirectory = { ensure: async () => cwd };
  const services = { agents, subagents, workingDirectory };

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

  const harnessWaterfall = async (name, args, base) => {
    let next = base;
    for (const listener of [...(listeners.get(name) ?? [])].reverse()) {
      const downstream = next;
      next = () => listener(...args, downstream);
    }
    return next();
  };

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
    statCalls,
    pre: (exec) => harnessWaterfall("tools/pre-execute", [exec], async () => ({ kind: "allow" })),
    post: (exec, result) => harnessWaterfall("tools/post-execute", [exec, result], async () => result),
    // 即时检查是 void 调用：等一轮宏任务让它的微任务链跑完，用例因此不需要 sleep。
    flush: () => new Promise((resolve) => setImmediate(resolve)),
    tick: async () => {
      const interval = intervals.at(-1);
      assert.ok(interval, "apply 应注册定时器");
      await interval.fn();
    },
    monitor: () => readJsonl(`${home}/verispring-monitor.jsonl`),
    // boot 行是每次 apply 都落的自报，动作断言要看 actions()。
    boot: () => readJsonl(`${home}/verispring-monitor.jsonl`).find((entry) => entry.kind === "mem-guard-boot"),
    actions: () => readJsonl(`${home}/verispring-monitor.jsonl`).filter((entry) => entry.kind !== "mem-guard-boot"),
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("比例阈值纯函数：4GiB 顶棚≈2.4/3.2GiB，8GiB 顶棚≈4.8/6.4GiB", () => {
  const four = proportionalThresholds(4 * GIB);
  assert.equal(four.softBytes, Math.floor(4 * GIB * 0.6));
  assert.equal(four.hardBytes, Math.floor(4 * GIB * 0.8));
  // floor 与旧的 Math.round(2.4GiB) 差 1 字节，属于分母取整差，档位不变。
  assert.ok(Math.abs(four.softBytes - 2.4 * GIB) < 1);
  assert.ok(Math.abs(four.hardBytes - 3.2 * GIB) < 1);

  const eight = proportionalThresholds(8 * GIB);
  assert.equal(eight.softBytes, Math.floor(8 * GIB * 0.6));
  assert.equal(eight.hardBytes, Math.floor(8 * GIB * 0.8));
  assert.ok(Math.abs(eight.softBytes - 4.8 * GIB) < 1);
  assert.ok(Math.abs(eight.hardBytes - 6.4 * GIB) < 1);
});

test("启动自报：mem-guard-boot 带 heapLimitBytes/nodeArgv/pid 与比例阈值来源", () => {
  const harness = makeHarness({ heapLimitBytes: 4 * GIB });
  const line = harness.boot();
  assert.ok(line, "激活时应落 mem-guard-boot");
  assert.equal(line.heapLimitBytes, 4 * GIB);
  assert.deepEqual(line.nodeArgv, process.execArgv);
  assert.equal(line.pid, process.pid);
  assert.equal(line.thresholdsSource, "proportional");
  assert.equal(line.softBytes, Math.floor(4 * GIB * 0.6));
  assert.equal(line.hardBytes, Math.floor(4 * GIB * 0.8));
  assert.equal(typeof line.checkMs, "number");
});

test("8GiB 顶棚：阈值抬到 4.8/6.4GiB，heapUsed 5GiB 落在软阈值段", async () => {
  const harness = makeHarness({ heapLimitBytes: 8 * GIB, heapUsed: 5 * GIB });
  assert.equal(harness.boot().softBytes, Math.floor(8 * GIB * 0.6));
  assert.equal(harness.boot().hardBytes, Math.floor(8 * GIB * 0.8));
  await harness.tick();
  const line = harness.actions().find((entry) => entry.kind === "mem-guard-skip");
  assert.equal(line?.reason, "soft-threshold-no-targets", "5GiB 不该被当成 8GiB 顶棚下的硬阈值");
});

test("env 覆盖：显式 CASEOS_MEM_* 优先，thresholdsSource=env；单侧覆盖另一侧仍按比例", () => {
  const both = makeHarness({
    heapLimitBytes: 8 * GIB,
    env: { CASEOS_MEM_SOFT_BYTES: 1024, CASEOS_MEM_HARD_BYTES: 2048 },
  });
  assert.equal(both.boot().softBytes, 1024);
  assert.equal(both.boot().hardBytes, 2048);
  assert.equal(both.boot().thresholdsSource, "env");

  const one = makeHarness({ heapLimitBytes: 8 * GIB, env: { CASEOS_MEM_SOFT_BYTES: 1024 } });
  assert.equal(one.boot().softBytes, 1024);
  assert.equal(one.boot().hardBytes, Math.floor(8 * GIB * 0.8));
  assert.equal(one.boot().thresholdsSource, "env");
});

test("顶棚读数失败：兜底 4GiB 并照常按比例出阈值，看门狗不因读数异常失活", () => {
  const harness = makeHarness({ heapLimitUnknown: true });
  assert.equal(harness.boot().heapLimitBytes, 4 * GIB);
  assert.equal(harness.boot().softBytes, Math.floor(4 * GIB * 0.6));
  assert.equal(harness.boot().hardBytes, Math.floor(4 * GIB * 0.8));
  assert.equal(harness.boot().thresholdsSource, "proportional");
  assert.equal(typeof heapLimitBytes(), "number");
});

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

test("软阈值以下：tick 与 subagent/end 都不产生动作（boot 自报除外）", async () => {
  const harness = makeHarness({ heapUsed: 1 * GIB });
  const leader = harness.primeAgent("leader-1");
  harness.primeAgent("child-idle", { origin: "subagent", parentSession: leader.id });
  harness.makeResident("child-idle");
  await harness.tick();
  await harness.emit("subagent/end", { id: "child-idle" });
  assert.deepEqual(harness.actions(), [], "boot 自报不算动作");
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
  assert.equal(line.hardBytes, Math.floor(4 * GIB * 0.8));
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

test("CASEOS_MEM_GUARD=0：不装定时器、不挂监听、不留监控（含不落 boot 自报）", async () => {
  const harness = makeHarness({ guard: false, heapUsed: 3.5 * GIB });
  assert.equal(harness.intervals.length, 0);
  assert.equal(harness.disposers.length, 0);
  assert.equal(harness.boot(), void 0);
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

// ---- v3：整读门（read-guard）与采样加密 ----------------------------------------

const BIG = 64 * MIB;

test("read-guard 解析：只认整读动词；sed -n 行范围与 head/tail 限量属受控，歧义放行", () => {
  assert.deepEqual(bashReadPaths("cat /big/a.log"), ["/big/a.log"]);
  assert.deepEqual(bashReadPaths("cat -n /big/a.log /big/b.log"), ["/big/a.log", "/big/b.log"]);
  assert.deepEqual(bashReadPaths("base64 /big/a.log"), ["/big/a.log"]);
  assert.deepEqual(bashReadPaths("cat /big/a.log && xxd /big/b.bin"), ["/big/a.log", "/big/b.bin"]);
  // 受控读取：sed 行范围、head/tail 限量、tail 默认 10 行
  assert.deepEqual(bashReadPaths("sed -n '10,20p' /big/a.log"), []);
  assert.deepEqual(bashReadPaths("sed -n '/err/p' /big/a.log"), ["/big/a.log"]);
  assert.deepEqual(bashReadPaths("sed -n '1,$p' /big/a.log"), ["/big/a.log"]);
  assert.deepEqual(bashReadPaths("head -n 5 /big/a.log"), []);
  assert.deepEqual(bashReadPaths("head /big/a.log"), []);
  assert.deepEqual(bashReadPaths("tail -n 5 /big/a.log"), []);
  assert.deepEqual(bashReadPaths("tail -n +1 /big/a.log"), ["/big/a.log"]);
  // 非读命令完全不进检查面
  assert.deepEqual(bashReadPaths("grep -n err /big/a.log"), []);
  assert.deepEqual(bashReadPaths("ls -la /big/a.log"), []);
  // 解析歧义：重定向、命令替换、引号不闭合、sed -i/-e
  assert.deepEqual(bashReadPaths("cat /big/a.log > /dev/null"), []);
  assert.deepEqual(bashReadPaths("cat $(ls /big)"), []);
  assert.deepEqual(bashReadPaths("cat '/big/a.log"), []);
  assert.deepEqual(bashReadPaths("sed -i 's/a/b/' /big/a.log"), []);
  // read 工具：带 offset/limit 不是整读
  assert.equal(readToolReadPath("read", { file_path: "/big/a.log" }), "/big/a.log");
  assert.equal(readToolReadPath("read", { file_path: "/big/a.log", limit: 50 }), void 0);
  assert.equal(readToolReadPath("read", { file_path: "/big/a.log", offset: 10 }), void 0);
  assert.equal(readToolReadPath("write", { file_path: "/big/a.log" }), void 0);
});

test("read-guard：read 整读超限被拒，理由给出 offset/limit 与 sed 分段读法，落 mem-guard-read-deny", async () => {
  const harness = makeHarness({ files: { "/big/session.log": BIG } });
  const agent = harness.primeAgent("leader-1");
  const decision = await harness.pre({ name: "read", arguments: { file_path: "/big/session.log" }, agent });

  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /64\.0 MB/, "理由要写明刚被拒文件的大小");
  assert.match(decision.reason, /offset\/limit/);
  assert.match(decision.reason, /sed -n 'a,bp'/);
  assert.match(decision.reason, /会话日志/);
  const line = harness.actions().find((entry) => entry.kind === "mem-guard-read-deny");
  assert.ok(line, "应落 mem-guard-read-deny");
  assert.equal(line.gate, "read-guard");
  assert.equal(line.tool, "read");
  assert.equal(line.path, "/big/session.log");
  assert.equal(line.size, BIG);
  assert.equal(line.session, "leader-1");
});

test("read-guard：bash 的整读动词超限被拒（cat/base64），wc 只出计数不查，阈值边界放行", async () => {
  const harness = makeHarness({
    files: { "/big/a.log": BIG, "/big/edge.log": 2 * MIB, "/big/over.log": 2 * MIB + 1 },
  });
  const agent = harness.primeAgent("leader-1");
  const cat = await harness.pre({ name: "bash", arguments: { command: "cat /big/a.log" }, agent });
  assert.equal(cat.kind, "deny");
  assert.match(cat.reason, /\/big\/a\.log 有 64\.0 MB/);

  const b64 = await harness.pre({ name: "bash", arguments: { command: "base64 /big/a.log" }, agent });
  assert.equal(b64.kind, "deny");

  // wc 只输出计数不倾倒内容，不在检查面（非读命令，根本不 stat）
  assert.deepEqual(bashReadPaths("wc -c /big/a.log"), []);

  // 阈值是「大于」：等于上限放行，多 1 字节拒绝
  const edge = await harness.pre({ name: "bash", arguments: { command: "cat /big/edge.log" }, agent });
  assert.equal(edge.kind, "allow");
  const over = await harness.pre({ name: "bash", arguments: { command: "cat /big/over.log" }, agent });
  assert.equal(over.kind, "deny");
});

test("read-guard：受控形态与非读命令放行，且根本不 stat", async () => {
  const harness = makeHarness({ files: { "/big/a.log": BIG } });
  const agent = harness.primeAgent("leader-1");
  const allowed = [
    { name: "read", arguments: { file_path: "/big/a.log", limit: 100 } },
    { name: "bash", arguments: { command: "sed -n '10,20p' /big/a.log" } },
    { name: "bash", arguments: { command: "head -n 5 /big/a.log" } },
    { name: "bash", arguments: { command: "tail -n 5 /big/a.log" } },
    { name: "bash", arguments: { command: "grep -n err /big/a.log" } },
    { name: "bash", arguments: { command: "ls -la /big/a.log" } },
    { name: "bash", arguments: { command: "pnpm test 2>&1 | tail -5" } },
    { name: "edit", arguments: { file_path: "/big/a.log" } },
  ];
  for (const exec of allowed) {
    assert.equal((await harness.pre({ ...exec, agent })).kind, "allow", JSON.stringify(exec));
  }
  assert.deepEqual(harness.statCalls, [], "放行路径不该产生 stat");
  assert.deepEqual(harness.actions(), []);
});

test("read-guard：CASEOS_READ_GUARD_ALLOW 前缀放行，邻近同名前缀不放行，~ 展开", async () => {
  const homeLog = `${homedir()}/logs/huge.log`;
  const harness = makeHarness({
    files: { "/big/session.log": BIG, "/bigger/session.log": BIG, [homeLog]: BIG },
    env: { CASEOS_READ_GUARD_ALLOW: "/big, ~/logs" },
  });
  const agent = harness.primeAgent("leader-1");
  assert.equal((await harness.pre({ name: "read", arguments: { file_path: "/big/session.log" }, agent })).kind, "allow");
  assert.equal((await harness.pre({ name: "read", arguments: { file_path: homeLog }, agent })).kind, "allow");
  const denied = await harness.pre({ name: "read", arguments: { file_path: "/bigger/session.log" }, agent });
  assert.equal(denied.kind, "deny", "前缀匹配按目录边界，/big 不能放行 /bigger");
});

test("read-guard：CASEOS_READ_GUARD=0 全关（不检查、不落事件，boot 自报 readGuard=false）", async () => {
  const harness = makeHarness({ files: { "/big/session.log": BIG }, env: { CASEOS_READ_GUARD: "0" } });
  const agent = harness.primeAgent("leader-1");
  const decision = await harness.pre({ name: "read", arguments: { file_path: "/big/session.log" }, agent });
  assert.equal(decision.kind, "allow");
  assert.deepEqual(harness.statCalls, []);
  assert.deepEqual(harness.actions(), []);
  assert.equal(harness.boot().readGuard, false);
  assert.equal(harness.boot().readGuardMaxBytes, void 0);
});

test("read-guard：stat 失败/文件不存在/相对路径拿不到 cwd 一律放行；有 cwd 时按 cwd 解析", async () => {
  const missing = makeHarness({ heapUsed: 1 * GIB });
  const missingAgent = missing.primeAgent("leader-1");
  assert.equal((await missing.pre({ name: "read", arguments: { file_path: "/big/gone.log" }, agent: missingAgent })).kind, "allow");

  const throwing = makeHarness({ statThrows: true, files: { "/big/a.log": BIG } });
  const throwingAgent = throwing.primeAgent("leader-1");
  assert.equal((await throwing.pre({ name: "read", arguments: { file_path: "/big/a.log" }, agent: throwingAgent })).kind, "allow");

  // 没有 agent 就拿不到会话 cwd：相对路径解析不出 → 放行，且不 stat
  const noAgent = makeHarness({ files: { "/workspace/local.log": BIG } });
  assert.equal((await noAgent.pre({ name: "read", arguments: { file_path: "local.log" } })).kind, "allow");
  assert.deepEqual(noAgent.statCalls, []);

  // 有 agent（cwd=/workspace）时相对路径照常受检
  const resolved = makeHarness({ files: { "/workspace/local.log": BIG } });
  const resolvedAgent = resolved.primeAgent("leader-1");
  assert.equal((await resolved.pre({ name: "read", arguments: { file_path: "local.log" }, agent: resolvedAgent })).kind, "deny");
  assert.deepEqual(resolved.statCalls, ["/workspace/local.log"]);
});

test("read-guard：子代理会话同样受检（根 ctx 监听器收到子代理的调用，事件带子代理会话）", async () => {
  const harness = makeHarness({ files: { "/big/session.log": BIG } });
  const leader = harness.primeAgent("leader-1");
  const child = harness.primeAgent("child-1", { origin: "subagent", parentSession: leader.id });
  const decision = await harness.pre({ name: "bash", arguments: { command: "cat /big/session.log" }, agent: child });
  assert.equal(decision.kind, "deny");
  const line = harness.actions().find((entry) => entry.kind === "mem-guard-read-deny");
  assert.equal(line.session, "child-1");
});

test("采样加密：默认 15s，boot 自报 checkMs 照实报，CASEOS_MEM_CHECK_MS 仍可覆盖", () => {
  const harness = makeHarness({});
  assert.equal(harness.intervals.at(-1).ms, 15000);
  assert.equal(harness.boot().checkMs, 15000);

  const custom = makeHarness({ env: { CASEOS_MEM_CHECK_MS: 5000 } });
  assert.equal(custom.intervals.at(-1).ms, 5000);
  assert.equal(custom.boot().checkMs, 5000);
});

test("tools/post-execute 即时检查：结果落地后不等定时器就补一次采样，且不吞结果", async () => {
  const harness = makeHarness({ heapUsed: 1 * GIB });
  harness.primeAgent("leader-1");
  harness.setHeap(2.5 * GIB);

  const result = await harness.post({ name: "bash" }, { value: "ok" });
  assert.deepEqual(result, { value: "ok" }, "post-execute 必须把下游结果返回");
  await harness.flush();

  const line = harness.actions().find((entry) => entry.kind === "mem-guard-skip" && entry.reason === "soft-threshold-no-targets");
  assert.ok(line, "post-execute 后应立即补一次检查");
  assert.equal(line.heapUsed, 2.5 * GIB);
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
