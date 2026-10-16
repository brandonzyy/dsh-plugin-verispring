// verispring 配置面板（宿主侧）：Config schema 即设置页——dsh settings 传输会把每个条目的
// schema 自动生成原生配置页（autoGenerate 默认开），表单写入经官方传输回到本条目的 live
// Config，cordis 随即以新配置重跑 apply，apply 把四个模型位落到三处执法面：
//   1 测绘/执行路由 -> ~/.dsh/verispring.json（dispatch-gate 读取并执法）
//   2 主会话默认   -> profile patch 条目 agent-default-model（configEditor.edit，含思考强度，
//                     agentDefaultModel 服务活重载）
//   3 执行智能体默认路由 -> profile patch 条目 tool-subagent 的 agentOptions（活重载）
//   4 deep-query / embedding -> ~/.dsh/manon.env 键值 upsert（bridge 注入的 source 调用式
//                     让 manon-kg 子进程读到；manon-kg 侧 MANON_DEEPQUERY_* / MANON_EMBEDDING_*）
// 主会话默认也可继续用 dsh 原生模型选择器按会话选择——本面板写的是"无会话选择时的默认"。
import z from "@deepseek-ai/schemastery";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export const Config = z.object({
  scoutProvider: z.string().description("测绘智能体渠道").default("verispring").volatile(),
  scoutModel: z.string().description("测绘智能体模型").default("deepseek-flash").volatile(),
  scoutEffort: z.string().description("测绘智能体思考强度（默认 High）").default("high").volatile(),
  executorProvider: z.string().description("执行智能体渠道").default("verispring").volatile(),
  executorModel: z.string().description("执行智能体模型").default("deepseek-flash").volatile(),
  executorEffort: z.string().description("执行智能体思考强度（默认 High）").default("high").volatile(),
  mainSessionProvider: z.string().description("主会话默认渠道").default("verispring").volatile(),
  mainSessionModel: z.string().description("主会话默认模型").default("claude-opus-5-5").volatile(),
  mainSessionEffort: z.string().description("主会话思考强度（off/low/medium/high/xhigh/max；默认 High）").default("high").volatile(),
  deepQueryProvider: z.string().description("Manon Deep Query 渠道").default("verispring").volatile(),
  deepQueryModel: z.string().description("Manon Deep Query 模型").default("deepseek-flash").volatile(),
  deepQueryEffort: z.string().description("Manon Deep Query 思考强度（默认 Off）").default("off").volatile(),
  embeddingUrl: z.string().description("embedding 端点").default("https://api.siliconflow.cn/v1").volatile(),
  embeddingModel: z.string().description("embedding 模型（更换后需重新 sync 重建向量）").default("BAAI/bge-m3").volatile(),
});

export const inject = ["configEditor", "credentials"];

const EMBEDDING_CREDENTIAL_REF = "MANON_EMBEDDING_API_KEY";

function upsertEnvKeys(path, entries) {
  let lines = [];
  try { lines = readFileSync(path, "utf8").split("\n"); } catch { lines = ["# manon 凭据与覆盖（dsh-plugin-verispring 面板维护 MANON_* 键）"]; }
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!m || !(m[1] in entries)) return line;
    seen.add(m[1]);
    return `${m[1]}=${entries[m[1]]}`;
  });
  for (const [key, value] of Object.entries(entries)) if (!seen.has(key)) out.push(`${key}=${value}`);
  writeFileSync(path, out.join("\n"));
}

function shellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

async function syncEmbeddingCredential(credentials, path) {
  const resolved = await credentials.resolve(EMBEDDING_CREDENTIAL_REF);
  upsertEnvKeys(path, { MANON_EMBEDDING_API_KEY: shellLiteral(resolved?.value ?? "") });
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

export function apply(ctx, config) {
  // 写入根 = DSH_HOME；未挂 profileContext 时才回落到用户 home 下的 .dsh。
  const dshHome = ctx.profileContext?.home ?? `${homedir()}/.dsh`;
  mkdirSync(dshHome, { recursive: true });
  const manonEnv = `${dshHome}/manon.env`;
  const syncEmbeddingKey = () => syncEmbeddingCredential(ctx.credentials, manonEnv)
    .catch((error) => ctx.logger.warn(`verispring-config: embedding key sync failed: ${String(error)}`));
  void syncEmbeddingKey();
  ctx.on("credentials/reference-updated", (ref) => {
    if (ref === EMBEDDING_CREDENTIAL_REF) void syncEmbeddingKey();
  });
  const editor = ctx.configEditor;
  const rawConfig = editor.configuration().find(item => item.entry.options.id === "verispring-config")?.override ?? {};
  const valueOf = (key, fallback) => {
    if (typeof rawConfig[key] === "string") return rawConfig[key];
    return configValue(config[key], fallback);
  };
  const scoutProvider = valueOf("scoutProvider", "verispring");
  const scoutModel = valueOf("scoutModel", "deepseek-flash");
  const scoutEffort = valueOf("scoutEffort", "high") || "high";
  const executorProvider = valueOf("executorProvider", "verispring");
  const executorModel = valueOf("executorModel", "deepseek-flash");
  const executorEffort = valueOf("executorEffort", "high") || "high";
  const mainSessionProvider = valueOf("mainSessionProvider", "verispring");
  const mainSessionModel = valueOf("mainSessionModel", "claude-opus-5-5");
  const mainSessionEffort = valueOf("mainSessionEffort", "high") || "high";
  const deepQueryProvider = valueOf("deepQueryProvider", "verispring");
  const deepQueryModel = valueOf("deepQueryModel", "deepseek-flash");
  const deepQueryEffort = valueOf("deepQueryEffort", "off") || "off";
  const embeddingUrl = valueOf("embeddingUrl", "https://api.siliconflow.cn/v1");
  const embeddingModel = valueOf("embeddingModel", "BAAI/bge-m3");

  // 1 测绘/执行路由 -> verispring.json
  writeFileSync(
    `${dshHome}/verispring.json`,
    `${JSON.stringify({
      scout: { provider: scoutProvider, model: scoutModel, reasoningEffort: scoutEffort },
      executor: { provider: executorProvider, model: executorModel, reasoningEffort: executorEffort },
    }, null, 2)}\n`,
  );

  // 2 deep-query / embedding -> manon.env（只动自己的 MANON_* 键，凭据行原样保留）
  upsertEnvKeys(manonEnv, {
    MANON_DEEPQUERY_LLM_URL: "https://api.verispring.cn/v1/chat/completions",
    MANON_DEEPQUERY_LLM_PROVIDER: deepQueryProvider,
    MANON_DEEPQUERY_LLM_MODEL: deepQueryModel,
    MANON_DEEPQUERY_LLM_REASONING_EFFORT: deepQueryEffort,
    MANON_EMBEDDING_URL: embeddingUrl,
    MANON_EMBEDDING_MODEL: embeddingModel,
  });
  chmodSync(manonEnv, 0o600);

  // 3 主会话默认（含思考强度）+ 子代理角色 preset 与默认路由 -> profile patch（活重载）
  // 有差异才写，避免每次启动对 patch 做无意义写入。
  const writes = [
    ["agent-default-model", (next) => {
      next.provider = mainSessionProvider;
      next.model = mainSessionModel;
      if (mainSessionEffort) next.reasoningEffort = mainSessionEffort;
      else delete next.reasoningEffort;
    }],
    ["preset-standard", (next) => {
      const tool = findNestedPluginConfig(next, "tool-subagent");
      if (!tool) return;
      tool.agentPreset = "verispring-subagent";
      tool.agentOptions = {
        ...(tool.agentOptions ?? {}),
        provider: executorProvider,
        model: executorModel,
      };
      if (executorEffort) tool.agentOptions.reasoningEffort = executorEffort;
      else delete tool.agentOptions.reasoningEffort;
    }],
  ];
  for (const [entryId, mutate] of writes) {
    const entry = editor.entries().find((candidate) => candidate.options.id === entryId);
    if (!entry) continue;
    const current = { ...(entry.options.config ?? {}) };
    const next = { ...current };
    mutate(next);
    if (JSON.stringify(next) === JSON.stringify(current)) continue;
    editor.edit(entry, () => next).catch((error) => ctx.logger.warn(`verispring-config: 写 ${entryId} 失败: ${String(error)}`));
  }

  process.stderr.write(
    `verispring-config: applied (scout ${scoutProvider}/${scoutModel}` +
    `${scoutEffort ? `@${scoutEffort}` : ""};` +
    ` executor ${executorProvider}/${executorModel}` +
    `${executorEffort ? `@${executorEffort}` : ""};` +
    ` main ${mainSessionProvider}/${mainSessionModel}` +
    `${mainSessionEffort ? `@${mainSessionEffort}` : ""};` +
    ` deep-query ${deepQueryProvider}/${deepQueryModel}${deepQueryEffort ? `@${deepQueryEffort}` : "@off"})\n`,
  );
}
