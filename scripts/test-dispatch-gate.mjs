#!/usr/bin/env node
// 派遣门禁行为测试：纯 node、无依赖，mock ctx 只提供 apply() 实际用到的服务面。
// 核心不变量「测绘身份由 description 前缀决定，可达性只决定能不能派」：没有可达测绘时执行
// 派遣被拒并记 scout-missing，绝不偷换成测绘；测绘前缀的派遣总是按测绘启动、注入职责与
// 地图；可达测绘重复派遣被拒；end 非 completed 或 send_message 报 NOT_RESUMABLE 后旧测绘
// 记不可达，重派测绘在任务书与回执里带接替事实。监控只在启动成功后记 start。
// 第二组不变量（执行派遣的代码级门禁）：调研型任务书拦截、地图基准登记与新鲜度、
// 执行子代理并发上限、回执保留 started subagent 前缀并附路由。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../gates/dispatch-gate.js";

const MAP_TEXT = "## 入口表\n- gates/dispatch-gate.js: 派遣门禁\n- scripts/smoke-test.mjs: 冒烟\n";
const SPEC_TEXT = "# 子代理派遣规范\n";
// 全局工作规范夹具：代表 ~/.claude/CLAUDE.md 的完整正文与硬禁令。门禁唯一源由 apply 参数
// 指向本夹具，测试绝不读写用户真实 CLAUDE.md。
const GLOBAL_SPEC_LINES = [
  "# 全局工作规范",
  "**这份文件每个会话都载入，只放不知道就会做错的东西：不变量、入口命令、硬禁令。**",
  "## 硬禁令（不知道就会做错的十二条）",
  "1. **提交一律 `git commit -F msg -- <显式路径>`。** 裸 commit 会带走别的会话暂存的东西。",
  "2. **未公开项目对外不点名、也不描述产品具体情况。**",
  "3. **取配置与凭据文件只点名取值。** 禁 `cat` / `head` / `grep -v`。",
  "## 入口",
  "- 代码写作：`~/.claude/specs/代码写作规范.md`（完整判据按路径按需读取）。",
];
const GLOBAL_SPEC_TEXT = GLOBAL_SPEC_LINES.join("\n");
const GLOBAL_SPEC_SECTION = "caseos:global-work-spec";
const GLOBAL_SPEC_RULE = "spec-source-missing";
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
  // 全局工作规范源的测试替身：apply 的仅内部参数指向它，生产默认值仍是唯一真实源。
  const specFile = join(home, "global-work-spec.md");
  writeFileSync(specFile, options.specText ?? GLOBAL_SPEC_TEXT);
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
  // 会话标题（行内副标题）：宿主持久化，冷恢复后仍可读。options.titles 预置历史标题
  // （模拟跨进程遗留），rename 只记录调用；预置事实不被改写，角色/描述自愈据此还原。
  const presetTitles = options.titles ?? {};
  const sessionTitle = {
    get: (session) => {
      const title = session?.header?.id ? presetTitles[session.header.id] : void 0;
      return title === void 0 ? void 0 : { title };
    },
    rename: (target, title) => calls.rename.push([target, title]),
  };
  const sessionController = { agents: { selectForNextRequest: (...args) => calls.select.push(args) } };
  // root 动态系统段：section 只记录定义，text 由测试在需要的时刻求值（模拟每次 assemble）。
  const promptSections = [];
  const systemPrompt = {
    getSectionOrder: (name) => ({ TOOL_SUBAGENT: 2800, TOOL_REPORT: 2900 }[name] ?? 0),
    section: (definition) => {
      promptSections.push(definition);
      return () => {};
    },
  };
  const services = { agents, sessionTitle, sessionController, sessionProjections: { stateOf: () => void 0 }, systemPrompt };

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

  // root 层服务：tools 用 root 注册表。
  const rootTools = { get: (name) => rootToolsOf.get(name) };
  const rootToolsOf = new Map();
  const rootToolsService = {
    guard: (callback) => guards.push(callback),
    register: (definition) => {
      if (options.scopedOnly) throw new Error('cannot get required service "tools" in inactive context');
      rootToolsOf.set(definition.name, definition);
    },
    get: (name) => rootToolsOf.get(name),
    // 宿主语义：root 层没有 scope，restrict 必抛；门禁不得依赖它。
    restrict: () => {
      throw new Error('cannot get required service "tools" in inactive context');
    },
  };
  // 宿主 cordis 语义（cordis/lib/index.js 的 ReflectService.handler.get）：未在该作用域
  // inject 链里声明的服务，属性访问抛 cannot get property "<name>" without inject；get()
  // 不要求 inject。领导/子代理作用域继承 agent-loop 的 inject（agents、tools、sessions…），
  // 但不含 subagents 与 sessionController——直取 .subagents 就是线上故障 1 的形态。
  const agentInject = options.agentInject ?? ["agents", "tools", "sessions", "sessionTitle", "sessionProjections"];
  const serviceCtx = (own, injected, overrides = {}) => new Proxy(own, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (typeof prop !== "string") return void 0;
      const value = overrides[prop] ?? services[prop];
      if (value === void 0) return void 0;
      if (injected.includes(prop)) return value;
      throw new Error(`cannot get property "${prop}" without inject`);
    },
  });
  const ctx = serviceCtx({
    profileContext: { home },
    get: (name) => services[name],
    on: (name, callback) => listeners.set(name, [...(listeners.get(name) ?? []), callback]),
    tools: rootToolsService,
    // root 也是真 Context：inject 会给出一个声明了依赖的子作用域。
    inject: (names, callback) => callback(serviceCtx({
      get: (name) => services[name],
    }, [...new Set([...Object.keys(services), ...names])])),
  }, Object.keys(services));
  ctx.root = ctx;
  ctx.root.on = ctx.on;

  // 会话层注入面：安装领导入口时宿主给的 rtc（scoped tools + subagents）。
  const scopedTools = new Map();
  const scopedRestricted = [];
  const scopedToolsService = {
    get: (name) => scopedTools.get(name),
    register: (definition) => scopedTools.set(definition.name, definition),
    restrict: (spec) => scopedRestricted.push(spec),
  };
  // 安装时那一次注入得到的 rtc 代表"闭包 ctx"：面板重载后它所属的 fiber 已释放，再注入
  // 就是 CordisError（cannot create effect on inactive context）。派遣必须换活作用域重试。
  let injections = 0;
  const staleSubagents = {
    startActivation: async () => {
      throw new Error('cannot get required service "subagents" in inactive context');
    },
  };

  plugin.apply(ctx, { specFile });

  // 领导作用域（agent.ctx）：注入链来自 agent-loop（没有 subagents / sessionController），
  // 属性直取 subagents 会抛 without inject；get() 照常可读——线上故障 1 就在这一层。
  const liveCtx = serviceCtx({
    root: ctx,
    get: (name) => services[name],
    inject: (names, callback) => {
      const stale = options.scopedStartActivation !== void 0 && injections++ === 0;
      const injected = serviceCtx({
        root: ctx,
        get: (name) => services[name],
        // 注入作用域在宿主里是领导作用域的子 fiber：祖先声明过的依赖照样能取。
        ...(stale ? {
          subagents: staleSubagents,
          inject: () => { throw new Error("cannot create effect on inactive context"); },
        } : {}),
      }, [...new Set([...agentInject, ...names])], { tools: scopedToolsService });
      return callback(injected);
    },
  }, agentInject);
  const leader = { id: sessionId, session, ctx: liveCtx };
  const routedTool = () => rootTools.get("subagent") ?? scopedTools.get("subagent");
  const stateDir = `${home}/caseos/session-state`;
  const baselineFile = `${home}/caseos/map-baselines.json`;
  const head = () => git(cwd, ["rev-parse", "HEAD"]);
  const runGuards = (name, args, agent) => {
    const exec = { name, agent, arguments: args };
    for (const callback of guards) {
      const reason = callback(exec);
      if (typeof reason === "string") return reason;
    }
    return void 0;
  };

  return {
    leader,
    cwd,
    home,
    specFile,
    scopedTools,
    scopedRestricted,
    calls,
    seedAgent,
    emit: (name, payload) => {
      for (const callback of listeners.get(name) ?? []) callback(payload);
    },
    /** 走所有 guard 回调，返回第一条拒绝文案 */
    guard: (args, agent = leader) => runGuards("subagent", args, agent),
    /** 任意工具走全部 guard 回调（既有子代理的工具调用面） */
    guardTool: (name, args, agent = leader) => runGuards(name, args, agent),
    /** 求值 root 动态规范段（每次调用即一次 assemble） */
    sectionText: (scope = leader.ctx) => {
      const section = promptSections.find((candidate) => candidate.name === GLOBAL_SPEC_SECTION);
      return typeof section?.text === "function" ? section.text({ scope }) : section?.text;
    },
    sections: promptSections,
    writeSpec: (text) => writeFileSync(specFile, text),
    removeSpec: () => rmSync(specFile, { force: true }),
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
    /** 宿主 agent/created 广播：逐个 await，与宿主串行语义一致 */
    created: async (agent = leader) => {
      for (const callback of listeners.get("agent/created") ?? []) await callback({ agent });
    },
    /** 宿主 agents 注册表里的子代理（派发成功后 startActivation 已登记） */
    agent: (id) => childAgents.get(id),
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

test("测绘 end=error 后执行派遣被拒，明示测绘前缀的接替派遣注入地图全文", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");

  harness.emit("subagent/end", { id: "scout-A", provider: "spawn", stopReason: "error", error: { message: "模型超时" } });
  assert.equal(harness.scoutState().scoutUnreachable, "end=error");

  // 执行派遣不会被偷换成测绘：直接拒绝，文案给出续接、重派与建图三条路，并点名上一任。
  const reason = harness.guard({ description: "随便写什么都行", prompt: "增量校对" });
  assert.equal(typeof reason, "string");
  assert.match(reason, /没有可达测绘/);
  assert.match(reason, /scout-A end=error/);
  assert.match(reason, /send_message scout-A/);
  assert.match(reason, /「测绘智能体」或「scout:」开头/);
  assert.match(reason, /地图/);
  assert.equal(harness.monitor().find((line) => line.kind === "dispatch-deny").rule, "scout-missing");

  // 领导明确标注测绘前缀：按测绘启动，任务书前置职责说明 + 接替事实 + 地图全文。
  const result = await harness.dispatch({ description: "测绘智能体：增量校对", prompt: "增量校对" });

  assert.equal(harness.calls.activation.length, 1);
  const spec = harness.calls.activation[0];
  // descriptor label 是事项简述：列表主标题不得以模型/路由名开头。
  assert.equal(spec.label, "测绘智能体：增量校对");
  assert.equal(spec.request.label, "测绘智能体：增量校对");
  const prompt = spec.request.prompt[0].text;
  assert.match(prompt, /【实际路由：scout/);
  assert.match(prompt, /【测绘智能体】/);
  assert.match(prompt, /上任测绘 scout-A 已不可达（end=error）/);
  assert.match(prompt, /仓库已有地图/);
  assert.ok(prompt.includes("gates/dispatch-gate.js: 派遣门禁"), "地图全文应注入任务书");
  assert.match(prompt, /只做增量校对/);
  assert.doesNotMatch(prompt, /自动接替|自动定为/);

  // 新测绘接任常驻：scoutId 换人，失联标记清空，路由按活上下文落到子代理。
  assert.equal(harness.scoutState().scoutId, result.subagentId);
  assert.equal(harness.scoutState().scoutUnreachable, void 0);
  assert.equal(harness.calls.select.length, 1);
  assert.equal(harness.calls.select[0][0].id, result.subagentId);
  // 标题是延迟重写的（宿主自动起名会覆盖一次），等第一个定时器落下再看。
  await new Promise((resolve) => setTimeout(resolve, 20));
  const titles = harness.calls.rename.map(([, title]) => title);
  assert.ok(titles.includes("verispring/deepseek-flash@high · scout · 测绘智能体：增量校对"), "会话标题应保留路由、角色与事项简述");
  assert.ok(titles.some((title) => title.includes(" · scout · ")), "roleFromTitle/manon-bridge 依赖的标记必须保留");
});

test("send_message 报 NOT_RESUMABLE 后旧测绘记不可达，执行派遣被拒、测绘前缀可重派", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");

  harness.sendMessageResult("scout-A", {
    isError: true,
    error: { message: 'subagent "scout-A" is unavailable', info: { code: "NOT_RESUMABLE" } },
  });
  assert.equal(harness.scoutState().scoutUnreachable, "NOT_RESUMABLE");
  assert.ok(harness.monitor().some((line) => line.kind === "scout-unreachable" && line.child === "scout-A"));

  assert.match(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), /scout-A NOT_RESUMABLE/);
  assert.equal(harness.guard({ description: "scout: 重派", prompt: "x" }), void 0);
  await harness.dispatch({ description: "scout: 重派", prompt: "x" });
  assert.equal(harness.calls.activation.length, 1);
  assert.equal(harness.calls.activation[0].label, "scout: 重派");
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

test("无地图且无可达测绘时，明示测绘前缀的派遣放行（地图门禁不拦测绘）", async () => {
  const harness = makeHarness({ map: false });

  // 执行派遣被拒的理由是没有测绘（scout-missing），不是地图。
  assert.match(harness.guard({ description: "改代码", prompt: "x" }), /没有可达测绘/);

  assert.equal(harness.guard({ description: "测绘智能体：建图", prompt: "x" }), void 0);
  const result = await harness.dispatch({ description: "测绘智能体：建图", prompt: "建图" });
  assert.ok(result.subagentId);
  const prompt = harness.calls.activation[0].request.prompt[0].text;
  assert.match(prompt, /【实际路由：scout/);
  assert.match(prompt, /【测绘智能体】/);
  assert.doesNotMatch(prompt, /仓库已有地图/, "没有地图时不注入地图段");

  // 测绘已在常驻：同一份执行任务书改由地图前置门禁拦（缺地图）。
  assert.match(harness.guard({ description: "改代码", prompt: "x" }), /必须先有项目地图/);
});

test("有可达测绘但无地图时，执行派遣被地图门禁拦下", () => {
  const harness = makeHarness({ map: false });
  harness.primeScout("scout-A");

  const reason = harness.guard({ description: "改代码", prompt: "x" });
  assert.equal(typeof reason, "string");
  assert.match(reason, /\.project-map\.md/);
  assert.match(reason, /先派测绘智能体/);
});

test("无可达测绘时执行派遣被拒（scout-missing，文案指路续接/重派/建图）", () => {
  const harness = makeHarness();

  const reason = harness.guard({ description: "改代码", prompt: "把 a 改成 b" });
  assert.equal(typeof reason, "string");
  assert.match(reason, /本会话没有可达测绘（还没有派过测绘），执行派遣不会被改写成测绘/);
  assert.match(reason, /send_message <测绘 id> 续接/);
  assert.match(reason, /「测绘智能体」或「scout:」开头/);
  assert.match(reason, /地图/);

  const line = harness.monitor().find((entry) => entry.kind === "dispatch-deny");
  assert.ok(line, "拒绝必须落 dispatch-deny");
  assert.equal(line.rule, "scout-missing");
  assert.equal(line.tool, "subagent");
  assert.equal(harness.scoutState(), void 0, "被拒的派遣不得写 scout 字段");
});

test("测绘前缀的派遣按测绘启动：注册 scoutId，注入职责与地图全文", async () => {
  const harness = makeHarness();

  assert.equal(harness.guard({ description: "scout: 建图", prompt: "建图" }), void 0);
  const result = await harness.dispatch({ description: "scout: 建图", prompt: "建图" });

  const spec = harness.calls.activation[0];
  assert.equal(spec.label, "scout: 建图", "主标题是事项简述，不含路由");
  const prompt = spec.request.prompt[0].text;
  assert.match(prompt, /【实际路由：scout/);
  assert.match(prompt, /【测绘智能体】/);
  assert.match(prompt, /只做定位、事实与建图/);
  assert.match(prompt, /你没有 edit\/write 工具；地图由领导 write 落盘/);
  assert.match(prompt, /仓库已有地图/);
  assert.ok(prompt.includes("gates/dispatch-gate.js: 派遣门禁"), "地图全文应注入任务书");
  assert.doesNotMatch(prompt, /自动接替|自动定为/);

  assert.equal(harness.scoutState().scoutId, result.subagentId);
  assert.equal(harness.monitor().find((line) => line.kind === "subagent-start").role, "scout");
  const receipt = harness.receipt(result);
  assert.ok(receipt.startsWith(`started subagent ${result.subagentId}`));
  assert.match(receipt, /角色：scout/);
  assert.doesNotMatch(receipt, /已接替不可达测绘/, "首任测绘没有接替事实");
});

// ---- 主标题与副标题分离：列表主标题 = 事项简述，会话标题仍含路由与角色 ----

test("新派遣 descriptor label 是事项简述，会话标题保留 route · role · 简述", async () => {
  const harness = makeHarness();
  const scoutDescription = "测绘智能体：增量校对 ask_scout 微任务空转";
  const scout = await harness.dispatch({ description: scoutDescription, prompt: "只做增量校对" });
  const executorDescription = "修 ask_scout 微任务空转致 OOM";
  const executor = await harness.dispatch({ description: executorDescription, prompt: "改 gates/scout-relay.js:520" });

  const [scoutSpec, executorSpec] = harness.calls.activation;
  assert.equal(scoutSpec.label, scoutDescription, "主标题必须是事项简述");
  assert.equal(scoutSpec.request.label, scoutDescription, "request.label 与 startActivation label 同源");
  assert.equal(executorSpec.label, executorDescription);
  assert.ok(!scoutSpec.label.startsWith("verispring/"), "主标题不得以模型/路由名开头");

  await new Promise((resolve) => setTimeout(resolve, 20));
  const titleOf = (id) => harness.calls.rename
    .filter(([target]) => target?.header?.id === id)
    .map(([, title]) => title);
  assert.deepEqual(titleOf(scout.subagentId), [`verispring/deepseek-flash@high · scout · ${scoutDescription}`]);
  assert.deepEqual(titleOf(executor.subagentId), [`verispring/deepseek-flash@high · executor · ${executorDescription}`]);
  assert.match(titleOf(scout.subagentId)[0], / · scout · /, "roleFromTitle/manon-bridge 依赖的标记必须保留");
});

test("事项简述为空时主标题回落角色名，会话标题只留 route · role", async () => {
  const harness = makeHarness();
  await harness.dispatch({ description: "   ", prompt: "x" });

  assert.equal(harness.calls.activation[0].label, "executor");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    harness.calls.rename.some(([, title]) => title === "verispring/deepseek-flash@high · executor"),
    "没有简述时标题不应带空段或路由名当主标题",
  );
});

test("resume（派遣队列为空）按会话标题还原简述，不写无描述的 route · role", async () => {
  const description = "修 ask_scout 微任务空转致 OOM";
  const title = `verispring/deepseek-flash@high · scout · ${description}`;
  const harness = makeHarness({ titles: { "child-resume": title } });
  harness.seedAgent({ id: "child-resume", role: "scout" });

  await harness.created(harness.agent("child-resume"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const renamed = harness.calls.rename.map(([, value]) => value);
  assert.ok(renamed.length > 0, "有简述时必须按当前路由重拼标题");
  assert.ok(renamed.every((value) => value.includes(description)), `不得改写为无描述标题：${JSON.stringify(renamed)}`);
  assert.ok(!renamed.includes("verispring/deepseek-flash@high · scout"), "不得产生 route · role 标题");
  assert.equal(renamed[0], title, "重拼结果与原标题一致");
});

test("resume 解析不出简述时保留原标题，不做 rename", async () => {
  const harness = makeHarness({ titles: { "child-legacy": "临时标题" } });
  harness.seedAgent({ id: "child-legacy", role: "executor" });

  await harness.created(harness.agent("child-legacy"));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(harness.calls.rename.length, 0, "解析不出简述不得改写标题");
});

test("路由热更新重拼标题时保留事项简述", async () => {
  const harness = makeHarness();
  const description = "修 ask_scout 微任务空转致 OOM";
  const result = await harness.dispatch({ description, prompt: "改 gates/scout-relay.js:520" });

  writeFileSync(
    `${harness.home}/verispring.json`,
    `${JSON.stringify({ executor: { provider: "verispring", model: "deepseek-v4-pro", reasoningEffort: "max" } })}\n`,
  );
  await harness.install(harness.agent(result.subagentId));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const titles = harness.calls.rename
    .filter(([target]) => target?.header?.id === result.subagentId)
    .map(([, title]) => title);
  assert.ok(
    titles.includes(`verispring/deepseek-v4-pro@max · executor · ${description}`),
    `热更新标题应保留简述：${JSON.stringify(titles)}`,
  );
  assert.ok(!titles.includes("verispring/deepseek-v4-pro@max · executor"), "不得丢掉简述");
});

test("执行派遣不写、不改会话的 scout 字段", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");
  await harness.dispatch({ description: "改代码", prompt: "把 a 改成 b" });
  assert.equal(harness.scoutState().scoutId, "scout-A");
  assert.equal(harness.scoutState().scoutUnreachable, void 0);
  assert.equal(harness.calls.activation[0].label, "改代码");

  // 没有测绘时直接调用执行入口（绕过 guard）也不会把子代理记成测绘。
  const blank = makeHarness();
  const result = await blank.dispatch({ description: "改代码", prompt: "把 a 改成 b" });
  assert.equal(blank.calls.activation[0].label, "改代码");
  assert.match(blank.calls.activation[0].request.prompt[0].text, /【实际路由：executor/);
  assert.equal(blank.scoutState(), void 0);
  assert.equal(result.role, "executor");
});

test("CASEOS_SCOUT=0 关闭测绘架构时没有测绘也放行执行派遣", async () => {
  await withEnv({ CASEOS_SCOUT: "0" }, async () => {
    const harness = makeHarness();
    assert.equal(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), void 0);
  });
});

// ---- 测绘工具硬禁：角色只在 agent/created 的派遣队列计划里可判（早于角色落盘与 scoutId 登记） ----

const deniesEditWrite = (spec) => spec.deny?.includes("edit") && spec.deny?.includes("write");

test("pending 计划 role=scout 的子代理创建时被 restrict deny edit/write，并记 scout-tools-restricted", async () => {
  const harness = makeHarness();
  const result = await harness.dispatch({ description: "scout: 建图", prompt: "建图" });

  await harness.created(harness.agent(result.subagentId));

  assert.ok(
    harness.scopedRestricted.some(deniesEditWrite),
    `测绘创建时必须摘掉 edit/write：${JSON.stringify(harness.scopedRestricted)}`,
  );
  const line = harness.monitor().find((entry) => entry.kind === "scout-tools-restricted");
  assert.ok(line, "收掉工具时必须记 scout-tools-restricted");
  assert.equal(line.child, result.subagentId);
});

test("pending 计划 role=executor 的子代理创建时不 restrict edit/write", async () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");
  const result = await harness.dispatch({ description: "改代码", prompt: "把 a 改成 b" });

  await harness.created(harness.agent(result.subagentId));

  assert.equal(harness.scopedRestricted.filter(deniesEditWrite).length, 0, "执行者必须保留 edit/write");
  assert.equal(harness.monitor().filter((entry) => entry.kind === "scout-tools-restricted").length, 0);
});

test("领导会话创建时不 restrict edit/write", async () => {
  const harness = makeHarness();

  await harness.created(harness.leader);

  assert.equal(harness.scopedRestricted.filter(deniesEditWrite).length, 0, "领导必须保留 edit/write");
  assert.ok(harness.scopedRestricted.some((spec) => spec.deny.includes("subagent-base")), "领导面限定照旧生效");
});

test("CASEOS_SCOUT=0 时测绘子代理创建不 restrict edit/write", async () => {
  await withEnv({ CASEOS_SCOUT: "0" }, async () => {
    const harness = makeHarness();
    const result = await harness.dispatch({ description: "scout: 建图", prompt: "建图" });

    await harness.created(harness.agent(result.subagentId));

    assert.equal(harness.scopedRestricted.filter(deniesEditWrite).length, 0, "测绘机制关闭时不得摘工具");
    assert.equal(harness.monitor().filter((entry) => entry.kind === "scout-tools-restricted").length, 0);
  });
});

test("pending 计划缺失的子代理创建时不误伤 edit/write", async () => {
  const harness = makeHarness();
  const stray = harness.seedAgent({ id: "stray-1" });

  await harness.created(stray);

  assert.equal(harness.scopedRestricted.filter(deniesEditWrite).length, 0, "没有派遣计划就无角色事实，不得摘工具");
  assert.equal(harness.monitor().filter((entry) => entry.kind === "scout-tools-restricted").length, 0);
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

test("测绘派遣含调研措辞仍放行（第 1、3 条只约束执行派遣）", async () => {
  const harness = makeHarness();
  const args = { description: "测绘智能体：全库巡检", prompt: "先调研整个仓库并回报入口表" };
  assert.equal(harness.guard(args), void 0);

  const first = await harness.dispatch(args);
  assert.ok(first.subagentId);
  assert.equal(harness.calls.activation[0].label, "测绘智能体：全库巡检");

  // 测绘已在常驻：同一任务书写给执行者仍被调研措辞拦（规则只对执行派遣生效）。
  assert.match(harness.guard({ description: "改代码", prompt: "先调研一下现状" }), /调研型措辞/);
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

test("运行中 8 个执行子代理时第 9 个被拒，测绘不计入上限", () => {
  const harness = makeHarness({
    running: [
      ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `exec-${n}`, role: "executor" })),
      { id: "scout-A", role: "scout" },
    ],
  });
  harness.primeScout("scout-A");

  assert.equal(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), void 0, "7 执行 + 1 测绘仍在限额内");

  harness.seedAgent({ id: "exec-8", role: "executor" });
  const reason = harness.guard({ description: "改代码", prompt: "把 a 改成 b" });
  assert.match(reason, /执行子代理并发已达上限 8/);
  assert.match(reason, /exec-1、exec-2、exec-3、exec-4、exec-5、exec-6、exec-7、exec-8/);
  assert.match(reason, /请结束本回合等回执后再派/);

  const line = harness.monitor().find((entry) => entry.kind === "dispatch-deny");
  assert.equal(line.rule, "executor-cap");
});

test("CASEOS_MAX_EXECUTORS=2 时 1 个运行中执行者放行、2 个运行中时第 3 个被拒", async () => {
  await withEnv({ CASEOS_MAX_EXECUTORS: "2" }, async () => {
    const harness = makeHarness({ running: [{ id: "exec-1", role: "executor" }] });
    harness.primeScout("scout-A");

    assert.equal(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), void 0);
    harness.seedAgent({ id: "exec-2", role: "executor" });
    const reason = harness.guard({ description: "改代码", prompt: "把 a 改成 b" });
    assert.match(reason, /并发已达上限 2/);
    assert.match(reason, /exec-1、exec-2/);
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

  const takeover = await harness.dispatch({ description: "测绘智能体：增量校对", prompt: "增量校对" });
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

// ---- 全局工作规范供给：唯一源 + root 动态段 + fail closed ----

test("root 动态规范段：三角色拿到完整正文，连续两次求值反映源文件更新（续接不冻结）", () => {
  const harness = makeHarness();
  const section = harness.sections.find((candidate) => candidate.name === GLOBAL_SPEC_SECTION);
  assert.ok(section, "root 作用域必须注册全局规范段");
  assert.equal(section.order, 2800, "与 TOOL_SUBAGENT 同序");
  assert.equal(section.interpolate, false, "规范里的 {{...}} 模板必须逐字注入，禁止宿主变量展开");

  const scopes = {
    leader: harness.leader.ctx,
    scout: { session: { header: { id: "child-scout", origin: "subagent", parentSession: harness.leader.id } } },
    executor: { session: { header: { id: "child-exec", origin: "subagent", parentSession: harness.leader.id } } },
  };
  for (const [role, scope] of Object.entries(scopes)) {
    const text = harness.sectionText(scope);
    assert.ok(text.includes(GLOBAL_SPEC_TEXT), `${role} 必须拿到完整正文，不能只给首行或摘要`);
    for (const line of GLOBAL_SPEC_LINES) assert.ok(text.includes(line), `${role} 缺正文行：${line}`);
    assert.match(text, /子代理任务书不能豁免、覆盖或替代本段/);
    assert.match(text, /任务涉及某份规范时，先按正文路径完整读取对应规范再执行/);
    assert.match(text, /不得用全局段摘要替代该规范/);
  }

  // 同尺寸、同一路径的连续更新：读的必须是文件当前内容，不缓存正文、mtime 或大小。
  const v1 = "# 全局工作规范\n硬禁令：提交一律 git commit -F msg -- <显式路径>。".padEnd(120, " ");
  const v2 = "# 全局工作规范\n硬禁令：取凭据只点名取值，禁 cat 全文。".padEnd(120, " ");
  assert.equal(v1.length, v2.length, "两次更新必须同尺寸，才能证明不靠 mtime/大小判新旧");
  harness.writeSpec(v1);
  const first = harness.sectionText(scopes.executor);
  assert.ok(first.includes("提交一律"));
  assert.ok(!first.includes("取凭据只点名取值"));
  harness.writeSpec(v2);
  const second = harness.sectionText(scopes.executor);
  assert.ok(second.includes("取凭据只点名取值"));
  assert.ok(!second.includes("提交一律"), "第二次求值不得返回上一次的旧正文");
});

test("子代理任务书之外仍由系统段供给：scout 与 executor 都不漏完整规范", async () => {
  const harness = makeHarness();
  const scout = await harness.dispatch({ description: "scout: 建图", prompt: "建图" });
  const executor = await harness.dispatch({ description: "改代码", prompt: "把 a 改成 b" });

  for (const [role, id] of [["scout", scout.subagentId], ["executor", executor.subagentId]]) {
    const child = harness.agent(id);
    assert.ok(child?.session, `${role} 子代理会话必须已登记`);
    const text = harness.sectionText(child);
    assert.ok(text.includes(GLOBAL_SPEC_TEXT), `${role} 的系统段必须是完整正文`);
    assert.match(text, /此段对 leader \/ scout \/ executor 一律生效/);
  }

  const executorBrief = harness.calls.activation[1].request.prompt[0].text;
  assert.ok(executorBrief.startsWith("【实际路由：executor"));
  assert.ok(!executorBrief.includes(GLOBAL_SPEC_LINES[3]), "任务书不得成为规范正文的第二份来源");
});

test("规范源缺失或空白时新派遣被拒：spec-source-missing 落监控，段不退回空串", () => {
  const harness = makeHarness();
  harness.primeScout("scout-A"); // 排除其它门禁，拒绝只可能来自规范源
  assert.equal(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), void 0, "源正常时派遣应放行");

  harness.removeSpec();
  const missing = harness.guard({ description: "改代码", prompt: "把 a 改成 b" });
  assert.match(missing, /全局工作规范源缺失/);
  assert.match(missing, /fail closed/);
  assert.match(missing, /恢复为可读且非空白/);
  assert.match(missing, /不退回空规范/);

  const denied = harness.monitor().filter((entry) => entry.rule === GLOBAL_SPEC_RULE);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].kind, "dispatch-deny");
  assert.equal(denied[0].tool, "subagent");
  assert.match(denied[0].reason, /global-work-spec\.md/);
  assert.match(denied[0].reason, /缺失/);

  const notice = harness.sectionText();
  assert.ok(notice.trim().length > 0, "源缺失时段不得静默变空");
  assert.match(notice, /fail closed/);
  assert.ok(!notice.includes(GLOBAL_SPEC_TEXT), "不得把旧正文当作仍有效规范继续供给");

  harness.writeSpec("  \n\t\n");
  assert.match(
    harness.guard({ description: "改代码", prompt: "把 a 改成 b" }),
    /全局工作规范源空白/,
  );
});

test("既有子代理的工具调用在源失效时被拒，领导普通工具不被误拒", () => {
  const harness = makeHarness();
  const executor = harness.seedAgent({ id: "child-exec", role: "executor" });
  const scout = harness.seedAgent({ id: "child-scout", role: "scout" });
  assert.equal(harness.guardTool("read", { path: "/tmp/a" }, executor), void 0, "源正常时子代理工具放行");

  harness.removeSpec();
  for (const agent of [executor, scout]) {
    const reason = harness.guardTool("read", { path: "/tmp/a" }, agent);
    assert.match(reason, /全局工作规范源缺失/);
    assert.match(reason, /已拒绝本次调用（read）/);
  }
  const denied = harness.monitor().filter((entry) => entry.rule === GLOBAL_SPEC_RULE);
  assert.equal(denied.length, 2, "每只既有子代理的调用各记一条");
  assert.deepEqual(denied.map((entry) => entry.session).sort(), ["child-exec", "child-scout"]);
  assert.ok(denied.every((entry) => entry.kind === "dispatch-deny" && entry.tool === "read"));

  // 领导普通工具不属于强制面：不拒、不落 dispatch-deny。
  assert.equal(harness.guardTool("read", { path: "/tmp/a" }, harness.leader), void 0);
  assert.equal(harness.guardTool("write", { file_path: "/tmp/a" }, harness.leader), void 0);
  assert.equal(harness.monitor().filter((entry) => entry.rule === GLOBAL_SPEC_RULE).length, 2);
});

test("只有 parentSession 的续接/旧子代理同样纳入 fail closed，领导普通工具不误伤", () => {
  const harness = makeHarness();
  // 冷恢复/旧会话可能只有父会话血缘、没有 origin：身份口径与 scout-relay 一致。
  const legacy = {
    id: "child-legacy",
    session: { header: { id: "child-legacy", parentSession: harness.leader.id } },
  };
  assert.equal(harness.guardTool("read", { path: "/tmp/a" }, legacy), void 0, "源正常时旧子代理放行");

  harness.removeSpec();
  const reason = harness.guardTool("read", { path: "/tmp/a" }, legacy);
  assert.match(reason, /全局工作规范源缺失/);
  assert.match(reason, /已拒绝本次调用（read）/);
  const denied = harness.monitor().filter((entry) => entry.rule === GLOBAL_SPEC_RULE);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].kind, "dispatch-deny");
  assert.equal(denied[0].session, "child-legacy");
  assert.equal(denied[0].tool, "read");

  // 领导会话没有 parentSession：普通工具仍不属于强制面。
  assert.equal(harness.guardTool("read", { path: "/tmp/a" }, harness.leader), void 0);
  assert.equal(harness.guardTool("write", { file_path: "/tmp/a" }, harness.leader), void 0);
  assert.equal(harness.monitor().filter((entry) => entry.rule === GLOBAL_SPEC_RULE).length, 1);
});

test("恢复有效源后动态段与允许路径立即恢复，无缓存旧正文", () => {
  const harness = makeHarness();
  harness.primeScout("scout-A");
  const child = harness.seedAgent({ id: "child-exec", role: "executor" });
  harness.removeSpec();
  assert.ok(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }));
  assert.ok(harness.guardTool("read", {}, child));
  assert.match(harness.sectionText(), /当前缺失/);

  harness.writeSpec(`${GLOBAL_SPEC_TEXT}\n- 恢复后的新行：RESUMED-MARKER。`);
  assert.equal(harness.guard({ description: "改代码", prompt: "把 a 改成 b" }), void 0);
  assert.equal(harness.guardTool("read", {}, child), void 0);
  const text = harness.sectionText();
  assert.ok(text.includes("RESUMED-MARKER"), "恢复后必须读到新正文，不得命中旧缓存");
  assert.ok(text.includes(GLOBAL_SPEC_TEXT));
  assert.ok(!text.includes("当前缺失"));
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
