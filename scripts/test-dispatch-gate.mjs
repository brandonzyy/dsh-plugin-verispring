#!/usr/bin/env node
// 派遣门禁行为测试：纯 node、无依赖，mock ctx 只提供 apply() 实际用到的服务面。
// 核心不变量「常驻=可达」：可达测绘重复派遣被拒；end 非 completed 或 send_message 报
// NOT_RESUMABLE 之后重派自动接替为测绘并注入地图；监控只在启动成功后记 start。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../gates/dispatch-gate.js";

const MAP_TEXT = "## 入口表\n- gates/dispatch-gate.js: 派遣门禁\n- scripts/smoke-test.mjs: 冒烟\n";
const SPEC_TEXT = "# 子代理派遣规范\n";
let harnessSeq = 0;

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function makeHarness(options = {}) {
  harnessSeq += 1;
  const home = mkdtempSync(join(tmpdir(), "verispring-gate-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "verispring-gate-cwd-"));
  mkdirSync(`${cwd}/.git`, { recursive: true });
  if (options.map !== false) writeFileSync(`${cwd}/.project-map.md`, options.map ?? MAP_TEXT);

  const sessionId = `session-${harnessSeq}`;
  const session = {
    header: { id: sessionId, cwd, origin: "leader" },
    seq: 1,
    // 规范已读门：会话首个事件里带《子代理派遣规范》首行标记即视为已读。
    eventAt: (index) => (index === 0
      ? { type: "tool/result", data: { message: { content: [{ type: "text", text: SPEC_TEXT }] } } }
      : undefined),
  };

  const listeners = new Map();
  const guards = [];
  const calls = { activation: [], select: [], rename: [] };
  const childAgents = new Map();
  const agents = {
    list: () => [],
    get: (id) => childAgents.get(id),
    isOwnedBy: () => false,
  };
  const sessionTitle = { get: () => void 0, rename: (target, title) => calls.rename.push([target, title]) };
  const sessionController = { agents: { selectForNextRequest: (...args) => calls.select.push(args) } };
  const services = { agents, sessionTitle, sessionController, sessionProjections: { stateOf: () => void 0 } };

  const spawned = async (spec, index) => {
    if (options.startActivation) return options.startActivation(spec, index, home);
    return { childId: `child-${harnessSeq}-${index}` };
  };
  const subagents = {
    startActivation: async (spec) => {
      calls.activation.push(spec);
      const child = await spawned(spec, calls.activation.length);
      childAgents.set(child.childId, {
        id: child.childId,
        session: { header: { id: child.childId, origin: "subagent", parentSession: sessionId } },
        ctx: liveCtx,
      });
      return child;
    },
  };
  services.subagents = subagents;

  // root 层：静态入口；options.scopedOnly 时模拟"全局注册不可用"，只能挂在会话层。
  const rootTools = new Map();
  const ctx = {
    profileContext: { home },
    get: (name) => services[name],
    on: (name, callback) => listeners.set(name, [...(listeners.get(name) ?? []), callback]),
    tools: {
      guard: (callback) => guards.push(callback),
      register: (definition) => {
        if (options.scopedOnly) throw new Error('cannot get required service "tools" in inactive context');
        rootTools.set(definition.name, definition);
      },
      get: (name) => rootTools.get(name),
      // 宿主语义：root 层没有 scope，restrict 必抛；门禁不得依赖它。
      restrict: () => {
        throw new Error('cannot get required service "tools" in inactive context');
      },
    },
  };
  ctx.root = ctx;
  ctx.root.on = ctx.on;

  // 会话层注入面：安装领导入口时宿主给的 rtc（scoped tools + subagents）。
  const scopedTools = new Map();
  const scopedRestricted = [];
  const scopedSubagents = {
    startActivation: async (spec) => {
      calls.activation.push(spec);
      if (options.scopedStartActivation) return options.scopedStartActivation(spec);
      return { childId: `scoped-${harnessSeq}-${calls.activation.length}` };
    },
  };
  const rtc = {
    tools: {
      get: (name) => scopedTools.get(name),
      register: (definition) => scopedTools.set(definition.name, definition),
      restrict: (spec) => scopedRestricted.push(spec),
    },
    subagents: scopedSubagents,
  };

  plugin.apply(ctx);

  const liveCtx = {
    agents,
    subagents,
    sessionController,
    get: (name) => services[name],
    root: ctx,
    inject: (_names, callback) => callback(rtc),
  };
  const leader = { id: sessionId, session, ctx: liveCtx };
  const routedTool = () => rootTools.get("subagent") ?? scopedTools.get("subagent");

  return {
    leader,
    scopedTools,
    scopedRestricted,
    calls,
    emit: (name, payload) => {
      for (const callback of listeners.get(name) ?? []) callback(payload);
    },
    /** 走所有 guard 回调，返回第一条拒绝文案 */
    guard: (args, agent = leader) => {
      const exec = { name: "subagent", agent, arguments: args };
      for (const callback of guards) {
        const reason = callback(exec);
        if (typeof reason === "string") return reason;
      }
      return void 0;
    },
    /** 领导 send_message 的结果（tools/result 广播） */
    sendMessageResult: (agentId, result, agent = leader) => {
      const exec = { name: "send_message", agent, arguments: { agent_id: agentId, message: "继续" } };
      for (const callback of listeners.get("tools/result") ?? []) callback(exec, result);
    },
    /** 让插件安装会话层领导入口（agent/created 与 agent/pre-step 都走这里） */
    install: async (agent = leader) => {
      for (const callback of listeners.get("agent/pre-step") ?? []) await callback({ agent }, () => {});
    },
    tool: () => routedTool(),
    dispatch: async (args, agent = leader) => routedTool().execute(args, { agent }),
    /** 直接写一条"上任测绘"状态，模拟跨进程遗留 */
    primeScout: (scoutId) => {
      mkdirSync(`${home}/caseos/session-state`, { recursive: true });
      writeFileSync(`${home}/caseos/session-state/${sessionId}.json`, `${JSON.stringify({ version: 1, scoutId })}\n`);
    },
    scoutState: () => {
      try {
        return JSON.parse(readFileSync(`${home}/caseos/session-state/${sessionId}.json`, "utf8"));
      } catch {
        return void 0;
      }
    },
    monitor: () => readJsonl(`${home}/verispring-monitor.jsonl`),
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("有可达测绘时重复派遣测绘被拒，两种前缀都识别", () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");

  for (const description of ["scout: 建图", "测绘智能体：建图", "Scout 建图"]) {
    const reason = harness.guard({ description, prompt: "任务" });
    assert.equal(typeof reason, "string", `description=${description} 应被拒`);
    assert.match(reason, /scout-A 仍可达/);
    assert.match(reason, /send_message scout-A/);
    assert.match(reason, /finished\/inactive 属正常/);
  }
  assert.equal(harness.guard({ description: "执行任务", prompt: "x" }), void 0);
});

test("测绘 end=completed 仍算可达，不解除常驻", () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");

  harness.emit("subagent/end", { id: "scout-A", provider: "spawn", stopReason: "completed" });

  assert.equal(harness.scoutState().scoutUnreachable, void 0);
  assert.match(harness.guard({ description: "scout: 再建一次", prompt: "x" }), /scout-A 仍可达/);
});

test("测绘 end=error 后重派自动接替为测绘并注入地图全文", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");

  harness.emit("subagent/end", { id: "scout-A", provider: "spawn", stopReason: "error", error: { message: "模型超时" } });
  assert.equal(harness.scoutState().scoutUnreachable, "end=error");
  // 修订文案已经不带 touch 解锁：description 随便写，可达性说了算。
  assert.equal(harness.guard({ description: "随便写什么都行", prompt: "增量校对" }), void 0);

  const result = await harness.dispatch({ description: "随便写什么都行", prompt: "增量校对" });

  assert.equal(harness.calls.activation.length, 1);
  const spec = harness.calls.activation[0];
  assert.match(spec.label, / · scout · /);
  const prompt = spec.request.prompt[0].text;
  assert.match(prompt, /【实际路由：scout/);
  assert.match(prompt, /【测绘接替】上任测绘 scout-A end=error/);
  assert.match(prompt, /仓库已有地图/);
  assert.ok(prompt.includes("gates/dispatch-gate.js: 派遣门禁"), "地图全文应注入任务书");
  assert.match(prompt, /只做增量校对/);

  // 新测绘接任常驻：scoutId 换人，失联标记清空，路由按活上下文落到子代理。
  assert.equal(harness.scoutState().scoutId, result.subagentId);
  assert.equal(harness.scoutState().scoutUnreachable, void 0);
  assert.equal(harness.calls.select.length, 1);
  assert.equal(harness.calls.select[0][0].id, result.subagentId);
  // 标题是延迟重写的（宿主自动起名会覆盖一次），等第一个定时器落下再看。
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(harness.calls.rename.some(([, title]) => title.includes(" · scout · ")), "子代理标题应写实际路由");
});

test("send_message 报 NOT_RESUMABLE 后解除常驻，下一笔派遣可为测绘", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");

  harness.sendMessageResult("scout-A", {
    isError: true,
    error: { message: 'subagent "scout-A" is unavailable', info: { code: "NOT_RESUMABLE" } },
  });
  assert.equal(harness.scoutState().scoutUnreachable, "NOT_RESUMABLE");
  assert.ok(harness.monitor().some((line) => line.kind === "scout-unreachable" && line.child === "scout-A"));

  assert.equal(harness.guard({ description: "scout: 重派", prompt: "x" }), void 0);
  await harness.dispatch({ description: "scout: 重派", prompt: "x" });
  assert.equal(harness.calls.activation.length, 1);
  assert.match(harness.calls.activation[0].label, / · scout · /);
});

test("无关的 send_message 失败不解除常驻", () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");

  harness.sendMessageResult("scout-A", {
    isError: true,
    error: { message: "direct parent is not live; the message was not delivered", info: { code: "PARENT_UNAVAILABLE" } },
  });

  assert.equal(harness.scoutState().scoutUnreachable, void 0);
  assert.match(harness.guard({ description: "scout: 再派", prompt: "x" }), /scout-A 仍可达/);
});

test("启动失败只写 subagent-start-failed（带 error/code），不写 start、不记 scoutId", async () => {
  const harness = makeHarness({
    startActivation: () => {
      throw Object.assign(new Error("宿主拒绝激活"), { code: "ACTIVATION_TEARDOWN_FAILED" });
    },
  });

  await assert.rejects(() => harness.dispatch({ description: "scout: 建图", prompt: "x" }), /宿主拒绝激活/);

  const lines = harness.monitor();
  assert.equal(lines.filter((line) => line.kind === "subagent-start").length, 0);
  const failed = lines.find((line) => line.kind === "subagent-start-failed");
  assert.ok(failed, "失败必须留一条 subagent-start-failed");
  assert.equal(failed.error, "宿主拒绝激活");
  assert.equal(failed.code, "ACTIVATION_TEARDOWN_FAILED");
  assert.equal(failed.role, "scout");
  assert.equal(harness.scoutState(), void 0, "启动失败不得记 scoutId");
});

test("启动成功后才写 subagent-start，且带子代理 id", async () => {
  // 在 startActivation 内部读一次监控：此刻仍是"启动中"，不得已有 start 记录。
  let linesDuringSpawn;
  const harness = makeHarness({
    startActivation: (spec, index, home) => {
      assert.match(spec.request.prompt[0].text, /【实际路由：scout/);
      linesDuringSpawn = readJsonl(`${home}/verispring-monitor.jsonl`);
      return { childId: `child-late-${index}` };
    },
  });

  const result = await harness.dispatch({ description: "scout: 建图", prompt: "x" });

  assert.deepEqual(linesDuringSpawn, [], "启动过程中不得提前记 start");
  const start = harness.monitor().find((line) => line.kind === "subagent-start");
  assert.ok(start, "成功后必须记 subagent-start");
  assert.equal(start.role, "scout");
  assert.equal(start.child, result.subagentId);
});

test("end 记录 error message/code，agent/error 记 subagent-error", () => {
  const harness = makeHarness();

  harness.emit("subagent/end", {
    id: "scout-B",
    provider: "spawn",
    stopReason: "error",
    error: { message: "上下文溢出", code: "E_CONTEXT" },
  });
  const end = harness.monitor().find((line) => line.kind === "subagent-end" && line.child === "scout-B");
  assert.ok(end, "end 必须落盘");
  assert.equal(end.stopReason, "error");
  assert.equal(end.error, "上下文溢出");
  assert.equal(end.code, "E_CONTEXT");

  harness.emit("agent/error", {
    agent: { id: "child-9", session: { header: { origin: "subagent", parentSession: "session-parent" } } },
    error: new Error("模型 500"),
  });
  const errorLine = harness.monitor().find((line) => line.kind === "subagent-error");
  assert.ok(errorLine, "子代理报错必须落盘");
  assert.equal(errorLine.child, "child-9");
  assert.equal(errorLine.parent, "session-parent");
  assert.match(errorLine.message, /模型 500/);
});

test("闭包 ctx 失活时用活 ctx 重试一次启动成功", async () => {
  // 全局注册不可用 → 入口只能挂在会话层，执行体持有注入时拿到的 rtc；
  // rtc 是旧作用域（inactive），而 exec.agent.ctx 是活的：必须自动改走活 ctx。
  const harness = makeHarness({
    scopedOnly: true,
    scopedStartActivation: () => {
      throw new Error('cannot get required service "agents" in inactive context');
    },
  });
  harness.scopedTools.set("subagent-base", {
    name: "subagent-base",
    description: "官方基座",
    parameters: { type: "object", properties: { description: { type: "string" }, prompt: { type: "string" } } },
  });

  await harness.install(harness.leader);
  assert.ok(harness.scopedTools.get("subagent")?.__caseosRouted, "会话层入口应已注册");
  assert.ok(harness.scopedRestricted.some((spec) => spec.deny.includes("subagent-base")), "基座应在会话层隐藏");

  const result = await harness.tool().execute({ description: "scout: 建图", prompt: "x" }, { agent: harness.leader });

  assert.ok(result.subagentId, "重试后应拿到子代理 id");
  const lines = harness.monitor();
  assert.equal(lines.filter((line) => line.kind === "subagent-start-failed").length, 0);
  assert.equal(lines.filter((line) => line.kind === "subagent-start").length, 1);
});

test("活 ctx 也失活时给出明确拒绝文案并留失败记录", async () => {
  const harness = makeHarness({
    startActivation: () => {
      throw new Error('cannot get required service "agents" in inactive context');
    },
  });

  await assert.rejects(
    () => harness.dispatch({ description: "scout: 建图", prompt: "x" }),
    /宿主 agents 服务不可用（会话上下文已失效），请刷新会话后重派/,
  );
  const failed = harness.monitor().filter((line) => line.kind === "subagent-start-failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /inactive context/);
});

test("无地图且无可达测绘时放行测绘（首笔派测绘不受地图门禁拦截）", async () => {
  const harness = makeHarness({ map: false });

  assert.equal(harness.guard({ description: "测绘智能体：建图", prompt: "x" }), void 0);
  const result = await harness.dispatch({ description: "测绘智能体：建图", prompt: "建图" });
  assert.ok(result.subagentId);
  assert.match(harness.calls.activation[0].request.prompt[0].text, /【实际路由：scout/);
});

test("无地图派执行者被地图门禁拦下", () => {
  const harness = makeHarness({ map: false });
  harness.primeScout("scout-A");

  const reason = harness.guard({ description: "改代码", prompt: "x" });
  assert.equal(typeof reason, "string");
  assert.match(reason, /\.project-map\.md/);
});

test("测绘身份按状态目录隔离：别的 profile 的同名 id 不会互相污染", async () => {
  const first = makeHarness();
  const second = makeHarness();
  first.primeScout("scout-shared");
  second.primeScout("scout-shared");

  // 第一份状态里 scout-shared 结束失败，不得把第二份的常驻判成失联。
  first.emit("subagent/end", { id: "scout-shared", provider: "spawn", stopReason: "error" });

  assert.equal(first.scoutState().scoutUnreachable, "end=error");
  assert.equal(second.scoutState().scoutUnreachable, void 0);
  assert.match(second.guard({ description: "scout: 再派", prompt: "x" }), /scout-shared 仍可达/);
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
console.log(`test-dispatch-gate: ${tests.length - failed}/${tests.length} passed`);
// 门禁的重试标题定时器最长 10s，测试不等它自然走完：结论已定，直接收尾。
process.exit(failed > 0 ? 1 : 0);
