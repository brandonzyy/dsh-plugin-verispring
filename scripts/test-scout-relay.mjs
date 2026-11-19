#!/usr/bin/env node
// 三条闭环的运行时行为测试：纯 node、无依赖，mock ctx 只提供 apply() 实际用到的服务面。
// 覆盖：ask_scout 以领导为 sender 代发并返回新答复；测绘自身/领导/无可达测绘报错；超时文案；
// 结构增量自动转交的三种收尾（有增量、无增量、测绘自己结束）；转交附插件实测事实与核实纪律
// （本地 bare 仓当 origin + clone 作工作区，真实 git 输出算数）；失败检查点落盘；
// 领导续接命中检查点时拒绝并代发合并消息；代发失败时放行；CASEOS_SCOUT_RELAY=0 全部不生效。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  // 会话头 cwd 是插件事实计算的工作区来源（与 dispatch-gate 同源）；不传即无 cwd，
  // 用于「取不到工作区」的退化口径。
  const leader = {
    id: leaderId,
    session: { header: { id: leaderId, ...(options.cwd ? { cwd: options.cwd } : {}) }, snapshotEvents: () => [] },
    ctx: liveCtx,
  };
  agentsMap.set(leaderId, leader);

  // 开关在 apply 读一次（所以要在 apply 前设置）；超时在每次 ask 时读。
  // 用例结束后由 runner 复位这两个变量。
  plugin.apply(ctx);

  const childAgent = (childId, parentId = leaderId, events = [], childOptions = {}) => {
    const agent = {
      id: childId,
      session: {
        header: {
          id: childId,
          origin: "subagent",
          parentSession: parentId,
          ...(childOptions.cwd ? { cwd: childOptions.cwd } : {}),
        },
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

// ---- 转交事实段夹具：本地 bare 仓当 origin + clone 作工作区，不碰真实远端与真实仓 ----

const GIT_CONFIG = ["-c", "user.email=gate@test", "-c", "user.name=gate", "-c", "core.hooksPath=/dev/null"];
const gitRoots = [];

function relayGit(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...GIT_CONFIG, ...args], { encoding: "utf8" }).trim();
}

function relayCommit(cwd, name) {
  mkdirSync(join(cwd, name, ".."), { recursive: true });
  writeFileSync(join(cwd, name), `${name}\n`);
  relayGit(cwd, ["add", "--", name]);
  relayGit(cwd, ["commit", "-q", "-m", `add ${name}`, "--", name]);
}

// bare 当 origin，donor 推种子提交后 clone，origin/HEAD 由 clone 正常建立。
function makeRelayRepo() {
  const root = mkdtempSync(join(tmpdir(), "scout-relay-repo-"));
  gitRoots.push(root);
  const bare = join(root, "origin.git");
  relayGit(root, ["init", "-q", "--bare", "-b", "main", bare]);
  const donor = join(root, "donor");
  relayGit(root, ["init", "-q", "-b", "main", donor]);
  relayCommit(donor, "seed.md");
  relayGit(donor, ["push", "-q", bare, "main"]);
  const work = join(root, "work");
  relayGit(root, ["clone", "-q", bare, work]);
  return { root, work };
}

// 迁移文件推进 origin/main：事实读的是远端跟踪 ref，只在工作区提交未推送的文件不算数。
function pushMigrations(work) {
  for (let n = 1; n <= 12; n += 1) {
    const prefix = n < 12 ? String(n).padStart(3, "0") : String(n);
    relayCommit(work, `backend/migrations/${prefix}_${String.fromCharCode(96 + n)}.sql`);
  }
  relayGit(work, ["push", "-q", "origin", "main"]);
}

// 无远端的普通仓：originHead 无读数，迁移与 worktree 事实改由 HEAD 与本地命令提供。
function makeRelayPlain() {
  const plain = mkdtempSync(join(tmpdir(), "scout-relay-plain-"));
  gitRoots.push(plain);
  relayGit(plain, ["init", "-q", "-b", "main", "."]);
  relayCommit(plain, "a.md");
  return plain;
}

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

const emitExecutorEnd = async (harness, childId, deltaLine) => {
  await harness.emit("subagent/end", {
    id: childId,
    provider: "spawn",
    stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: `## 结构增量\n- ${deltaLine}` }],
  });
};

test("转交附插件实测事实：origin/main 真实 sha、迁移最大号 12、worktree 原文含额外树", async () => {
  const { root, work } = makeRelayRepo();
  pushMigrations(work);
  relayGit(work, ["worktree", "add", "-q", "-b", "wt-extra", join(root, "extra-tree")]);
  const sha = relayGit(work, ["rev-parse", "refs/remotes/origin/main"]);
  const harness = makeHarness({ cwd: work });
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const child = harness.childAgent("exec-1");

  await emitExecutorEnd(harness, child.id, "新增 a 于 gates/a.js:1");

  assert.equal(harness.sent.length, 1);
  const text = harness.sent[0].text;
  assert.match(text, /【结构增量自动转交 · 执行者 exec-1】/);
  assert.match(text, /【插件实测事实（转交前由插件执行，照抄，勿凭记忆改写）】/);
  assert.match(text, new RegExp(`- origin/main = ${sha}（git fetch 成功）`));
  assert.match(text, /- 迁移目录最大编号：backend\/migrations=12（12 个）/);
  assert.match(text, /- git worktree list 原文：/);
  // macOS 的 tmpdir 在 /var 下是软链，git worktree list 输出的是 realpath。
  const realRoot = realpathSync(root);
  const realWork = realpathSync(work);
  assert.ok(text.includes(`  ${join(realRoot, "extra-tree")} `), "worktree 原文应含额外树路径");
  assert.ok(text.includes(`  ${realWork} `), "worktree 原文应含工作区自身");
});

test("核实纪律硬规则：fetch+merge-base 判据、未核实/未核对，不再要求回报最新全表", async () => {
  const { work } = makeRelayRepo();
  pushMigrations(work);
  const harness = makeHarness({ cwd: work });
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const child = harness.childAgent("exec-2");

  await emitExecutorEnd(harness, child.id, "新增 b 于 gates/b.js:2");

  assert.equal(harness.sent.length, 1);
  const text = harness.sent[0].text;
  assert.match(text, /git fetch 之后 git merge-base --is-ancestor <sha> origin\/main 的输出/);
  assert.match(text, /没有输出就写「未核实」/);
  assert.match(text, /分支头存在、已推送、PR 状态均不等于已并入/);
  assert.match(text, /未核对的标「未核对」/);
  assert.match(text, /git status --short/);
  assert.match(text, /不能证明任何合并状态/);
  assert.match(text, /照抄，不得凭记忆改写/);
  assert.match(text, /以命令输出为准并回报差异/);
  assert.equal(text.includes("回报最新全表"), false, "不得再要求测绘回报最新全表");
});

test("fetch 失败：转交照发、origin 行标注失败、monitor fetchOk=false、远端路径不泄漏", async () => {
  const { root, work } = makeRelayRepo();
  pushMigrations(work);
  const missing = join(root, "missing-origin.git");
  relayGit(work, ["remote", "set-url", "origin", missing]);
  const sha = relayGit(work, ["rev-parse", "refs/remotes/origin/main"]);
  const harness = makeHarness({ cwd: work });
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const child = harness.childAgent("exec-3");

  await emitExecutorEnd(harness, child.id, "新增 c 于 gates/c.js:3");

  assert.equal(harness.sent.length, 1, "fetch 失败不得拦转交");
  const text = harness.sent[0].text;
  assert.equal(text.includes(missing), false, "远端路径不得出现在消息里");
  assert.match(text, new RegExp(`- origin/main = ${sha}（git fetch 失败：读数可能过期）`));
  const line = harness.monitor().find((entry) => entry.kind === "structure-forward" && entry.result === "forwarded");
  assert.equal(line.fetchOk, false);
  assert.equal(JSON.stringify(harness.monitor()).includes(missing), false, "远端路径不得出现在 monitor 里");
});

test("取不到 cwd：转交照发、事实段写未取到、relay-facts-unavailable 记录", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const child = harness.childAgent("exec-4");

  await emitExecutorEnd(harness, child.id, "新增 d 于 gates/d.js:4");

  assert.equal(harness.sent.length, 1, "取不到 cwd 不得中断转交");
  assert.match(harness.sent[0].text, /插件未取到工作区，事实未附/);
  const unavailable = harness.monitor().find((entry) => entry.kind === "relay-facts-unavailable");
  assert.equal(unavailable.child, "exec-4");
  assert.equal(unavailable.reason, "no-cwd");
  const line = harness.monitor().find((entry) => entry.kind === "structure-forward" && entry.result === "forwarded");
  assert.equal(line.factsAttached, false);
  assert.equal(line.fetchOk, false);
  assert.equal(line.originSha7, void 0);
});

test("领导会话头没有 cwd 时退回子代理会话头的 cwd，事实照常附", async () => {
  const { work } = makeRelayRepo();
  const harness = makeHarness();
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const child = harness.childAgent("exec-5", harness.leaderId, [], { cwd: work });

  await emitExecutorEnd(harness, child.id, "新增 e 于 gates/e.js:5");

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /- git worktree list 原文：/);
  assert.equal(harness.monitor().some((entry) => entry.kind === "relay-facts-unavailable"), false);
});

test("无 origin：迁移改读 HEAD、origin 行写不得报已并入、fetchOk=false", async () => {
  const plain = makeRelayPlain();
  relayCommit(plain, "backend/migrations/007_x.sql");
  const harness = makeHarness({ cwd: plain });
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const child = harness.childAgent("exec-6");

  await emitExecutorEnd(harness, child.id, "新增 f 于 gates/f.js:6");

  assert.equal(harness.sent.length, 1);
  const text = harness.sent[0].text;
  assert.match(text, /- 无 origin 远端，不得报告任何「已并入」/);
  assert.match(text, /- 迁移目录最大编号：backend\/migrations=7（1 个）/);
  assert.match(text, /- git worktree list 原文：/);
  const line = harness.monitor().find((entry) => entry.kind === "structure-forward" && entry.result === "forwarded");
  assert.equal(line.factsAttached, true);
  assert.equal(line.fetchOk, false, "无 remote 时 fetch 不可成功");
  assert.equal(line.originSha7, void 0);
});

test("monitor structure-forward payload 附 factsAttached/fetchOk/originSha7", async () => {
  const { work } = makeRelayRepo();
  pushMigrations(work);
  const sha = relayGit(work, ["rev-parse", "refs/remotes/origin/main"]);
  const harness = makeHarness({ cwd: work });
  harness.primeScout("scout-A");
  harness.childAgent("scout-A", harness.leaderId, []);
  const child = harness.childAgent("exec-7");

  await emitExecutorEnd(harness, child.id, "新增 g 于 gates/g.js:7");

  const line = harness.monitor().find((entry) => entry.kind === "structure-forward" && entry.result === "forwarded");
  assert.equal(line.child, "exec-7");
  assert.equal(line.scout, "scout-A");
  assert.equal(line.factsAttached, true);
  assert.equal(line.fetchOk, true);
  assert.equal(line.originSha7, sha.slice(0, 7));
  assert.match(line.originSha7, /^[0-9a-f]{7}$/);
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
for (const root of gitRoots) rmSync(root, { recursive: true, force: true });
if (failed > 0) process.exit(1);
