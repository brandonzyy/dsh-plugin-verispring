// Verispring 派遣门禁（六条代码级强制 + 监控）：
// 1 规范门：subagent / subagent_fork 调用前，本会话必须出现过《子代理派遣规范》首行标记
//   （read/bash 结果内容判定，增量扫描会话事件；会话日志是唯一事实源，跨进程重启不丢）。
// 2 测绘常驻（按可达性判定）：本会话首笔派遣由运行时定为测绘（description 只是展示标签，
//   模型无法漏写前缀跳过测绘）。当前测绘 id 落 ~/.dsh/caseos/session-state/<会话id>.json
//   （{version:1, scoutId}；本门唯一写入方，harness 拒绝含未知类型的会话日志）。
//   常驻的判据是可达，不是标题前缀：子代理每次应询结束都会 settle 成 completed 并移出
//   resident，send_message 走冷恢复，所以 finished/inactive 都不算失联；只有该 id 的
//   subagent/end stopReason 不是 completed，或领导 send_message 回报 unavailable /
//   NOT_RESUMABLE，才判定不可达。不可达后下一笔派遣自动接替为测绘，并在 prompt 前注入
//   上任测绘 id 与仓库根地图全文（只做增量校对）。测绘子代理 deny edit/write。
//   子代理自身的角色同样落盘（同目录 <子会话id>.json {role}）：重载后 childPlan 优先读
//   落盘角色，其次按标题自愈（label 已写为标题），最后才按父会话状态推导——否则常驻测绘
//   会在内存路由表清空后被静默重归类为执行（v1.3.58 实测事故）。
// 3 地图前置 + 新鲜度：非测绘派遣要求 <会话工作区>/.project-map.md 存在——cwd 取会话
//   header 的 cwd（桌面宿主进程目录不是项目根），且 .git 或 .manon 在场才认定项目根，否则
//   放行（fail-open）。没有地图先派测绘（建图 + 入口表），由领导 write 落盘后重派；
//   write 该文件时把当前 HEAD 登记为新鲜度基准（caseos/map-baselines.json），此后 main
//   再前进就拒绝执行派遣，指路测绘增量校对 + 重写地图登记新基准（首建前与 CASEOS_SCOUT=0
//   时 fail-open）。
// 4 模型路由：测绘与执行分别读取面板配置（verispring.json），运行时按角色强制注入，
//   调用里显式写的 provider/model 一律忽略。fork 拒绝（三智能体架构唯一入口是 spawn）。
// 5 子代理 preset：spawn 通过 agentPreset 显式选择 verispring-subagent；创建事件只负责
//   记录组合结果，不再发送 0.2.1-rc.1 已移除的 persona/toolFilter 请求字段。
//   subagent-base 只在领导会话层隐藏（root 层 restrict 必然抛错：宿主要求 scoped ctx），
//   路由执行体异常时模型应无路可走，而非退回裸派遣。
// 6 监控只写事实：门禁拦截、角色漂移、子代理 start/start-failed/end/error（角色 + 路由 +
//   子代理 id + 报错 message/code）追加落盘 ~/.dsh/verispring-monitor.jsonl
//   （gates/monitor-log.js）；start 只在 spawn 成功后才记。
// 规范目录按主目录解析（~/.dsh/specs/），搬家无需改码。
const MARKER = "# 子代理派遣规范";
const SPEC_FRAGMENT = "specs/子代理派遣规范.md";
const GATE_TOOLS = new Set(["subagent", "subagent_fork"]);
const MAP_FILE = ".project-map.md";
const SUBAGENT_PRESET = "verispring-subagent";
const BASE_SUBAGENT_TOOL = "subagent-base";
const LEADER_SUBAGENT_TOOL = "subagent";
const ROUTES_UPDATED_EVENT = "verispring/routes-updated";
const DEFAULT_ROUTES = {
  scout: { provider: "verispring", model: "deepseek-flash", reasoningEffort: "high" },
  executor: { provider: "verispring", model: "deepseek-flash", reasoningEffort: "high" },
};
// 用户配置文件（配置面板写入）：{ scout: {...}, executor: {...} }。
// 读取失败/缺省回落常量，门禁永不因配置文件崩。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { SLIM_DESC, slimSchema } from "./leader-scope.js";
import { monitorEvent } from "./monitor-log.js";

function loadRoutes(configFile) {
  try {
    const cfg = JSON.parse(readFileSync(configFile, "utf8"));
    const route = (name) => {
      const configured = cfg?.[name];
      if (!configured?.provider || !configured?.model) return DEFAULT_ROUTES[name];
      return {
        ...DEFAULT_ROUTES[name],
        ...configured,
        reasoningEffort: configured.reasoningEffort || DEFAULT_ROUTES[name].reasoningEffort,
      };
    };
    return { scout: route("scout"), executor: route("executor") };
  } catch (error) {
    // 配置文件是唯一事实源；损坏时恢复默认结构，避免每次启动继续运行在不可见的旧路由上。
    try {
      const temp = `${configFile}.tmp-${process.pid}`;
      mkdirSync(`${configFile.slice(0, configFile.lastIndexOf("/"))}`, { recursive: true });
      writeFileSync(temp, `${JSON.stringify(DEFAULT_ROUTES, null, 2)}\n`);
      renameSync(temp, configFile);
      process.stderr.write(`caseos-dispatch-gate: verispring.json 已按默认路由自愈: ${String(error)}\n`);
    } catch (repairError) {
      process.stderr.write(`caseos-dispatch-gate: verispring.json 自愈失败: ${String(repairError)}\n`);
    }
  }
  return DEFAULT_ROUTES;
}

function isScoutDescription(description) {
  const value = String(description ?? "").trim().toLowerCase();
  return value.startsWith("测绘智能体") || value.startsWith("scout");
}

// 子代理角色持久化：spawn 时落盘（stateDir/<子会话id>.json {version, role}），
// childPlan 永远优先读它——进程重载后内存路由表清空也不能让常驻测绘被重新归类为执行。
function childRoleFile(stateDir, session) {
  const id = sessionIdOf(session);
  return id ? `${stateDir}/${id}.json` : void 0;
}

function readChildRole(stateDir, session) {
  const file = childRoleFile(stateDir, session);
  if (!file) return void 0;
  try {
    const role = JSON.parse(readFileSync(file, "utf8")).role;
    return role === "scout" || role === "executor" ? role : void 0;
  } catch {}
  return void 0;
}

function writeChildRole(stateDir, session, role) {
  const file = childRoleFile(stateDir, session);
  if (!file || (role !== "scout" && role !== "executor")) return;
  if (readChildRole(stateDir, session) === role) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ version: 1, role })}\n`);
  } catch (error) {
    process.stderr.write(`caseos-dispatch-gate: 子代理角色落盘失败: ${String(error)}\n`);
  }
}

// 会话标题自愈：spawn 时 label（含 " · scout|executor · "）已写为标题；标题是最早的
// 角色事实，历史子代理（修复前创建、无角色文件）据此恢复真实角色。
function roleFromTitle(sessionTitle, session) {
  if (!sessionTitle?.get) return void 0;
  try {
    const title = sessionTitle.get(session)?.title ?? "";
    if (title.includes(" · scout · ")) return "scout";
    if (title.includes(" · executor · ")) return "executor";
  } catch {}
  return void 0;
}

// git HEAD 读取（地图新鲜度门用）：非仓库/git 缺失一律返回 undefined 并放行（fail-open）。
function gitHead(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 3000, encoding: "utf8" }).trim() || void 0;
  } catch {}
  return void 0;
}

const MAP_BASELINES_FILE = "caseos/map-baselines.json";

function loadMapBaseline(dshHome, cwd) {
  try {
    const commit = JSON.parse(readFileSync(`${dshHome}/${MAP_BASELINES_FILE}`, "utf8"))[cwd]?.commit;
    return typeof commit === "string" && commit ? commit : void 0;
  } catch {}
  return void 0;
}

function saveMapBaseline(dshHome, cwd, commit) {
  if (!cwd || !commit) return;
  let all = {};
  try { all = JSON.parse(readFileSync(`${dshHome}/${MAP_BASELINES_FILE}`, "utf8")); } catch {}
  all[cwd] = { commit, at: new Date().toISOString() };
  try {
    mkdirSync(`${dshHome}/caseos`, { recursive: true });
    const temp = `${dshHome}/${MAP_BASELINES_FILE}.tmp-${process.pid}`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(temp, `${dshHome}/${MAP_BASELINES_FILE}`);
  } catch (error) {
    process.stderr.write(`caseos-dispatch-gate: 地图基准落盘失败: ${String(error)}\n`);
  }
}

// 宿主 agents 服务只在活跃 fiber 上解析；失活作用域读取会抛 inactive context。
function isInactiveContext(error) {
  return /inactive context/i.test(String(error?.message ?? error));
}

function routeText(route) {
  return `${route.provider}/${route.model}${route.reasoningEffort ? `@${route.reasoningEffort}` : ""}`;
}

function pathMatches(value, dshHome) {
  if (typeof value !== "string") return false;
  const expanded = value.startsWith("~/") ? dshHome + value.slice(1) : value;
  return expanded.includes(SPEC_FRAGMENT);
}

// 会话状态（规范已读 + 测绘可达）：规范已读增量扫描会话事件日志（WeakMap 缓存扫描
// 位点）；测绘身份与其可达性落在状态文件（跨进程、跨重启一致）。
const sessionStates = new WeakMap();
function sessionIdOf(session) {
  return session?.header?.id ?? session?.header?.sessionId ?? session?.id ?? session?.sessionId ?? void 0;
}

// 领导 send_message 的失败是测绘不可达的第二条事实来源：宿主冷恢复不可用时报
// NOT_RESUMABLE（"subagent \"…\" is unavailable"）。
function sendMessageFailure(result) {
  if (!result?.isError) return void 0;
  const message = String(result.error?.message ?? "");
  const code = String(result.error?.info?.code ?? "");
  if (code === "NOT_RESUMABLE" || /unavailable|NOT_RESUMABLE/i.test(message)) {
    return code || "NOT_RESUMABLE";
  }
  return void 0;
}

function readStateFile(sessionId, stateDir) {
  if (!sessionId) return {};
  try {
    return JSON.parse(readFileSync(`${stateDir}/${sessionId}.json`, "utf8")) ?? {};
  } catch {}
  return {};
}

function scoutIdIn(state) {
  const scoutId = state?.scoutId;
  return typeof scoutId === "string" && scoutId ? scoutId : void 0;
}

// 测绘身份只有一个事实源：会话状态文件里的 scoutId；不可达是外部事实（end 的 stopReason、
// send_message 的失败）推出的投影，与 scoutId 同写一个文件、同一次原子写。
function writeScoutState(sessionId, next, stateDir) {
  if (!sessionId) return;
  const current = readStateFile(sessionId, stateDir);
  const scoutId = next.scoutId !== undefined ? next.scoutId : scoutIdIn(current);
  const unreachable = next.unreachable !== undefined ? next.unreachable : current.scoutUnreachable;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      `${stateDir}/${sessionId}.json`,
      `${JSON.stringify({ version: 1, ...(scoutId ? { scoutId } : {}), ...(unreachable ? { scoutUnreachable: unreachable } : {}) })}\n`,
    );
  } catch (error) {
    process.stderr.write(`caseos-dispatch-gate: 状态文件写入失败: ${String(error)}\n`);
  }
}

// 常驻判据=可达，不是标题前缀：completed 只是应询结束（send_message 走冷恢复），仍算常驻；
// 只有 end 的 stopReason 非 completed，或 send_message 回报 NOT_RESUMABLE 一类错误才失联。
function reachableScoutId(sessionId, stateDir) {
  const state = readStateFile(sessionId, stateDir);
  if (state.scoutUnreachable) return void 0;
  return scoutIdIn(state);
}

// 只对当前这一任测绘生效：旧测绘迟到的 end 不得把刚接替的新测绘判成失联。
function markScoutUnreachable(sessionId, scoutId, reason, stateDir) {
  const state = readStateFile(sessionId, stateDir);
  if (!scoutId || state.scoutId !== scoutId || state.scoutUnreachable) return false;
  writeScoutState(sessionId, { unreachable: reason }, stateDir);
  return true;
}

// subagent/end 只带子代理 id（宿主把 parent 用作作用域键，不传给监听器），而可达性记在
// 父会话的状态文件里：这份索引把子代理 id 映射回会话 id。写入 scoutId 时填充；进程重启后
// 按状态目录懒重建（状态文件是唯一事实源）。
const scoutSessionIndex = new Map();
const indexedStateDirs = new Set();

// 键带状态目录：同一进程可能换 profile（DSH_HOME 变），子代理 id 只在各自目录内有意义。
const scoutKey = (stateDir, scoutId) => `${stateDir}\u0000${scoutId}`;

function rememberScoutOwner(scoutId, sessionId, stateDir) {
  if (scoutId && sessionId) scoutSessionIndex.set(scoutKey(stateDir, scoutId), sessionId);
}

function scoutOwnerOf(scoutId, stateDir) {
  if (!scoutId) return void 0;
  const key = scoutKey(stateDir, scoutId);
  const known = scoutSessionIndex.get(key);
  if (known) return known;
  if (!indexedStateDirs.has(stateDir)) {
    indexedStateDirs.add(stateDir);
    let names = [];
    try { names = readdirSync(stateDir); } catch {}
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sessionId = name.slice(0, -5);
      const owner = scoutIdIn(readStateFile(sessionId, stateDir));
      if (owner) rememberScoutOwner(owner, sessionId, stateDir);
    }
  }
  return scoutSessionIndex.get(key);
}

// 接替测绘的任务书前缀：说清上任测绘为何不可达，并把现有地图全文交底（只做增量校对）。
function scoutTakeoverPrefix({ previous, reason, cwd }) {
  const mapPath = `${cwd}/${MAP_FILE}`;
  let text = previous
    ? `【测绘接替】上任测绘 ${previous} ${reason}，本笔派遣自动接替为测绘智能体。`
    : `【测绘接替】${reason}，本笔派遣自动定为测绘智能体。`;
  try {
    text += `\n仓库已有地图（${mapPath}），只做增量校对：只核对变化部分并回报入口表 ≤20 行，不必重头建图。\n\n`
      + readFileSync(mapPath, "utf8");
  } catch {}
  return `${text}\n\n`;
}

function sessionState(session) {
  let st = sessionStates.get(session);
  if (!st) {
    st = { scanned: 0, specRead: false };
    sessionStates.set(session, st);
  }
  const total = typeof session?.seq === "number" ? session.seq : 0;
  for (let i = st.scanned; i < total; i++) {
    let e;
    try { e = session.eventAt(i); } catch { break; }
    if (!e) break;
    if (e.type === "tool/result" && !st.specRead) {
      const content = e.data?.message?.content;
      const text = Array.isArray(content) ? content.map((block) => block?.text ?? "").join("\n") : "";
      if (text.includes(MARKER)) {
        st.specRead = true;
        process.stderr.write("caseos-dispatch-gate: spec read detected\n");
      }
    }
  }
  st.scanned = Math.max(st.scanned, total);
  return st;
}

const pendingRoutePlans = new Map();
// 跨重载状态：面板改一次模型配置，cordis 就重跑一次 apply、旧作用域失活。这些状态
// 必须放在模块层才能跨重载延续（WeakSet 按对象、Map 按 id，重载不丢）。
const leaderToolInstalled = new WeakSet();
const leaderToolInstalling = new WeakSet();
const childRoutePlans = new Map();

function queueRoutePlan(parent, plan) {
  if (!parent) return;
  const queue = pendingRoutePlans.get(parent) ?? [];
  queue.push(plan);
  pendingRoutePlans.set(parent, queue);
}

function takeRoutePlan(parent) {
  if (!parent) return undefined;
  const queue = pendingRoutePlans.get(parent);
  const plan = queue?.shift();
  if (!queue?.length) pendingRoutePlans.delete(parent);
  return plan;
}

function renameChildTitle(ctx, childId, title) {
  const sessionTitle = ctx?.get?.("sessionTitle");
  const child = ctx?.get?.("agents")?.get(childId);
  if (!sessionTitle || !child?.session) return;
  try { sessionTitle.rename(child.session, title); }
  catch (error) { process.stderr.write(`caseos-dispatch-gate: 子代理标题写入失败: ${String(error)}\n`); }
}

function renameChildTitleAfterAutoTitle(ctx, childId, title) {
  for (const delay of [0, 1500, 5000, 10000]) {
    setTimeout(() => renameChildTitle(ctx, childId, title), delay);
  }
}

const plugin = {
  inject: ["tools", "agents", "sessionController", "sessionTitle", "profileContext"],
  apply(ctx) {
    const dshHome = ctx.profileContext?.home ?? process.env.DSH_HOME ?? `${homedir()}/.dsh`;
    const configFile = `${dshHome}/verispring.json`;
    const stateDir = `${dshHome}/caseos/session-state`;
    const specPath = `${dshHome}/specs/子代理派遣规范.md`;
    const denyReason =
      `派遣前必读 ${specPath}：先用 read 工具读取该规范（含任务书模板与派发前自查），然后重新发起本次调用。`;
    let routes = loadRoutes(configFile);
    // 子代理生命周期落监控：不再需要解压会话日志就能审计"谁、什么角色、什么路由、怎么结束的"。
    // end 也入账可达性：completed 只是应询结束（send_message 冷恢复），其余 stopReason 才算失联。
    ctx.root.on("subagent/end", (info) => {
      const cause = info?.error ?? info?.cause;
      monitorEvent(dshHome, {
        kind: "subagent-end",
        child: info?.id,
        provider: info?.provider,
        stopReason: info?.stopReason,
        parent: scoutOwnerOf(info?.id, stateDir),
        ...(cause ? { error: String(cause?.message ?? cause) } : {}),
        ...(cause?.code ? { code: String(cause.code) } : {}),
      });
      if (info?.stopReason === "completed") return;
      const owner = scoutOwnerOf(info?.id, stateDir);
      if (owner && markScoutUnreachable(owner, info?.id, `end=${info?.stopReason}`, stateDir)) {
        process.stderr.write(`caseos-dispatch-gate: 测绘 ${info?.id} 不可达（${info?.stopReason}），下次派遣自动接替\n`);
      }
    });
    // 子代理自身报错：agent/error 带 agent 与 error，直接记为一条事实（end 只带子代理 id）。
    ctx.root.on("agent/error", ({ agent, error }) => {
      if (agent?.session?.header?.origin !== "subagent") return;
      monitorEvent(dshHome, {
        kind: "subagent-error",
        child: agent.id,
        parent: agent.session?.header?.parentSession,
        message: String(error?.message ?? error).slice(0, 300),
        ...(error?.code ? { code: String(error.code) } : {}),
      });
    });
    ctx.root.on(ROUTES_UPDATED_EVENT, () => {
      routes = loadRoutes(configFile);
      process.stderr.write(`caseos-dispatch-gate: routes reloaded (${routeText(routes.scout)}; ${routeText(routes.executor)})\n`);
    });
    process.stderr.write(
      `caseos-dispatch-gate: plugin activated (测绘: ${routeText(routes.scout)}; 执行: ${routeText(routes.executor)})\n`,
    );
    let globalLeaderToolInstalled = false;

    // 服务一律从活上下文现取（agent.ctx 随会话存活），不碰 apply 闭包 ctx：面板改配置会
    // 重跑 apply、旧作用域失活，闭包 ctx 一读就是 inactive context 事故。
    const liveOf = (agent) => {
      try {
        return agent?.ctx ?? ctx.root;
      } catch {
        return ctx.root;
      }
    };

    const applyChildRoute = (agent, plan, live) => {
      if (!agent || !plan) {
        return;
      }
      // 角色漂移是 v1.3.58 之前的真实事故（重载后测绘被重归类为执行并长期跑错路由）：
      // 这里既落盘角色（根治），也把任何同 id 换角色的迹象写进监控（兜底告警）。
      const previous = childRoutePlans.get(agent.id);
      if (previous?.role && plan.role && previous.role !== plan.role) {
        monitorEvent(dshHome, { kind: "role-route-mismatch", agent: agent.id, from: previous.role, to: plan.role });
        process.stderr.write(`caseos-dispatch-gate: 角色漂移告警 ${agent.id} ${previous.role} -> ${plan.role}\n`);
      }
      childRoutePlans.set(agent.id, plan);
      writeChildRole(stateDir, agent.session, plan.role);
      try {
        // 写路由的服务从活上下文取（调用方给的就是 liveOf/注入面的 ctx），不碰 apply 闭包 ctx。
        const controller = (live ?? liveOf(agent)).sessionController;
        controller.agents.selectForNextRequest(agent, {
          provider: plan.route.provider,
          model: plan.route.model,
          ...(plan.route.reasoningEffort ? { reasoningEffort: plan.route.reasoningEffort } : {}),
        });
      } catch (error) {
        process.stderr.write(`caseos-dispatch-gate: 子代理模型选择写入失败: ${String(error)}\n`);
      }
    };

    const executeRouted = async (args, exec, rtc) => {
      // 重载安全（v1.3.61）：面板改模型配置会重跑 apply、旧作用域失活，而已注册的派遣
      // 入口持有的可能是旧作用域。服务一律从活上下文现取——会话层入口传注入时的 rtc，
      // 静态入口按 exec.agent.ctx 现取，两者都不碰 apply 闭包的 ctx，否则就是 inactive
      // context 事故（旧作用域读服务直接抛错）。
      const live = rtc ?? exec.agent?.ctx ?? ctx.root;
      const session = exec.agent?.session;
      const sessionId = sessionIdOf(session);
      // 角色只看可达性：有可达测绘就派执行，没有（首笔、或上任测绘已失联）就派测绘。
      // description 只是展示标签，不参与判定。
      const activeScout = reachableScoutId(sessionId, stateDir);
      const role = activeScout ? "executor" : "scout";
      routes = loadRoutes(configFile);
      const route = routes[role];
      const label = String(args.description ?? "").trim();
      const roleLabel = `${routeText(route)} · ${role} · ${label}`;
      // 派测绘时把"上任为何失联"与仓库根地图全文交底：接替的测绘只做增量校对。
      const previous = role === "scout" ? readStateFile(sessionId, stateDir) : {};
      const scoutPrefix = role === "scout"
        ? scoutTakeoverPrefix({
          previous: scoutIdIn(previous),
          reason: previous.scoutUnreachable || "本会话尚无可达测绘",
          cwd: session?.header?.cwd ?? process.cwd(),
        })
        : "";
      const routedPrompt = `【实际路由：${role} · ${routeText(route)}】\n${scoutPrefix}${String(args.prompt ?? "")}`;
      process.stderr.write(`caseos-dispatch-gate: 强制 ${role} 子代理 ${routeText(route)}\n`);
      const request = {
        label: roleLabel,
        prompt: [{ type: "text", text: routedPrompt }],
        parent: exec.agent,
        agentPreset: SUBAGENT_PRESET,
        agentOptions: { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort },
        maxDepth: 1,
      };
      queueRoutePlan(sessionId, { label: roleLabel, route, role });
      let child;
      try {
        child = await startActivation(live, exec, { provider: "spawn", label: roleLabel, request, signal: exec.signal, delivery: "parent" });
      } catch (error) {
        takeRoutePlan(sessionId);
        monitorEvent(dshHome, {
          kind: "subagent-start-failed",
          role,
          route: routeText(route),
          parent: sessionId,
          label: label.slice(0, 120),
          error: String(error?.message ?? error).slice(0, 300),
          ...(error?.code ? { code: String(error.code) } : {}),
        });
        if (isInactiveContext(error)) {
          throw new Error("宿主 agents 服务不可用（会话上下文已失效），请刷新会话后重派");
        }
        throw error;
      }
      monitorEvent(dshHome, {
        kind: "subagent-start",
        role,
        route: routeText(route),
        parent: sessionId,
        child: child.childId,
        label: label.slice(0, 120),
      });
      applyChildRoute(live.agents?.get(child.childId), { label: roleLabel, route, role }, live);
      renameChildTitleAfterAutoTitle(live, child.childId, roleLabel);
      if (role === "scout") {
        rememberScoutOwner(child.childId, sessionId, stateDir);
        writeScoutState(sessionId, { scoutId: child.childId, unreachable: "" }, stateDir);
      }
      return { kind: "activation", subagentId: child.childId };
    };

    // startActivation 是唯一启动入口；inactive context 说明本次用的 ctx 已失活，改从活上下文
    // 重取服务重试一次（宿主 agents 服务只在活跃 fiber 上解析）。
    const startActivation = async (liveCtx, exec, spec) => {
      try {
        return await liveCtx.subagents.startActivation(spec);
      } catch (error) {
        if (!isInactiveContext(error)) throw error;
        const fallback = exec.agent?.ctx ?? liveCtx.root;
        if (fallback === liveCtx) throw error;
        return await fallback.subagents.startActivation(spec);
      }
    };

    const staticSubagentBase = {
      name: BASE_SUBAGENT_TOOL,
      description: SLIM_DESC.subagent,
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          description: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["description", "prompt"],
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => [{ type: "text", text: `started subagent ${value.subagentId}` }],
      },
    };
    const staticRoutedTool = {
      ...staticSubagentBase,
      name: LEADER_SUBAGENT_TOOL,
      __caseosRouted: true,
      // 不传 rtc：执行体按 exec.agent.ctx 现取活上下文，静态入口同样不持有闭包 ctx。
      async execute(args, exec) { return executeRouted(args, exec); },
    };
    try {
      ctx.root.tools.register(staticRoutedTool);
      globalLeaderToolInstalled = true;
    } catch (error) {
      process.stderr.write(`caseos-dispatch-gate: 全局 subagent 入口注册失败: ${String(error)}\n`);
    }

    // 子代理的 provider/model/角色是运行时契约，不能依赖模型是否记得在 tool call 里填写。
    // 官方 tool-subagent 先以 subagent-base 挂载，领导层只暴露本插件的 subagent 入口；
    // 这样不在官方同名工具作用域上重复注册，角色由会话事件推导（首笔=测绘，其后=执行）。
    const installLeaderTool = async (agent) => {
      if (!agent || agent.session?.header?.origin === "subagent") return;
      if (leaderToolInstalled.has(agent) || leaderToolInstalling.has(agent)) return;
      leaderToolInstalling.add(agent);
      try {
        await agent.ctx.inject(["tools", "subagents"], (rtc) => {
        if (globalLeaderToolInstalled) {
          try { rtc.tools.restrict({ deny: [BASE_SUBAGENT_TOOL] }); }
          catch {}
          leaderToolInstalled.add(agent);
          return;
        }
        // 按领导自己的视图取官方基座；它只作为执行实现，不直接暴露给模型。
        const current = rtc.tools.get(BASE_SUBAGENT_TOOL, agent);
        if (!current) {
          // 基座已被会话层 restrict 藏掉（见下）：取不到是正常态，只要本插件的路由入口
          // （__caseosRouted）也在，派遣就有着落，别再重复装配。
          const existing = rtc.tools.get(LEADER_SUBAGENT_TOOL, agent);
          if (existing?.__caseosRouted) leaderToolInstalled.add(agent);
          return;
        }
        // 领导层的 subagent 只此一处注册：瘦身文案来自 leader-scope，执行体是本文件的路由强制。
        // 其他插件（如 leader-scope）不得再注册同名工具，否则同层重复注册会抛错。
        if (current.__caseosRouted) {
          leaderToolInstalled.add(agent);
          return;
        }
        const wrapped = { ...current, name: LEADER_SUBAGENT_TOOL, __caseosRouted: true,
          description: SLIM_DESC.subagent ?? current.description,
          parameters: slimSchema(current.parameters ?? {}),
          execute: (args, exec) => executeRouted(args, exec, rtc) };
        let registered = globalLeaderToolInstalled;
        if (!registered) {
          try {
            ctx.root.tools.register(wrapped);
            globalLeaderToolInstalled = true;
            registered = true;
            process.stderr.write("caseos-dispatch-gate: 全局 subagent 入口已绑定强制路由\n");
          } catch (error) {
            try {
              rtc.tools.register(wrapped);
              registered = true;
              process.stderr.write("caseos-dispatch-gate: 领导 subagent 入口已绑定强制路由\n");
            } catch (scopedError) {
              process.stderr.write(`caseos-dispatch-gate: subagent 入口注册失败: ${String(scopedError)}; 全局尝试: ${String(error)}\n`);
            }
          }
        }
        if (registered) {
          // 基座只供本插件保留，领导模型只看到路由入口。
          try { rtc.tools.restrict({ deny: [BASE_SUBAGENT_TOOL] }); }
          catch (error) { process.stderr.write(`caseos-dispatch-gate: 官方基座隐藏失败: ${String(error)}\n`); }
          leaderToolInstalled.add(agent);
        }
        });
      } catch (error) {
        process.stderr.write(`caseos-dispatch-gate: 领导 subagent 入口注入失败: ${String(error)}\n`);
      } finally {
        leaderToolInstalling.delete(agent);
      }
    };

    // 新建子代理会话仍空白，走 select（写 agent-preset/selected，冷读按日志重建组合）；
    // 冷恢复时 harness 又让子代理接回父会话 preset，按会话投影记录的 preset 重新组合。
    // 失败只记日志：agent/created 监听器抛错会让整个子代理创建回滚。
    const composeSubagentPreset = async (agent) => {
      const live = liveOf(agent);
      const presets = live.get("agentPresets");
      if (presets === void 0 || presets.composedPreset(agent.ctx) === SUBAGENT_PRESET) return;
      try {
        const recorded = live.get("sessionProjections")?.stateOf(agent.session, "agentPreset");
        if (recorded === SUBAGENT_PRESET) await presets.recompose(agent.ctx, SUBAGENT_PRESET);
        else await presets.select(agent, SUBAGENT_PRESET);
        process.stderr.write(`caseos-dispatch-gate: 子代理 ${agent.id} 已挂载 preset ${SUBAGENT_PRESET}\n`);
      } catch (error) {
        process.stderr.write(`caseos-dispatch-gate: 子代理 ${agent.id} 挂载 ${SUBAGENT_PRESET} 失败，沿用继承的 preset: ${String(error)}\n`);
      }
    };

    const hideBaseSubagentTool = async (agent) => {
      if (!agent) return;
      try {
        await agent.ctx.inject(["tools"], (rtc) => {
          const deny = [BASE_SUBAGENT_TOOL, LEADER_SUBAGENT_TOOL]
            .filter((name) => rtc.tools.get(name, agent) !== void 0);
          if (deny.length) rtc.tools.restrict({ deny });
        });
      } catch (error) {
        process.stderr.write(`caseos-dispatch-gate: 子代理基座工具隐藏失败: ${String(error)}\n`);
      }
    };

    const childPlan = (agent) => {
      if (!agent || agent.session?.header?.origin !== "subagent") return undefined;
      const live = liveOf(agent);
      const agents = live.get("agents");
      const parent = agent.parent ?? agent.parentAgent
        ?? agents?.list().find((candidate) => agents.isOwnedBy?.(agent.id, candidate));
      // 角色判定顺序：本次派遣的队列计划 > 持久化角色文件 > 标题自愈 > 父会话状态推导。
      // 前两者是修复 v1.3.58 测绘路由漂移的根治面：任何重载后都先回到 spawn 时的角色。
      const derivedRole = scoutIdIn(readStateFile(sessionIdOf(parent?.session), stateDir)) ? "executor" : "scout";
      const role = readChildRole(stateDir, agent.session)
        ?? roleFromTitle(live.get("sessionTitle"), agent.session)
        ?? derivedRole;
      routes = loadRoutes(configFile);
      const route = routes[role];
      const queued = takeRoutePlan(agent.session.header.parentSession);
      return queued ?? { label: `${routeText(route)} · ${role}`, route, role };
    };

    for (const agent of liveOf().get("agents")?.list() ?? []) void installLeaderTool(agent);
    ctx.root.on("agent/created", async ({ agent }) => {
      if (agent?.session?.header?.origin === "subagent") {
        const plan = childPlan(agent);
        applyChildRoute(agent, plan, liveOf(agent));
        await composeSubagentPreset(agent);
        await hideBaseSubagentTool(agent);
        const title = plan?.label;
        const sessionTitle = liveOf(agent).get("sessionTitle");
        if (title && sessionTitle) {
          try { sessionTitle.rename(agent.session, title); }
          catch (error) { process.stderr.write(`caseos-dispatch-gate: 子代理标题写入失败: ${String(error)}\n`); }
        }
      } else await installLeaderTool(agent);
    });

    // 新建主会话的首个回合可能在 agent/created 返回后立刻开始；在正式生成
    // 回合前再绑定一次，确保模型拿到的是本插件的强制路由入口，而不是原始工具。
    ctx.root.on("agent/pre-step", async ({ agent }, next) => {
      if (agent?.session?.header?.origin === "subagent") {
        const cached = childRoutePlans.get(agent.id) ?? childPlan(agent);
        if (cached) {
          // 角色终身不变（缓存/落盘为准），路由每回合现读面板配置：模型变更对进行中的
          // 常驻测绘与执行子代理下一回合即生效，不必重派、不必重启。
          const route = loadRoutes(configFile)[cached.role] ?? cached.route;
          if (routeText(route) !== routeText(cached.route)) {
            const suffix = cached.label.split(" · ").slice(2).join(" · ");
            const label = `${routeText(route)} · ${cached.role}${suffix ? ` · ${suffix}` : ""}`;
            monitorEvent(dshHome, { kind: "child-route-updated", agent: agent.id, role: cached.role, to: routeText(route) });
            applyChildRoute(agent, { ...cached, route, label }, liveOf(agent));
            renameChildTitleAfterAutoTitle(liveOf(agent), agent.id, label);
          } else applyChildRoute(agent, cached, liveOf(agent));
        }
      }
      await installLeaderTool(agent);
      return next();
    });

    // 领导续接测绘失败=该测绘不可达（第二事实源）：解除常驻，下一笔派遣自动接替。
    ctx.on("tools/result", (exec, result) => {
      if (!exec || !result?.isError || exec.name !== "send_message") return;
      const failure = sendMessageFailure(result);
      const scoutId = String(exec.arguments?.agent_id ?? "");
      const sessionId = sessionIdOf(exec.agent?.session) ?? scoutOwnerOf(scoutId, stateDir);
      if (!failure || !sessionId || !scoutId) return;
      if (markScoutUnreachable(sessionId, scoutId, failure, stateDir)) {
        monitorEvent(dshHome, { kind: "scout-unreachable", session: sessionId, child: scoutId, reason: failure });
        process.stderr.write(`caseos-dispatch-gate: 测绘 ${scoutId} send_message 失败（${failure}），下次派遣自动接替\n`);
      }
    });

    // 规范已读的路径判定补充：read/bash 结果内容不含首行标记（如被截断）但调用路径
    // 指向规范文件时，同样计入。内容判定由 sessionState 的增量扫描覆盖。
    ctx.on("tools/result", (exec, result) => {
      if (!exec || result?.isError) return;
      if (exec.name === "read" || exec.name === "bash") {
        let args = {};
        try { args = exec.arguments ?? {}; } catch {}
        if (pathMatches(args.path, dshHome) || pathMatches(args.file, dshHome)) {
          const st = sessionState(exec.agent?.session);
          if (!st.specRead) {
            st.specRead = true;
            process.stderr.write("caseos-dispatch-gate: spec read detected (path)\n");
          }
        }
      }
      // 地图基准登记：领导 write .project-map.md 成功即把当前 HEAD 记为该工作区的新鲜度基准。
      if (exec.name === "write") {
        let args = {};
        try { args = exec.arguments ?? {}; } catch {}
        const target = args.file_path ?? args.path ?? args.file;
        const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
        if (typeof target === "string" && target === `${cwd}/${MAP_FILE}`) {
          const head = gitHead(cwd);
          if (head) saveMapBaseline(dshHome, cwd, head);
        }
      }
    });

    ctx.tools.guard((exec) => {
      if (!GATE_TOOLS.has(exec.name)) return undefined;
      const deny = (reason) => {
        monitorEvent(dshHome, {
          kind: "gate-deny",
          gate: "dispatch",
          tool: exec.name,
          session: sessionIdOf(exec.agent?.session),
          reason: reason.slice(0, 160),
        });
        return reason;
      };
      if (exec.name === "subagent_fork") {
        return deny("本插件统一使用 subagent spawn 入口；subagent_fork 不属于三智能体架构。");
      }
      const description = exec.arguments?.description;
      const session = exec.agent?.session;
      const state = sessionState(session);
      if (!state.specRead) return deny(denyReason);
      const sessionId = sessionIdOf(session);
      // 可达性决定下一笔派遣的角色：没有可达测绘时这一笔就是测绘（description 只是标签），
      // 不受地图前置/新鲜度约束——建图正是它要做的事。
      const activeScout = reachableScoutId(sessionId, stateDir);
      if (!activeScout) return undefined;
      // 有可达测绘时再派测绘才拒绝，判据是可达性与运行期角色，不看 description 前缀。
      // 应询结束显示 finished/inactive 属正常：send_message 会冷恢复它。
      if (isScoutDescription(description)) {
        return deny(
          `测绘 ${activeScout} 仍可达（应询结束显示 finished/inactive 属正常），用 send_message ${activeScout} 续接；`
          + "只有它真的不可达（end 非 completed，或 send_message 报 unavailable）时才重派，插件会自动接替并注入地图。",
        );
      }
      // 地图前置：cwd 取会话工作区（桌面宿主进程目录不是项目根）。
      const cwd = session?.header?.cwd ?? process.cwd();
      const isProjectRoot = existsSync(`${cwd}/.git`) || existsSync(`${cwd}/.manon`);
      if (isProjectRoot && !existsSync(`${cwd}/${MAP_FILE}`)) {
        process.stderr.write("caseos-dispatch-gate: 地图前置拦截（.project-map.md 不存在）\n");
        return deny(`派执行智能体前必须先有项目地图：${cwd}/${MAP_FILE} 不存在。先派测绘智能体（按系统提示的 manon-kg 调用前缀 sync 建图并回报入口表 ≤20 行），用 write 把入口表落盘为该文件，然后重新派遣。`);
      }
      // 地图新鲜度：main 自上次地图登记后又前进过，先让常驻测绘增量校对并重新落盘地图。
      // 基准在 write .project-map.md 时登记（见 tools/result 监听）；首建前不拦（fail-open），
      // CASEOS_SCOUT=0（无测绘可用）时同样跳过。
      if (isProjectRoot && process.env.CASEOS_SCOUT !== "0") {
        const head = gitHead(cwd);
        const baseline = loadMapBaseline(dshHome, cwd);
        if (head && baseline && baseline !== head) {
          process.stderr.write("caseos-dispatch-gate: 地图过期拦截（HEAD 前进于登记基准）\n");
          return deny(`项目地图已过期：main 自上次地图登记后又前进了（登记基准 ${baseline.slice(0, 8)} → 当前 HEAD ${head.slice(0, 8)}）。先 send_message 常驻测绘智能体做增量校对（manon-kg sync + 结构增量回报）；收到回报后用 write 更新 ${cwd}/${MAP_FILE}（即使结构无变化也原样落盘一次以登记新基准），然后重新派遣。`);
        }
      }
      return undefined;
    });
  },
};

export default plugin;
