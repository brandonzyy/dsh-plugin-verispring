// verispring 配置面板（宿主侧）：Config schema 即设置页——dsh settings 传输会把每个条目的
// schema 自动生成原生配置页（autoGenerate 默认开），表单写入经官方传输回到本条目的 live
// Config，cordis 随即以新配置重跑 apply，apply 把三套路由位落到两处执法面：
//   1 测绘/执行路由 -> ~/.dsh/verispring.json（dispatch-gate 读取并执法）
//   2 执行智能体默认路由 -> profile patch 条目 tool-subagent 的 agentOptions（活重载）
//   3 deep-query / embedding -> ~/.dsh/manon.env 键值 upsert（bridge 注入的 source 调用式
//                     让 manon-kg 子进程读到；manon-kg 侧 MANON_DEEPQUERY_* / MANON_EMBEDDING_*）
// 主会话由 DSH 原生模型选择器管理，不由本插件面板覆盖。
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// schemastery 必须按候选路径解析，不能用裸 import。`link:` 安装时插件目录是 profile 里
// 的一个符号链接，而 Node 解析裸标识符从 realpath（仓库真目录）出发按父目录上溯——仓库
// 自己没有 node_modules 时必定 ERR_MODULE_NOT_FOUND，整条目 import 失败，设置页显示
// 「配置服务暂不可用」。按锚点顺序试：插件自身目录（真实安装或仓库自带依赖）→ profile
// 目录（link: 安装时依赖由 profile 声明）→ 宿主入口目录（桌面 app / CLI 安装树）。
const SCHEMASTERY = "@deepseek-ai/schemastery";
const SCHEMASTERY_INSTALL_HINT =
  "请在 profile 目录执行 `dsh plugin --profile <name> add @deepseek-ai/schemastery`" +
  "（或在本仓库执行 pnpm install 装上依赖）后重启";

function packageRoots(anchor) {
  const roots = [];
  let dir = resolve(anchor);
  for (;;) {
    roots.push(join(dir, "node_modules"));
    const parent = dirname(dir);
    if (parent === dir) return roots;
    dir = parent;
  }
}

// profile 目录的候选：--profile 参数最准；桌面 app 启动时命令行里没有它，故再扫一遍
// $DSH_HOME/profiles 下的全部目录；DSH_PROFILE / DSH_PROFILE_DIR 由宿主注入时优先。
// 自己声明了 schemastery 依赖的 profile 排在其他 profile 之前——只有没人声明时才借用
// 邻居 profile 的那份，避免误用别处的旧版本。
function profileRoots() {
  const home = process.env.DSH_HOME ?? `${homedir()}/.dsh`;
  const profiles = join(home, "profiles");
  const preferred = [];
  const others = [];
  if (process.env.DSH_PROFILE_DIR) preferred.push(process.env.DSH_PROFILE_DIR);
  const names = [];
  if (process.env.DSH_PROFILE) names.push(process.env.DSH_PROFILE);
  const argv = process.argv;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--profile" && argv[index + 1] !== undefined) names.push(argv[index + 1]);
  }
  for (const name of names) if (name) preferred.push(join(profiles, name));
  preferred.push(profiles);
  others.push(profiles);
  try { for (const name of readdirSync(profiles).sort()) others.push(join(profiles, name)); } catch {}
  const declared = (dir) => {
    try {
      const fields = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return SCHEMASTERY in { ...fields.dependencies, ...fields.devDependencies };
    } catch { return false; }
  };
  const all = [...new Set([...preferred, ...others])];
  return [
    ...all.filter((dir) => dir !== profiles && declared(dir)),
    ...all.filter((dir) => dir === profiles || !declared(dir)),
  ];
}

// package.json 的 "exports" 可能只给出 import 条件；缺失时回落 module/main。
function schemasteryEntry(root) {
  const packageDir = join(root, SCHEMASTERY);
  const manifest = join(packageDir, "package.json");
  if (!existsSync(manifest)) return undefined;
  let fields;
  try { fields = JSON.parse(readFileSync(manifest, "utf8")); } catch { return undefined; }
  const exported = fields.exports?.["."];
  const target = typeof exported === "string" ? exported : (exported?.import ?? exported?.default) ?? fields.module ?? fields.main;
  if (typeof target !== "string") return undefined;
  const file = join(packageDir, target);
  return existsSync(file) ? file : undefined;
}

async function loadSchemastery() {
  const errors = [];
  const tried = new Set();
  const anchors = [
    ...packageRoots(dirname(fileURLToPath(import.meta.url))),
    ...profileRoots().flatMap(packageRoots),
    ...(process.argv[1] === undefined ? [] : packageRoots(dirname(process.argv[1]))),
  ];
  for (const root of anchors) {
    const file = schemasteryEntry(root);
    if (file === undefined || tried.has(file)) continue;
    tried.add(file);
    try {
      const module = await import(pathToFileURL(file).href);
      if (typeof module.default?.object === "function") return module.default;
      errors.push(`${file}: 导出不含 schemastery 默认导出`);
    } catch (error) {
      errors.push(`${file}: ${String(error).split("\n")[0]}`);
    }
  }
  process.stderr.write(
    `verispring-config: 无法解析 ${SCHEMASTERY}，设置页将不可用（路由同步与门禁照常）。${SCHEMASTERY_INSTALL_HINT}。\n` +
    errors.map((line) => `  - ${line}`).join("\n") + "\n",
  );
  return undefined;
}

// 解析失败只降级面板，绝不连坐 apply：apply 负责把路由落盘，一旦整条目 import 失败，
// 派遣门禁读到的是旧路由。
const z = await loadSchemastery();

function buildConfig(z) {
  return z.object({
    scoutProvider: z.string().description("测绘智能体渠道").default("verispring").volatile(),
    scoutModel: z.string().description("测绘智能体模型").default("deepseek-flash").volatile(),
    scoutEffort: z.string().description("测绘智能体思考强度（默认 High）").default("high").volatile(),
    executorProvider: z.string().description("执行智能体渠道").default("verispring").volatile(),
    executorModel: z.string().description("执行智能体模型").default("deepseek-flash").volatile(),
    executorEffort: z.string().description("执行智能体思考强度（默认 High）").default("high").volatile(),
    deepQueryProvider: z.string().description("Manon Deep Query 渠道").default("verispring").volatile(),
    deepQueryModel: z.string().description("Manon Deep Query 模型").default("deepseek-flash").volatile(),
    deepQueryEffort: z.string().description("Manon Deep Query 思考强度（默认 Off）").default("off").volatile(),
    embeddingUrl: z.string().description("embedding 端点").default("https://api.siliconflow.cn/v1").volatile(),
    embeddingModel: z.string().description("embedding 模型（更换后需重新 sync 重建向量）").default("BAAI/bge-m3").volatile(),
  });
}

export const Config = z === undefined ? undefined : buildConfig(z);

export const inject = ["configEditor", "credentials"];

const EMBEDDING_CREDENTIAL_REF = "MANON_EMBEDDING_API_KEY";
const ROUTES_UPDATED_EVENT = "verispring/routes-updated";

// manon.env 是用户与插件共用的文件：只增改自己名下的键；值未变的行原样保留（export 前缀、
// 引号形式都是用户的），改值时沿用原行的 export 前缀；整文件内容未变不写。
function upsertEnvKeys(path, entries) {
  let original;
  try { original = readFileSync(path, "utf8"); } catch {}
  const lines = original === void 0 ? ["# manon 凭据与覆盖（dsh-plugin-verispring 面板维护 MANON_* 键）"] : original.split("\n");
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || !(m[2] in entries)) return line;
    seen.add(m[2]);
    if (shellUnquote(m[3]) === entries[m[2]]) return line;
    return `${m[1] ?? ""}${m[2]}=${shellWord(entries[m[2]])}`;
  });
  for (const [key, value] of Object.entries(entries)) if (!seen.has(key)) out.push(`${key}=${shellWord(value)}`);
  const next = out.join("\n");
  if (next !== original) {
    const temp = `${path}.tmp-${process.pid}`;
    writeFileSync(temp, next);
    renameSync(temp, path);
  }
}

function shellUnquote(raw) {
  const text = raw.trim();
  const m = /^'([^']*)'$|^"([^"\\$`]*)"$/.exec(text);
  return m ? (m[1] ?? m[2]) : text;
}

function shellWord(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@%+,=-]*$/.test(text) ? text : `'${text.replaceAll("'", "'\"'\"'")}'`;
}

async function syncEmbeddingCredential(credentials, path) {
  const resolved = await credentials.resolve(EMBEDDING_CREDENTIAL_REF);
  // 凭据为空不落盘：保留 manon.env 里已有的 key 行，避免空串覆盖。
  if (!resolved?.value) return;
  upsertEnvKeys(path, { MANON_EMBEDDING_API_KEY: resolved.value });
  chmodSync(path, 0o600);
}

function configValue(value, fallback) {
  const resolved = value && typeof value.get === "function" ? value.get() : value;
  return typeof resolved === "string" && resolved !== "{}" && resolved !== "[object Object]" && (resolved !== "" || !fallback) ? resolved : fallback;
}

function findNestedPluginConfig(config, id) {
  if (!config || typeof config !== "object") return undefined;
  const plugins = Array.isArray(config.plugins) ? config.plugins : Array.isArray(config) ? config : [];
  for (const entry of plugins) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.id === id) return entry.config ?? (entry.config = {});
    const nested = findNestedPluginConfig(entry.config, id);
    if (nested) return nested;
  }
  return undefined;
}

function syncToolSubagentPatch(path, route) {
  let source;
  try { source = readFileSync(path, "utf8"); } catch { return false; }
  const marker = "- id: tool-subagent\n";
  const start = source.indexOf(marker);
  if (start < 0) return false;
  const nextEntry = source.indexOf("\n- id:", start + marker.length);
  const end = nextEntry < 0 ? source.length : nextEntry;
  let block = source.slice(start, end);
  const optionsMarker = "agentOptions:\n";
  const optionsStart = block.indexOf(optionsMarker);
  if (optionsStart < 0) return false;
  const head = block.slice(0, optionsStart + optionsMarker.length);
  let options = block.slice(optionsStart + optionsMarker.length);
  const replace = (key, value) => {
    const pattern = new RegExp(`(^\\s+${key}: ).*$`, "m");
    options = options.replace(pattern, `$1${value}`);
  };
  replace("provider", route.provider);
  replace("model", route.model);
  replace("reasoningEffort", route.reasoningEffort);
  block = head + options;
  const next = `${source.slice(0, start)}${block}${source.slice(end)}`;
  if (next === source) return true;
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, next);
  renameSync(temp, path);
  return true;
}

export function apply(ctx, config) {
  // 写入根 = DSH_HOME；未挂 profileContext 时才回落到用户 home 下的 .dsh。
  const dshHome = ctx.profileContext?.home ?? process.env.DSH_HOME ?? `${homedir()}/.dsh`;
  mkdirSync(dshHome, { recursive: true });
  const manonEnv = `${dshHome}/manon.env`;
  const syncEmbeddingKey = () => syncEmbeddingCredential(ctx.credentials, manonEnv)
    .catch((error) => ctx.logger.warn(`verispring-config: embedding key sync failed: ${String(error)}`));
  void syncEmbeddingKey();
  ctx.on("credentials/reference-updated", (ref) => {
    if (ref === EMBEDDING_CREDENTIAL_REF) void syncEmbeddingKey();
  });
  const editor = ctx.configEditor;
  if (!editor) {
    ctx.logger.warn("verispring-config: configEditor 不可用，跳过 profile patch 同步");
    return;
  }
  const persist = async () => {
    const override = (typeof editor.configuration === "function" ? editor.configuration() : [])
      .find(item => item.entry.options.id === "verispring-config")?.override ?? {};
    const valueOf = (key, fallback) => configValue(config[key], configValue(override[key], fallback));
    const scoutProvider = valueOf("scoutProvider", "verispring");
    const scoutModel = valueOf("scoutModel", "deepseek-flash");
    const scoutEffort = valueOf("scoutEffort", "high") || "high";
    const executorProvider = valueOf("executorProvider", "verispring");
    const executorModel = valueOf("executorModel", "deepseek-flash");
    const executorEffort = valueOf("executorEffort", "high") || "high";
    const deepQueryProvider = valueOf("deepQueryProvider", "verispring");
    const deepQueryModel = valueOf("deepQueryModel", "deepseek-flash");
    const deepQueryEffort = valueOf("deepQueryEffort", "off") || "off";
    const embeddingUrl = valueOf("embeddingUrl", "https://api.siliconflow.cn/v1");
    const embeddingModel = valueOf("embeddingModel", "BAAI/bge-m3");

    const allDefault =
      scoutProvider === "verispring" && scoutModel === "deepseek-flash" && scoutEffort === "high" &&
      executorProvider === "verispring" && executorModel === "deepseek-flash" && executorEffort === "high" &&
      deepQueryProvider === "verispring" && deepQueryModel === "deepseek-flash" && deepQueryEffort === "off" &&
      embeddingUrl === "https://api.siliconflow.cn/v1" && embeddingModel === "BAAI/bge-m3";
    const configRows = typeof editor.configuration === "function" ? editor.configuration() : [];
    const row = configRows.find(({ entry, inherited }) =>
      entry.options.id === "tool-subagent" ||
      findNestedPluginConfig(entry.options.config, "tool-subagent") || findNestedPluginConfig(inherited, "tool-subagent"));
    const entry = row?.entry;
    // 只做一次性装配引导：tool-subagent 缺 agentPreset 时才写入 preset。每笔派遣的
    // 渠道/模型/思考强度由 dispatch-gate 按角色从 verispring.json 运行时覆盖，preset
    // 里的 agentOptions 从不参与实际路由——而 editor.edit 会重组合 delegation 子树、
    // 换掉 subagents 管理器实例，进行中会话的常驻测绘与全部子代理随之失活（判例
    // 2026-10-20：换一次模型，旧 scout 即不可用，连官方 subagent-base 都抛
    // inactive context）。所以模型/思考强度变更绝不走这里。
    const needsBootstrap = (() => {
      if (!entry) return false;
      const existing = entry.options.id === "tool-subagent"
        ? entry.options.config
        : findNestedPluginConfig(entry.options.config, "tool-subagent");
      return existing?.agentPreset !== "verispring-subagent";
    })();
    if (needsBootstrap) {
      const current = JSON.parse(JSON.stringify(entry.options.config ?? {}));
      const inherited = JSON.parse(JSON.stringify(row.inherited ?? {}));
      const next = entry.options.id === "tool-subagent" || findNestedPluginConfig(current, "tool-subagent") ? current : inherited;
      const tool = entry.options.id === "tool-subagent" ? next : findNestedPluginConfig(next, "tool-subagent");
      if (tool) {
        delete tool.persona;
        delete tool.toolFilter;
        tool.agentPreset = "verispring-subagent";
        tool.agentOptions = { ...(tool.agentOptions ?? {}), provider: executorProvider, model: executorModel };
        if (executorEffort) tool.agentOptions.reasoningEffort = executorEffort;
        else delete tool.agentOptions.reasoningEffort;
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          // volatile-update 在配置编辑器写入期间触发；让当前 loader 事务先完成，
          // 再通过官方 editor.edit 写入嵌套 preset，避免重入被旧快照覆盖。
          await new Promise((resolve) => setTimeout(resolve, 0));
          await editor.edit(entry, () => next);
        }
      }
    } else process.stderr.write("verispring-config: 未找到包含 tool-subagent 的 preset 配置\n");
    const patchPath = ctx.profileContext?.patchPath;
    if (patchPath && needsBootstrap) syncToolSubagentPatch(patchPath, {
      provider: executorProvider,
      model: executorModel,
      reasoningEffort: executorEffort,
    });

    if (allDefault) return;

    const routeFile = `${dshHome}/verispring.json`;
    const routeTemp = `${routeFile}.tmp-${process.pid}`;
    writeFileSync(routeTemp, `${JSON.stringify({
      scout: { provider: scoutProvider, model: scoutModel, reasoningEffort: scoutEffort },
      executor: { provider: executorProvider, model: executorModel, reasoningEffort: executorEffort },
    }, null, 2)}\n`);
    renameSync(routeTemp, routeFile);

    upsertEnvKeys(manonEnv, {
      MANON_DEEPQUERY_LLM_URL: "https://api.verispring.cn/v1/chat/completions",
      MANON_DEEPQUERY_LLM_PROVIDER: deepQueryProvider,
      MANON_DEEPQUERY_LLM_MODEL: deepQueryModel,
      MANON_DEEPQUERY_LLM_REASONING_EFFORT: deepQueryEffort,
      MANON_EMBEDDING_URL: embeddingUrl,
      MANON_EMBEDDING_MODEL: embeddingModel,
    });
    chmodSync(manonEnv, 0o600);
    ctx.root.emit(ROUTES_UPDATED_EVENT);

    process.stderr.write(
      `verispring-config: applied (scout ${scoutProvider}/${scoutModel}` +
      `${scoutEffort ? `@${scoutEffort}` : ""};` +
      ` executor ${executorProvider}/${executorModel}` +
      `${executorEffort ? `@${executorEffort}` : ""};` +
      ` deep-query ${deepQueryProvider}/${deepQueryModel}${deepQueryEffort ? `@${deepQueryEffort}` : "@off"})\n`,
    );
  };

  ctx.on("loader/volatile-update", () => {
    void persist().catch((error) => ctx.logger.warn(`verispring-config: volatile update failed: ${String(error)}`));
  });
  void persist().catch((error) => ctx.logger.warn(`verispring-config: 初始配置同步失败: ${String(error)}`));

}
