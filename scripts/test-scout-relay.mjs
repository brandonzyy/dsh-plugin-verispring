#!/usr/bin/env node
// 三条闭环的运行时行为测试：纯 node、无依赖，mock ctx 只提供 apply() 实际用到的服务面。
// 覆盖：ask_scout 以领导为 sender 代发并返回新答复；测绘自身/领导/无可达测绘报错；超时文案；
// 结构增量自动转交的三种收尾（有增量、无增量、测绘自己结束）；失败检查点落盘；
// 领导续接命中检查点时拒绝并代发合并消息；代发失败时放行；CASEOS_SCOUT_RELAY=0 全部不生效。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { extractStructureDelta } from "../gates/scout-relay.js";

let harnessSeq = 0;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return void 0;
  }
}

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function makeHarness(options = {}) {
  harnessSeq += 1;
  const home = mkdtempSync(join(tmpdir(), "scout-relay-home-"));
  const stateDir = `${home}/caseos/session-state`;
  const checkpointDir = `${home}/caseos/checkpoints`;
  mkdirSync(stateDir, { recursive: true });

  if (options.relay === false) process.env.CASEOS_SCOUT_RELAY = "0";
  else delete process.env.CASEOS_SCOUT_RELAY;
  if (options.timeoutMs !== void 0) process.env.CASEOS_ASK_SCOUT_TIMEOUT_MS = String(options.timeoutMs);
  else delete process.env.CASEOS_ASK_SCOUT_TIMEOUT_MS;

  const leaderId = `leader-${harnessSeq}`;
  const listeners = new Map();
  const registeredTools = new Map();
  const agentsMap = new Map();
  const sent = [];

  const subagents = {
    async sendMessage(sender, targetId, content, sendOptions) {
      if (options.sendMessage) await options.sendMessage({ sender, targetId, content, sendOptions }, sent);
      const text = content.map((block) => block.text ?? "").join("");
      sent.push({ sender, targetId, text });
      return `msg-${sent.length}`;
    },
  };

  const getCalls = new Map();
  const services = {
    agents: {
      get: (id) => {
        getCalls.set(id, (getCalls.get(id) ?? 0) + 1);
        return agentsMap.get(id);
      },
      list: () => [...agentsMap.values()],
    },
    subagents,
  };
  // systemPrompt 段落：收集注入文案，按 scope 现算（与 leader-scope 同写法）。
  const sections = new Map();

  const ctx = {
    profileContext: { home },
    get: (name) => services[name],
    on: (name, callback) => listeners.set(name, [...(listeners.get(name) ?? []), callback]),
    tools: { register: (definition) => registeredTools.set(definition.name, definition) },
    systemPrompt: {
      getSectionOrder: () => 100,
      section: (definition) => sections.set(definition.name, definition),
    },
  };
  ctx.root = ctx;
  ctx.root.on = ctx.on;
  ctx.root.tools = ctx.tools;
  ctx.root.agents = services.agents;
  ctx.root.subagents = subagents;

  const liveCtx = {
    agents: services.agents,
    subagents,
    get: (name) => services[name],
    root: ctx,
  };
  const leader = { id: leaderId, session: { header: { id: leaderId }, snapshotEvents: () => [] }, ctx: liveCtx };
  agentsMap.set(leaderId, leader);

  // 开关在 apply 读一次（所以要在 apply 前设置）；超时在每次 ask 时读。
  // 用例结束后由 runner 复位这两个变量。
  plugin.apply(ctx);

  const childAgent = (childId, parentId = leaderId, events = []) => {
    const agent = {
      id: childId,
      session: {
        header: { id: childId, origin: "subagent", parentSession: parentId },
        snapshotEvents: () => events,
      },
      ctx: liveCtx,
    };
    agentsMap.set(childId, agent);
    return agent;
  };

  return {
    checkpointDir,
    leader,
    leaderId,
    sent,
    childAgent,
    removeAgent: (childId) => agentsMap.delete(childId),
    getCalls: (childId) => getCalls.get(childId) ?? 0,
    tools: () => registeredTools,
    tool: () => registeredTools.get("ask_scout"),
    emit: async (name, payload) => {
      await Promise.all((listeners.get(name) ?? []).map((callback) => callback(payload)));
    },
    /** 测绘会话事件：宿主按 (session, event) 派发，等待循环据此按 marker 取答案。 */
    emitSession: async (session, event) => {
      await Promise.all((listeners.get("session/event") ?? []).map((callback) => callback(session, event)));
    },
    /** 领导 send_message 的原调用：返回 pre-execute 决定；upstream 模拟其它门禁的决定 */
    sendMessage: async (targetId, message, caller = leader, upstream = { kind: "allow" }) => {
      const handler = (listeners.get("tools/pre-execute") ?? [])[0];
      assert.equal(typeof handler, "function", "应注册 tools/pre-execute");
      const exec = { name: "send_message", agent: caller, arguments: { agent_id: targetId, message } };
      return await handler(exec, async () => upstream);
    },
    primeScout: (scoutId, { unreachable } = {}) => {
      writeFileSync(
        `${stateDir}/${leaderId}.json`,
        `${JSON.stringify({ version: 1, ...(scoutId ? { scoutId } : {}), ...(unreachable ? { scoutUnreachable: unreachable } : {}) })}\n`,
      );
    },
    primeRole: (childId, role) => {
      writeFileSync(`${stateDir}/${childId}.json`, `${JSON.stringify({ version: 1, role })}\n`);
    },
    checkpoint: (childId) => readJson(`${checkpointDir}/${childId}.json`),
    monitor: () => readJsonl(`${home}/verispring-monitor.jsonl`),
    preExecuteCount: () => (listeners.get("tools/pre-execute") ?? []).length,
    /** 子代理提示段：按 scope 现算，返回注入正文（领导/测绘为空串）。 */
    locator: (scope) => sections.get("caseos:scout-relay")?.text({ scope }),
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const userEvent = (text) => ({ type: "user/message", data: { content: [{ type: "text", text }] } });
const assistantEvent = (text) => ({
  type: "assistant/message",
  data: { message: { content: [{ type: "text", text }] } },
});
const turnEndEvent = () => ({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
// 计时器记账替身：转发生成真实计时器，只额外记录创建数与未清除数。用来断言等待循环
// 每轮都由真实计时器让出、结算后不残留（不改变插件看到的计时器语义）。
function instrumentTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = new Set();
  let created = 0;
  globalThis.setTimeout = (callback, ms, ...args) => {
    created += 1;
    const handle = realSetTimeout(() => {
      pending.delete(handle);
      callback(...args);
    }, ms);
    pending.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    pending.delete(handle);
    realClearTimeout(handle);
  };
  return {
    created: () => created,
    pending: () => pending.size,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

const toolCallEvent = (name, path) => ({
  type: "tool/call",
  data: { name, arguments: JSON.stringify({ path }) },
});

test("执行者 ask_scout 以领导 Agent 为 sender 代发，并返回测绘的新答复", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");
  const events = [assistantEvent("上一轮的旧答复，不得返回")];
  harness.childAgent("scout-A", harness.leaderId, events);
  const executor = harness.childAgent("exec-1");
  // 提问之后才出现的新答复
  const marker = "【执行者 exec-1 经 ask_scout 提问";
  events.push(userEvent(`${marker}，请只答事实，带 路径:行号】入口在哪`));
  events.push(assistantEvent("入口在 gates/dispatch-gate.js:346"));

  const value = await harness.tool().execute({ question: "入口在哪" }, { agent: executor, signal: new AbortController().signal });

  assert.equal(value.status, "answered");
  assert.equal(value.scoutId, "scout-A");
  assert.match(value.answer, /gates\/dispatch-gate\.js:346/);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].sender, harness.leader, "sender 必须是领导 Agent");
  assert.equal(harness.sent[0].targetId, "scout-A");
  assert.match(harness.sent[0].text, /【执行者 exec-1 经 ask_scout 提问/);
  assert.match(harness.sent[0].text, /入口在哪/);
  const line = harness.monitor().find((entry) => entry.kind === "ask-scout");
  assert.equal(line.result, "answered");
  assert.equal(line.child, "exec-1");
  assert.equal(line.scout, "scout-A");
  assert.equal(typeof line.elapsedMs, "number");
});

test("测绘自己调、领导调都报无可达测绘", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");
  const scout = harness.childAgent("scout-A");
  await assert.rejects(
    () => harness.tool().execute({ question: "x" }, { agent: scout, signal: new AbortController().signal }),
    /无可达测绘，请在汇报里写明问题，由领导处理/,
  );
  // 领导（非 subagent）调用同样被拒
  await assert.rejects(
    () => harness.tool().execute({ question: "x" }, { agent: harness.leader, signal: new AbortController().signal }),
    /无可达测绘/,
  );
  assert.equal(harness.sent.length, 0);
  assert.ok(harness.monitor().some((entry) => entry.kind === "ask-scout" && entry.result === "unavailable"));
});

test("无可达测绘（无 scoutId 或已标记不可达）时执行者提问报错", async () => {
  for (const prime of [() => {}, (h) => h.primeScout("scout-A", { unreachable: "end=error" })]) {
    const harness = makeHarness();
    prime(harness);
    const executor = harness.childAgent("exec-1");
    await assert.rejects(
      () => harness.tool().execute({ question: "x" }, { agent: executor, signal: new AbortController().signal }),
      /无可达测绘/,
    );
    assert.equal(harness.sent.length, 0);
  }
});

test("测绘未在时限内答复时返回超时文案", async () => {
  const harness = makeHarness({ timeoutMs: 40 });
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, [assistantEvent("只有一个旧结论")]);
  const executor = harness.childAgent("exec-1");

  const value = await harness.tool().execute({ question: "定位在哪" }, { agent: executor, signal: new AbortController().signal });

  assert.equal(value.status, "timeout");
  const rendered = harness.tool().output.render({}, value)[0].text;
  assert.match(rendered, /已转交测绘 scout-A/);
  assert.match(rendered, /未在时限内答复/);
  assert.equal(harness.monitor().find((entry) => entry.kind === "ask-scout").result, "timeout");
});

test("测绘在首轮轮询前离场时等待循环不空转，按时限结束且不残留计时器", async () => {
  const harness = makeHarness({ timeoutMs: 80 });
  harness.primeScout("scout-A");
  // 不把 scout-A 放进 agents：模拟 subagent/end 后宿主已把它摘出注册表。
  const executor = harness.childAgent("exec-1");
  const timers = instrumentTimers();
  let value;
  try {
    value = await harness.tool().execute({ question: "入口在哪" }, { agent: executor, signal: new AbortController().signal });
  } finally {
    timers.restore();
  }

  assert.equal(value.status, "timeout");
  // 80ms 时限 / 250ms 计时器间隔：快照轮询只允许首轮加尾轮，绝不能按微任务次数增长。
  assert.ok(harness.getCalls("scout-A") <= 3, `轮询次数应有界，实际 ${harness.getCalls("scout-A")}`);
  assert.ok(timers.created() <= 3, `每轮只挂一个计时器，实际创建 ${timers.created()}`);
  assert.equal(timers.pending(), 0, "结算后不得残留计时器");
  assert.equal(harness.monitor().find((entry) => entry.kind === "ask-scout").result, "timeout");
});

test("测绘答完即结算离场时仍按会话事件返回正确答案", async () => {
  const hooks = {};
  const harness = makeHarness({
    timeoutMs: 2000,
    sendMessage: async (info) => {
      await hooks.onSend?.(info);
    },
  });
  harness.primeScout("scout-A");
  const scout = harness.childAgent("scout-A", harness.leaderId, []);
  const executor = harness.childAgent("exec-1");
  let asked = "";
  hooks.onSend = ({ content }) => {
    asked = content.map((block) => block.text ?? "").join("");
    // 先让等待循环进入计时器等待，再由事件把答案送达；测绘随后结算离场，
    // 它的内存快照自始至终是空数组，答案只可能来自会话事件。
    setImmediate(() => {
      void (async () => {
        await harness.emitSession(scout.session, userEvent(asked));
        await harness.emitSession(scout.session, assistantEvent("入口在 gates/dispatch-gate.js:346"));
        await harness.emitSession(scout.session, turnEndEvent());
        harness.removeAgent("scout-A");
      })();
    });
  };
  const timers = instrumentTimers();
  let value;
  try {
    value = await harness.tool().execute({ question: "入口在哪" }, { agent: executor, signal: new AbortController().signal });
  } finally {
    timers.restore();
  }

  assert.equal(value.status, "answered");
  assert.equal(value.scoutId, "scout-A");
  assert.equal(value.answer, "入口在 gates/dispatch-gate.js:346");
  assert.ok(harness.getCalls("scout-A") <= 2, `首轮之后就由事件送达，实际轮询 ${harness.getCalls("scout-A")}`);
  assert.equal(timers.pending(), 0, "事件送达后计时器必须清除");
  assert.match(asked, /【执行者 exec-1 经 ask_scout 提问/);
  assert.equal(harness.monitor().find((entry) => entry.kind === "ask-scout").result, "answered");
});

test("测绘结算只带最终输出（没有 turn/end）时也能送达答案", async () => {
  const hooks = {};
  const harness = makeHarness({
    timeoutMs: 2000,
    sendMessage: async (info) => {
      await hooks.onSend?.(info);
    },
  });
  harness.primeScout("scout-A");
  const scout = harness.childAgent("scout-A", harness.leaderId, []);
  const executor = harness.childAgent("exec-1");
  hooks.onSend = ({ content }) => {
    const asked = content.map((block) => block.text ?? "").join("");
    setImmediate(() => {
      void (async () => {
        await harness.emitSession(scout.session, userEvent(asked));
        // 答完即离场：没有 turn/end，最终输出只在 subagent/end 的 lastAssistantMessage 里。
        harness.removeAgent("scout-A");
        await harness.emit("subagent/end", {
          id: "scout-A",
          provider: "spawn",
          stopReason: "completed",
          lastAssistantMessage: [{ type: "text", text: "入口在 gates/dispatch-gate.js:346" }],
        });
      })();
    });
  };
  const timers = instrumentTimers();
  let value;
  try {
    value = await harness.tool().execute({ question: "入口在哪" }, { agent: executor, signal: new AbortController().signal });
  } finally {
    timers.restore();
  }

  assert.equal(value.status, "answered");
  assert.equal(value.answer, "入口在 gates/dispatch-gate.js:346");
  assert.equal(timers.pending(), 0, "结算送达后计时器必须清除");
  assert.equal(harness.monitor().find((entry) => entry.kind === "ask-scout").result, "answered");
});

test("收尾含非「无」的结构增量段时自动转交测绘", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const child = harness.childAgent("exec-1");
  const closing = "## 收尾\n\n## 结构增量\n- 新增 extractStructureDelta 于 gates/scout-relay.js:999\n\n## 风险\n无\n";

  await harness.emit("subagent/end", { id: child.id, provider: "spawn", stopReason: "completed", lastAssistantMessage: [{ type: "text", text: closing }] });

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].sender, harness.leader);
  assert.equal(harness.sent[0].targetId, "scout-A");
  assert.match(harness.sent[0].text, /【结构增量自动转交 · 执行者 exec-1】/);
  assert.match(harness.sent[0].text, /git status --short/);
  assert.match(harness.sent[0].text, /gates\/scout-relay\.js:999/);
  assert.doesNotMatch(harness.sent[0].text, /## 风险/, "只截到下一个同级标题为止");
  const line = harness.monitor().find((entry) => entry.kind === "structure-forward");
  assert.equal(line.child, "exec-1");
  assert.equal(line.scout, "scout-A");
  assert.ok(line.chars > 0);
});

test("结构增量为「无」、缺段、测绘自己结束时都不转交", async () => {
  const cases = [
    { closing: "## 结构增量\n无\n", role: "executor", expect: 0 },
    { closing: "## 结构增量\n- 无。\n", role: "executor", expect: 0 },
    { closing: "## 收尾\n没有这一段\n", role: "executor", expect: 0 },
    { closing: "**结构增量**：新增 foo 于 gates/x.js:1", role: "scout", expect: 0 },
  ];
  for (const item of cases) {
    const harness = makeHarness();
    harness.primeScout("scout-A");
    const childId = item.role === "scout" ? "scout-A" : `exec-${harnessSeq}`;
    harness.childAgent("scout-A", harness.leaderId, []);
    harness.childAgent(childId);
    harness.primeRole(childId, item.role);
    await harness.emit("subagent/end", {
      id: childId,
      provider: "spawn",
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: item.closing }],
    });
    assert.equal(harness.sent.length, item.expect, `${JSON.stringify(item.closing)} role=${item.role}`);
  }
});

test("无可达测绘时结构增量跳过并记 monitor", async () => {
  const harness = makeHarness();
  const child = harness.childAgent("exec-1");
  await harness.emit("subagent/end", {
    id: child.id,
    provider: "spawn",
    stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "## 结构增量\n- 新增 a 于 x.js:1" }],
  });
  assert.equal(harness.sent.length, 0);
  const line = harness.monitor().find((entry) => entry.kind === "structure-forward");
  assert.equal(line.result, "unavailable");
  assert.equal(line.child, "exec-1");
});

test("error 结束时落盘检查点，含改过的文件与最后结论", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const events = [
    toolCallEvent("edit", "gates/scout-relay.js"),
    toolCallEvent("read", "README.md"),
    toolCallEvent("write", "scripts/test-scout-relay.mjs"),
  ];
  const child = harness.childAgent("exec-1", harness.leaderId, events);
  await harness.emit("agent/error", { agent: child, error: { message: "模型超时" } });

  await harness.emit("subagent/end", {
    id: child.id,
    provider: "spawn",
    stopReason: "error",
    lastAssistantMessage: [{ type: "text", text: "改到一半，缺测试" }],
  });

  const checkpoint = harness.checkpoint("exec-1");
  assert.equal(checkpoint.childId, "exec-1");
  assert.equal(checkpoint.parent, harness.leaderId);
  assert.equal(checkpoint.stopReason, "error");
  assert.equal(checkpoint.error, "模型超时");
  assert.equal(checkpoint.lastAssistantText, "改到一半，缺测试");
  assert.deepEqual(checkpoint.editedFiles, ["gates/scout-relay.js", "scripts/test-scout-relay.mjs"]);
  assert.ok(checkpoint.at);
  assert.ok(harness.monitor().some((entry) => entry.kind === "checkpoint-saved" && entry.child === "exec-1"));
});

test("aborted/refusal 也落检查点，completed 不落", async () => {
  for (const stopReason of ["aborted", "refusal"]) {
    const harness = makeHarness();
    harness.primeScout("scout-A");
    harness.childAgent("scout-A", harness.leaderId, []);
    const child = harness.childAgent(`exec-${harnessSeq}`, harness.leaderId, [assistantEvent("半成品")]);
    await harness.emit("subagent/end", { id: child.id, provider: "spawn", stopReason });
    const checkpoint = harness.checkpoint(child.id);
    assert.equal(checkpoint.stopReason, stopReason);
    assert.equal(checkpoint.lastAssistantText, "半成品", "end 缺 lastAssistantMessage 时从事件取");
  }
  const harness = makeHarness();
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const child = harness.childAgent("exec-ok", harness.leaderId, []);
  await harness.emit("subagent/end", { id: child.id, provider: "spawn", stopReason: "completed" });
  assert.equal(harness.checkpoint("exec-ok"), void 0);
});

test("领导 send_message 命中检查点时被拒并携检查点代发，随后删除检查点", async () => {
  const harness = makeHarness();
  mkdirSync(harness.checkpointDir, { recursive: true });
  writeFileSync(`${harness.checkpointDir}/exec-1.json`, `${JSON.stringify({
    childId: "exec-1",
    parent: harness.leaderId,
    stopReason: "error",
    error: "模型超时",
    lastAssistantText: "改到一半",
    editedFiles: ["gates/scout-relay.js"],
    at: "2026-01-01T00:00:00.000Z",
  })}\n`);

  const decision = await harness.sendMessage("exec-1", "继续把测试补完");

  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /已由插件携检查点代发给 exec-1，无需重发/);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].sender, harness.leader);
  assert.match(harness.sent[0].text, /【插件检查点：上次因 error 中断】/);
  assert.match(harness.sent[0].text, /gates\/scout-relay\.js/);
  assert.match(harness.sent[0].text, /改到一半/);
  assert.match(harness.sent[0].text, /请从检查点继续，不要从头调研/);
  assert.match(harness.sent[0].text, /继续把测试补完/);
  assert.equal(existsSync(`${harness.checkpointDir}/exec-1.json`), false);
  assert.ok(harness.monitor().some((entry) => entry.kind === "checkpoint-injected" && entry.child === "exec-1"));
});

test("代发失败时放行原调用，检查点保留", async () => {
  const harness = makeHarness({
    sendMessage: () => {
      throw new Error('subagent "exec-1" is unavailable');
    },
  });
  mkdirSync(harness.checkpointDir, { recursive: true });
  writeFileSync(`${harness.checkpointDir}/exec-1.json`, `${JSON.stringify({
    childId: "exec-1",
    parent: harness.leaderId,
    stopReason: "error",
    lastAssistantText: "改到一半",
    editedFiles: [],
    at: "2026-01-01T00:00:00.000Z",
  })}\n`);

  const decision = await harness.sendMessage("exec-1", "继续");

  assert.equal(decision.kind, "allow");
  assert.ok(existsSync(`${harness.checkpointDir}/exec-1.json`), "检查点必须保留");
  assert.ok(harness.monitor().some((entry) => entry.kind === "checkpoint-inject-failed"));
});

test("上游门禁已拒绝时不改写它的决定", async () => {
  const harness = makeHarness();
  mkdirSync(harness.checkpointDir, { recursive: true });
  writeFileSync(`${harness.checkpointDir}/exec-1.json`, `${JSON.stringify({
    childId: "exec-1",
    parent: harness.leaderId,
    stopReason: "error",
    at: "2026-01-01T00:00:00.000Z",
  })}\n`);

  const decision = await harness.sendMessage("exec-1", "继续", harness.leader, { kind: "deny", reason: "别的原因" });

  assert.equal(decision.reason, "别的原因");
  assert.equal(harness.sent.length, 0);
  assert.ok(existsSync(`${harness.checkpointDir}/exec-1.json`), "检查点不得被消费");
});

test("无检查点或别的会话的检查点都不拦截 send_message", async () => {
  const harness = makeHarness();
  assert.equal((await harness.sendMessage("exec-1", "继续")).kind, "allow");

  mkdirSync(harness.checkpointDir, { recursive: true });
  writeFileSync(`${harness.checkpointDir}/exec-2.json`, `${JSON.stringify({
    childId: "exec-2",
    parent: "another-leader",
    stopReason: "error",
    at: "2026-01-01T00:00:00.000Z",
  })}\n`);
  assert.equal((await harness.sendMessage("exec-2", "继续")).kind, "allow");
  assert.equal(harness.sent.length, 0);
});

test("执行者提示注入：有可达测绘指 ask_scout，无可达测绘改为写进汇报，领导与测绘为空", () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");
  const scout = harness.childAgent("scout-A");
  harness.primeRole("scout-A", "scout");
  const executor = harness.childAgent("exec-1");

  const withScout = harness.locator(executor);
  assert.match(withScout, /ask_scout 问常驻测绘 scout-A/);
  assert.match(withScout, /不要自己通读实现/);
  assert.match(withScout, /结构增量/);
  assert.match(withScout, /没有就写「无」/);
  // 简语规则：一条、且明写不影响结构增量段
  assert.match(withScout, /收尾报告用简语：每句只说一件事/);
  assert.match(withScout, /先结论后理由/);
  assert.match(withScout, /测试读数逐字保留/);
  assert.match(withScout, /否定词（「无」「不」「禁止」等）绝不省略/);
  assert.match(withScout, /安全警告与不可逆操作提示用完整句/);
  assert.match(withScout, /「结构增量」段不受简语影响/);
  assert.ok(withScout.split("\n").length <= 4, "注入不超过 4 行");

  // 测绘自己与领导不注入
  assert.equal(harness.locator(scout), "");
  assert.equal(harness.locator(harness.leader), "");

  // 无可达测绘：同一段改用「写进汇报」
  const lonely = makeHarness();
  const lonelyExec = lonely.childAgent("exec-noscout");
  const without = lonely.locator(lonelyExec);
  assert.match(without, /没有可达测绘/);
  assert.match(without, /写进汇报/);
  assert.doesNotMatch(without, /ask_scout 问常驻测绘/);
  assert.match(without, /结构增量/);
  // 简语规则两条分支一致
  assert.match(without, /收尾报告用简语：每句只说一件事/);
  assert.match(without, /「结构增量」段不受简语影响/);
  assert.ok(without.split("\n").length <= 4, "注入不超过 4 行");
});

test("CASEOS_SCOUT_RELAY=0 时工具、转交、检查点、注入全部不生效", async () => {
  const harness = makeHarness({ relay: false });
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const child = harness.childAgent("exec-1", harness.leaderId, [toolCallEvent("edit", "gates/scout-relay.js")]);

  assert.equal(harness.tools().has("ask_scout"), false);
  assert.equal(harness.preExecuteCount(), 0);
  assert.equal(harness.locator(child), void 0, "关闭后不得注入提示段");

  await harness.emit("subagent/end", {
    id: child.id,
    provider: "spawn",
    stopReason: "error",
    lastAssistantMessage: [{ type: "text", text: "## 结构增量\n- 新增 x 于 gates/x.js:1" }],
  });
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.checkpoint("exec-1"), void 0);
});

test("extractStructureDelta 覆盖标题变体与截断边界", () => {
  assert.equal(extractStructureDelta("## 结构增量\n- 新增 a 于 x.js:1\n## 风险\n略"), "- 新增 a 于 x.js:1");
  assert.equal(extractStructureDelta("### 结构增量：新增 b 于 y.js:2"), "新增 b 于 y.js:2");
  assert.equal(extractStructureDelta("**结构增量**\n- 移动 c"), "- 移动 c");
  assert.equal(extractStructureDelta("结构增量：删除 d"), "删除 d");
  assert.equal(extractStructureDelta("- 结构增量：新增 e 于 z.js:3\n- 风险：低"), "新增 e 于 z.js:3");
  assert.equal(extractStructureDelta("## 结构增量\n- 无\n"), void 0);
  assert.equal(extractStructureDelta("## 结构增量\n无。\n"), void 0);
  assert.equal(extractStructureDelta("## 结构增量\n"), void 0);
  assert.equal(extractStructureDelta("## 收尾\n只有别的段"), void 0);
  assert.equal(extractStructureDelta(""), void 0);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    delete process.env.CASEOS_ASK_SCOUT_TIMEOUT_MS;
    delete process.env.CASEOS_SCOUT_RELAY;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(String(error?.stack ?? error).split("\n").slice(0, 6).join("\n"));
  }
}
console.log(`scout-relay: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
