// verispring 配置面板（宿主侧）：Config schema 即设置页——dsh settings 传输会把每个条目的
// schema 自动生成原生配置页（autoGenerate 默认开），表单写入经官方传输回到本条目的 live
// Config，cordis 随即以新配置重跑 apply，apply 把四个模型位落到三处执法面：
//   1 子代理钉死   -> ~/.dsh/verispring.json（dispatch-gate 读取并执法）
//   2 主会话默认   -> profile patch 条目 agent-default-model（configEditor.edit，含思考强度，
//                     agentDefaultModel 服务活重载）
//   3 子代理默认路由 -> profile patch 条目 tool-subagent 的 agentOptions（活重载）
//   4 deep-query / embedding -> ~/.dsh/manon.env 键值 upsert（bridge 注入的 source 调用式
//                     让 manon-kg 子进程读到；manon-kg 侧 MANON_DEEPQUERY_* / MANON_EMBEDDING_*）
// 主会话默认也可继续用 dsh 原生模型选择器按会话选择——本面板写的是"无会话选择时的默认"。
import z from "@deepseek-ai/schemastery";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export const Config = z.object({
  subagentProvider: z.string().description("子代理渠道（scout + 执行层共用）").default("verispring"),
  subagentModel: z.string().description("子代理模型（scout 与执行层；gate 强制执法）").default("deepseek-flash"),
  mainSessionProvider: z.string().description("主会话默认渠道").default("verispring"),
  mainSessionModel: z.string().description("主会话默认模型").default("claude-opus-5-5"),
  mainSessionEffort: z.string().description("主会话思考强度（off/low/medium/high/xhigh/max；留空跟随模型默认）").default(""),
  deepQueryUrl: z.string().description("manon deep-query 端点（OpenAI 兼容）").default("https://api.verispring.cn/v1/chat/completions"),
  deepQueryModel: z.string().description("manon deep-query 模型").default("deepseek-flash"),
  embeddingUrl: z.string().description("embedding 端点").default("https://api.siliconflow.cn/v1"),
  embeddingModel: z.string().description("embedding 模型（更换后需重新 sync 重建向量）").default("BAAI/bge-m3"),
});

export const inject = ["configEditor"];

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

export function apply(ctx, config) {
  // 写入根 = Harness home（= DSH_HOME），不是硬编码 ~：与 settings/specs 同根，探针/多 home 隔离不被写穿。
  const home = ctx.profileContext?.home ?? homedir();
  mkdirSync(`${home}/.dsh`, { recursive: true });
  const editor = ctx.configEditor;

  // 1 子代理钉死 -> verispring.json
  writeFileSync(
    `${home}/.dsh/verispring.json`,
    `${JSON.stringify({ subagent: { provider: config.subagentProvider, model: config.subagentModel } }, null, 2)}\n`,
  );

  // 2 deep-query / embedding -> manon.env（只动自己的 MANON_* 键，凭据行原样保留）
  upsertEnvKeys(`${home}/.dsh/manon.env`, {
    MANON_DEEPQUERY_LLM_URL: config.deepQueryUrl,
    MANON_DEEPQUERY_LLM_MODEL: config.deepQueryModel,
    MANON_EMBEDDING_URL: config.embeddingUrl,
    MANON_EMBEDDING_MODEL: config.embeddingModel,
  });

  // 3 主会话默认（含思考强度）+ 子代理默认路由 -> profile patch（活重载）
  // 有差异才写，避免每次启动对 patch 做无意义写入。
  const writes = [
    ["agent-default-model", (next) => {
      next.provider = config.mainSessionProvider;
      next.model = config.mainSessionModel;
      if (config.mainSessionEffort) next.reasoningEffort = config.mainSessionEffort;
      else delete next.reasoningEffort;
    }],
    ["tool-subagent", (next) => {
      next.agentOptions = { ...(next.agentOptions ?? {}), provider: config.subagentProvider, model: config.subagentModel };
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
    `verispring-config: applied (subagent ${config.subagentProvider}/${config.subagentModel};` +
    ` main ${config.mainSessionProvider}/${config.mainSessionModel}` +
    `${config.mainSessionEffort ? `@${config.mainSessionEffort}` : ""})\n`,
  );
}
