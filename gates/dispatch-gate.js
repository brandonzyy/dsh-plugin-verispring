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
    const route = (name) => ({
      ...DEFAULT_ROUTES[name],
      ...(cfg?.[name]?.provider && cfg?.[name]?.model ? cfg[name] : {}),
    });
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

const plugin = {
  inject: ["tools"],
  apply(ctx) {
    const routes = loadRoutes();
    process.stderr.write(
      `caseos-dispatch-gate: plugin activated (测绘: ${routeText(routes.scout)}; 执行: ${routeText(routes.executor)})\n`,
    );
    const readSessions = new WeakMap();
    const scoutSessions = new WeakMap();
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
      const description = exec.arguments?.description;
      const role = isScoutDescription(description) ? "scout" : "executor";
      const route = loadRoutes()[role];
      const provider = exec.arguments?.provider;
      const model = exec.arguments?.model;
      const effort = exec.arguments?.reasoning_effort;
      const hasRoute = provider !== void 0 || model !== void 0 || effort !== void 0;
      if (role === "scout" && (provider === void 0 || model === void 0 || (route.reasoningEffort && effort === void 0))) {
        return `测绘智能体必须显式指定 provider=${route.provider}、model=${route.model}、reasoning_effort=${route.reasoningEffort || "模型默认"}；执行智能体才省略路由字段。`;
      }
      if (hasRoute && (provider !== route.provider || model !== route.model || (effort !== void 0 && effort !== route.reasoningEffort))) {
        process.stderr.write(`caseos-dispatch-gate: ${role} 路由拦截 (${provider ?? "-"}/${model ?? "-"}@${effort ?? "-"})\n`);
        return `${role === "scout" ? "测绘智能体" : "执行智能体"}路由已配置为 ${routeText(route)}，请按面板配置发起 ${exec.name}。`;
      }
      const session = exec.agent?.session;
      if (!readSessions.get(session)) return DENY_REASON;
      const desc = String(description ?? "").trim().toLowerCase();
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
        scoutSessions.set(session, true);
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
