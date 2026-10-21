// 空闲会话卸载器：把「被点开 / 被 promote 过、但已经没人看也没人用」的会话真正释放。
//
// 病因（rc.2 实测源码）：session-controller 的 promote 链
//   follow() 收到冷快照 → source.retain() → this.promote()（dsh-api-session-controller/lib/index.js:1586-1594）
//   → resolveObservedAgent()（:3006-3017）→ resumeObserved() 里的
//     `(await this.ctx.agents.resume({...})).agent`（:396-403），把 resume 返回的
//   `{ agent, dispose }` 里的 dispose 丢掉（dsh-agent-loop/lib/index.js:1795-1806）。
// AgentRegistry.resume 的 owner 是长期存活的控制器作用域（dsh-agent/lib/index.js:466-470），
// 于是每次 promote 都把整份 Session.log 挂到进程生命周期，直到 OOM。
//
// 包装生效面（必须查清的一点）：cordis 的 context 是 proxy，`ctx.agents` 每次读取都经
// getTraceable 返回一个 traceable proxy（cordis/lib/index.js:675、:686、:763-764）；该 proxy 的
// get 陷阱在**每次方法访问**时重新沿原型链查 `resume`（:84-157），所以改
// `AgentRegistry.prototype.resume` 对 session-controller 的 `this.ctx.agents.resume` 必然生效
// （rc.2 的 resume 是类方法，在原型上：dsh-agent/lib/index.js:466）。反过来，插件拿不到 raw
// registry 实例（`ctx.get("agents")` 同样被 getTraceable 包过），改实例不可行。
//
// 卸载判据（全部满足）：不是「仍有活 activation 的子代理会话」；agent.status === "idle"；
// durable inbox 无 pending；无任何活的子代 agent；没有 UI follow 流（按 follow 的 session 归属；
// 无法归属的 follower 视为「有人在看」一律不卸）；session-controller 没有在途 resume/claim；
// subagents manager 没有在途 child 操作；距最后一次 session/event、agent/status、工具调用 ≥
// 空闲阈值。子代理来源会话按 activation 归属判定：id 仍在 manager 的 resident 里才不碰
// （subagent-resident）；已经 settle（resident 在 dsh-subagent/lib/index.js:2034 删除）的会话
// 与普通会话走同一套判据。resident 探针拿不到时退回旧行为（子代理会话一律不卸）并保守记
// subagent-probe-unavailable；follower 证据找不到时同样保守不卸（记 skip，5 分钟限流一次）。
//
// 释放后 session-controller 的 resolve() 首行 liveAgent() 会落空（dsh-api-session-controller/
// lib/index.js:218-240），下一次访问自然重新 promote → 再次被本插件捕获。dispose 会 stop loop、
// await idle、卸 scope、关持久化 handle、最后 detachAgent/detachSession（agent-loop:1740-1810），
// 因而 SessionStore（dsh-session/lib/index.js:1886-1893）与 AgentRegistry（dsh-agent:544）的条目
// 一起消失。残留引用只剩有界缓存：session-query 冷观察缓存 ≤5（dsh-session-query/lib/index.js:
// 327-341）、persistence coldLogMemo ≤2（dsh-session-persistence-jsonl:2881-2888）；本插件对
// 前者做一次 refs===0 的定点清退，对后者按 session id 删一条可重建缓存。
//
// 开关与阈值（CASEOS_* 惯例）：CASEOS_EVICT=0 全关（不包装、不装定时器、不落事件）；
// CASEOS_EVICT_SCAN_MS 默认 60000；CASEOS_EVICT_IDLE_MS 默认 600000；
// 堆压力（heapUsed ≥ V8 顶棚 × 50%）时门槛降到 2 分钟并按 lastActive 的 LRU 顺序卸。
// 卸载失败 30 分钟内不再尝试该会话。monitor：mem-guard-evict（session、idleMs、
// heapUsedBefore、pressure、observationEvicted）/ mem-guard-evict-fail（error 截 200）/
// mem-guard-evict-boot / mem-guard-evict-skip（reason：follower-unknown、scan-failed）。
import { homedir } from "node:os";
import { monitorEvent } from "./monitor-log.js";
import { heapLimitBytes } from "./memory-guard.js";

const EVICT_ENV = "CASEOS_EVICT";
const SCAN_MS_ENV = "CASEOS_EVICT_SCAN_MS";
const IDLE_MS_ENV = "CASEOS_EVICT_IDLE_MS";
const DEFAULT_SCAN_MS = 60 * 1000;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const PRESSURE_IDLE_MS = 2 * 60 * 1000;
const PRESSURE_RATIO = 0.5;
const FAIL_BACKOFF_MS = 30 * 60 * 1000;
const SKIP_LOG_MS = 5 * 60 * 1000;
const DISPOSE_TIMEOUT_MS = 60 * 1000;
const ERROR_LIMIT = 200;
const UNTRACKED_LIMIT = 10;
// 原型补丁用全局 symbol 标记：插件重载时能从旧包装里取出 original，避免把包装套在包装上。
const RESUME_PATCH = Symbol.for("caseos.session-evictor.resume");
const FOLLOW_PATCH = Symbol.for("caseos.session-evictor.follow");

function envMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorText(error) {
  return String(error?.message ?? error).slice(0, ERROR_LIMIT);
}

// dispose 自身也可能卡住（宿主 teardown 等 scope/persistence close）。超时不是「没卸」：
// 报 fail 并退避，底层 dispose 继续跑，真卸掉时会由 agent/disposed 清条目。
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    if (typeof timer?.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// follow 是 AsyncGenerator 方法。包一层只为拿到「哪个 session 正在被看」的归属，不改变
// 迭代/return/throw 语义；signal abort 也释放，避免取消后计数悬空。
function makeFollowWrapper(original, active) {
  const release = (sessionId) => {
    const left = (active.get(sessionId) ?? 1) - 1;
    if (left > 0) active.set(sessionId, left);
    else active.delete(sessionId);
  };
  const wrapped = function followTracked(request, signal) {
    const address = request?.address;
    const sessionId = address?.kind === "session" ? address.sessionId : address?.childSessionId;
    const tracked = typeof sessionId === "string" && sessionId !== "";
    const inner = original.apply(this, arguments);
    if (inner === null || typeof inner !== "object" || typeof inner.next !== "function") return inner;
    return (async function* () {
      // 与宿主的 closeFollowers.add 同步：生成器体开始执行时才登记，避免「调用但从未迭代」
      // 的流把某个会话永久锁在不可卸载状态。
      if (tracked) active.set(sessionId, (active.get(sessionId) ?? 0) + 1);
      let released = false;
      const releaseOnce = () => {
        if (released || !tracked) return;
        released = true;
        release(sessionId);
      };
      if (typeof signal?.addEventListener === "function") signal.addEventListener("abort", releaseOnce, { once: true });
      try {
        yield* inner;
      } finally {
        releaseOnce();
        if (typeof signal?.removeEventListener === "function") signal.removeEventListener("abort", releaseOnce);
      }
    })();
  };
  wrapped[FOLLOW_PATCH] = { original, active };
  return wrapped;
}

// 包装后的 resume 原样返回宿主 handle，只旁路记录；任何记录失败都不能影响 promote 本身。
function installResumePatch(agents, track) {
  const proto = Object.getPrototypeOf(agents);
  if (typeof proto?.resume !== "function") return void 0;
  const current = proto.resume;
  const original = current[RESUME_PATCH]?.original ?? current;
  const wrapped = function resumeTracked(...args) {
    const result = original.apply(this, args);
    if (result === null || typeof result?.then !== "function") return result;
    return result.then((handle) => {
      track(handle, args[0]);
      return handle;
    });
  };
  wrapped[RESUME_PATCH] = { original };
  proto.resume = wrapped;
  return { proto, original, wrapped };
}

// 纯判据：返回阻塞原因列表，[] 才允许卸载。测试直接喂替身对象核对。
export function evictionBlockers(entry, context) {
  const {
    now,
    threshold,
    agents,
    sessions,
    followerBlocks,
    descendantLive,
    claimInFlight,
    subagentResident,
    subagentOperationInFlight,
  } = context;
  if (entry === void 0 || entry.agent === void 0) return ["no-entry"];
  const blockers = [];
  if (entry.subagent === true) {
    const resident = subagentResident();
    if (resident === void 0) blockers.push("subagent-probe-unavailable");
    else if (resident.has(entry.sessionId)) blockers.push("subagent-resident");
    else if (subagentOperationInFlight(entry.sessionId)) blockers.push("subagent-operation-in-flight");
  }
  if (now - entry.lastActive < threshold) blockers.push("recent-activity");
  if ((entry.blockedUntil ?? 0) > now) blockers.push("backoff");
  if (agents.get(entry.sessionId) !== entry.agent) blockers.push("agent-not-live");
  if (sessions.get(entry.sessionId) !== entry.agent.session) blockers.push("session-not-attached");
  if (entry.agent.status !== "idle") blockers.push("running");
  try {
    if (entry.agent.inbox?.hasPending !== false) blockers.push("pending-inbox");
  } catch {
    blockers.push("pending-inbox");
  }
  if (descendantLive(entry.sessionId)) blockers.push("live-descendant");
  if (claimInFlight(entry.sessionId)) blockers.push("operation-in-flight");
  if (followerBlocks(entry.sessionId)) blockers.push("followed");
  return blockers;
}

export default {
  name: "caseos-session-evictor",
  // 只依赖 agents/sessions 两个宿主服务；sessionController、sessionQuery、subagents 都按需惰性取，
  // 缺任何一个都不该让卸载器整个不激活。
  inject: ["agents", "sessions"],
  apply(ctx) {
    if (process.env[EVICT_ENV] === "0") return;

    let profileHome;
    try {
      profileHome = ctx.get?.("profileContext")?.home;
    } catch {
      profileHome = void 0;
    }
    const dshHome = profileHome ?? process.env.DSH_HOME ?? `${homedir()}/.dsh`;
    const scanMs = envMs(SCAN_MS_ENV, DEFAULT_SCAN_MS);
    const idleMs = envMs(IDLE_MS_ENV, DEFAULT_IDLE_MS);
    const limit = heapLimitBytes();
    const root = ctx.root ?? ctx;

    const service = (name) => {
      try {
        const value = root.get?.(name);
        if (value !== void 0) return value;
      } catch {}
      try {
        return root[name];
      } catch {
        return void 0;
      }
    };

    // resident 在 manager 上（service 暴露的是 `subagents.manager`，dsh-subagent/lib/index.js:
    // 2984、:2996-3003），不是 service 顶层字段。它是 live activation 的唯一权威集合
    // （:1220-1223、:1850 插入、:2034 自然 settle 删除）。拿不到 Map 时返回 undefined，判据退回旧行为。
    const subagentManager = () => service("subagents")?.manager;
    const subagentResident = () => {
      const resident = subagentManager()?.resident;
      return resident instanceof Map || resident instanceof Set ? resident : void 0;
    };
    // 续接/投递在 resident 插入之前要跑 observe + resume：manager 的 ChildLock 用 tails 记录
    // 在途 child（dsh-subagent/lib/index.js:1121-1140、:2090-2095），命中就说明有人正在操作它。
    const subagentOperationInFlight = (sessionId) => {
      const tails = subagentManager()?.locks?.tails;
      return tails instanceof Map && tails.has(sessionId);
    };

    const agents = ctx.agents;
    const sessions = ctx.sessions;
    // sessionId → { handle, agent, lastActive, subagent, blockedUntil }
    const entries = new Map();
    const activeFollowers = new Map();
    let resumePatch;
    let followPatch;
    let followerKnown = false;
    let scanning = false;
    // 卸载后若别的插件又把 resume 包在我们外层，原型恢复不回去；trackingEnabled 让残留
    // 包装变成 no-op，避免往已清空的 entries 里继续塞 handle。
    let trackingEnabled = true;
    let lastSkipAt = 0;
    let lastSkipReason = "";

    const reportSkip = (reason, extra) => {
      const now = Date.now();
      if (reason === lastSkipReason && now - lastSkipAt < SKIP_LOG_MS) return;
      lastSkipAt = now;
      lastSkipReason = reason;
      monitorEvent(dshHome, { kind: "mem-guard-evict-skip", reason, ...extra });
    };

    const liveAgents = () => {
      try {
        return agents?.list?.() ?? [];
      } catch {
        return [];
      }
    };

    const touch = (sessionId, now = Date.now()) => {
      const entry = entries.get(sessionId);
      if (entry !== void 0) entry.lastActive = now;
    };

    const removeEntry = (entry) => {
      if (entries.get(entry.sessionId) === entry) entries.delete(entry.sessionId);
    };

    const track = (handle, options) => {
      if (!trackingEnabled) return;
      try {
        const agent = handle?.agent;
        if (agent === void 0) return;
        const sessionId = agent.id ?? options?.resumeSessionId;
        if (typeof sessionId !== "string" || sessionId === "") return;
        if (agent.session?.header?.id !== sessionId) return;
        if (entries.has(sessionId)) return;
        entries.set(sessionId, {
          sessionId,
          handle,
          agent,
          lastActive: Date.now(),
          subagent: agent.session?.header?.origin === "subagent",
          blockedUntil: 0,
        });
      } catch {
        // 记录失败不影响 resume 的返回值；该会话退化为「未跟踪」，后续 promote 仍会被包装捕获。
      }
    };

    // follower 归属：session-controller 的 closeFollowers 只有全局 Set，不能直接按会话归属；
    // 在 history.follow 上做一次可逆包装，拿到 sessionId → 活跃 follow 数。若包装不可用，
    // 只要 closeFollowers.size > 0 就保守视为「所有会话都有人在看」。
    const ensureFollowerProbe = () => {
      const history = service("sessionController")?.history;
      if (history === void 0 || typeof history.follow !== "function") {
        followerKnown = typeof history?.closeFollowers?.size === "number";
        return;
      }
      const marker = history.follow[FOLLOW_PATCH];
      if (marker?.active === activeFollowers) {
        followerKnown = true;
        return;
      }
      try {
        const original = marker?.original ?? history.follow;
        const wrapped = makeFollowWrapper(original, activeFollowers);
        history.follow = wrapped;
        followPatch = { history, wrapped, original };
        followerKnown = true;
      } catch {
        followerKnown = typeof history.closeFollowers?.size === "number";
      }
    };

    const followerBlocks = (sessionId) => {
      ensureFollowerProbe();
      if (!followerKnown) return true;
      if ((activeFollowers.get(sessionId) ?? 0) > 0) return true;
      const history = service("sessionController")?.history;
      const total = history?.closeFollowers?.size;
      if (typeof total !== "number") return false;
      let tracked = 0;
      for (const count of activeFollowers.values()) tracked += count;
      // 包装安装前就存在的 follow 没有归属：只要总数多于已归属数，就对所有会话保守不卸。
      return total > tracked;
    };

    // 任何活子代（含 idle 常驻）都算「有活」：父 agent 的 dispose 会连带拆子激活，
    // 让 memory-guard 的 drainChildren 先按宿主自己的顺序释放，卸载器只碰叶子会话。
    // 每次扫描只建一次索引，避免候选多时反复 list()/建 Map。
    const makeDescendantCheck = (live) => {
      const byParent = new Map();
      for (const agent of live) {
        const parent = agent?.session?.header?.parentSession;
        if (typeof parent !== "string") continue;
        const children = byParent.get(parent) ?? [];
        children.push(agent);
        byParent.set(parent, children);
      }
      const resident = subagentResident();
      return (sessionId) => {
        if ((byParent.get(sessionId) ?? []).some((child) => child?.id !== void 0)) return true;
        if (resident instanceof Map) {
          for (const activation of resident.values()) {
            if (activation?.parent?.id === sessionId) return true;
          }
        }
        return false;
      };
    };

    const claimInFlight = (sessionId) => {
      const controller = service("sessionController")?.agents;
      for (const map of [controller?.resumes, controller?.claims]) {
        if (map instanceof Map && map.has(sessionId)) return true;
      }
      return false;
    };

    // 冷观察缓存把整份事件数组按会话缓存到 5 条；dispose 后若不点名清退，内存仍留一份。
    // 只在没有活跃 lease（refs > 0）时删；缓存 miss 只会让下一次冷读重新加载。
    const purgePreparedObservation = (sessionId) => {
      try {
        const cache = service("sessionQuery")?._observations?.cache;
        if (!(cache instanceof Map)) return false;
        const entry = cache.get(sessionId);
        if (entry === void 0 || (entry.refs ?? 0) > 0) return false;
        cache.delete(sessionId);
        return true;
      } catch {
        return false;
      }
    };

    // persistence 的 coldLogMemo 是上限 2 的解码结果 LRU，没有公开清退 API；按会话 id 点名
    // 删一条只是丢掉可重建的缓存，正在读的调用方仍持有自己的引用。
    const purgeColdLogMemo = (sessionId) => {
      try {
        const memo = service("sessionPersistence")?.coldLogMemo;
        return memo instanceof Map ? memo.delete(sessionId) : false;
      } catch {
        return false;
      }
    };

    const scan = async () => {
      if (scanning) return;
      scanning = true;
      try {
        const now = Date.now();
        const heapUsed = process.memoryUsage().heapUsed;
        const pressure = heapUsed >= Math.floor(limit * PRESSURE_RATIO);
        const threshold = pressure ? Math.min(idleMs, PRESSURE_IDLE_MS) : idleMs;
        if (!followerKnown) {
          ensureFollowerProbe();
          if (!followerKnown) reportSkip("follower-unknown", { heapUsed });
        }
        const live = liveAgents();
        const context = {
          now,
          threshold,
          agents,
          sessions,
          followerBlocks,
          descendantLive: makeDescendantCheck(live),
          claimInFlight,
          subagentResident,
          subagentOperationInFlight,
        };
        const candidates = [];
        for (const entry of entries.values()) {
          if (evictionBlockers(entry, context).length === 0) candidates.push(entry);
        }
        // 堆压力下按 LRU 先卸；非压力时同样从最久未活动的开始，避免先动刚用过的会话。
        candidates.sort((left, right) => left.lastActive - right.lastActive);
        for (const entry of candidates) {
          // 候选确定到真正 dispose 之间可能来输入/follow/claim/子代理：调用前用最新状态再核一次。
          const fresh = {
            ...context,
            now: Date.now(),
            descendantLive: makeDescendantCheck(liveAgents()),
          };
          if (evictionBlockers(entry, fresh).length > 0) continue;
          const idle = Date.now() - entry.lastActive;
          const before = process.memoryUsage().heapUsed;
          try {
            await withTimeout(Promise.resolve(entry.handle.dispose()), DISPOSE_TIMEOUT_MS, "session dispose");
            if (agents.get(entry.sessionId) !== void 0) {
              throw new Error("agent is still registered after dispose resolved");
            }
            const observationEvicted = purgePreparedObservation(entry.sessionId);
            const coldLogEvicted = purgeColdLogMemo(entry.sessionId);
            removeEntry(entry);
            monitorEvent(dshHome, {
              kind: "mem-guard-evict",
              session: entry.sessionId,
              idleMs: idle,
              heapUsedBefore: before,
              heapUsedAfter: process.memoryUsage().heapUsed,
              pressure,
              observationEvicted,
              coldLogEvicted,
            });
          } catch (error) {
            entry.blockedUntil = Date.now() + FAIL_BACKOFF_MS;
            monitorEvent(dshHome, {
              kind: "mem-guard-evict-fail",
              session: entry.sessionId,
              idleMs: idle,
              heapUsedBefore: before,
              error: errorText(error),
              retryAfterMs: FAIL_BACKOFF_MS,
            });
          }
        }
      } catch (error) {
        reportSkip("scan-failed", { error: errorText(error) });
      } finally {
        scanning = false;
      }
    };

    resumePatch = installResumePatch(agents, track);
    ensureFollowerProbe();

    const live = liveAgents();
    const untracked = live.filter((agent) => agent?.id !== void 0 && !entries.has(agent.id)).map((agent) => agent.id);
    monitorEvent(dshHome, {
      kind: "mem-guard-evict-boot",
      scanMs,
      idleMs,
      pressureIdleMs: PRESSURE_IDLE_MS,
      pressureRatio: PRESSURE_RATIO,
      heapLimitBytes: limit,
      tracked: entries.size,
      untrackedTotal: untracked.length,
      untracked: untracked.slice(0, UNTRACKED_LIMIT),
      followerProbe: followerKnown ? "session-controller" : "unavailable",
      resumePatched: resumePatch !== void 0,
      subagentProbe: subagentResident() !== void 0,
    });

    // 活动面：任何会话事件/状态/工具调用都刷新 lastActive；agent 消失时清条目，避免本插件自己泄漏。
    ctx.on("session/event", (session) => touch(session?.id));
    ctx.on("agent/status", ({ agent }) => touch(agent?.id));
    ctx.on("agent/disposed", ({ agent }) => {
      const entry = entries.get(agent?.id);
      if (entry !== void 0 && entry.agent === agent) entries.delete(entry.sessionId);
    });
    ctx.on("tools/pre-execute", (exec, next) => {
      touch(exec?.agent?.session?.header?.id ?? exec?.agent?.id);
      return typeof next === "function" ? next() : void 0;
    });
    ctx.on("tools/post-execute", (exec, _result, next) => {
      touch(exec?.agent?.session?.header?.id ?? exec?.agent?.id);
      return typeof next === "function" ? next() : void 0;
    });

    const timer = setInterval(scan, scanMs);
    if (typeof timer?.unref === "function") timer.unref();

    ctx.effect(() => () => {
      trackingEnabled = false;
      clearInterval(timer);
      if (resumePatch !== void 0 && resumePatch.proto.resume === resumePatch.wrapped) {
        resumePatch.proto.resume = resumePatch.original;
      }
      if (followPatch !== void 0 && followPatch.history.follow === followPatch.wrapped) {
        followPatch.history.follow = followPatch.original;
      }
      activeFollowers.clear();
      entries.clear();
    }, "caseos-session-evictor: interval + prototype patches");
  },
};
