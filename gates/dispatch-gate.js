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
// 5 子代理 preset：spawn 请求没有 preset 字段，harness 让子代理继承父会话 preset；本门在
//   agent/created（串行等待，早于子代理首个 prompt）把子代理切到 verispring-subagent。
// 规范目录按主目录解析（~/.dsh/specs/），搬家无需改码。
const MARKER = "# 子代理派遣规范";
const SPEC_FRAGMENT = "specs/子代理派遣规范.md";
const GATE_TOOLS = new Set(["subagent", "subagent_fork"]);
const MAP_FILE = ".project-map.md";
const SUBAGENT_PRESET = "verispring-subagent";
const RESET_FILE = `/tmp/dsh-caseos-scout-reset-${process.pid}`;
const DEFAULT_ROUTES = {
  scout: { provider: "verispring", model: "deepseek-flash", reasoningEffort: "high" },
  executor: { provider: "verispring", model: "deepseek-flash", reasoningEffort: "high" },
};
// 用户配置文件（配置面板写入）：{ scout: {...}, executor: {...} }。
// 读取失败/缺省回落常量，门禁永不因配置文件崩。
const CONFIG_FILE = `${homedir()}/.dsh/verispring.json`;

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { SLIM_DESC, slimSchema } from "./leader-scope.js";

const SPEC_PATH = `${homedir()}/.dsh/specs/子代理派遣规范.md`;
const DENY_REASON =
  `派遣前必读 ${SPEC_PATH}：先用 read 工具读取该规范（含任务书模板与派发前自查），然后重新发起本次调用。`;

function loadRoutes() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
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
  } catch {}
  return DEFAULT_ROUTES;
}

function isScoutDescription(description) {
  const value = String(description ?? "").trim().toLowerCase();
  return value.startsWith("测绘智能体") || value.startsWith("scout");
}

function routeText(route) {
  return `${route.provider}/${route.model}${route.reasoningEffort ? `@${route.reasoningEffort}` : ""}`;
}

function pathMatches(value) {
  if (typeof value !== "string") return false;
  const expanded = value.startsWith("~/") ? homedir() + value.slice(1) : value;
  return expanded.includes(SPEC_FRAGMENT);
}

// 会话状态（规范已读 + 测绘常驻）：规范已读增量扫描会话事件日志（WeakMap 缓存扫描
// 位点）；测绘常驻落在状态文件（跨进程、跨重启一致）。
const sessionStates = new WeakMap();
const STATE_DIR = `${homedir()}/.dsh/caseos/session-state`;

function sessionIdOf(session) {
  return session?.header?.id ?? session?.id ?? void 0;
}

function scoutStartedPersisted(session) {
  const id = sessionIdOf(session);
  if (!id) return false;
  try {
    return JSON.parse(readFileSync(`${STATE_DIR}/${id}.json`, "utf8")).scoutStarted === true;
  } catch {}
  return false;
}

function writeScoutStarted(session, value) {
  const id = sessionIdOf(session);
  if (!id) return;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(`${STATE_DIR}/${id}.json`, `${JSON.stringify({ version: 1, scoutStarted: value === true })}\n`);
  } catch (error) {
    process.stderr.write(`caseos-dispatch-gate: 状态文件写入失败: ${String(error)}\n`);
  }
}

function sessionState(session) {
  let st = sessionStates.get(session);
  if (!st) {
    st = { scanned: 0, specRead: false, scoutStarted: scoutStartedPersisted(session) };
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

const EXECUTOR_PERSONA =
  "你是执行智能体：承接全部执行类工作——读码、检索、改码、跑测试与门禁、查代码图谱、web 查证。" +
  "你拥有全部工具与规范权限；动作涉及派遣/提交/工程规范时，先读 ~/.dsh/specs/ 下同名规范再动手。" +
  "全部工作完成后一次性验证并汇报：结论、改动文件路径、测试读数，不报过程，不追加确认轮。";

const SCOUT_PERSONA =
  "你是只读测绘智能体：只读扫描项目并回报入口表（≤20 行），由领导落盘为 .project-map.md；" +
  "禁止编辑业务代码。";

const plugin = {
  inject: ["tools", "agents"],
  apply(ctx) {
    const routes = loadRoutes();
    process.stderr.write(
      `caseos-dispatch-gate: plugin activated (测绘: ${routeText(routes.scout)}; 执行: ${routeText(routes.executor)})\n`,
    );
    const leaderToolInstalled = new WeakSet();

    // 子代理的 provider/model/角色是运行时契约，不能依赖模型是否记得在 tool call 里填写。
    // 领导会话的 subagent 工具在这里被替换成唯一的 spawn 入口：角色由会话事件推导
    // （首笔=测绘，其后=执行），路由按角色取面板配置。
    const installLeaderTool = (agent) => {
      if (!agent || agent.session?.header?.origin === "subagent") return;
      if (leaderToolInstalled.has(agent)) return;
      agent.ctx.inject(["tools", "subagents"], (rtc) => {
        // 按领导自己的视图取：桌面把模型可见工具全放在 preset 层，全局视图里没有 subagent。
        const current = rtc.tools.get("subagent", agent);
        if (!current) return;
        // 领导层的 subagent 只此一处注册：瘦身文案来自 leader-scope，执行体是本文件的路由强制。
        // 其他插件（如 leader-scope）不得再注册同名工具，否则同层重复注册会抛错。
        if (current.__caseosRouted) {
          leaderToolInstalled.add(agent);
          return;
        }
        const wrapped = {
          ...current,
          __caseosRouted: true,
          description: SLIM_DESC.subagent ?? current.description,
          parameters: slimSchema(current.parameters ?? {}),
          async execute(args, exec) {
            const session = exec.agent?.session;
            const role = sessionState(session).scoutStarted ? "executor" : "scout";
            const route = loadRoutes()[role];
            const label = String(args.description ?? "").trim();
            const roleLabel = role === "scout" ? `scout: ${label}` : `executor: ${label}`;
            process.stderr.write(
              `caseos-dispatch-gate: 强制 ${role} 子代理 ${routeText(route)}\n`,
            );
            const request = {
              label: roleLabel,
              prompt: [{ type: "text", text: String(args.prompt ?? "") }],
              parent: exec.agent,
              agentOptions: {
                provider: route.provider,
                model: route.model,
                reasoningEffort: route.reasoningEffort,
              },
              persona: role === "scout" ? SCOUT_PERSONA : EXECUTOR_PERSONA,
              // 测绘只读由 harness 在子代理 setup 内 restrict：前台 one-shot 的 descriptor 晚于
              // agent/created 才写入，事后按标签识别测绘不可靠。
              ...(role === "scout" ? { toolFilter: { deny: ["edit", "write"] } } : {}),
              maxDepth: 1,
            };
            let result;
            if (args.run_in_background === false) {
              // 前台：等待交付后返回（headless/单线程驱动依赖这一点拿到结果再收回合）。
              const run = await rtc.subagents.start("spawn", { ...request, signal: exec.signal });
              try {
                const runResult = await run.result;
                result = { kind: "foreground", runId: run.id, output: runResult.output };
              } finally {
                await Promise.resolve(run.dispose?.()).catch(() => {});
              }
            } else {
              const child = await rtc.subagents.startContinuable({
                provider: "spawn",
                label: roleLabel,
                request,
                signal: exec.signal,
              });
              result = { kind: "continuable", subagentId: child.childId };
            }
            // 常驻标记只在 spawn 成功后落位：spawn 失败不能把本会话污染成 executor。
            if (role === "scout") writeScoutStarted(session, true);
            return result;
          },
        };
        try {
          rtc.tools.register(wrapped);
          leaderToolInstalled.add(agent);
          process.stderr.write("caseos-dispatch-gate: 领导 subagent 入口已绑定强制路由\n");
        } catch (error) {
          process.stderr.write(`caseos-dispatch-gate: 领导 subagent 注册失败（同名工具已被其他插件占用）: ${String(error)}\n`);
        }
      });
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

    for (const agent of ctx.agents.list()) installLeaderTool(agent);
    ctx.on("agent/created", async ({ agent }) => {
      if (agent?.session?.header?.origin === "subagent") await composeSubagentPreset(agent);
      else installLeaderTool(agent);
    });

    // 规范已读的路径判定补充：read/bash 结果内容不含首行标记（如被截断）但调用路径
    // 指向规范文件时，同样计入。内容判定由 sessionState 的增量扫描覆盖。
    ctx.on("tools/result", (exec, result) => {
      if (!exec || result?.isError) return;
      if (exec.name !== "read" && exec.name !== "bash") return;
      let args = {};
      try { args = exec.arguments ?? {}; } catch {}
      if (pathMatches(args.path) || pathMatches(args.file)) {
        const st = sessionState(exec.agent?.session);
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
      const state = sessionState(session);
      if (!state.specRead) return DENY_REASON;
      const desc = String(description ?? "").trim().toLowerCase();
      // 第一笔派遣的身份由运行时决定为测绘智能体，description 只是展示标签。
      // 这样模型无法通过漏写 scout 前缀跳过测绘阶段。
      if (!state.scoutStarted) return undefined;
      if (isScoutDescription(desc)) {
        if (existsSync(RESET_FILE)) {
          try { unlinkSync(RESET_FILE); } catch {}
          writeScoutStarted(session, false);
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
