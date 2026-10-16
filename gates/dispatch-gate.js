// Verispring 派遣门禁（四条代码级强制）：
// 1 规范门：subagent / subagent_fork 调用前必须先读 specs/子代理派遣规范.md。
//   判定"已读"：read/bash 的结果内容里出现规范唯一首行标记，或调用参数路径指向该文件。
//   状态按会话隔离（WeakMap<session>），多会话互不污染。
// 2 scout 常驻：description 以 scout 开头的派遣只许一次；再次派遣拒绝，改用 send_message
//   复用最早那个 scout。逃生口：确认旧 scout 已结束/失败时，bash `touch <RESET_FILE>` 后
//   重派——门自行消费该文件并重置标记（拒绝必须可满足，否则训练出来的是绕门）。
//   RESET_FILE 按运行时 pid 隔离（/tmp/dsh-caseos-scout-reset-<pid>），路径写在拒绝信息里。
// 3 地图前置：非 scout 派遣要求 <cwd>/.project-map.md 存在——cwd 取运行时进程目录（约定
//   在项目根启动），且 .git 或 .manon 在场才认定项目根，否则放行（fail-open）。没有地图先派
//   scout（建图 + 入口表），用 write 落盘后重派。
// 4 模型钉死：subagent / subagent_fork 显式指定 provider/model 时，必须 PIN_PROVIDER /
//   PIN_MODEL 二者同给且匹配；不带模型字段则吃组合包配置默认（同为钉死模型）。
//   fork 路由设计上继承父级（本组合包不覆盖 fork 默认），此处只拦显式错路由。
// 规范目录按主目录解析（~/.dsh/specs/），搬家无需改码，换文件名才要动 MARKER/SPEC_FRAGMENT。
const MARKER = "# 子代理派遣规范";
const SPEC_FRAGMENT = "specs/子代理派遣规范.md";
const GATE_TOOLS = new Set(["subagent", "subagent_fork"]);
const MAP_FILE = ".project-map.md";
const RESET_FILE = `/tmp/dsh-caseos-scout-reset-${process.pid}`;
const PIN_PROVIDER = "verispring";
const PIN_MODEL = "deepseek-flash";
// 用户配置文件（配置向导写入）：{ "subagent": { "provider": "...", "model": "..." } }
// 存在且字段完整时覆盖默认钉死值；读取失败/缺省回落常量，门禁永不因配置文件崩。
const CONFIG_FILE = `${homedir()}/.dsh/verispring.json`;

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const SPEC_PATH = `${homedir()}/.dsh/specs/子代理派遣规范.md`;
const DENY_REASON =
  `派遣前必读 ${SPEC_PATH}：先用 read 工具读取该规范（含任务书模板与派发前自查），然后重新发起本次调用。`;

function loadPin() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (cfg?.subagent?.provider && cfg?.subagent?.model) return cfg.subagent;
  } catch {}
  return { provider: PIN_PROVIDER, model: PIN_MODEL };
}

function pathMatches(value) {
  if (typeof value !== "string") return false;
  const expanded = value.startsWith("~/") ? homedir() + value.slice(1) : value;
  return expanded.includes(SPEC_FRAGMENT);
}

const plugin = {
  inject: ["tools"],
  apply(ctx) {
    const pin = loadPin();
    process.stderr.write(
      `caseos-dispatch-gate: plugin activated (scout reset: ${RESET_FILE}; pin: ${pin.provider}/${pin.model})\n`,
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
      const provider = exec.arguments?.provider;
      const model = exec.arguments?.model;
      if (provider !== void 0 || model !== void 0) {
        if (provider !== pin.provider || model !== pin.model) {
          process.stderr.write(`caseos-dispatch-gate: 模型钉死拦截 (${provider ?? "-"}/${model ?? "-"})\n`);
          return `子代理模型已钉死为 ${pin.provider}/${pin.model}：不要在 ${exec.name} 调用里指定其它 provider/model，去掉这两个字段重新发起即可（默认路由就是钉死的模型）。`;
        }
      }
      const session = exec.agent?.session;
      if (!readSessions.get(session)) return DENY_REASON;
      const desc = String(exec.arguments?.description ?? "").trim().toLowerCase();
      if (desc.startsWith("scout")) {
        if (scoutSessions.get(session)) {
          if (existsSync(RESET_FILE)) {
            try { unlinkSync(RESET_FILE); } catch {}
            scoutSessions.delete(session);
            process.stderr.write("caseos-dispatch-gate: scout 常驻标记已重置（reset 文件）\n");
          } else {
            return "scout 已常驻：不得重复派遣。先用 list_agents 确认最早那个 scout 的状态；仍在运行就用 send_message 复用它。若确认它已结束或派遣失败，用 bash 执行 `touch " + RESET_FILE + "` 后重新派遣即可解锁。";
          }
        }
        scoutSessions.set(session, true);
        process.stderr.write("caseos-dispatch-gate: scout 常驻标记已上\n");
        return undefined;
      }
      const cwd = process.cwd();
      const isProjectRoot = existsSync(`${cwd}/.git`) || existsSync(`${cwd}/.manon`);
      if (isProjectRoot && !existsSync(`${cwd}/${MAP_FILE}`)) {
        process.stderr.write("caseos-dispatch-gate: 地图前置拦截（.project-map.md 不存在）\n");
        return `派执行子代理前必须先有项目地图：${cwd}/${MAP_FILE} 不存在。先派 scout（它跑 ~/manon/manon-kg sync 建图并回报入口表 ≤20 行），用 write 把入口表落盘为该文件，然后重新派遣。`;
      }
      return undefined;
    });
  },
};

export default plugin;
