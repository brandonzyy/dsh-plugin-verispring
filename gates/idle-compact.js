// 主会话空闲自动压缩门禁：主会话连续 idleMinutes（默认 55）分钟没有真实模型请求、且
// tokenMeter 读到的上下文 totalTokens 严格超过 minTokens（默认 50000）时，调宿主
// compaction.compactNow 压缩一次。空闲期是唯一既能回收上下文又不打断回合的窗口。
// 只碰主会话：子代理的上下文由父会话的派遣生命周期管理，这里绝不介入。
//
// 宿主契约（0.2.1-rc.2 已查实）：
// - agent/request 是 waterfall，每个真实 turn 的模型请求触发；监听必须 return next()。
//   compactNow 的 summarize 直连 ctx.llm.stream，不会再触发它——所以压缩自身不会刷新
//   空闲计时，也不会推进请求纪元。
// - compaction.compactNow(agent, signal) 是空闲强制压缩入口；可返回 null（无可压区间），
//   这同样算本轮完成。维护期间 agent.status 仍是 idle，所以防重入必须靠本门禁的 inflight。
// - tokenMeter.measure(session).totalTokens 是上下文读数。
// 防重复用请求纪元：epoch 只在真实请求时 +1；压缩成功或返回 null 后把 compactedEpoch
// 记成触发时捕获的 epoch（不写完成时的 epoch），压缩完成后排进来的新请求因此仍具备资格。
// 新 agent / 重启后 epoch=compactedEpoch=0，没有真实请求就永远不会压，避免重启即压。
import { homedir } from "node:os";
import { monitorEvent } from "./monitor-log.js";

export const ENABLED_ENV = "CASEOS_IDLE_COMPACT";
export const TICK_MS = 60_000;
export const COOLDOWN_MS = 10 * 60_000;
export const MINUTE_MS = 60_000;
export const DEFAULT_IDLE_MINUTES = 55;
export const DEFAULT_MIN_TOKENS = 50000;
export const CONFIG_ID = "verispring-config";

// 配置值来自设置页（可能被手改成字符串/空值），一律收口成正整数；非法值回落到默认，
// 避免 NaN/负数把时间与阈值判断变成恒真或永不触发。
function positiveInteger(value, fallback) {
  const raw = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

export function normalizeSettings(raw) {
  const row = raw !== null && typeof raw === "object" ? raw : {};
  return {
    enabled: row.idleCompactEnabled !== false,
    idleMs: positiveInteger(row.idleCompactMinutes, DEFAULT_IDLE_MINUTES) * MINUTE_MS,
    minTokens: positiveInteger(row.idleCompactMinTokens, DEFAULT_MIN_TOKENS),
  };
}

// 与 leader-scope.js 同一判定口径：子代理会话头带 origin 或 parentSession。
export function isSubagent(agent) {
  try {
    const header = agent?.session?.header;
    return header?.origin === "subagent" || header?.parentSession !== void 0;
  } catch {
    return false;
  }
}

// 末会话事件时间只在插件装载时做一次保守初始化：读不到就按 now（宁可晚压，不早压）。
export function lastEventTime(session) {
  try {
    const log = session?.log;
    if (!Array.isArray(log) || log.length === 0) return undefined;
    const time = log[log.length - 1]?.time;
    if (typeof time === "number" && Number.isFinite(time)) return time;
    if (typeof time === "string") {
      const parsed = Date.parse(time);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function serviceOf(ctx, name) {
  try {
    const value = ctx?.get?.(name);
    if (value !== void 0) return value;
  } catch {}
  try {
    return ctx?.[name];
  } catch {
    return void 0;
  }
}

// 设置页 schema 在 verispring-config 条目上；这里只读合并后的覆盖值，schema 默认值由
// normalizeSettings 兜底。configEditor 不可用（精简 profile / 单测）时用默认值。
export function readSettings(ctx) {
  let merged;
  try {
    const editor = serviceOf(ctx, "configEditor");
    const rows = typeof editor?.configuration === "function" ? editor.configuration() : [];
    const row = Array.isArray(rows)
      ? rows.find((item) => item?.entry?.options?.id === CONFIG_ID)
      : undefined;
    if (row !== undefined) {
      merged = {
        ...(row.inherited ?? {}),
        ...(row.entry?.options?.config ?? {}),
        ...(row.override ?? {}),
      };
    } else {
      // 少数 profile 的条目不在 include 子树里：configuration() 不给行，退回 loader 条目本身。
      const entries = typeof editor?.entries === "function" ? editor.entries() : [];
      const entry = Array.isArray(entries)
        ? entries.find((item) => item?.options?.id === CONFIG_ID)
        : undefined;
      merged = entry?.options?.config;
    }
  } catch {
    merged = void 0;
  }
  return normalizeSettings(merged);
}

function errorCode(error) {
  const code = error?.code ?? error?.name ?? "error";
  return String(code).slice(0, 80);
}

function errorMessage(error) {
  return String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 200);
}

/**
 * 空闲压缩调度器（apply 与单测共用的实现面）。
 * @param ctx 插件上下文（只用于取 agents/configEditor/profileContext，不执行压缩）。
 * @param options.now 时钟（默认 Date.now）；options.timers 定时器面（默认全局 setInterval）。
 */
export function createIdleCompactor(ctx, options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const timers = options.timers ?? { setInterval, clearInterval };
  const settingsOf = typeof options.readSettings === "function" ? options.readSettings : () => readSettings(ctx);
  const dshHome = options.dshHome
    ?? serviceOf(ctx, "profileContext")?.home
    ?? process.env.DSH_HOME
    ?? `${homedir()}/.dsh`;

  const states = new WeakMap();
  // 维护期间 agent.status 仍是 idle：本门禁自己的 inflight 集合是唯一的重入闸。
  const inflight = new Set();
  // 只保留根作用域上的监听器（agent/created）；每个 agent 的请求监听属于该 agent 的
  // 作用域，随 agent 卸载自动销毁，不能塞进这里——否则本插件会持有已结束会话的引用。
  const rootDisposers = new Set();
  const controllers = new Set();
  let timer;
  let stopped = false;

  const agents = () => {
    try {
      return serviceOf(ctx, "agents")?.list?.() ?? [];
    } catch {
      return [];
    }
  };

  // 服务同步现取：compaction 挂在 agentPresets 的隔离 realm 里（web-app 在 root 禁用
  // compaction-basic，preset 内是 isolate:{compaction:true}），agent.ctx 与它不在同一条
  // 服务继承链上，agent.ctx.get("compaction") 恒为 undefined、inject 会永久等待依赖并卡住
  // inflight。官方入口是 ctx.get("agentPresets").serviceFor(agent, "compaction")；后两项
  // 只作无 preset/老宿主兜底。tokenMeter 在 host plane，root 或 agent ctx 都能读。
  // 缺失或未绑定时同步抛错，由 run 按 fail + 冷却记账；失败会清缓存以便冷却后重试。
  function loadServices(agent) {
    let compaction;
    try {
      const presets = serviceOf(ctx, "agentPresets");
      if (typeof presets?.serviceFor === "function") compaction = presets.serviceFor(agent, "compaction");
    } catch {}
    if (compaction === void 0) compaction = serviceOf(agent.ctx, "compaction");
    if (compaction === void 0) compaction = serviceOf(ctx, "compaction");
    const tokenMeter = serviceOf(ctx, "tokenMeter") ?? serviceOf(agent.ctx, "tokenMeter");
    if (typeof compaction?.compactNow !== "function") throw new Error("compaction.compactNow unavailable");
    if (typeof tokenMeter?.measure !== "function") throw new Error("tokenMeter.measure unavailable");
    return { compaction, tokenMeter };
  }

  // 每个主会话一份状态 + 一个 agent/request 监听（请求纪元与真实请求时间只在这里更新）。
  function adopt(agent, existing) {
    if (stopped || agent === void 0 || isSubagent(agent)) return void 0;
    const known = states.get(agent);
    if (known !== void 0) return known;
    const state = {
      epoch: 0,
      compactedEpoch: 0,
      lastRequestAt: existing ? (lastEventTime(agent.session) ?? now()) : now(),
      controller: void 0,
      cooldownUntil: 0,
      services: void 0,
      disposer: void 0,
    };
    states.set(agent, state);
    try {
      const dispose = agent.ctx?.on?.("agent/request", (_payload, next) => {
        state.epoch += 1;
        state.lastRequestAt = now();
        return typeof next === "function" ? next() : void 0;
      });
      if (typeof dispose === "function") state.disposer = dispose;
    } catch (error) {
      process.stderr.write(`caseos-idle-compact: 会话 ${String(agent?.id)} 请求监听安装失败: ${errorMessage(error)}\n`);
    }
    return state;
  }

  function trigger(agent, state, settings, idleMs) {
    // inflight 必须在任何 await（服务装载 / measure / compactNow）之前登记：维护期间
    // agent.status 仍是 idle，只有这里能挡住下一个 tick 的重入。
    inflight.add(agent);
    const controller = new AbortController();
    controllers.add(controller);
    state.controller = controller;
    return run(agent, state, controller, {
      triggerEpoch: state.epoch,
      idleMs,
      minTokens: settings.minTokens,
    });
  }

  async function run(agent, state, controller, meta) {
    const base = {
      agent: agent.id,
      epoch: meta.triggerEpoch,
      idleMs: Math.max(0, meta.idleMs),
      idleMinutes: Math.floor(Math.max(0, meta.idleMs) / MINUTE_MS),
    };
    let totalTokens;
    let services;
    try {
      if (state.services === void 0) state.services = loadServices(agent);
      services = await state.services;
      if (stopped || controller.signal.aborted) return;
      const measurement = services.tokenMeter.measure(agent.session);
      totalTokens = Number(measurement?.totalTokens);
      if (!Number.isFinite(totalTokens)) throw new Error("tokenMeter returned no totalTokens");
      // 严格大于才压；不够就不消耗纪元，上下文长起来后仍可在同一段空闲里再判。
      if (totalTokens <= meta.minTokens) return;
      monitorEvent(dshHome, {
        kind: "idle-compact-start",
        ...base,
        totalTokens,
        minTokens: meta.minTokens,
      });
      const result = await services.compaction.compactNow(agent, controller.signal);
      // 只记触发时捕获的 epoch：压缩期间若排入新请求（epoch 已经更大），下次空闲仍具备资格。
      state.compactedEpoch = Math.max(state.compactedEpoch, meta.triggerEpoch);
      monitorEvent(dshHome, {
        kind: "idle-compact-done",
        ...base,
        totalTokens,
        compacted: result !== null && result !== void 0,
      });
    } catch (error) {
      if (services === void 0) state.services = void 0;
      const code = errorCode(error);
      const cancelled = stopped || controller.signal.aborted || code === "cancelled" || code === "abort";
      // 失败与取消都冷却 10 分钟：取消不是系统故障，但也不立即重试。
      state.cooldownUntil = now() + COOLDOWN_MS;
      monitorEvent(dshHome, {
        kind: cancelled ? "idle-compact-cancelled" : "idle-compact-fail",
        ...base,
        ...(totalTokens === void 0 ? {} : { totalTokens }),
        code,
        error: errorMessage(error),
      });
    } finally {
      controllers.delete(controller);
      if (state.controller === controller) state.controller = void 0;
      inflight.delete(agent);
    }
  }

  function eligible(agent, state, settings, at) {
    if (inflight.has(agent)) return false;
    if (agent.status !== "idle") return false;
    // 无真实请求（或本轮已压过）绝不触发：这正是重启后不立即压、压完不重复压的来源。
    if (state.epoch <= state.compactedEpoch) return false;
    if (at - state.lastRequestAt < settings.idleMs) return false;
    if (at < state.cooldownUntil) return false;
    return true;
  }

  // 单一 60s tick：先筛主会话/状态/时间/纪元/冷却，够格才 measure；子会话与非 idle
  // 会话连 tokenMeter 都不会碰。
  async function tick() {
    if (stopped) return;
    // 总开关在 tick 也复核：运行期设置 CASEOS_IDLE_COMPACT=0 后下一分钟即停手。
    if (process.env[ENABLED_ENV] === "0") return;
    const settings = settingsOf();
    if (!settings.enabled) return;
    const at = now();
    const pending = [];
    for (const agent of agents()) {
      if (stopped) break;
      try {
        if (isSubagent(agent)) continue;
        if (agent?.status !== "idle") continue;
        const state = adopt(agent, true);
        if (state === void 0 || !eligible(agent, state, settings, at)) continue;
        pending.push(trigger(agent, state, settings, at - state.lastRequestAt));
      } catch (error) {
        process.stderr.write(`caseos-idle-compact: tick 处理会话失败: ${errorMessage(error)}\n`);
      }
    }
    await Promise.all(pending);
  }

  function start() {
    if (stopped || timer !== void 0) return;
    // 装载时已存在的 agent 只做一次保守初始化（末事件时间或 now）；之后空闲计时完全由
    // agent/request 更新，后台事件不会刷新它。
    for (const agent of agents()) {
      try {
        adopt(agent, true);
      } catch {}
    }
    try {
      const root = ctx.root ?? ctx;
      const dispose = root?.on?.("agent/created", ({ agent } = {}) => {
        try {
          adopt(agent, false);
        } catch (error) {
          process.stderr.write(`caseos-idle-compact: 新会话登记失败: ${errorMessage(error)}\n`);
        }
      });
      if (typeof dispose === "function") rootDisposers.add(dispose);
    } catch (error) {
      process.stderr.write(`caseos-idle-compact: agent/created 监听安装失败: ${errorMessage(error)}\n`);
    }
    timer = timers.setInterval(() => {
      void tick().catch(() => {});
    }, TICK_MS);
    if (typeof timer?.unref === "function") timer.unref();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== void 0) {
      try {
        timers.clearInterval(timer);
      } catch {}
      timer = void 0;
    }
    for (const dispose of rootDisposers) {
      try {
        dispose();
      } catch {}
    }
    rootDisposers.clear();
    // 活会话的请求监听属于 agent 作用域，插件卸载时主动摘掉；已结束会话的监听已随
    // agent 作用域销毁，无需（也无法）在这里遍历。
    for (const agent of agents()) {
      const state = states.get(agent);
      if (typeof state?.disposer !== "function") continue;
      try {
        state.disposer();
      } catch {}
      state.disposer = void 0;
    }
    for (const controller of controllers) {
      try {
        controller.abort();
      } catch {}
    }
    controllers.clear();
  }

  return {
    start,
    stop,
    tick,
    adoptAgent: (agent) => adopt(agent, false),
    stateOf: (agent) => states.get(agent),
    inflightCount: () => inflight.size,
    interval: () => timer,
    stopped: () => stopped,
  };
}

export default {
  name: "caseos-idle-compact",
  inject: ["agents", "profileContext"],
  apply(ctx) {
    // 总开关：关掉即不注册定时器、不挂监听，回到无空闲压缩状态。
    if (process.env[ENABLED_ENV] === "0") return;
    const compactor = createIdleCompactor(ctx);
    // 先挂 effect 再启动：start 中途失败时由卸载路径统一 stop（清 interval/监听/abort）。
    ctx.effect(() => () => compactor.stop(), "caseos-idle-compact: lifecycle");
    compactor.start();
  },
};
