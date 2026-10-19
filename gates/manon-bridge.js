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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEvent } from "./monitor-log.js";

const SECRET_FILES = new Set(["manon.env", "verispring.env"]);
// 项目侧环境文件（值会连 key 一起进会话日志）：.env、*.env、.env.local 等；
// example/template/sample 是给仓库看的占位，放行。
const ENV_FILE_RE = /(?:^|\/)[A-Za-z0-9._-]*\.env(?:\.[A-Za-z0-9_-]+)?$/;
const ENV_FILE_EXEMPT = /(?:example|template|sample|dist)\.?$/i;
const READER_VERB_RE = /(?<![\w.])(?:cat|head|tail|less|more|sed|awk|cut|grep|rg|strings|xxd|base64|jq)\b/;

function shellDoubleQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

function isSecretFile(value) {
  if (typeof value !== "string") return false;
  const normalized = value.replaceAll("\\", "/");
  const base = normalized.split("/").at(-1);
  if (SECRET_FILES.has(base)) return true;
  return ENV_FILE_RE.test(base) && !ENV_FILE_EXEMPT.test(base);
}

function segmentsOf(command) {
  return String(command ?? "").split(/(?:&&|\|\||;|\||\n)/);
}

// 判定改为按命令段：读取动词与密钥文件名必须出现在同一段才算读取。
// 这样受控调用式（[ -f ... ] && source 的段没有读取动词）和给 manon-kg 输出接管道
// （manon-kg query … | head，该段没有密钥文件名）都不再误伤；`cat manon.env`、
// `sed … demo-executor.env` 依然拦截。
function readsSecretFile(command) {
  for (const segment of segmentsOf(command)) {
    if (!READER_VERB_RE.test(segment)) continue;
    if ([...SECRET_FILES].some((name) => segment.includes(name))) return true;
    const match = /([A-Za-z0-9._/-]*\.env(?:\.[A-Za-z0-9_-]+)?)/.exec(segment);
    if (match && !ENV_FILE_EXEMPT.test(match[1])) return true;
  }
  return false;
}

// 整环境倾倒：无参数的 env/printenv（含 sudo、docker exec、$() 内；env 只带赋值也视为
// 倾倒）、ps 的 e/eww 旗标、/proc/*/environ、无 --format 的 docker inspect（整个 Env
// 数组都会进结果）。
function dumpsEnvironment(command) {
  const text = String(command ?? "");
  for (const segment of segmentsOf(text)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "env" || tokens[i] === "printenv") {
        const rest = tokens.slice(i + 1);
        const isDump = rest.length === 0 || rest.every((token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
        if (isDump) return true;
      }
    }
    if (/(^|\s)ps\s/.test(segment) && /(?:^|\s)\S*(?:eww|wwE)\S*/.test(segment)) return true;
    if (/\/proc\/\d+\/environ\b/.test(segment)) return true;
    if (/\bdocker\s+(?:compose\s+)?inspect\b/.test(segment) && !segment.includes("--format")) return true;
  }
  return false;
}

const plugin = {
  inject: ["systemPrompt", "tools", "profileContext", "sessionTitle"],
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
    const deny = (exec, rule, reason) => {
      monitorEvent(home, {
        kind: "gate-deny",
        gate: "manon-bridge",
        rule,
        tool: exec.name,
        session: exec.agent?.session?.header?.id,
        reason: reason.slice(0, 160),
      });
      return reason;
    };
    ctx.tools.guard((exec) => {
      if (exec.name === "read" && isSecretFile(exec.arguments?.path ?? exec.arguments?.file ?? exec.arguments?.file_path)) {
        return deny(exec, "secret-file", "凭据/环境文件只允许由受控调用式 source 注入；禁止用 read 读取——内容会原样写进会话日志。");
      }
      if (exec.name === "bash") {
        const command = exec.arguments?.command;
        if (readsSecretFile(command)) {
          return deny(exec, "secret-file", "凭据/环境文件禁止用命令输出；只允许在受控调用式里 source 后执行目标子命令。");
        }
        if (dumpsEnvironment(command)) {
          return deny(exec, "env-dump", "这条命令会把整个环境（含密钥）倾倒进会话日志。请只查具体变量：`docker exec <容器> printenv <变量名>`；查看镜像配置用 `docker inspect --format`；看进程列表用 `ps aux`（不带 e/eww）。");
        }
      }
      return undefined;
    });
    if (!kgOk) return;
    // 角色化注入（设计：manon 是测绘专责，领导和执行都不直接调用）：
    // - 测绘：完整命令面 + source 调用铁则 + 维护纪律；
    // - 领导：只保留"图谱事实找测绘"，命令面与密钥前缀都不给；
    // - 执行：一行说明（图谱事实从任务书拿，缺了在回报里提）。
    const roleOf = (scope) => {
      try {
        const header = scope?.session?.header;
        if (header?.origin !== "subagent" && header?.parentSession === void 0) return "leader";
        const id = header?.id ?? header?.sessionId;
        if (id) {
          try {
            const role = JSON.parse(readFileSync(`${home}/caseos/session-state/${id}.json`, "utf8")).role;
            if (role === "scout" || role === "executor") return role;
          } catch {}
        }
        const title = ctx.sessionTitle?.get?.(scope.session)?.title ?? "";
        if (title.includes(" · scout · ")) return "scout";
      } catch {}
      return "executor";
    };
    ctx.systemPrompt.section({
      name: "verispring:manon-kg",
      order: ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT"),
      text: (context) => {
        const role = roleOf(context.scope);
        if (role === "leader") {
          return `本地图谱（manon，存储在 <项目>/.manon/）由常驻测绘智能体专责：sync 建图、入口表、语义查询都是它的活。你要图谱事实（结构、调用链、入口坐标）就 send_message 问测绘或写进任务书让它回报，不要自己运行 manon-kg。`;
        }
        if (role === "executor") {
          return `本地图谱（<项目>/.manon/）由常驻测绘专责维护，你不直接调用 manon-kg；任务书没给而你又需要图谱事实时，在回报里写明缺失，由领导转测绘补齐。`;
        }
        return `本地图谱：${kg}（存储在 <项目>/.manon/，随仓库走；组件版首次运行自动建运行环境，需联网一次）。` +
          `命令面：sync（增量建图，--full 全量）、query "词" -j（检索，默认已瘦身：紧凑字段+条数上限，全量加 --full）、` +
          `deep-query "问题"（多轮规划问答）、graph、impact、health、status。图谱由你专责：领导与执行不直接调用。` +
          `调用铁则：dsh 会剥掉子进程里 KEY/TOKEN 形状的环境变量，直接运行必报缺密钥——必须让 bash 命令自带密钥，` +
          `统一用这个前缀：\`bash -c '${sourcePrefix}<子命令>'\`（例：${sourcePrefix}${kg} sync）。` +
          `维护纪律：进仓先 sync 并把入口表落盘为仓库根 .project-map.md；main 前进后被派遣拦截时做增量校对并回报，` +
          `由领导重写地图登记新基准。不 clear。语义与陷阱详见 ${home}/specs/Manon调用规则.md，动手前先读。`;
      },
    });
  },
};

export { readsSecretFile, dumpsEnvironment, isSecretFile };
export default plugin;
