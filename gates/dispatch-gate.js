// Verispring 派遣门禁（四条代码级强制）：
// 1 规范门：subagent / subagent_fork 调用前必须先读 specs/子代理派遣规范.md。
//   判定"已读"：read/bash 的结果内容里出现规范唯一首行标记，或调用参数路径指向该文件。
//   状态按会话隔离（WeakMap<session>），多会话互不污染。
// 2 测绘智能体常驻：description 以「测绘智能体」或 scout 开头的派遣只许一次；再次派遣拒绝，改用 send_message
//   复用最早那个测绘智能体。逃生口：确认旧测绘智能体已结束/失败时，bash `touch <RESET_FILE>` 后
//   重派——门自行消费该文件并重置标记（拒绝必须可满足，否则训练出来的是绕门）。
//   RESET_FILE 按运行时 pid 隔离（/tmp/dsh-caseos-scout-reset-<pid>），路径写在拒绝信息里。
// 3 地图前置：非 scout 派遣要求 <cwd>/.project-map.md 存在——cwd 取运行时进程目录（约定
//   在项目根启动），且 .git 或 .manon 在场才认定项目根，否则放行（fail-open）。没有地图先派
//   scout（建图 + 入口表），用 write 落盘后重派。
// 4 模型路由：测绘智能体与执行智能体分别读取面板配置；测绘调用必须显式带出三项路由，
//   执行调用省略时吃 tool-subagent 的执行默认。显式路由必须匹配对应角色配置。
//   fork 路由设计上继承父级（本组合包不覆盖 fork 默认），此处只拦显式错路由。
// 规范目录按主目录解析（~/.dsh/specs/），搬家无需改码，换文件名才要动 MARKER/SPEC_FRAGMENT。
const MARKER = "# 子代理派遣规范";
const SPEC_FRAGMENT = "specs/子代理派遣规范.md";
const GATE_TOOLS = new Set(["subagent", "subagent_fork"]);
const MAP_FILE = ".project-map.md";
const RESET_FILE = `/tmp/dsh-caseos-scout-reset-${process.pid}`;
const DEFAULT_ROUTES = {
  scout: { provider: "verispring", model: "deepseek-flash", reasoningEffort: "high" },
  executor: { provider: "verispring", model: "deepseek-flash", reasoningEffort: "high" },
};
// 用户配置文件（配置面板写入）：{ scout: {...}, executor: {...} }。
// 读取失败/缺省回落常量，门禁永不因配置文件崩。
const CONFIG_FILE = `${homedir()}/.dsh/verispring.json`;

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

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

const EXECUTOR_PERSONA =
  "你是执行智能体：承接全部执行类工作——读码、检索、改码、跑测试与门禁、查代码图谱、web 查证。" +
  "你拥有全部工具与规范权限；动作涉及派遣/提交/工程规范时，先读 ~/.dsh/specs/ 下同名规范再动手。" +
  "全部工作完成后一次性验证并汇报：结论、改动文件路径、测试读数，不报过程，不追加确认轮。";

const plugin = {
  inject: ["tools", "agents"],
  apply(ctx) {
    const routes = loadRoutes();
    process.stderr.write(
      `caseos-dispatch-gate: plugin activated (测绘: ${routeText(routes.scout)}; 执行: ${routeText(routes.executor)})\n`,
    );
    const readSessions = new WeakMap();
    const scoutSessions = new WeakMap();
    const leaderToolInstalled = new WeakSet();

    // 子代理的 provider/model/preset 是运行时契约，不能依赖模型是否记得在
    // tool call 里填写，也不能依赖旧会话当时加载的 preset 配置。领导会话的
    // subagent 工具在这里被替换成唯一的 spawn 入口，所有请求统一挂载
    // verispring-subagent 并使用当前面板的执行路由。
    const installLeaderTool = (agent) => {
      if (!agent || agent.session?.header?.origin === "subagent") return;
      if (leaderToolInstalled.has(agent)) return;
      agent.ctx.inject(["tools", "subagents"], (rtc) => {
        const original = rtc.tools.get("subagent");
        if (!original) return;
        const wrapped = {
          ...original,
          async execute(args, exec) {
            const session = exec.agent?.session;
            const route = loadRoutes().executor;
            const state = scoutSessions.get(session) ?? { started: false };
            const role = state.started ? "executor" : "scout";
            const label = String(args.description ?? "").trim();
            const roleLabel = role === "scout" ? `scout: ${label}` : `executor: ${label}`;
            process.stderr.write(
              `caseos-dispatch-gate: 强制 ${role} 子代理 ${routeText(route)} preset=verispring-subagent\n`,
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
              persona: role === "scout" ? "你是只读测绘智能体：只读扫描项目并在项目根写入 .project-map.md；禁止编辑业务代码。" : EXECUTOR_PERSONA,
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
            if (role === "scout") {
              state.started = true;
              scoutSessions.set(session, state);
            }
            return result;
          },
        };
        rtc.tools.register(wrapped);
        leaderToolInstalled.add(agent);
        process.stderr.write("caseos-dispatch-gate: 领导 subagent 入口已绑定强制 preset/路由\n");
      });
    };

    for (const agent of ctx.agents.list()) installLeaderTool(agent);
    ctx.on("agent/created", ({ agent }) => installLeaderTool(agent));

    ctx.on("tools/result", (exec, result) => {
      if (!exec || result?.isError) return;
      if (exec.name !== "read" && exec.name !== "bash") return;
      const session = exec.agent?.session;
      const text = (result?.content ?? []).map((block) => block?.text ?? "").join("\n");
      let args = {};
      try { args = exec.arguments ?? {}; } catch {}
      if (text.includes(MARKER) || pathMatches(args.path) || pathMatches(args.file)) {
        process.stderr.write("caseos-dispatch-gate: spec read detected\n");
        readSessions.set(session, true);
      }
    });
    ctx.tools.guard((exec) => {
      if (!GATE_TOOLS.has(exec.name)) return undefined;
      if (exec.name === "subagent_fork") {
        return "本插件统一使用 subagent spawn 入口；subagent_fork 不属于三智能体架构。";
      }
      const description = exec.arguments?.description;
      const session = exec.agent?.session;
      const state = scoutSessions.get(session) ?? { started: false };
      const role = state.started ? "executor" : "scout";
      if (!readSessions.get(session)) return DENY_REASON;
      const desc = String(description ?? "").trim().toLowerCase();
      // 第一笔派遣的身份由运行时决定为测绘智能体，description 只是展示标签。
      // 这样模型无法通过漏写 scout 前缀跳过测绘阶段。
      if (!state.started) return undefined;
      if (isScoutDescription(desc)) {
        if (scoutSessions.get(session)) {
          if (existsSync(RESET_FILE)) {
            try { unlinkSync(RESET_FILE); } catch {}
            scoutSessions.delete(session);
            process.stderr.write("caseos-dispatch-gate: 测绘智能体常驻标记已重置（reset 文件）\n");
          } else {
            return "测绘智能体已常驻：不得重复派遣。先用 list_agents 确认最早那个测绘智能体的状态；仍在运行就用 send_message 复用它。若确认它已结束或派遣失败，用 bash 执行 `touch " + RESET_FILE + "` 后重新派遣即可解锁。";
          }
        }
        scoutSessions.set(session, { started: true });
        process.stderr.write("caseos-dispatch-gate: 测绘智能体常驻标记已上\n");
        return undefined;
      }
      const cwd = process.cwd();
      const isProjectRoot = existsSync(`${cwd}/.git`) || existsSync(`${cwd}/.manon`);
      if (isProjectRoot && !existsSync(`${cwd}/${MAP_FILE}`)) {
        process.stderr.write("caseos-dispatch-gate: 地图前置拦截（.project-map.md 不存在）\n");
        return `派执行智能体前必须先有项目地图：${cwd}/${MAP_FILE} 不存在。先派测绘智能体（它跑 ~/manon/manon-kg sync 建图并回报入口表 ≤20 行），用 write 把入口表落盘为该文件，然后重新派遣。`;
      }
      return undefined;
    });
  },
};

export default plugin;
