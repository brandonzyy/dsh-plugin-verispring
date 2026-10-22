// 主会话决定的子代理释放器（session-evictor）。
//
// 病因（rc.2 实测源码）：session-controller 的 promote 链
//   follow() 收到冷快照 → source.retain() → this.promote()（dsh-api-session-controller/lib/index.js:1586-1594）
//   → resolveObservedAgent()（:3006-3017）→ resumeObserved() 里的
//     `(await this.ctx.agents.resume({...})).agent`（:396-403），把 resume 返回的
//   `{ agent, dispose }` 里的 dispose 丢掉（dsh-agent-loop/lib/index.js:1795-1806）。
// AgentRegistry.resume 的 owner 是长期存活的控制器作用域（dsh-agent/lib/index.js:466-470），
// 于是每次 promote 都把整份 Session.log 挂到进程生命周期，直到 OOM。
//
// 决定权模型（本版起）：没有任何自动卸载。主会话自身永不被自动卸载；子代理是否卸载由主会话
// 通过 `release_subagent` 工具按需决定（权限与任务都在主会话）。resume 包装保留——它捕获的
// handle 正是释放冷续接过的子代理所需的；定时扫描只做遥测，不 dispose 任何会话。
//
// 包装生效面：cordis 的 context 是 proxy，`ctx.agents` 每次读取都经 getTraceable 返回
// traceable proxy（cordis/lib/index.js:675、:686、:763-764）；该 proxy 的 get 陷阱在每次方法
// 访问时重新沿原型链查 `resume`（:84-157），所以改 `AgentRegistry.prototype.resume` 对
// session-controller 的 `this.ctx.agents.resume` 必然生效（rc.2 的 resume 是类方法，在原型上：
// dsh-agent/lib/index.js:466）。反过来，插件拿不到 raw registry 实例（`ctx.get("agents")` 同样被
// getTraceable 包过），改实例不可行。
//
// 释放路径（宿主语义，rc.2 已查实）：目标仍在 `subagents.manager.resident` → 走
// `subagents.drainChildren(parent, [id])`（manager 要求 exact live parent；调用方是祖父时用该
// activation 自己的直接父 Agent，它必须仍在 agents 注册表里）；否则用本插件捕获的 handle
// `dispose()`；两者都没有 → not-loaded（本就不在内存，成功无操作）。drainChildren 见
// dsh-subagent/lib/index.js:1372（EXACT live parent + direct child 校验），drainDescendants
// 见 :1334（按 root 批量释放全部后代，不能只挑一个孙代，故这里不用它）。
//
// 释放后 SessionStore（dsh-session/lib/index.js:1886-1893）与 AgentRegistry（dsh-agent:544）
// 的条目一起消失；残留引用只剩有界缓存：session-query 冷观察缓存 ≤5
// （dsh-session-query/lib/index.js:327-341）、persistence coldLogMemo ≤2
// （dsh-session-persistence-jsonl:2881-2888）；本插件对前者做一次 refs===0 的定点清退，对后者
// 按 session id 删一条可重建缓存。之后对该子代理 send_message 会走 manager 的
// coldResume → materialize → agents.resume 重建，并被本包装再次捕获。
//
// 开关与遥测：CASEOS_EVICT=0 全关（不包装、不装定时器、不注册工具、不落事件）；
// CASEOS_EVICT_SCAN_MS 默认 60000（只决定遥测扫描间隔，不触发释放）。
// monitor：mem-guard-release（caller、child、mode=drain|dispose|noop|refused、reason、
// heapUsedBefore/After、observationEvicted/coldLogEvicted）/ mem-guard-release-hint（由
// memory-guard 落：软阈值后给主会话的非阻断提示）/ mem-guard-evict-boot（apply 时刻快照）/
// mem-guard-evict-tool（工具注册终态：registered、via=root|inject、elapsedMs）/ mem-guard-evict-follow
// （follow 包装装上时一条：source=apply|inject|scan|release、preexistingFollowers、elapsedMs）/
// mem-guard-evict-scan（每 5 分钟一条汇总：tracked、candidates、resident、followerTotal、
// followerTracked、followerUntracked、followerProbe、subagentProbe、heapUsed）/
// mem-guard-evict-skip（reason：scan-failed）。
import { homedir } from "node:os";
import { monitorEvent } from "./monitor-log.js";
import { registerSurfaceTool } from "./tool-surface.js";

const EVICT_ENV = "CASEOS_EVICT";
const SCAN_MS_ENV = "CASEOS_EVICT_SCAN_MS";
const TOOL_NAME = "release_subagent";
const DEFAULT_SCAN_MS = 60 * 1000;
const SKIP_LOG_MS = 5 * 60 * 1000;
const SUMMARY_MS = 5 * 60 * 1000;
const DISPOSE_TIMEOUT_MS = 60 * 1000;
const ERROR_LIMIT = 200;
const UNTRACKED_LIMIT = 10;
const LINEAGE_LIMIT = 512;
// 内存外祖先链的查找上限：每层只读一次会话首行，损坏/成环的链不会触发无界磁盘查找。
const LINEAGE_LOOKUP_LIMIT = 32;
// 单次持久化头读取的上限：超时 abort 宿主的首行/首帧读循环（persistence.stat 的 signal）。
const STORED_HEADER_TIMEOUT_MS = 5000;
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
// 报失败让主会话重试，底层 dispose 继续跑，真卸掉时由 agent/disposed 清条目。
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
      // 的流把某个会话永久锁在不可释放状态。
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

// 纯判据：返回阻塞原因列表，[] 才允许释放。测试直接喂替身对象核对。
// 只判断「这一刻是否安全」，不看空闲时长与堆压力——那两样不再触发任何动作。
export function releaseBlockers(target, context) {
  if (target === void 0) return ["no-target"];
  const { followerBlocks, descendantLive, claimInFlight, subagentOperationInFlight } = context;
  const blockers = [];
  const agent = target.agent;
  if (agent !== void 0) {
    // 宿主只有 idle/running 两态；非 idle 一律按「还没结束」保守拒绝。
    if (agent.status !== "idle") blockers.push("running");
    let pending = true;
    try {
      pending = agent.inbox?.hasPending !== false;
    } catch {
      pending = true;
    }
    if (pending) blockers.push("pending-inbox");
  }
  if (claimInFlight?.(target.sessionId) === true) blockers.push("operation-in-flight");
  if (subagentOperationInFlight?.(target.sessionId) === true) blockers.push("subagent-operation-in-flight");
  if (descendantLive?.(target.sessionId) === true) blockers.push("live-descendant");
  // followerBlocks 返回具体原因串（followed / follower-untracked），替身返回布尔时按 followed 记。
  const follower = followerBlocks?.(target.sessionId);
  if (follower) blockers.push(typeof follower === "string" ? follower : "followed");
  return blockers;
}

// 沿 parentSession 链判断 id 是否是 ancestorId 的后代。parentOf 由调用方提供（活会话头优先，
// 已释放/未加载的会话退回本插件记住的 lineage）。环路按 visited 截断，不信任损坏的日志。
export function descendsFrom(id, ancestorId, parentOf) {
  const visited = new Set();
  let current = id;
  while (typeof current === "string" && current !== "") {
    if (current === ancestorId) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = typeof parentOf === "function" ? parentOf(current) : void 0;
  }
  return false;
}

export default {
  name: "caseos-session-evictor",
  // 只硬依赖 agents/sessions；sessionController、sessionQuery、subagents、tools 都按需惰性取，
  // 缺任何一个都不该让释放器整个不激活。
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
    // 2984、:2996-3003），是 live activation 的唯一权威集合。拿不到 Map 时返回 undefined。
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
    // sessionId → { handle, agent, subagent }：resume 包装捕获的释放句柄。
    const entries = new Map();
    // 子会话 id → 直接父会话 id：本进程见过的血缘。活会话优先读 header；内存里没有的目标先查
    // 这份记忆，再只读持久化头。从持久化头查到的关系回填这里，重复调用不再读盘。
    const knownParents = new Map();
    const activeFollowers = new Map();
    let resumePatch;
    let followPatch;
    let followerKnown = false;
    let scanning = false;
    let trackingEnabled = true;
    let lastSkipAt = 0;
    let lastSkipReason = "";
    let lastSummaryAt = 0;
    let followerInstalledAt = 0;
    let releaseTool;
    let releaseToolRegistered = false;
    let disposed = false;
    const bootAt = Date.now();

    const reportSkip = (reason, extra) => {
      const now = Date.now();
      if (reason === lastSkipReason && now - lastSkipAt < SKIP_LOG_MS) return;
      lastSkipAt = now;
      lastSkipReason = reason;
      monitorEvent(dshHome, { kind: "mem-guard-evict-skip", reason, ...extra });
    };

    const heapUsed = () => {
      try {
        return process.memoryUsage().heapUsed;
      } catch {
        return 0;
      }
    };

    const liveAgents = () => {
      try {
        return agents?.list?.() ?? [];
      } catch {
        return [];
      }
    };

    const rememberParent = (childId, parentId) => {
      if (typeof childId !== "string" || childId === "") return;
      if (typeof parentId !== "string" || parentId === "" || parentId === childId) return;
      knownParents.delete(childId);
      knownParents.set(childId, parentId);
      while (knownParents.size > LINEAGE_LIMIT) knownParents.delete(knownParents.keys().next().value);
    };

    const headerOf = (sessionId) => {
      const agent = agents?.get?.(sessionId);
      if (agent?.session?.header !== void 0) return agent.session.header;
      try {
        return sessions?.get?.(sessionId)?.header;
      } catch {
        return void 0;
      }
    };

    const parentOf = (sessionId) => {
      const header = headerOf(sessionId);
      const parent = header?.parentSession;
      if (typeof parent === "string") {
        rememberParent(sessionId, parent);
        return parent;
      }
      return knownParents.get(sessionId);
    };

    // 内存外的授权事实来自持久化会话头。rc.2 的 persistence.stat(id) 只读首行（zstd 时只解第一
    // 个帧，均按 8KB 块读：dsh-session-persistence-jsonl/lib/index.js:2570-2601、:3352-3403），
    // 不解析事件日志、不 promote、不走 observeSession——会话动辄几十 MB 时这是唯一可用的轻量入口。
    const storedHeader = async (sessionId) => {
      const backend = service("sessionPersistence");
      if (typeof backend?.stat !== "function") return { status: "unavailable" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), STORED_HEADER_TIMEOUT_MS);
      if (typeof timer?.unref === "function") timer.unref();
      try {
        const stored = await backend.stat(sessionId, { signal: controller.signal });
        if (stored?.header === void 0) return { status: "missing" };
        return { status: "found", header: stored.header };
      } catch (error) {
        return { status: "failed", error };
      } finally {
        clearTimeout(timer);
      }
    };

    // 直接父：活头 → 本进程记忆 → 持久化头。持久化头只在被问到的 id 上读一次首行。
    const resolveParent = async (sessionId) => {
      const live = headerOf(sessionId);
      if (live !== void 0) {
        const parent = live.parentSession ?? knownParents.get(sessionId);
        if (typeof parent === "string") rememberParent(sessionId, parent);
        return { parent, source: "live" };
      }
      if (knownParents.has(sessionId)) {
        return { parent: knownParents.get(sessionId), source: "memory" };
      }
      const stored = await storedHeader(sessionId);
      if (stored.status === "found") {
        const parent = stored.header.parentSession;
        if (typeof parent === "string") rememberParent(sessionId, parent);
        return { parent, source: "stored" };
      }
      return { parent: void 0, source: stored.status };
    };

    // 目标身份：活头优先，其次本进程记忆的 lineage，最后才为这一个 id 读持久化头。
    const resolveTarget = async (childId) => {
      const live = headerOf(childId);
      if (live !== void 0) {
        const parent = live.parentSession ?? knownParents.get(childId);
        if (typeof parent === "string") rememberParent(childId, parent);
        return { status: "found", source: "live", header: live, parent };
      }
      if (knownParents.has(childId)) {
        return { status: "found", source: "memory", header: void 0, parent: knownParents.get(childId) };
      }
      const stored = await storedHeader(childId);
      if (stored.status === "found") {
        const parent = stored.header.parentSession;
        if (typeof parent === "string") rememberParent(childId, parent);
        return { status: "found", source: "stored", header: stored.header, parent };
      }
      if (stored.status === "failed") return { status: "unreadable", error: stored.error };
      return { status: "unknown" };
    };

    // 沿 parentSession 链判断后代；内存外的每一层按需读持久化头，层数有上限。
    const descendsFromStored = async (id, ancestorId) => {
      const visited = new Set();
      let current = id;
      let lookups = 0;
      while (typeof current === "string" && current !== "") {
        if (current === ancestorId) return "descendant";
        if (visited.has(current)) return "not-descendant";
        visited.add(current);
        lookups += 1;
        if (lookups > LINEAGE_LOOKUP_LIMIT) return "not-descendant";
        const { parent, source } = await resolveParent(current);
        if (source === "failed") return "header-unreadable";
        if (typeof parent !== "string") return "not-descendant";
        current = parent;
      }
      return "not-descendant";
    };

    const removeEntry = (sessionId) => entries.delete(sessionId);

    const track = (handle, options) => {
      if (!trackingEnabled) return;
      try {
        const agent = handle?.agent;
        if (agent === void 0) return;
        const sessionId = agent.id ?? options?.resumeSessionId;
        if (typeof sessionId !== "string" || sessionId === "") return;
        const header = agent.session?.header;
        if (header?.id !== sessionId) return;
        if (typeof header?.parentSession === "string") rememberParent(sessionId, header.parentSession);
        if (entries.has(sessionId)) return;
        entries.set(sessionId, {
          sessionId,
          handle,
          agent,
          subagent: header?.origin === "subagent",
        });
      } catch {
        // 记录失败不影响 resume 的返回值；该会话退化为「未捕获」，release_subagent 会报 not-loaded。
      }
    };

    // follower 归属：session-controller 的 closeFollowers 只有全局 Set，不能直接按会话归属；
    // 在 history.follow 上做一次可逆包装，拿到 sessionId → 活跃 follow 数。若包装不可用，
    // 只要 closeFollowers.size > 0 就保守视为「所有会话都有人在看」。
    //
    // 安装时机就是判据本身：包装必须早于界面第一条 follow。apply 时先试装（history 可能已 provide），
    // 没装上就交给 ctx.inject(["sessionController"], …) 在服务 provide 的同一刻补装；只有宿主没有
    // inject 时才退化到首次扫描。closeFollowers 的元素是裸闭包，安装前已存在的流无法归属。
    const installFollowerProbe = (source) => {
      if (disposed) return false;
      const history = service("sessionController")?.history;
      if (history === void 0 || typeof history.follow !== "function") {
        followerKnown = typeof history?.closeFollowers?.size === "number";
        return false;
      }
      const marker = history.follow[FOLLOW_PATCH];
      if (marker?.active === activeFollowers) {
        followerKnown = true;
        return true;
      }
      try {
        const original = marker?.original ?? history.follow;
        const wrapped = makeFollowWrapper(original, activeFollowers);
        history.follow = wrapped;
        followPatch = { history, wrapped, original };
        followerKnown = true;
        if (followerInstalledAt === 0) {
          followerInstalledAt = Date.now();
          const preexisting = typeof history.closeFollowers?.size === "number" ? history.closeFollowers.size : -1;
          monitorEvent(dshHome, {
            kind: "mem-guard-evict-follow",
            source,
            preexistingFollowers: preexisting,
            elapsedMs: followerInstalledAt - bootAt,
          });
        }
        return true;
      } catch {
        followerKnown = typeof history?.closeFollowers?.size === "number";
        return false;
      }
    };

    const followerBlocks = (sessionId, source = "scan") => {
      installFollowerProbe(source);
      if (!followerKnown) return true;
      if ((activeFollowers.get(sessionId) ?? 0) > 0) return "followed";
      const history = service("sessionController")?.history;
      const total = history?.closeFollowers?.size;
      if (typeof total !== "number") return false;
      let tracked = 0;
      for (const count of activeFollowers.values()) tracked += count;
      // 安装前就存在的 follow 没有归属（元素是裸闭包，取不到 sessionId/address）：只要总数多于
      // 已归属数，就对所有会话保守拒绝；它们关掉之后总数回落，释放自动恢复。
      return total > tracked ? "follower-untracked" : false;
    };

    // 任何活子代（含 idle 常驻）都算「有活」：逐个释放时才不会拆掉还在用的子树。
    // 每次调用只建一次索引，避免候选多时反复 list()/建 Map。
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

    // 冷观察缓存把整份事件数组按会话缓存到 5 条；释放后若不点名清退，内存仍留一份。
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

    const emitRelease = (callerId, childId, mode, reason, before, extra) => {
      const after = heapUsed();
      const trimmed = reason === void 0 ? void 0 : String(reason).slice(0, ERROR_LIMIT);
      monitorEvent(dshHome, {
        kind: "mem-guard-release",
        caller: callerId,
        child: childId,
        mode,
        ...(trimmed === void 0 ? {} : { reason: trimmed }),
        heapUsedBefore: before,
        heapUsedAfter: after,
        ...extra,
      });
      return {
        id: childId,
        result: mode === "refused" ? "refused" : mode === "noop" ? "not-loaded" : "released",
        mode,
        ...(trimmed === void 0 ? {} : { reason: trimmed }),
        heapUsedBefore: before,
        heapUsedAfter: after,
      };
    };

    // 释放单个 id。安全判据全部通过才动手；任一不满足就拒绝并说明原因。
    const releaseOne = async (caller, callerId, childId) => {
      const before = heapUsed();
      const refuse = (reason) => emitRelease(callerId, childId, "refused", reason, before);
      if (childId === callerId) return refuse("main-session");
      // 重启后子代理不在 agents/sessions 里，父子关系只能来自持久化会话头；只查被点名的 id。
      const target = await resolveTarget(childId);
      if (target.status === "unknown") return refuse("unknown-session");
      if (target.status === "unreadable") return refuse("header-unreadable");
      if (target.header !== void 0 && target.header.origin !== "subagent") return refuse("main-session");
      if (typeof target.parent !== "string") return refuse("not-descendant");
      const lineage = await descendsFromStored(childId, callerId);
      if (lineage === "header-unreadable") return refuse("header-unreadable");
      if (lineage !== "descendant") return refuse("not-descendant");

      const agent = agents?.get?.(childId);
      const resident = subagentResident();
      const entry = entries.get(childId);
      // 不在内存就是成功无操作：没有可释放的对象，运行中/follow 等安全判据不适用。
      if (agent === void 0 && resident?.has?.(childId) !== true && entry?.handle === void 0) {
        return emitRelease(callerId, childId, "noop", void 0, before);
      }

      const blockers = releaseBlockers(
        { sessionId: childId, agent },
        {
          followerBlocks: (sessionId) => followerBlocks(sessionId, "release"),
          descendantLive: makeDescendantCheck(liveAgents()),
          claimInFlight,
          subagentOperationInFlight,
        },
      );
      if (blockers.length > 0) return refuse(blockers.join(","));

      if (resident?.has?.(childId) === true) {
        const activation = resident.get(childId);
        const directParent = activation?.parent;
        // 宿主的 drainChildren 要求 exact live parent（dsh-subagent/lib/index.js:1373-1378）。
        // 调用方是直接父时就是它；是祖父时用 activation 自己的直接父，且必须仍活着。
        if (directParent === void 0 || agents?.get?.(directParent.id) !== directParent) {
          return refuse("drain-parent-not-live");
        }
        if (directParent.id !== callerId && !descendsFrom(directParent.id, callerId, parentOf)) {
          return refuse("not-descendant");
        }
        const subagents = service("subagents");
        if (typeof subagents?.drainChildren !== "function") return refuse("subagents-unavailable");
        try {
          await withTimeout(Promise.resolve(subagents.drainChildren(directParent, [childId])), DISPOSE_TIMEOUT_MS, "subagent drain");
        } catch (error) {
          return refuse(`drain-failed: ${errorText(error)}`);
        }
        if (agents?.get?.(childId) !== void 0) return refuse("still-registered");
        removeEntry(childId);
        rememberParent(childId, directParent.id);
        return emitRelease(callerId, childId, "drain", void 0, before, {
          observationEvicted: purgePreparedObservation(childId),
          coldLogEvicted: purgeColdLogMemo(childId),
        });
      }

      if (entry?.handle === void 0 || typeof entry.handle.dispose !== "function") {
        // 还活着但本插件没有捕获到 handle（激活前就存在、或走了别的 resume 路径）：
        // 不能谎报 not-loaded——它在内存里，只是我们无法安全释放。
        if (agents?.get?.(childId) !== void 0) return refuse("not-captured");
        return emitRelease(callerId, childId, "noop", void 0, before);
      }
      try {
        await withTimeout(Promise.resolve(entry.handle.dispose()), DISPOSE_TIMEOUT_MS, "session dispose");
      } catch (error) {
        return refuse(`dispose-failed: ${errorText(error)}`);
      }
      if (agents?.get?.(childId) !== void 0) return refuse("still-registered");
      removeEntry(childId);
      return emitRelease(callerId, childId, "dispose", void 0, before, {
        observationEvicted: purgePreparedObservation(childId),
        coldLogEvicted: purgeColdLogMemo(childId),
      });
    };

    const executeRelease = async (args, exec) => {
      const caller = exec?.agent;
      if (caller === void 0) throw new Error("release_subagent 需要调用方会话（exec.agent 为空）");
      const header = caller.session?.header ?? {};
      const callerId = header.id ?? caller.id;
      const requested = Array.isArray(args?.agent_ids)
        ? args.agent_ids.filter((id) => typeof id === "string" && id !== "")
        : [];
      const ids = [...new Set(requested)];
      // 权限只在主会话：子代理会话一律拒绝，且不解析、不释放任何目标。
      if (header.origin === "subagent" || header.parentSession !== void 0) {
        monitorEvent(dshHome, {
          kind: "mem-guard-release",
          caller: callerId,
          child: ids[0] ?? null,
          mode: "refused",
          reason: "not-leader",
          heapUsedBefore: heapUsed(),
          heapUsedAfter: heapUsed(),
        });
        throw new Error("release_subagent 只给主会话调用：子代理无权释放子代理，由主会话统一决定。");
      }
      if (ids.length === 0) throw new Error("release_subagent 需要 agent_ids：至少一个子代理 id");
      const before = heapUsed();
      const results = [];
      for (const id of ids) results.push(await releaseOne(caller, callerId, id));
      return { results, heapUsedBefore: before, heapUsedAfter: heapUsed() };
    };

    releaseTool = {
      name: TOOL_NAME,
      description:
        "释放主会话名下的已结束子代理的内存（只给主会话）。目标必须是你派出的后代，且当前未运行、"
        + "durable inbox 无 pending、manager 无在途操作、无界面跟随、无活的后代。常驻 release 走宿主 "
        + "drainChildren，其余走本插件捕获的 handle.dispose；本就不在内存（含重启后只剩持久化会话头的）"
        + "返回 not-loaded。血缘判定优先活会话头，内存里没有时只读持久化会话头（首行），不读事件日志。"
        + "释放后仍可用 send_message 续接（会自动从磁盘冷恢复）。主会话自身永不被自动卸载。",
      parameters: {
        type: "object",
        properties: {
          agent_ids: {
            type: "array",
            items: { type: "string" },
            description: "要释放的子代理 id 列表；每个 id 独立判定，返回 released / not-loaded / refused + 原因。",
          },
        },
        required: ["agent_ids"],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: "object",
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  result: { type: "string", enum: ["released", "not-loaded", "refused"] },
                  mode: { type: "string", enum: ["drain", "dispose", "noop", "refused"] },
                  reason: { type: "string" },
                  heapUsedBefore: { type: "number" },
                  heapUsedAfter: { type: "number" },
                },
                required: ["id", "result", "mode", "heapUsedBefore", "heapUsedAfter"],
                additionalProperties: false,
              },
            },
            heapUsedBefore: { type: "number" },
            heapUsedAfter: { type: "number" },
          },
          required: ["results", "heapUsedBefore", "heapUsedAfter"],
          additionalProperties: false,
        },
        render: (_args, value) => [{
          type: "text",
          text: value.results.map((row) => {
            if (row.result === "released") return `${row.id}: 已释放（${row.mode}）`;
            if (row.result === "not-loaded") return `${row.id}: 本就不在内存（noop）`;
            return `${row.id}: 拒绝（${row.reason}）`;
          }).join("\n"),
        }],
      },
      async execute(args, exec) {
        return executeRelease(args, exec);
      },
    };

    // 逐会话冻结：release_subagent 的模型可见文案属于本插件的工具定义，会话恢复/重启后按
    // 该会话的冻结快照注册（gates/tool-surface.js），执行体仍是这里的当前实现。只对主会话
    // 提供——子代理面本来就被 restrict 摘掉，冻结注册不得把它塞回去。
    registerSurfaceTool(TOOL_NAME, (agent) => {
      const header = agent?.session?.header;
      if (header?.origin === "subagent" || header?.parentSession !== void 0) return void 0;
      return releaseTool;
    });

    // 注册终态单独落一条：boot 事件写于 apply 时刻，tools 服务晚 provide 时那里的 releaseTool
    // 只是快照；本事件在 root/inject 任一路径出结果后写一次，registered 才是最终事实。
    let releaseToolReported = false;
    const reportReleaseTool = (registered, via) => {
      if (releaseToolReported) return;
      releaseToolReported = true;
      monitorEvent(dshHome, {
        kind: "mem-guard-evict-tool",
        tool: TOOL_NAME,
        registered,
        via,
        elapsedMs: Date.now() - bootAt,
      });
    };

    const canInject = typeof ctx.inject === "function";
    const registerReleaseTool = (registry, via) => {
      if (releaseToolRegistered) return true;
      if (registry === void 0 || typeof registry.register !== "function") return false;
      try {
        registry.register(releaseTool);
        releaseToolRegistered = true;
        reportReleaseTool(true, via);
        return true;
      } catch (error) {
        process.stderr.write(`caseos-session-evictor: ${TOOL_NAME} 注册失败: ${errorText(error)}\n`);
        return false;
      }
    };
    let registeredFromRoot = false;
    try {
      registeredFromRoot = registerReleaseTool(root.tools, "root");
    } catch {}
    if (!registeredFromRoot) {
      if (canInject) {
        try {
          ctx.inject(["tools"], (rtc) => {
            if (!registerReleaseTool(rtc?.tools ?? root.tools, "inject")) reportReleaseTool(false, "inject");
          });
        } catch {
          reportReleaseTool(false, "inject");
        }
      } else {
        reportReleaseTool(false, "root");
      }
    }

    // 每 5 分钟一条扫描汇总：candidates 是「当前可由主会话释放的已结束子代理」计数。
    // 首次扫描就发（lastSummaryAt=0），之后按 5 分钟节流；节流以发事件时刻为准。
    const reportScan = (summary) => {
      const now = Date.now();
      if (lastSummaryAt !== 0 && now - lastSummaryAt < SUMMARY_MS) return;
      lastSummaryAt = now;
      const total = service("sessionController")?.history?.closeFollowers?.size;
      let followerTracked = 0;
      for (const count of activeFollowers.values()) followerTracked += count;
      const resident = subagentResident();
      monitorEvent(dshHome, {
        kind: "mem-guard-evict-scan",
        ...summary,
        resident: resident instanceof Map || resident instanceof Set ? resident.size : null,
        followerTotal: typeof total === "number" ? total : null,
        followerTracked,
        followerUntracked: typeof total === "number" ? Math.max(0, total - followerTracked) : null,
        followerProbe: followerKnown ? "session-controller" : "unavailable",
        subagentProbe: resident !== void 0,
      });
    };

    const scan = () => {
      if (scanning) return;
      scanning = true;
      try {
        const live = liveAgents();
        if (!followerKnown) installFollowerProbe("scan");
        const context = {
          followerBlocks: (sessionId) => followerBlocks(sessionId, "scan"),
          descendantLive: makeDescendantCheck(live),
          claimInFlight,
          subagentOperationInFlight,
        };
        const resident = subagentResident();
        let candidates = 0;
        for (const agent of live) {
          const header = agent?.session?.header;
          if (header?.origin !== "subagent" || typeof header?.parentSession !== "string") continue;
          const canAct = resident?.has?.(agent.id) === true || entries.has(agent.id);
          if (!canAct) continue;
          if (releaseBlockers({ sessionId: agent.id, agent }, context).length === 0) candidates += 1;
        }
        reportScan({ tracked: entries.size, candidates, heapUsed: heapUsed() });
      } catch (error) {
        reportSkip("scan-failed", { error: errorText(error) });
      } finally {
        scanning = false;
      }
    };

    resumePatch = installResumePatch(agents, track);
    installFollowerProbe("apply");
    // 会话控制器与插件条目由 loader 并发 apply（cordis-plugin-loader/src/config/group.ts:56），
    // apply 时它可能还没 provide。inject 回调在服务 provide 的那一刻触发（cordis/lib/index.js:
    // 800-856、:1306-1343），仍早于 host 向 shell 发 ready（dsh-desktop-host/lib/index.js:328 →
    // :342-346），因此早于界面发起的第一条 follow。没有 inject 的宿主退化为首次扫描安装。
    if (canInject) {
      try {
        ctx.inject(["sessionController"], () => installFollowerProbe("inject"));
      } catch {
        // 忽略：首次扫描的 installFollowerProbe("scan") 仍会尝试；失败时保守规则照常生效。
      }
    }

    const live = liveAgents();
    for (const agent of live) {
      const header = agent?.session?.header;
      if (header?.origin === "subagent" && typeof header.parentSession === "string") {
        rememberParent(header.id, header.parentSession);
      }
    }
    const untracked = live.filter((agent) => agent?.id !== void 0 && !entries.has(agent.id)).map((agent) => agent.id);
    monitorEvent(dshHome, {
      kind: "mem-guard-evict-boot",
      scanMs,
      tracked: entries.size,
      untrackedTotal: untracked.length,
      untracked: untracked.slice(0, UNTRACKED_LIMIT),
      // 有 inject 的宿主这里只是「还没到 provide 时刻」，实际安装由 mem-guard-evict-follow 记录。
      followerProbe: followerKnown ? "session-controller" : canInject ? "deferred" : "unavailable",
      resumePatched: resumePatch !== void 0,
      releaseTool: releaseToolRegistered,
      subagentProbe: subagentResident() !== void 0,
    });

    // 子代理会话不暴露 release_subagent（工具只给主会话）；权限在 execute 里还会再判一次。
    ctx.on("agent/created", ({ agent }) => {
      const header = agent?.session?.header;
      if (header === void 0) return;
      if (header.origin === "subagent" && typeof header.parentSession === "string") {
        rememberParent(header.id, header.parentSession);
      }
      if (header.origin !== "subagent") return;
      try {
        agent.ctx?.inject?.(["tools"], (rtc) => {
          try {
            rtc.tools.restrict({ deny: [TOOL_NAME] });
          } catch {}
        });
      } catch {}
    });

    // 宿主自己释放（或面板重载）时清条目；捕获的 handle 不能第二次 dispose。
    ctx.on("agent/disposed", ({ agent }) => {
      const entry = entries.get(agent?.id);
      if (entry !== void 0 && entry.agent === agent) entries.delete(entry.sessionId);
    });

    const timer = setInterval(scan, scanMs);
    if (typeof timer?.unref === "function") timer.unref();

    ctx.effect(() => () => {
      disposed = true;
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
      knownParents.clear();
    }, "caseos-session-evictor: interval + prototype patches");
  },
};
