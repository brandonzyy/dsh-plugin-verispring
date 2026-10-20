// Verispring 派遣门禁（六条代码级强制 + 监控）：
// 1 规范门：subagent / subagent_fork 调用前，本会话必须出现过《子代理派遣规范》首行标记
//   （read/bash 结果内容判定，增量扫描会话事件；会话日志是唯一事实源，跨进程重启不丢）。
// 2 测绘智能体常驻：本会话首笔派遣由运行时定为测绘（description 只是展示标签，模型无法
//   漏写前缀跳过测绘）。常驻状态持久化在 ~/.dsh/caseos/session-state/<会话id>.json（本门
//   唯一写入方；harness 拒绝含未知类型的会话日志，状态不能进会话事件）：测绘 spawn 成功
//   后置 scoutStarted，reset 逃生口（bash touch 拒绝信息里的 RESET_FILE，按 pid 隔离）
//   清除。重复测绘派遣被拒，改用 send_message 复用。测绘子代理 deny edit/write。
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
//   subagent-base 在 root 层无条件隐藏：路由执行体异常时模型应无路可走，而非退回裸派遣。
// 6 监控：门禁拦截、scout 重置、角色漂移、子代理 start/end（角色 + 路由 + 停止原因）追加
//   落盘 ~/.dsh/verispring-monitor.jsonl（gates/monitor-log.js）。
// 规范目录按主目录解析（~/.dsh/specs/），搬家无需改码。
const MARKER = "# 子代理派遣规范";
const SPEC_FRAGMENT = "specs/子代理派遣规范.md";
const GATE_TOOLS = new Set(["subagent", "subagent_fork"]);
const MAP_FILE = ".project-map.md";
const SUBAGENT_PRESET = "verispring-subagent";
const BASE_SUBAGENT_TOOL = "subagent-base";
const LEADER_SUBAGENT_TOOL = "subagent";
const ROUTES_UPDATED_EVENT = "verispring/routes-updated";
const RESET_FILE = `/tmp/dsh-caseos-scout-reset-${process.pid}`;
const DEFAULT_ROUTES = {
  scout: { provider: "verispring", model: "deepseek-flash", reasoningEffort: "high" },
  executor: { provider: "verispring", model: "deepseek-flash", reasoningEffort: "high" },
};
// 用户配置文件（配置面板写入）：{ scout: {...}, executor: {...} }。
// 读取失败/缺省回落常量，门禁永不因配置文件崩。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

function routeText(route) {
  return `${route.provider}/${route.model}${route.reasoningEffort ? `@${route.reasoningEffort}` : ""}`;
}

function pathMatches(value, dshHome) {
  if (typeof value !== "string") return false;
  const expanded = value.startsWith("~/") ? dshHome + value.slice(1) : value;
  return expanded.includes(SPEC_FRAGMENT);
}

// 会话状态（规范已读 + 测绘常驻）：规范已读增量扫描会话事件日志（WeakMap 缓存扫描
// 位点）；测绘常驻落在状态文件（跨进程、跨重启一致）。
const sessionStates = new WeakMap();
function sessionIdOf(session) {
  return session?.header?.id ?? session?.header?.sessionId ?? session?.id ?? session?.sessionId ?? void 0;
}

function hasChildAgent(agents, session, parentAgent) {
  const parentId = sessionIdOf(session);
  return agents.list().some((agent) => {
    if (agent === parentAgent) return false;
    const childParent = agent?.parent ?? agent?.parentAgent;
    if (childParent === parentAgent || childParent?.id === parentAgent?.id) return true;
    return Boolean(parentId && agent?.session?.header?.parentSession === parentId);
  });
}

function scoutStartedPersisted(session, stateDir) {
  const id = sessionIdOf(session);
  if (!id) return false;
  try {
    return JSON.parse(readFileSync(`${stateDir}/${id}.json`, "utf8")).scoutStarted === true;
  } catch {}
  return false;
}

function writeScoutStarted(session, value, stateDir) {
  const state = sessionState(session, stateDir);
  if (state) state.scoutStarted = value === true;
  const id = sessionIdOf(session);
  if (!id) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(`${stateDir}/${id}.json`, `${JSON.stringify({ version: 1, scoutStarted: value === true })}\n`);
  } catch (error) {
    process.stderr.write(`caseos-dispatch-gate: 状态文件写入失败: ${String(error)}\n`);
  }
}

function sessionState(session, stateDir) {
  let st = sessionStates.get(session);
  if (!st) {
    st = { scanned: 0, specRead: false, scoutStarted: scoutStartedPersisted(session, stateDir) };
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
const leaderScoutStarted = new WeakSet();
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
  const sessionTitle = ctx.sessionTitle ?? ctx.get("sessionTitle");
  const child = ctx.agents?.get(childId) ?? ctx.get("agents")?.get(childId);
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
    const stateOf = (session) => sessionState(session, stateDir);
    let routes = loadRoutes(configFile);
    // P3 兜底：基座派遣入口在 root 层无条件隐藏。路由执行体一旦崩溃/未装配，模型看到的
    // 应该是"无路可走"而不是裸的 subagent-base（那会绕过规范门、测绘强制与模型钉死）。
    try { ctx.root.tools.restrict({ deny: [BASE_SUBAGENT_TOOL] }); }
    catch (error) { process.stderr.write(`caseos-dispatch-gate: root 层基座隐藏失败: ${String(error)}\n`); }
    // 子代理生命周期落监控：不再需要解压会话日志就能审计"谁、什么角色、什么路由、怎么结束的"。
    ctx.root.on("subagent/end", (info, parent) => {
      monitorEvent(dshHome, {
        kind: "subagent-end",
        child: info?.id,
        provider: info?.provider,
        stopReason: info?.stopReason,
        parent: sessionIdOf(parent?.session),
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
        const controller = (live ?? ctx).sessionController;
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
      // 入口（root 静态入口 + 各会话层的瘦身入口）持有的可能是旧作用域。服务一律从
      // 活上下文现取——rtc 恒为活上下文（静态入口传 root，会话层入口传随注入的
      // agent.ctx），绝不碰 apply 闭包的 ctx，否则就是 inactive context 事故。
      const live = rtc ?? exec.agent?.ctx ?? ctx.root;
      const session = exec.agent?.session;
      const state = stateOf(session);
      const recovered = state.scoutStarted || leaderScoutStarted.has(exec.agent)
        || hasChildAgent(live.agents, session, exec.agent);
      if (!state.scoutStarted && recovered) writeScoutStarted(session, true, stateDir);
      const role = recovered ? "executor" : "scout";
      routes = loadRoutes(configFile);
      const route = routes[role];
      const label = String(args.description ?? "").trim();
      const roleLabel = `${routeText(route)} · ${role} · ${label}`;
      const routedPrompt = `【实际路由：${role} · ${routeText(route)}】\n${String(args.prompt ?? "")}`;
      process.stderr.write(`caseos-dispatch-gate: 强制 ${role} 子代理 ${routeText(route)}\n`);
      const request = {
        label: roleLabel,
        prompt: [{ type: "text", text: routedPrompt }],
        parent: exec.agent,
        agentPreset: SUBAGENT_PRESET,
        agentOptions: { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort },
        maxDepth: 1,
      };
      const parentId = sessionIdOf(session);
      monitorEvent(dshHome, {
        kind: "subagent-start",
        role,
        route: routeText(route),
        parent: parentId,
        label: label.slice(0, 120),
      });
      queueRoutePlan(parentId, { label: roleLabel, route, role });
      try {
        const child = await rtc.subagents.startActivation({
          provider: "spawn",
          label: roleLabel,
          request,
          signal: exec.signal,
          delivery: "parent",
        });
        applyChildRoute(live.agents?.get(child.childId), { label: roleLabel, route, role }, live);
        renameChildTitleAfterAutoTitle(live, child.childId, roleLabel);
        if (role === "scout") {
          leaderScoutStarted.add(exec.agent);
          writeScoutStarted(session, true, stateDir);
        }
        return { kind: "activation", subagentId: child.childId };
      } catch (error) {
        takeRoutePlan(parentId);
        throw error;
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
      async execute(args, exec) { return executeRouted(args, exec, ctx.root); },
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
          // root 层已无条件藏掉基座（v1.3.61），这里取不到是正常态：只要会话层已有
          // 本插件的路由入口（__caseosRouted），派遣就有着落，别再重复装配。
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
      const presets = ctx.get("agentPresets");
      if (presets === void 0 || presets.composedPreset(agent.ctx) === SUBAGENT_PRESET) return;
      try {
        const recorded = ctx.get("sessionProjections")?.stateOf(agent.session, "agentPreset");
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
      const parent = agent.parent ?? agent.parentAgent
        ?? ctx.agents.list().find((candidate) => ctx.agents.isOwnedBy?.(agent.id, candidate));
      const parentSession = parent?.session;
      const parentState = stateOf(parentSession);
      // 角色判定顺序：本次派遣的队列计划 > 持久化角色文件 > 标题自愈 > 父会话状态推导。
      // 前两者是修复 v1.3.58 测绘路由漂移的根治面：任何重载后都先回到 spawn 时的角色。
      const derivedRole = parentState?.scoutStarted || (parent && leaderScoutStarted.has(parent)) ? "executor" : "scout";
      const role = readChildRole(stateDir, agent.session)
        ?? roleFromTitle(ctx.sessionTitle ?? ctx.get("sessionTitle"), agent.session)
        ?? derivedRole;
      routes = loadRoutes(configFile);
      const route = routes[role];
      const queued = takeRoutePlan(agent.session.header.parentSession);
      return queued ?? { label: `${routeText(route)} · ${role}`, route, role };
    };

    for (const agent of ctx.agents.list()) void installLeaderTool(agent);
    ctx.root.on("agent/created", async ({ agent }) => {
      if (agent?.session?.header?.origin === "subagent") {
        const plan = childPlan(agent);
        applyChildRoute(agent, plan);
        await composeSubagentPreset(agent);
        await hideBaseSubagentTool(agent);
        const title = plan?.label;
        const sessionTitle = ctx.sessionTitle ?? ctx.get("sessionTitle");
        if (title && sessionTitle) {
          try { sessionTitle.rename(agent.session, title); }
          catch (error) { process.stderr.write(`caseos-dispatch-gate: 子代理标题写入失败: ${String(error)}\n`); }
        }
      } else await installLeaderTool(agent);
    });

    // 新建主会话的首个回合可能在 agent/created 返回后立刻开始；在正式生成
    // 回合前再绑定一次，确保模型拿到的是本插件的强制路由入口，而不是原始工具。
    ctx.root.on("agent/pre-step", async ({ agent }, next) => {
      if (agent?.session?.header?.origin === "subagent") applyChildRoute(agent, childRoutePlans.get(agent.id) ?? childPlan(agent));
      await installLeaderTool(agent);
      return next();
    });

    // 规范已读的路径判定补充：read/bash 结果内容不含首行标记（如被截断）但调用路径
    // 指向规范文件时，同样计入。内容判定由 sessionState 的增量扫描覆盖。
    ctx.on("tools/result", (exec, result) => {
      if (!exec || result?.isError) return;
      if (exec.name === "read" || exec.name === "bash") {
        let args = {};
        try { args = exec.arguments ?? {}; } catch {}
        if (pathMatches(args.path, dshHome) || pathMatches(args.file, dshHome)) {
          const st = stateOf(exec.agent?.session);
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
      const state = stateOf(session);
      if (!state.specRead) return deny(denyReason);
      const desc = String(description ?? "").trim().toLowerCase();
      // 第一笔派遣的身份由运行时决定为测绘智能体，description 只是展示标签。
      // 这样模型无法通过漏写 scout 前缀跳过测绘阶段。
      if (!state.scoutStarted) return undefined;
      if (isScoutDescription(desc)) {
        if (existsSync(RESET_FILE)) {
          try { unlinkSync(RESET_FILE); } catch {}
          leaderScoutStarted.delete(exec.agent);
          writeScoutStarted(session, false, stateDir);
          sessionStates.delete(session);
          monitorEvent(dshHome, { kind: "scout-reset", session: sessionIdOf(session) });
          process.stderr.write("caseos-dispatch-gate: 测绘智能体常驻标记已重置（reset 文件）\n");
        } else {
          return deny("测绘智能体已常驻：不得重复派遣。先用 list_agents 确认最早那个测绘智能体的状态；仍在运行就用 send_message 复用它。若确认它已结束或派遣失败，用 bash 执行 `touch " + RESET_FILE + "` 后重新派遣即可解锁。");
        }
        return undefined;
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
