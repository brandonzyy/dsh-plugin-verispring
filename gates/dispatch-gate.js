// Verispring 派遣门禁（五条代码级强制）：
// 1 规范门：subagent / subagent_fork 调用前，本会话必须出现过《子代理派遣规范》首行标记
//   （read/bash 结果内容判定，增量扫描会话事件；会话日志是唯一事实源，跨进程重启不丢）。
// 2 测绘智能体常驻：本会话首笔派遣由运行时定为测绘（description 只是展示标签，模型无法
//   漏写前缀跳过测绘）。常驻状态持久化在 ~/.dsh/caseos/session-state/<会话id>.json（本门
//   唯一写入方；harness 拒绝含未知类型的会话日志，状态不能进会话事件）：测绘 spawn 成功
//   后置 scoutStarted，reset 逃生口（bash touch 拒绝信息里的 RESET_FILE，按 pid 隔离）
//   清除。重复测绘派遣被拒，改用 send_message 复用。测绘子代理 deny edit/write。
// 3 地图前置：非测绘派遣要求 <会话工作区>/.project-map.md 存在——cwd 取会话 header 的
//   cwd（桌面宿主进程目录不是项目根），且 .git 或 .manon 在场才认定项目根，否则放行
//   （fail-open）。没有地图先派测绘（建图 + 入口表），由领导 write 落盘后重派。
// 4 模型路由：测绘与执行分别读取面板配置（verispring.json），运行时按角色强制注入，
//   调用里显式写的 provider/model 一律忽略。fork 拒绝（三智能体架构唯一入口是 spawn）。
// 5 子代理 preset：spawn 通过 agentPreset 显式选择 verispring-subagent；创建事件只负责
//   记录组合结果，不再发送 0.2.1-rc.1 已移除的 persona/toolFilter 请求字段。
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
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { SLIM_DESC, slimSchema } from "./leader-scope.js";

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
    ctx.root.on(ROUTES_UPDATED_EVENT, () => {
      routes = loadRoutes(configFile);
      process.stderr.write(`caseos-dispatch-gate: routes reloaded (${routeText(routes.scout)}; ${routeText(routes.executor)})\n`);
    });
    process.stderr.write(
      `caseos-dispatch-gate: plugin activated (测绘: ${routeText(routes.scout)}; 执行: ${routeText(routes.executor)})\n`,
    );
    const leaderToolInstalled = new WeakSet();
    let globalLeaderToolInstalled = false;
    // 桌面恢复/切换 fiber 时 session 可能被重新包装；领导 agent 身份更稳定，
    // 作为当前进程内的第二份测绘完成事实。
    const leaderScoutStarted = new WeakSet();
    const leaderToolInstalling = new WeakSet();
    const childRoutePlans = new Map();

    const applyChildRoute = (agent, plan) => {
      if (!agent || !plan) {
        return;
      }
      childRoutePlans.set(agent.id, plan);
      try {
        ctx.sessionController.agents.selectForNextRequest(agent, {
          provider: plan.route.provider,
          model: plan.route.model,
          ...(plan.route.reasoningEffort ? { reasoningEffort: plan.route.reasoningEffort } : {}),
        });
      } catch (error) {
        process.stderr.write(`caseos-dispatch-gate: 子代理模型选择写入失败: ${String(error)}\n`);
      }
    };

    const executeRouted = async (args, exec, rtc) => {
      const session = exec.agent?.session;
      const state = stateOf(session);
      const recovered = state.scoutStarted || leaderScoutStarted.has(exec.agent)
        || hasChildAgent(ctx.agents, session, exec.agent);
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
      queueRoutePlan(parentId, { label: roleLabel, route, role });
      let result;
      try {
        if (args.run_in_background === false) {
          const run = await rtc.subagents.start("spawn", { ...request, signal: exec.signal });
          applyChildRoute(ctx.agents.get(run.id), { label: roleLabel, route, role });
          try {
            const runResult = await run.result;
            result = { kind: "foreground", runId: run.id, output: runResult.output };
            renameChildTitleAfterAutoTitle(ctx, run.id, roleLabel);
          } finally {
            await Promise.resolve(run.dispose?.()).catch(() => {});
          }
        } else {
          const child = await rtc.subagents.startContinuable({ provider: "spawn", label: roleLabel, request, signal: exec.signal });
          applyChildRoute(ctx.agents.get(child.childId), { label: roleLabel, route, role });
          renameChildTitleAfterAutoTitle(ctx, child.childId, roleLabel);
          result = { kind: "continuable", subagentId: child.childId };
        }
      } catch (error) {
        takeRoutePlan(parentId);
        throw error;
      }
      if (role === "scout") {
        leaderScoutStarted.add(exec.agent);
        writeScoutStarted(session, true, stateDir);
      }
      return result;
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
          run_in_background: { type: "boolean" },
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
      const role = parentState?.scoutStarted || (parent && leaderScoutStarted.has(parent)) ? "executor" : "scout";
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
      if (exec.name !== "read" && exec.name !== "bash") return;
      let args = {};
      try { args = exec.arguments ?? {}; } catch {}
      if (pathMatches(args.path, dshHome) || pathMatches(args.file, dshHome)) {
        const st = stateOf(exec.agent?.session);
        if (!st.specRead) {
          st.specRead = true;
          process.stderr.write("caseos-dispatch-gate: spec read detected (path)\n");
        }
      }
    });

    ctx.tools.guard((exec) => {
      if (!GATE_TOOLS.has(exec.name)) return undefined;
      if (exec.name === "subagent_fork") {
        return "本插件统一使用 subagent spawn 入口；subagent_fork 不属于三智能体架构。";
      }
      const description = exec.arguments?.description;
      const session = exec.agent?.session;
      const state = stateOf(session);
      if (!state.specRead) return denyReason;
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
          process.stderr.write("caseos-dispatch-gate: 测绘智能体常驻标记已重置（reset 文件）\n");
        } else {
          return "测绘智能体已常驻：不得重复派遣。先用 list_agents 确认最早那个测绘智能体的状态；仍在运行就用 send_message 复用它。若确认它已结束或派遣失败，用 bash 执行 `touch " + RESET_FILE + "` 后重新派遣即可解锁。";
        }
        return undefined;
      }
      // 地图前置：cwd 取会话工作区（桌面宿主进程目录不是项目根）。
      const cwd = session?.header?.cwd ?? process.cwd();
      const isProjectRoot = existsSync(`${cwd}/.git`) || existsSync(`${cwd}/.manon`);
      if (isProjectRoot && !existsSync(`${cwd}/${MAP_FILE}`)) {
        process.stderr.write("caseos-dispatch-gate: 地图前置拦截（.project-map.md 不存在）\n");
        return `派执行智能体前必须先有项目地图：${cwd}/${MAP_FILE} 不存在。先派测绘智能体（按系统提示的 manon-kg 调用前缀 sync 建图并回报入口表 ≤20 行），用 write 把入口表落盘为该文件，然后重新派遣。`;
      }
      return undefined;
    });
  },
};

export default plugin;
