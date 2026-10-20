// 网关版 llm-deepseek provider：与官方共用同一个 Messages 适配器（dsh-llm-deepseek），
// 但注册成**另一个 provider id**，以便与官方 "deepseek-official" 在同一 profile 里并存。
//
// 为什么需要它：@deepseek-ai/dsh-llm-deepseek-api-key 把 provider id 硬编码为
// "deepseek-official"（lib/index.js:37），同一 profile 起不了第二个 llm-deepseek 路由。
// dsh-llm-deepseek 导出了 registerDeepSeekProvider（lib/index.js:2328），这里复用它，
// 只换 provider id 与鉴权来源（沿用 x-api-key —— 网关实测接受只带 x-api-key 的请求）。
//
// 依赖解析：插件以 file: 方式加载时没有任何 node_modules，裸标识符一律解析不到；
// 宿主安装树（app.asar/dsh/node_modules）里才是真实安装。按锚点顺序找：
//   1 宿主 resourcesPath（桌面 app / CLI 安装树，process.resourcesPath 由 Electron 注入）
//   2 DSH_HOME 的 profile 共享树（dsh plugin add 装到 profile 时的形态）
// 找不到时给出可执行的安装提示，不静默降级。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const SPECS = {
  deepseek: "@deepseek-ai/dsh-llm-deepseek",
  llm: "@deepseek-ai/dsh-llm",
  env: "@deepseek-ai/dsh-launch-environment",
  credentials: "@deepseek-ai/dsh-credentials",
  schemastery: "@deepseek-ai/schemastery",
};

function candidateRoots() {
  const roots = [];
  const resources = process.resourcesPath;
  if (typeof resources === "string" && resources !== "") {
    roots.push(join(resources, "app.asar", "dsh", "node_modules"));
  }
  const home = process.env.DSH_HOME;
  if (typeof home === "string" && home !== "") {
    roots.push(join(home, "profiles", "node_modules"));
    roots.push(join(home, "node_modules"));
  }
  return roots;
}

const modules = new Map();
let lastError;
async function load(key) {
  const cached = modules.get(key);
  if (cached !== undefined) return cached;
  const spec = SPECS[key];
  for (const root of candidateRoots()) {
    const dir = join(root, spec);
    if (!existsSync(join(dir, "package.json"))) continue;
    const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    // schemastery 的 main 是 CJS（lib/index.cjs），其余是 ESM 的 lib/index.js；按 module → main → 默认顺序试。
    const candidates = [manifest.module, manifest.main, "lib/index.js"].filter((entry) => typeof entry === "string");
    let mod;
    for (const entry of candidates) {
      if (!existsSync(join(dir, entry))) continue;
      try {
        mod = await import(pathToFileURL(join(dir, entry)).href);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (mod === undefined) throw lastError ?? new Error(`dsh-plugin-verispring/deepseek-gateway: ${spec} 没有可加载入口`);
    modules.set(key, mod);
    return mod;
  }
  throw new Error(
    `dsh-plugin-verispring/deepseek-gateway: 找不到 ${spec}（试过 ${candidateRoots().join(", ")}）；` +
      `请把插件装进带该依赖的 DSH 安装树`,
  );
}


/**
* 网关的 anthropic 出口在「thinking 开启 + 短回复」时会重复发一条逐字节相同的 `message_start`
* （`service/convert.go:336` 用 `SendResponseCount == 1` 当「首块」判据，短流里命中两次）。
* dsh-llm-deepseek 把它判成 MALFORMED_RESPONSE 并结束整轮，pi-ai 只更新 usage 所以历史上没暴露。
*
* 这个包装只丢弃**重复的** message_start 帧，其余帧原样流式透传；由配置
* `dedupeDuplicateMessageStart` 控制（默认关，网关修好后应当删掉这个开关）。
* @param base - 底层 fetch。
* @returns 带 SSE 去重的 fetch。
*/
function dedupeFetch(base, scopeUrl) {
  return async (input, init) => {
    const response = await base(input, init);
    // 只处理本 provider 的 Messages 端点，绝不碰同一进程里其它 provider 的流量。
    const target = typeof input === "string" ? input : input?.url ?? "";
    if (!target.startsWith(scopeUrl)) return response;
    const type = response.headers.get("content-type") ?? "";
    if (!response.body || !type.includes("text/event-stream")) return response;
    let seenStart = false;
    const decoder = new TextDecoder();
    let held = "";
    const out = new TransformStream({
      transform(chunk, controller) {
        held += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = held.indexOf("\n\n")) !== -1) {
          const frame = held.slice(0, cut + 2);
          held = held.slice(cut + 2);
          if (frame.includes("event: message_start")) {
            if (seenStart) continue;
            seenStart = true;
          }
          controller.enqueue(new TextEncoder().encode(frame));
        }
      },
      flush(controller) {
        if (held !== "") controller.enqueue(new TextEncoder().encode(held));
      },
    });
    return new Response(response.body.pipeThrough(out), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** 默认 provider id：与官方 "deepseek-official" 区分，避免同 profile 路由撞名。 */
const DEFAULT_PROVIDER = "verispring-ds";
const DEFAULT_API_KEY_ENV = "VERISPRING_API_KEY";
const DEFAULT_DISPLAY_NAME = "Verispring (DeepSeek)";

const inject = ["llm"];

async function apply(ctx, config) {
  const settings = config ?? {};
  const providerId = settings.provider ?? DEFAULT_PROVIDER;
  const displayName = settings.displayName ?? DEFAULT_DISPLAY_NAME;

  const [{ registerDeepSeekProvider, catalogModelInfo, deepSeekConfigFields, plainOptions, resolveAdapterOptions }, { LlmError, assertUsableApiKey }, { launchEnvironmentOf }, { credentialRef }] =
    await Promise.all([load("deepseek"), load("llm"), load("env"), load("credentials")]);

  // cordis 把条目配置放在 fiber.entry.options.config（schema 解析后的活值）；无 Config 导出时
  // 直接用 apply 收到的对象。两者同源，这里以前者为主以便面板即时生效。
  const current = () => {
    const live = ctx.fiber?.entry?.options?.config;
    return live !== undefined && typeof live === "object" ? live : settings;
  };
  // 可选：包装全局 fetch 以丢弃网关重复的 message_start（见 dedupeFetch 注释）。
  if (settings.dedupeDuplicateMessageStart === true && globalThis.fetch.__deepseekGatewayDedupe !== true) {
    const scope = `${String(settings.baseURL ?? "").replace(/\/+$/u, "")}/v1/messages`;
    const wrapped = dedupeFetch(globalThis.fetch, scope);
    wrapped.__deepseekGatewayDedupe = true;
    globalThis.fetch = wrapped;
  }

  const options = () => resolveAdapterOptions(plainOptions(current()), launchEnvironmentOf(ctx));
  options();

  const resolveApiKey = async (connection) => {
    const ref = credentialRef(connection.apiKeyEnv ?? current().apiKeyEnv ?? DEFAULT_API_KEY_ENV);
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined) return assertUsableApiKey(hit.value, "llm-deepseek", ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-deepseek", ref);
    }
    throw new LlmError(
      `deepseek-gateway: no API key for provider route "${providerId}"; store ${ref} through the credentials service ` +
        `(the web Models page writes it), or export ${ref} in the launching environment`,
      "MISSING_CREDENTIAL",
    );
  };

  ctx.llm.registerConfigurableProviders([
    {
      provider: providerId,
      displayName,
      settingsNs: ctx.fiber?.entry?.options?.id ?? "deepseek-gateway",
      settingsPath: [],
    },
  ]);

  registerDeepSeekProvider(ctx, providerId, {
    options,
    providerName: displayName,
    // 网关只认 x-api-key（实测：只带 x-api-key 的 /v1/messages → 200），与官方同一套头。
    resolveAuth: async (connection) => ({ headers: { "x-api-key": await resolveApiKey(connection) } }),
    discoverModels: async (provider) => {
      const connection = options();
      try {
        await resolveApiKey(connection);
      } catch (error) {
        if (error instanceof LlmError && error.code === "MISSING_CREDENTIAL") return [];
        throw error;
      }
      return connection.models.map((model) => catalogModelInfo(provider, model));
    },
  });
}

export { apply, inject };
export const name = "deepseek-gateway";
