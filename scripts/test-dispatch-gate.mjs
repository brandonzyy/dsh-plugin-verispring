#!/usr/bin/env node
// 派遣门禁行为测试：纯 node、无依赖，mock ctx 只提供 apply() 实际用到的服务面。
// 核心不变量「常驻=可达」：可达测绘重复派遣被拒；end 非 completed 或 send_message 报
// NOT_RESUMABLE 之后重派自动接替为测绘并注入地图；监控只在启动成功后记 start。
// 第二组不变量（执行派遣的代码级门禁）：调研型任务书拦截、地图基准登记与新鲜度、
// 执行子代理并发上限、回执保留 started subagent 前缀并附路由。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../gates/dispatch-gate.js";

const MAP_TEXT = "## 入口表\n- gates/dispatch-gate.js: 派遣门禁\n- scripts/smoke-test.mjs: 冒烟\n";
const SPEC_TEXT = "# 子代理派遣规范\n";
const GIT_CONFIG = ["-c", "user.email=gate@test", "-c", "user.name=gate", "-c", "core.hooksPath=/dev/null"];
let harnessSeq = 0;

// 夹具仓库：门禁的地图新鲜度门用真 git 判定，提交夹具必须走真实 git。
function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...GIT_CONFIG, ...args], { encoding: "utf8" }).trim();
}

function commitFile(cwd, name) {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, ["add", "--", name]);
  const message = join(cwd, ".git", `msg-${name}`);
  writeFileSync(message, `add ${name}\n`);
  git(cwd, ["commit", "-q", "-F", message, "--", name]);
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
  const home = mkdtempSync(join(tmpdir(), "verispring-gate-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "verispring-gate-cwd-"));
  if (options.git) {
    git(cwd, ["init", "-q", "."]);
    for (let i = 0; i < (options.commits ?? 1); i += 1) commitFile(cwd, `file-${i}.md`);
  } else mkdirSync(`${cwd}/.git`, { recursive: true });
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
  const roleFiles = () => `${home}/caseos/session-state`;
  // 宿主 agents 注册表：运行中与否只看 status，归属由 session 血缘给出（与 leader-guard 同口径）。
  const seedAgent = ({ id, status = "running", role, parentSession = sessionId, owned = false }) => {
    const agent = { id, status, session: { header: { id, origin: "subagent", parentSession } } };
    childAgents.set(id, agent);
    if (role) {
      mkdirSync(roleFiles(), { recursive: true });
      writeFileSync(`${roleFiles()}/${id}.json`, `${JSON.stringify({ version: 1, role })}\n`);
    }
    return agent;
  };
  for (const entry of options.running ?? []) seedAgent(entry);
  const agents = {
    list: () => [...childAgents.values()],
    get: (id) => childAgents.get(id),
    isOwnedBy: (childId, leader) => childAgents.get(childId)?.owned === true && leader !== void 0,
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
  const stateDir = `${home}/caseos/session-state`;
  const baselineFile = `${home}/caseos/map-baselines.json`;
  const head = () => git(cwd, ["rev-parse", "HEAD"]);

  return {
    leader,
    cwd,
    scopedTools,
    scopedRestricted,
    calls,
    seedAgent,
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
    /** 领导的工具结果（tools/result 广播）：地图基准登记走这条 */
    toolResult: (name, args, agent = leader) => {
      const exec = { name, agent, arguments: args };
      for (const callback of listeners.get("tools/result") ?? []) callback(exec, { isError: false });
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
    /** 回执渲染（宿主与 client.js 读的那段文本） */
    receipt: (value) => routedTool().output.render({}, value)[0].text,
    /** 直接写一条"上任测绘"状态，模拟跨进程遗留 */
    primeScout: (scoutId) => {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(`${stateDir}/${sessionId}.json`, `${JSON.stringify({ version: 1, scoutId })}\n`);
    },
    scoutState: () => {
      try {
        return JSON.parse(readFileSync(`${stateDir}/${sessionId}.json`, "utf8"));
      } catch {
        return void 0;
      }
    },
    head,
    /** 夹具仓库前进一个提交（地图新鲜度门的「main 前进」） */
    commit: (name) => commitFile(cwd, name),
    baseline: () => {
      try {
        return JSON.parse(readFileSync(baselineFile, "utf8"))[cwd]?.commit;
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

// ---- 执行派遣的代码级门禁：调研措辞、地图基准、并发上限、回执 ----

// 环境变量是唯一来源：每条用例自己设置，退出时恢复，避免串味。
async function withEnv(vars, fn) {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === void 0) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("任务书命中调研型措辞被拒，文案指路常驻测绘并留 dispatch-deny", () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");

  const reason = harness.guard({ description: "改代码", prompt: "先调研一下这个模块的现状" });
  assert.equal(typeof reason, "string");
  assert.match(reason, /任务书含调研型措辞『先调研』/);
  assert.match(reason, /send_message scout-A/);
  assert.match(reason, /执行任务书只写改哪里、改成什么、怎么验证/);

  const line = harness.monitor().find((entry) => entry.kind === "dispatch-deny");
  assert.ok(line, "每条拒绝都要落 dispatch-deny");
  assert.equal(line.rule, "brief-lint");
  assert.equal(line.tool, "subagent");
  assert.match(line.reason, /先调研/);
});

test("英文调研措辞同样被拦，执行任务书不误伤", () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");

  for (const term of ["investigate first", "research first", "read the source to figure out"]) {
    assert.match(harness.guard({ description: "改代码", prompt: `please ${term} then edit` }), /调研型措辞/);
  }
  for (const term of ["先查清", "查清楚再", "先摸清", "读源码确认", "通读", "先读懂", "拿不准先读", "自行调研", "先排查根因再", "调研后再"]) {
    assert.match(harness.guard({ description: "改代码", prompt: `请${term}动手` }), /调研型措辞/);
  }
  assert.equal(
    harness.guard({ description: "改代码", prompt: "改 gates/x.js:12，把 a 改成 b，跑 node scripts/test-dispatch-gate.mjs" }),
    void 0,
  );
});

test("调研措辞带否定前缀时豁免（「不要通读实现」「禁止先调研」）", () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");

  const allowed = [
    "不要通读实现，改 gates/x.js:12 即可",
    "禁止先调研，直接按任务书改 gates/x.js",
    "严禁自行调研，坐标已由测绘给出",
    "别先读懂整个模块，只看 gates/x.js:12",
    "无需查清楚再动手",
    "不必先摸清，入口 gates/x.js:12",
    "勿读源码确认，事实在任务书里",
    "do not investigate first, just edit gates/x.js",
    "never read the source to figure out; the scout already did",
    "don't research first",
  ];
  for (const prompt of allowed) {
    assert.equal(harness.guard({ description: "改代码", prompt }), void 0, `应放行：${prompt}`);
  }

  // 否定只豁免它自己那一次：同一任务书里另有一处未被否定仍然拒。
  assert.match(
    harness.guard({ description: "改代码", prompt: "不要通读实现，接下来先调研现状再改" }),
    /任务书含调研型措辞『先调研』/,
  );
  // 否定词必须紧邻命中词（6 个字符以内），离远了不算豁免。
  assert.match(harness.guard({ description: "改代码", prompt: "不必在动手之前就开始通读" }), /通读/);
  assert.equal(harness.monitor().filter((entry) => entry.kind === "dispatch-deny" && entry.rule === "brief-lint").length, 2);
});

test("测绘派遣含调研措辞仍放行（首笔与接替都不受第 1、3 条约束）", async () => {
  const harness = makeHarness();
  assert.equal(harness.guard({ description: "随便写", prompt: "先调研整个仓库并回报入口表" }), void 0);

  const first = await harness.dispatch({ description: "随便写", prompt: "先调研整个仓库并回报入口表" });
  assert.ok(first.subagentId);
  assert.match(harness.calls.activation[0].label, / · scout · /);
});

test("CASEOS_BRIEF_LINT=0 关闭调研措辞拦截", async () => {
  await withEnv({ CASEOS_BRIEF_LINT: "0" }, async () => {
    const harness = makeHarness();
    harness.primeScout("scout-A");

    assert.equal(harness.guard({ description: "改代码", prompt: "先调研一下" }), void 0);
    assert.equal(harness.monitor().filter((entry) => entry.kind === "dispatch-deny").length, 0);
  });
});

test("write 与 edit .project-map.md 都登记基准，相对路径同样认", () => {
  const harness = makeHarness({ git: true });

  harness.toolResult("edit", { file_path: `${harness.cwd}/.project-map.md` });
  assert.equal(harness.baseline(), harness.head(), "edit 绝对路径应登记基准");

  harness.commit("next.md");
  assert.equal(harness.baseline() === harness.head(), false);

  harness.toolResult("write", { file_path: ".project-map.md" });
  assert.equal(harness.baseline(), harness.head(), "write 相对路径应登记基准");

  harness.commit("again.md");
  harness.toolResult("edit", { file_path: "./.project-map.md" });
  assert.equal(harness.baseline(), harness.head(), "edit 的 ./ 相对路径应登记基准");

  // 别的文件不算地图登记：基准不能因此翻新。
  harness.commit("other.md");
  harness.toolResult("write", { file_path: `${harness.cwd}/README.md` });
  assert.equal(harness.baseline() === harness.head(), false);
});

test("有地图但没有基准登记时拒绝执行派遣，提示先校对再 write 登记", () => {
  const harness = makeHarness({ git: true });
  harness.primeScout("scout-A");

  const reason = harness.guard({ description: "改代码", prompt: "把 a 改成 b" });
  assert.equal(typeof reason, "string");
  assert.match(reason, /^地图尚无基准登记/);
  assert.match(reason, /测绘增量校对/);
  assert.match(reason, /write 重写 \.project-map\.md 登记基准/);

  const line = harness.monitor().find((entry) => entry.kind === "dispatch-deny");
  assert.equal(line.rule, "map-baseline-missing");
});

test("无地图时仍走地图前置门禁，不被基准判定抢先", () => {
  const harness = makeHarness({ git: true, map: false });
  harness.primeScout("scout-A");

  const reason = harness.guard({ description: "改代码", prompt: "把 a 改成 b" });
  assert.match(reason, /必须先有项目地图/);
  assert.equal(harness.monitor().filter((entry) => entry.kind === "dispatch-deny").length, 0, "既有地图前置门禁仍记 gate-deny");
});

test("地图落后时拒绝并写清落后提交数与区间改动文件数", () => {
  const harness = makeHarness({ git: true });
  harness.primeScout("scout-A");
  harness.toolResult("write", { file_path: `${harness.cwd}/.project-map.md` });
  assert.equal(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), void 0, "基准与 HEAD 一致应放行");

  harness.commit("one.md");
  harness.commit("two.md");

  const reason = harness.guard({ description: "改代码", prompt: "把 a 改成 b" });
  assert.match(reason, /项目地图已过期/);
  assert.match(reason, /落后 2 个提交/);
  assert.match(reason, /区间改动 2 个文件/);
  assert.match(reason, /send_message 常驻测绘智能体/);

  const line = harness.monitor().find((entry) => entry.kind === "dispatch-deny");
  assert.equal(line.rule, "map-stale");
});

test("只新增未跟踪文件不算地图过期（只比较提交）", () => {
  const harness = makeHarness({ git: true });
  harness.primeScout("scout-A");
  harness.toolResult("write", { file_path: `${harness.cwd}/.project-map.md` });

  writeFileSync(`${harness.cwd}/scratch.md`, "未跟踪\n");
  assert.equal(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), void 0);
});

test("运行中 3 个执行子代理时第 4 个被拒，测绘不计入上限", () => {
  const harness = makeHarness({
    running: [
      { id: "exec-1", role: "executor" },
      { id: "exec-2", role: "executor" },
      { id: "scout-A", role: "scout" },
    ],
  });
  harness.primeScout("scout-A");

  assert.equal(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), void 0, "2 执行 + 1 测绘仍在限额内");

  harness.seedAgent({ id: "exec-3", role: "executor" });
  const reason = harness.guard({ description: "改代码", prompt: "把 a 改成 b" });
  assert.match(reason, /执行子代理并发已达上限 3/);
  assert.match(reason, /exec-1、exec-2、exec-3/);
  assert.match(reason, /请结束本回合等回执后再派/);

  const line = harness.monitor().find((entry) => entry.kind === "dispatch-deny");
  assert.equal(line.rule, "executor-cap");
});

test("CASEOS_MAX_EXECUTORS=5 时 4 个运行中执行者仍放行", async () => {
  await withEnv({ CASEOS_MAX_EXECUTORS: "5" }, async () => {
    const harness = makeHarness({
      running: ["exec-1", "exec-2", "exec-3", "exec-4"].map((id) => ({ id, role: "executor" })),
    });
    harness.primeScout("scout-A");

    assert.equal(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), void 0);
    harness.seedAgent({ id: "exec-5", role: "executor" });
    assert.match(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), /并发已达上限 5/);
  });
});

test("运行中但不属于本领导会话的子代理不占本会话名额", () => {
  const harness = makeHarness({ running: [{ id: "foreign-1", role: "executor", parentSession: "session-other" }] });
  harness.primeScout("scout-A");

  assert.equal(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), void 0);
});

test("派遣回执保留 started subagent 前缀并附路由与角色，测绘接替补旧 id", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");
  harness.emit("subagent/end", { id: "scout-A", provider: "spawn", stopReason: "error" });

  const takeover = await harness.dispatch({ description: "随便写", prompt: "增量校对" });
  const takeoverText = harness.receipt(takeover);
  assert.ok(takeoverText.startsWith(`started subagent ${takeover.subagentId}`), `前缀必须原样保留：${takeoverText}`);
  assert.match(takeoverText, /（路由：verispring\/deepseek-flash@high · 角色：scout）/);
  assert.match(takeoverText, /已接替不可达测绘 scout-A/);

  const executor = await harness.dispatch({ description: "改代码", prompt: "把 a 改成 b" });
  const executorText = harness.receipt(executor);
  assert.ok(executorText.startsWith(`started subagent ${executor.subagentId}`));
  assert.match(executorText, /（路由：verispring\/deepseek-flash@high · 角色：executor）/);
  assert.doesNotMatch(executorText, /已接替不可达测绘/);
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
