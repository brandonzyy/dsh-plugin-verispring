#!/usr/bin/env node
// 工具面逐会话冻结的行为测试：纯 node、无依赖，mock ctx 提供门禁实际用到的服务面。
//
// 三条不变量（本轮修复）：
// 1 同一会话两次构建（重启/恢复/热重载）得到逐字节相同的模型可见工具面（name/description/
//   parameters 及顺序）与本插件系统段文本——工具定义在提示缓存前缀最前面，差一个字节就是
//   在跑会话整段重写（实测每次 15 万~39 万 token）。
// 2 文案变更（模拟新版插件）只对新会话生效：旧会话恢复后仍是快照里的旧文案，新会话拿新版。
//   快照里没有的新工具不暴露给旧会话；快照有而当前没有的工具跳过并记一行 stderr。
// 3 subagent 的参数说明在所有注册路径下同一形态：全局入口、会话冻结注册、有无宿主基座
//   （subagent-base）都是同一份 canonical schema——旧实现两条路径一份有说明一份整段缺失，
//   于是同一会话在 5cc6c9（有说明）与 00f363（整段缺失）之间来回切。
// 4 工具返回值与声明的 output.schema 一致：route/role/replacedScoutId 都是声明过的属性
//   （宿主按 additionalProperties:false 校验，缺声明会让整次调用报 invalid output）。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dispatchGate from "../gates/dispatch-gate.js";
import leaderScope from "../gates/leader-scope.js";
import manonBridge from "../gates/manon-bridge.js";
import scoutRelay from "../gates/scout-relay.js";
import sessionEvictor from "../gates/session-evictor.js";
import {
  SURFACE_TOOL_ORDER,
  installSessionSurface,
  registerSurfaceSection,
  registerSurfaceTool,
  resetSurfaceCache,
} from "../gates/tool-surface.js";

const PLUGINS = [dispatchGate, leaderScope, manonBridge, scoutRelay, sessionEvictor];
const HOST_TOOLS = [
  ["bash", "执行 shell 命令（宿主原文，很长的一段说明，模型面由宿主决定）。"],
  ["edit", "改文件（宿主原文）。"],
  ["write", "写文件（宿主原文）。"],
  ["read", "读文件（宿主原文）。"],
  ["read_image", "看图（宿主原文）。"],
  ["send_message", "向运行中的子代理发消息（宿主原文，这段在领导面会被瘦身替换）。"],
  ["interrupt_agent", "让某个子代理停止当前工作（宿主原文）。"],
  ["list_agents", "列出你启动的子代理及其状态（宿主原文）。"],
];
// 宿主官方 subagent-base 的参数说明（带各种长文案）：旧实现会从这里取参数再截断，
// 于是「有基座」与「没有基座」两条路径的形态不同。现在只作执行实现存在，模型面不再取它。
const HOST_BASE_TOOL = {
  name: "subagent-base",
  description: "宿主官方派遣入口（很长的一段说明，会被本插件替换）。",
  parameters: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Initial child working directory. Relative paths use your current directory; omitted inherits it." },
      description: { type: "string", description: "A short (3-5 word) description of the delegated task, for display." },
      prompt: { type: "string", description: "The task for the child agent. It must be self-contained." },
    },
    required: ["description", "prompt"],
  },
  output: { schema: { type: "object", additionalProperties: true }, render: () => [{ type: "text", text: "started" }] },
};

function makeDef(name, description) {
  return {
    name,
    description,
    parameters: { type: "object", properties: { path: { type: "string" } } },
    output: { schema: { type: "object", additionalProperties: true }, render: () => [{ type: "text", text: name }] },
  };
}

async function withStderr(fn) {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

// ---------------------------------------------------------------------------
// 宿主替身：层语义按宿主 tools 注册表来（继承层按注册顺序，会话自注册的覆盖同名条目但
// 保留原位置；restrict 只过滤继承面，不碰会话自己的注册）。
// ---------------------------------------------------------------------------
function createHost(options = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "verispring-surface-"));
  const sessionId = options.sessionId ?? "session-surface-1";
  const cwd = options.cwd ?? home;
  mkdirSync(`${home}/caseos/session-state`, { recursive: true });
  // 插件读 MANON_KG_BIN 判断图谱是否可用；给一个真实存在的文件让 manon 段真正注入。
  const kgPath = `${home}/manon-kg`;
  writeFileSync(kgPath, "#!/bin/sh\n");
  process.env.MANON_KG_BIN = kgPath;

  const globalTools = new Map();
  const agentLayers = new Map();
  const layerOf = (agent) => {
    let layer = agentLayers.get(agent);
    if (layer === void 0) {
      layer = { own: new Map(), filters: [] };
      agentLayers.set(agent, layer);
    }
    return layer;
  };
  const visibleOf = (agent) => {
    const map = new Map(globalTools);
    const layer = agent === void 0 ? void 0 : agentLayers.get(agent);
    const filters = layer?.filters ?? [];
    for (const name of [...map.keys()]) {
      const admitted = filters.every((filter) =>
        (filter.allow === void 0 || filter.allow.has(name))
        && (filter.deny === void 0 || !filter.deny.has(name)));
      if (!admitted) map.delete(name);
    }
    for (const [name, definition] of layer?.own ?? []) map.set(name, definition);
    return map;
  };
  // 模型可见投影：宿主 schemas() 只放 name/description/parameters。
  const schemasOf = (agent) => [...visibleOf(agent).values()]
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
  const surfaceJson = (agent) => JSON.stringify(schemasOf(agent));

  for (const [name, description] of HOST_TOOLS) {
    if (options.withoutHostTools?.includes(name)) continue;
    globalTools.set(name, makeDef(name, description));
  }
  if (options.withBase === true) globalTools.set(HOST_BASE_TOOL.name, HOST_BASE_TOOL);

  const listeners = new Map();
  const on = (name, callback) => listeners.set(name, [...(listeners.get(name) ?? []), callback]);
  const guards = [];
  const activations = [];
  const services = {
    profileContext: { home },
    agents: {
      list: () => [],
      get: () => void 0,
      isOwnedBy: () => false,
    },
    sessions: { get: () => void 0 },
    sessionTitle: { get: () => void 0, rename: () => {} },
    sessionController: { agents: { selectForNextRequest: () => {} }, history: { closeFollowers: new Map() } },
    sessionProjections: { stateOf: () => void 0 },
    subagents: {
      startActivation: async (spec) => {
        activations.push(spec);
        return { childId: `child-${activations.length}` };
      },
      sendMessage: async () => {},
    },
  };

  const rootTools = {
    register: (definition) => {
      if (globalTools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
      globalTools.set(definition.name, definition);
      return () => globalTools.delete(definition.name);
    },
    get: (name, agent) => visibleOf(agent).get(name),
    schemas: (agent) => schemasOf(agent),
    guard: (callback) => guards.push(callback),
    // 宿主语义：root 层没有 scope，restrict 必抛。
    restrict: () => { throw new Error("cannot get required service \"tools\" in inactive context"); },
  };

  const sessionTools = (agent) => ({
    register: (definition) => {
      const layer = layerOf(agent);
      if (layer.own.has(definition.name)) {
        throw new Error(`tool "${definition.name}" is already registered in this scope`);
      }
      layer.own.set(definition.name, definition);
      return () => layer.own.delete(definition.name);
    },
    get: (name) => visibleOf(agent).get(name),
    schemas: () => schemasOf(agent),
    restrict: (filter) => {
      layerOf(agent).filters.push({
        allow: filter.allow === void 0 ? void 0 : new Set(filter.allow),
        deny: filter.deny === void 0 ? void 0 : new Set(filter.deny),
      });
    },
  });

  const injected = (agent, names) => {
    void names;
    return {
      ...services,
      get: (name) => services[name],
      root: ctx,
      tools: sessionTools(agent),
    };
  };

  const sections = [];
  const ctx = {
    profileContext: services.profileContext,
    agents: services.agents,
    sessions: services.sessions,
    sessionTitle: services.sessionTitle,
    get: (name) => services[name],
    on,
    inject: (names, callback) => callback({ get: (name) => services[name], root: ctx }),
    effect: (fn) => fn(),
    tools: rootTools,
    systemPrompt: {
      getSectionOrder: () => 10,
      section: (definition) => sections.push(definition),
    },
  };
  ctx.root = ctx;

  // 每个 agent 一份会话层：闭包必须绑到它自己，不能共用 undefined 键的层。
  const makeAgent = (id, origin = options.origin ?? "leader") => {
    const created = {
      id,
      status: "idle",
      session: { header: { id, cwd, origin } },
      ctx: {
        get: (name) => services[name],
        inject: (names, callback) => callback(injected(created, names)),
      },
    };
    return created;
  };
  const agent = makeAgent(sessionId);

  for (const plugin of PLUGINS) plugin.apply(ctx);

  const emit = async (name, payload) => {
    for (const callback of listeners.get(name) ?? []) await callback(payload);
  };

  return {
    home,
    sessionId,
    agent,
    ctx,
    globalTools,
    sections,
    listeners,
    activations,
    surfaceJson: (agentLike) => surfaceJson(agentLike ?? agent),
    schemasOf: (agentLike) => schemasOf(agentLike ?? agent),
    ownNames: (agentLike = agent) => [...(agentLayers.get(agentLike)?.own.keys() ?? [])],
    rtcFor: (agentLike = agent) => injected(agentLike, ["tools"]),
    clearOwn: (agentLike = agent) => agentLayers.get(agentLike)?.own.clear(),
    visible: (agentLike = agent) => visibleOf(agentLike),
    sectionTexts: (scope = agent) => sections.map((section) => section.text({ scope })).filter((text) => text !== ""),
    created: (agentLike = agent) => emit("agent/created", { agent: agentLike }),
    preStep: async (agentLike = agent) => {
      for (const callback of listeners.get("agent/pre-step") ?? []) await callback({ agent: agentLike }, () => {});
    },
    newAgent: (id, origin = "leader") => makeAgent(id, origin),
    snapshotFile: (id = sessionId) => `${home}/caseos/session-state/${id}.surface.json`,
    // 模拟「新版插件」：换掉某个工具的当前实现文案（等价于改了 SLIM_DESC 后热重载）。
    overrideToolText: (name, description) => {
      registerSurfaceTool(name, (agentLike, get) => {
        const current = get(name);
        if (current === void 0) return void 0;
        void agentLike;
        return { ...current, name, description };
      });
    },
    overrideSectionText: (name, text) => {
      registerSurfaceSection(name, () => text);
    },
    resetSurfaceCache,
  };
}

function agentOf(host, id) {
  return host.newAgent(id);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------
// 1 同一会话两次构建逐字节相同（重启 + 会话恢复）
// ---------------------------------------------------------------------------
test("同一会话重启后重建工具面与系统段，逐字节相同", async () => {
  const home = mkdtempSync(join(tmpdir(), "verispring-surface-a-"));
  const first = createHost({ home });
  await first.created();
  const toolsJson = first.surfaceJson();
  const sectionTexts = first.sectionTexts();
  assert.ok(toolsJson.includes("subagent"), "领导面必须有 subagent");
  assert.ok(sectionTexts.some((text) => text.includes("分工：")), "领导分工段必须注入");

  // 同一会话、同一状态目录，新进程（模块缓存与安装标记都是新的）。
  const second = createHost({ home });
  await second.created();
  assert.equal(second.surfaceJson(), toolsJson, "重启后模型可见工具面必须逐字节相同");
  assert.deepEqual(second.sectionTexts(), sectionTexts, "重启后系统段必须逐字相同");

  // 同进程再装一次（agent/pre-step 路径）不得改变模型面，也不得重复注册。
  await second.created();
  await second.preStep();
  assert.equal(second.surfaceJson(), toolsJson);

  // 模拟「旧注册随热重载释放、模块缓存还没清」：会话层被清空后按同一份快照重装，模型面不变。
  second.clearOwn();
  const reinstalled = installSessionSurface({
    stateDir: `${second.home}/caseos/session-state`,
    agent: second.agent,
    rtc: second.rtcFor(),
  });
  assert.deepEqual(reinstalled, ["subagent", "send_message", "interrupt_agent", "list_agents", "release_subagent"]);
  assert.equal(second.surfaceJson(), toolsJson, "重装后模型面必须与首次构建逐字节相同");
});

// ---------------------------------------------------------------------------
// 2 subagent 参数说明：所有注册路径同一形态
// ---------------------------------------------------------------------------
test("subagent 参数说明在全局入口/会话冻结/有无宿主基座四种路径下同一形态", async () => {
  const home = mkdtempSync(join(tmpdir(), "verispring-surface-b-"));
  const withBase = createHost({ home, sessionId: "session-shape-base", withBase: true });
  await withBase.created();
  const withoutBase = createHost({ home, sessionId: "session-shape-plain" });
  await withoutBase.created();

  const pick = (def) => JSON.stringify({ description: def.description, parameters: def.parameters });
  const globalPath = pick(withBase.globalTools.get("subagent"));
  const sessionPath = pick(withBase.visible().get("subagent"));
  const plainPath = pick(withoutBase.visible().get("subagent"));
  assert.ok(withBase.visible().has("subagent-base") === false, "基座在领导面被藏掉");
  assert.equal(sessionPath, globalPath, "会话冻结注册与全局入口必须同一形态");
  assert.equal(plainPath, globalPath, "宿主有没有 subagent-base 不能改变模型面参数形态");

  const parameters = JSON.parse(globalPath).parameters;
  assert.deepEqual(parameters.required, ["description", "prompt"]);
  for (const key of ["cwd", "description", "prompt"]) {
    assert.equal(typeof parameters.properties[key]?.description, "string", `${key} 必须有参数说明`);
    assert.ok(parameters.properties[key].description.length > 0, `${key} 的参数说明不能为空`);
    assert.ok(parameters.properties[key].description.length < 60, `${key} 的参数说明按瘦身口径截短`);
  }
  assert.ok(JSON.parse(globalPath).description.includes("测绘"), "subagent 描述必须保留测绘前缀口径");
  // 全局入口与会话层各自的对象也必须已是同一份形态（不是靠视图覆盖才相同）。
  assert.equal(pick(withoutBase.globalTools.get("subagent")), globalPath);
});

// ---------------------------------------------------------------------------
// 3 快照规则：新工具不暴露给旧会话、快照多余的跳过、新系统段不注入
// ---------------------------------------------------------------------------
test("旧会话快照里没有的工具不暴露，快照有而当前没有的跳过并留痕", async () => {
  const home = mkdtempSync(join(tmpdir(), "verispring-surface-c-"));
  const id = "session-old";
  // 造一份「旧版本」快照：只有 subagent 与一个当前实现没有的 ask_scout；没有系统段。
  mkdirSync(`${home}/caseos/session-state`, { recursive: true });
  writeFileSync(`${home}/caseos/session-state/${id}.surface.json`, `${JSON.stringify({
    version: 1,
    session: id,
    order: ["subagent", "ask_scout"],
    tools: {
      subagent: {
        description: "旧版 subagent 描述",
        parameters: { type: "object", properties: { description: { type: "string" } }, required: ["description"] },
      },
      ask_scout: { description: "旧版 ask_scout", parameters: { type: "object", properties: {} } },
    },
    sections: {},
  }, null, 2)}\n`);
  const host = createHost({ home, sessionId: id });
  const stderr = await withStderr(() => host.created());
  const visible = host.visible();
  assert.equal(visible.get("subagent").description, "旧版 subagent 描述", "旧会话必须用快照里的文案");
  assert.equal(visible.has("send_message"), false, "快照里没有的工具不得对旧会话暴露");
  assert.equal(visible.has("list_agents"), false, "快照里没有的工具不得对旧会话暴露");
  assert.equal(visible.has("ask_scout"), false, "快照有而当前没有的工具不得出现");
  assert.match(stderr, /快照里有 ask_scout，当前实现没有该工具，跳过注册/);
  assert.match(stderr, /新工具只对新会话生效/);
  assert.deepEqual(host.sectionTexts(), [], "旧会话快照里没有的系统段不得注入");
});

// ---------------------------------------------------------------------------
// 4 返回值与 output.schema 一致（宿主 additionalProperties:false 校验）
// ---------------------------------------------------------------------------
test("subagent 返回值键都在 output.schema 里声明（含 route/role/replacedScoutId）", async () => {
  const home = mkdtempSync(join(tmpdir(), "verispring-surface-d-"));
  const host = createHost({ home, sessionId: "session-output" });
  await host.created();
  const tool = host.visible().get("subagent");
  assert.equal(tool.output.schema.additionalProperties, false);
  const declared = new Set(Object.keys(tool.output.schema.properties));

  // 上一任测绘不可达 → 回执带 replacedScoutId（宿主报错时多出来的正是 route/role/replacedScoutId）。
  writeFileSync(`${home}/caseos/session-state/${host.sessionId}.json`, `${JSON.stringify({
    version: 1,
    scoutId: "scout-old",
    scoutUnreachable: "end=error",
  })}\n`);
  const value = await tool.execute({ description: "测绘智能体：增量校对", prompt: "增量校对" }, { agent: host.agent });
  for (const key of Object.keys(value)) {
    assert.ok(declared.has(key), `返回值里的 ${key} 必须在 output.schema 里声明`);
  }
  assert.equal(value.kind, "activation");
  assert.equal(value.role, "scout");
  assert.equal(value.replacedScoutId, "scout-old");
  assert.ok(declared.has("route") && declared.has("role") && declared.has("replacedScoutId"));
  assert.ok(tool.output.render({}, value)[0].text.startsWith(`started subagent ${value.subagentId}`));
});

// ---------------------------------------------------------------------------
// 5 子代理会话同样冻结（ask_scout 一类的插件文案在子代理面也在前缀里）
// ---------------------------------------------------------------------------
test("子代理会话的工具面同样按快照冻结：旧会话不变、新会话拿新版", async () => {
  const home = mkdtempSync(join(tmpdir(), "verispring-surface-g-"));
  const first = createHost({ home, sessionId: "session-leader-x" });
  await first.created();
  const childId = "child-frozen";
  const child = first.newAgent(childId, "subagent");
  await first.created(child);
  const childTools = first.surfaceJson(child);
  const childVisible = first.visible(child);
  assert.ok(childVisible.has("ask_scout"), "子代理面必须有 ask_scout");
  assert.equal(childVisible.has("release_subagent"), false, "子代理面不得出现 release_subagent");
  const oldAsk = childVisible.get("ask_scout").description;
  const snapshot = JSON.parse(readFileSync(first.snapshotFile(childId), "utf8"));
  assert.deepEqual(Object.keys(snapshot.tools), ["ask_scout"], "子代理快照只含子代理面的插件工具");
  assert.ok(snapshot.sections["verispring:manon-kg"].includes("常驻测绘专责维护"), "执行者角色段随快照冻结");

  const NEW_ASK = "新版 ask_scout 描述（代表一次文案提交）。";
  resetSurfaceCache();
  const restarted = createHost({ home, sessionId: "session-leader-x" });
  await restarted.created();
  restarted.overrideToolText("ask_scout", NEW_ASK);
  const resumedChild = restarted.newAgent(childId, "subagent");
  await restarted.created(resumedChild);
  assert.equal(restarted.visible(resumedChild).get("ask_scout").description, oldAsk, "旧子代理会话必须仍是旧文案");
  assert.equal(restarted.surfaceJson(resumedChild), childTools, "旧子代理会话工具面必须逐字节不变");

  const freshChildId = "child-fresh";
  const freshChild = restarted.newAgent(freshChildId, "subagent");
  await restarted.created(freshChild);
  assert.equal(restarted.visible(freshChild).get("ask_scout").description, NEW_ASK, "新子代理会话拿新版");
});

// ---------------------------------------------------------------------------
// 6 文案变更只对新会话生效（旧会话恢复后仍是旧文案）
// ---------------------------------------------------------------------------
test("模拟文案变更后恢复旧会话：模型可见定义与系统段不变；新会话拿新版", async () => {
  const home = mkdtempSync(join(tmpdir(), "verispring-surface-e-"));
  const first = createHost({ home, sessionId: "session-frozen" });
  await first.created();
  const oldTools = first.surfaceJson();
  const oldSections = first.sectionTexts();
  const oldSubagent = JSON.parse(oldTools).find((entry) => entry.name === "subagent").description;

  const SECOND_TEXT = "新版 subagent 描述（只在本次测试里代表一次文案提交）。";
  const NEW_SECTION = "新版分工文案（代表一次系统段改写）。";
  resetSurfaceCache();

  // 同一状态目录、同一会话 id：先跑 apply（旧文案），再换掉当前实现文案 —— 等价于热重载到新版。
  const restarted = createHost({ home, sessionId: "session-frozen" });
  restarted.overrideToolText("subagent", SECOND_TEXT);
  restarted.overrideSectionText("caseos:leader-dispatch", NEW_SECTION);
  await restarted.created();
  const restoredTools = restarted.surfaceJson();
  const restoredSubagent = JSON.parse(restoredTools).find((entry) => entry.name === "subagent").description;
  assert.equal(restoredSubagent, oldSubagent, "旧会话恢复后必须仍是快照里的旧文案");
  assert.equal(restoredTools, oldTools, "旧会话恢复后模型可见工具面必须逐字节不变");
  assert.deepEqual(restarted.sectionTexts(), oldSections, "旧会话的系统段必须不变");
  assert.equal(restarted.sectionTexts().some((text) => text.includes(NEW_SECTION)), false);

  // 同一进程里的新会话：按当前实现建快照，拿新版。
  const freshAgent = agentOf(restarted, "session-fresh");
  await restarted.created(freshAgent);
  const freshTools = restarted.surfaceJson(freshAgent);
  const freshSubagent = JSON.parse(freshTools).find((entry) => entry.name === "subagent").description;
  assert.equal(freshSubagent, SECOND_TEXT, "新会话必须拿到新版文案");
  assert.notEqual(freshTools, oldTools);
  assert.ok(restarted.sectionTexts(freshAgent).some((text) => text.includes(NEW_SECTION)), "新会话必须注入新版系统段");

  // 工具面顺序固定：新会话的工具序列与旧会话一致（只有文案不同）。
  const namesOld = JSON.parse(oldTools).map((entry) => entry.name);
  const namesNew = JSON.parse(freshTools).map((entry) => entry.name);
  assert.deepEqual(namesNew, namesOld, "工具顺序不得随会话变化");
  assert.deepEqual(namesNew, [...new Set(namesNew)]);
});

test("注册顺序固定：会话层按 SURFACE_TOOL_ORDER 装，快照按同一顺序记录", async () => {
  const home = mkdtempSync(join(tmpdir(), "verispring-surface-f-"));
  const host = createHost({ home, sessionId: "session-order" });
  await host.created();
  const expected = [...SURFACE_TOOL_ORDER].filter((name) => name !== "ask_scout");
  assert.deepEqual(host.ownNames(), expected, "会话层注册顺序必须固定为 SURFACE_TOOL_ORDER");
  const snapshot = JSON.parse(readFileSync(host.snapshotFile(), "utf8"));
  assert.deepEqual(Object.keys(snapshot.tools), expected);
  assert.equal(snapshot.version, 1);
  const names = host.schemasOf().map((entry) => entry.name);
  assert.equal(names.includes("ask_scout"), false, "领导面不得出现 ask_scout（allow 名单之外）");

  // 同一会话重建：可见顺序逐项相同（宿主继承层顺序 + 会话层固定顺序）。
  const again = createHost({ home, sessionId: "session-order" });
  await again.created();
  assert.deepEqual(again.schemasOf().map((entry) => entry.name), names);
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
console.log(`test-tool-surface: ${tests.length - failed}/${tests.length} passed`);
// 派遣回执的标题重写用的是长定时器，测试不等它自然走完：结论已定，直接收尾。
process.exit(failed > 0 ? 1 : 0);
