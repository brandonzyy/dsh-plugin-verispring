// manon 桥接插件：本地图谱层随包分发（组件 manon/ 自带 manon-kg + Python 源 + 依赖清单），
// 所有表面（CLI / 桌面版）开箱可用。两件事：
// 1 CLI 解析：MANON_KG_BIN 显式指路 > 组件自带 ../manon/manon-kg（与本包版本配对，安装即含，
//   首次运行自举 venv）> 旧地 ~/manon/manon-kg（历史本机安装）。都不存在则只警告并跳过注入。
// 2 用法注入（承重墙）：dsh 的子进程服务会把名字匹配 /KEY|PASSWORD|SECRET|TOKEN/i 的环境变量
//   从子进程剥掉（防泄漏硬设计，dsh-subprocess 的 scrubbedParentEnv）——所以 manon-kg 依赖的
//   MANON_EMBEDDING_API_KEY / VERISPRING_API_KEY 永远不会经父环境到达 bash 子进程，直接
//   `manon-kg sync` 必然报缺密钥。唯一通路是让 bash 命令自己 source 密钥文件（清洗只发生在
//   dsh→第一层子进程的边界，孙进程自由继承）。注入的标准调用式：
//     bash -c 'set -a; [ -f ~/.dsh/manon.env ] && source ~/.dsh/manon.env; ...; manon-kg sync'
//   密钥值全程不经过本插件，也不打印。
const KG_BIN_ENV = "MANON_KG_BIN";
const SPEC = "Manon调用规则.md";

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_FILES = new Set(["manon.env", "verispring.env"]);

function shellDoubleQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function isSecretFile(value) {
  if (typeof value !== "string") return false;
  const normalized = value.replaceAll("\\", "/");
  return SECRET_FILES.has(normalized.split("/").at(-1));
}

function readsSecretFile(command) {
  const text = String(command ?? "");
  if (!/(?:cat|head|tail|sed|awk|cut|env|printenv|grep|rg)\b/.test(text)) return false;
  return [...SECRET_FILES].some((name) => text.includes(name));
}

const plugin = {
  inject: ["systemPrompt", "tools", "profileContext"],
  apply(ctx) {
    const home = ctx.profileContext?.home ?? process.env.DSH_HOME ?? `${homedir()}/.dsh`;
    const sourcePrefix =
      `set -a; [ -f ${shellDoubleQuote(`${home}/manon.env`)} ] && source ${shellDoubleQuote(`${home}/manon.env`)}; ` +
      `[ -f ${shellDoubleQuote(`${home}/verispring.env`)} ] && source ${shellDoubleQuote(`${home}/verispring.env`)}; set +a; `;
    const bundled = join(dirname(fileURLToPath(import.meta.url)), "..", "manon", "manon-kg");
    const legacy = join(home, "manon", "manon-kg");
    const kg = process.env[KG_BIN_ENV] ?? (existsSync(bundled) ? bundled : legacy);
    const kgOk = existsSync(kg);
    process.stderr.write(`manon-bridge: activated; kg=${kg}${kgOk ? "" : " (missing -> 用法注入跳过)"}\n`);
    ctx.tools.guard((exec) => {
      if (exec.name === "read" && isSecretFile(exec.arguments?.path ?? exec.arguments?.file ?? exec.arguments?.file_path)) {
        return "凭据文件只允许由受控 manon 调用式 source；禁止用 read 读取并写入会话日志。";
      }
      if (exec.name === "bash" && readsSecretFile(exec.arguments?.command)) {
        return "凭据文件禁止用命令输出；只允许在 manon 调用式中 source 后执行目标子命令。";
      }
      return undefined;
    });
    if (!kgOk) return;
    ctx.systemPrompt.section({
      name: "verispring:manon-kg",
      order: ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT"),
      text: () =>
        `本地图谱：${kg}（存储在 <项目>/.manon/，随仓库走；组件版首次运行自动建运行环境，需联网一次）。` +
        `命令面：sync（增量建图，--full 全量）、query "词" -j（检索）、deep-query "问题"（多轮规划问答）、` +
        `graph、impact、health、status。` +
        `调用铁则：dsh 会剥掉子进程里 KEY/TOKEN 形状的环境变量，直接运行必报缺密钥——必须让 bash 命令自带密钥，` +
        `统一用这个前缀：\`bash -c '${sourcePrefix}<子命令>'\`（例：${sourcePrefix}${kg} sync）。` +
        `维护纪律：常驻测绘兵（scout）进仓先 sync 并把入口表落盘为仓库根 .project-map.md；其余会话只读查询，不 clear。` +
        `语义与陷阱详见 ${home}/specs/${SPEC}，动手前先读。`,
    });
  },
};

export default plugin;
