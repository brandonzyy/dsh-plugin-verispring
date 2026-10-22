// 逐会话冻结「模型可见工具面 + 本插件注入的系统段」。
//
// 代价：工具定义（name/description/parameters 及顺序）排在 Anthropic 提示缓存前缀的最前面，
// 系统段紧随其后。任何一个字节变化，所有在跑会话的下一轮都要整段重写前缀（实测每次
// 15 万~39 万 token）。会话日志（~/.dsh/sessions/**/session.v4.jsonl.zstd 里 type=request/header
// 的 data.header.tools）实证过同一会话内工具集反复变化：5cc6c9 ↔ 00f363 是 subagent 三个参数
// 说明在「全局手写 schema」与「宿主基座 slim」两条注册路径间来回切；fc4bd78 改一段 SLIM_DESC
// 直接进了在跑会话；9cabfb8 新增工具让工具数 10 → 11。每次都对上一次生产网关的整段重写。
//
// 口径：会话首次构建工具面时，把该会话最终顺序的模型可见定义（description/parameters）与
// 本插件注册的全部系统段文本快照进 ~/.dsh/caseos/session-state/<会话id>.surface.json；此后
// 同一会话（恢复、重启、热重载）一律按快照注册与出文案，执行闭包取当前实现。于是：
// - 新增/改写的文案与新增工具只对新会话生效（旧会话看不到快照里没有的名字）；
// - 快照里有、当前实现没有的工具跳过并记一行 stderr；
// - 快照损坏/缺失按当前定义重建并写回（升级后第一次恢复即按当时的实现重建一次）。
// 唯一按「当前实现」出的工具定义是执行体本身（execute/output）；模型可见字段只来自快照。
//
// 已知例外（保持现行为，见 README）：caseos:scout-relay 段随「可达测绘 id」变化，那是会话
// 状态事实，冻结会把执行者指向已换掉的旧测绘，因此不纳入快照。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const VERSION = 1;

// 领导者/子代理面里的插件工具，注册顺序即模型可见顺序。顺序本身也是缓存前缀的一部分。
// 新增一个插件工具 = 在这里加名字 + 在所属插件里 registerSurfaceTool(name, factory)：
// 名字不在这个表里就不会被冻结（也就不会受「新工具只对新会话生效」保护）。
export const SURFACE_TOOL_ORDER = Object.freeze([
  "subagent",
  "send_message",
  "interrupt_agent",
  "list_agents",
  "release_subagent",
  "ask_scout",
]);

// name -> (agent, get) => 当前实现的工具定义（含 execute/output）。get(name) 取该会话当前视图。
const toolProviders = new Map();
// name -> (agent) => 当前实现的段文本。
const sectionProviders = new Map();
// stateDir\0会话id -> 快照（进程内缓存；插件重载会重建模块实例，缓存随之清空）。
// 子代理会话会被反复创建/释放，缓存按 FIFO 封顶：淘汰后回落到读盘，主进程不会为此无界增长。
const cache = new Map();
const MAX_CACHED_SURFACES = 256;
// 已经装过的 agent：同一个进程里 agent/created 与 agent/pre-step 都会调安装，只装一次。
// 记下装过的名字：热重载只换了部分模块时旧注册可能已随旧作用域释放，这时要按同一份快照重装，
// 不能因为「装过」就跳过（否则模型面会回落到全局入口的新文案）。
let installedAgents = new WeakSet();
let installedNames = new WeakMap();
const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`caseos-tool-surface: ${message}\n`);
}

function sessionIdOf(session) {
  return session?.header?.id ?? session?.header?.sessionId ?? session?.id ?? session?.sessionId ?? void 0;
}

function surfaceKey(stateDir, sessionId) {
  return `${stateDir}\u0000${sessionId}`;
}

function surfaceFile(stateDir, sessionId) {
  return `${stateDir}/${sessionId}.surface.json`;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
}

export function registerSurfaceTool(name, build) {
  if (!SURFACE_TOOL_ORDER.includes(name) || typeof build !== "function") return;
  toolProviders.set(name, build);
}

export function registerSurfaceSection(name, build) {
  if (typeof name !== "string" || !name || typeof build !== "function") return;
  sectionProviders.set(name, build);
}

// 测试与热重载钩子：清空进程内快照缓存与安装标记（落盘快照不受影响）。
export function resetSurfaceCache() {
  cache.clear();
  installedAgents = new WeakSet();
  installedNames = new WeakMap();
  warned.clear();
}

// 快照文件只有一种合法形态；缺字段/版本不符/解析失败一律当作损坏，调用方按当前实现重建。
function readSurfaceFile(stateDir, sessionId) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(surfaceFile(stateDir, sessionId), "utf8"));
  } catch {
    return void 0;
  }
  if (!raw || typeof raw !== "object" || raw.version !== VERSION) return void 0;
  if (!raw.tools || typeof raw.tools !== "object" || Array.isArray(raw.tools)) return void 0;
  const tools = {};
  for (const name of SURFACE_TOOL_ORDER) {
    const entry = raw.tools[name];
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.description !== "string") return void 0;
    if (!entry.parameters || typeof entry.parameters !== "object") return void 0;
    tools[name] = { description: entry.description, parameters: cloneJson(entry.parameters) };
  }
  // 快照里有、而本版本的 SURFACE_TOOL_ORDER 已经不列的工具：代码删掉了它，跳过并留一行。
  for (const name of Object.keys(raw.tools)) {
    if (SURFACE_TOOL_ORDER.includes(name)) continue;
    warnOnce(`${surfaceKey(stateDir, sessionId)}\u0000dropped\u0000${name}`,
      `会话 ${sessionId} 快照里有 ${name}，当前版本已不提供该工具，跳过`);
  }
  const sections = {};
  const rawSections = raw.sections && typeof raw.sections === "object" ? raw.sections : {};
  for (const [name, text] of Object.entries(rawSections)) {
    if (typeof text === "string") sections[name] = text;
  }
  return { fresh: false, session: sessionId, tools, sections };
}

function writeSurfaceFile(stateDir, sessionId, surface) {
  const file = surfaceFile(stateDir, sessionId);
  try {
    mkdirSync(stateDir, { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify({
      version: VERSION,
      session: sessionId,
      order: Object.keys(surface.tools),
      tools: surface.tools,
      sections: surface.sections,
    }, null, 2)}\n`);
    renameSync(temp, file);
    return true;
  } catch (error) {
    process.stderr.write(`caseos-tool-surface: 会话 ${sessionId} 工具面快照落盘失败: ${String(error)}\n`);
    return false;
  }
}

function currentToolDef(name, agent, get) {
  const build = toolProviders.get(name);
  if (build === void 0) return void 0;
  try {
    const def = build(agent, get);
    return def && typeof def === "object" && typeof def.name === "string" ? def : void 0;
  } catch (error) {
    process.stderr.write(`caseos-tool-surface: 工具 ${name} 当前定义构建失败: ${String(error)}\n`);
    return void 0;
  }
}

function buildSurface(agent, get) {
  const tools = {};
  for (const name of SURFACE_TOOL_ORDER) {
    const def = currentToolDef(name, agent, get);
    if (def === void 0) continue;
    tools[name] = {
      description: typeof def.description === "string" ? def.description : "",
      parameters: cloneJson(def.parameters ?? {}),
    };
  }
  const sections = {};
  for (const [name, build] of sectionProviders) {
    try {
      const text = build(agent);
      sections[name] = typeof text === "string" ? text : "";
    } catch (error) {
      process.stderr.write(`caseos-tool-surface: 系统段 ${name} 当前文本构建失败: ${String(error)}\n`);
      sections[name] = "";
    }
  }
  return { fresh: true, session: sessionIdOf(agent?.session), tools, sections };
}

// 取该会话的冻结快照：没有就按当前实现建一份并落盘。没有会话 id（无状态可挂）时返回 undefined。
function ensureSurface(stateDir, agent, get) {
  const sessionId = sessionIdOf(agent?.session);
  if (!stateDir || !sessionId) return void 0;
  const key = surfaceKey(stateDir, sessionId);
  const cached = cache.get(key);
  if (cached !== void 0) return cached;
  let surface = readSurfaceFile(stateDir, sessionId);
  if (surface === void 0) {
    surface = buildSurface(agent, get);
    writeSurfaceFile(stateDir, sessionId, surface);
    const tools = Object.keys(surface.tools);
    warnOnce(`${key}\u0000build`,
      `会话 ${sessionId} 工具面首次冻结（工具 ${tools.length} 个：${tools.join(", ") || "无"}；系统段 ${Object.keys(surface.sections).length} 段）`);
  }
  cache.set(key, surface);
  if (cache.size > MAX_CACHED_SURFACES) {
    const oldest = cache.keys().next().value;
    if (oldest !== void 0) cache.delete(oldest);
  }
  return surface;
}

// 按快照把模型可见定义装回会话自己的工具层，执行闭包用当前实现（current 的 execute/output）。
// 返回实际注册的名字列表；模型看不到的名字（快照有当前没有、当前有快照没有）不注册。
export function installSessionSurface({ stateDir, agent, rtc }) {
  if (!agent || !rtc?.tools || typeof rtc.tools.register !== "function") return [];
  const sessionId = sessionIdOf(agent?.session);
  const get = (name) => {
    try {
      return rtc.tools.get?.(name, agent);
    } catch {
      return void 0;
    }
  };
  if (installedAgents.has(agent)) {
    const previous = installedNames.get(agent) ?? [];
    const alive = previous.every((name) => get(name)?.__caseosSurface === true);
    if (alive) return previous;
    // 旧注册已随旧作用域释放：按同一份快照重装，别把模型面丢回全局入口。
    installedAgents.delete(agent);
    installedNames.delete(agent);
  }
  const surface = ensureSurface(stateDir, agent, get);
  if (surface === void 0) return [];
  installedAgents.add(agent);
  const registered = [];
  // 本版本新增、而该会话快照里没有的工具：不能让它在旧会话里冒出来——工具由插件全局注册时
  // 旧会话会从继承层看到它，这里用该会话的 restrict 摘掉（会话自注册的工具本就不会生效）。
  const hiddenNew = [];
  for (const name of SURFACE_TOOL_ORDER) {
    const frozen = surface.tools[name];
    const current = currentToolDef(name, agent, get);
    if (frozen !== void 0) {
      if (current === void 0) {
        warnOnce(`${surfaceKey(stateDir, sessionId)}\u0000missing\u0000${name}`,
          `会话 ${sessionId} 快照里有 ${name}，当前实现没有该工具，跳过注册`);
        continue;
      }
      try {
        rtc.tools.register({
          ...current,
          description: frozen.description,
          parameters: cloneJson(frozen.parameters),
          // 非模型可见标记：pre-step 据此判断冻结注册是否还在（热重载后需要重装）。
          __caseosSurface: true,
        });
        registered.push(name);
      } catch (error) {
        process.stderr.write(`caseos-tool-surface: 会话 ${sessionId} 冻结注册 ${name} 失败: ${String(error)}\n`);
      }
      continue;
    }
    if (current !== void 0) {
      hiddenNew.push(name);
      warnOnce(`${surfaceKey(stateDir, sessionId)}\u0000extra\u0000${name}`,
        `会话 ${sessionId} 的快照里没有 ${name}：新工具只对新会话生效，旧会话不暴露`);
    }
  }
  installedNames.set(agent, registered);
  if (hiddenNew.length > 0) {
    try {
      rtc.tools.restrict({ deny: hiddenNew });
    } catch (error) {
      process.stderr.write(`caseos-tool-surface: 会话 ${sessionId} 隐藏新工具 ${hiddenNew.join(", ")} 失败: ${String(error)}\n`);
    }
  }
  return registered;
}

// 系统段文本的唯一出口：会话有快照就返回快照里的那份；快照里没有这段（本版本新增的段）
// 对该会话返回空串——新文案只对新会话生效。还没有快照（安装未跑到）时保持现行为。
export function frozenSectionText({ stateDir, session, name, current }) {
  const sessionId = sessionIdOf(session);
  if (!stateDir || !sessionId) return current;
  const surface = cache.get(surfaceKey(stateDir, sessionId)) ?? readSurfaceFile(stateDir, sessionId);
  if (surface === void 0) return current;
  if (Object.hasOwn(surface.sections, name) === false) {
    warnOnce(`${surfaceKey(stateDir, sessionId)}\u0000section\u0000${name}`,
      `会话 ${sessionId} 的快照里没有系统段 ${name}：新文案只对新会话生效，旧会话不注入该段`);
    return "";
  }
  return surface.sections[name];
}
