// host 进程内存看门狗：周期读 process.memoryUsage()，越过软阈值做可逆回收，越过硬阈值只告警。
//
// T2 为什么不退出：main.js 的 host 子进程 close 处理（抽取版 lib/main.js:3842-3849）对任何
// 退出码都走 this.fail(...)，exit 0 同样被当作 "dsh desktop host stopped"；
// DesktopBackendController（:7109-7260）只在 start() 被再次调用时拉起子进程。所以「优雅退出
// 触发宿主重启」在本宿主上不成立，硬阈值降级为 monitor 事件 + stderr 提示（提示写明人工重启）。
//
// 触达边界：subagents 运行时暴露 drainChildren(parent, childIds)（只释放同一活父代理名下指定
// 的常驻子代理，后续 send_message 冷恢复）。这里只放 status === "idle" 且 durable inbox 已清空
// 的子代理：running 的有活在跑，inbox 有排队的还有活要干，两者都不算「已完成」。宿主没有暴露
// 释放「被点开常驻的父会话」的 API——那部分只能靠重启，正是 T2 告警的意义；父会话的 fiber 卸载
// 才删 SessionStore（dsh-session/lib/index.js:1871-1893）。
//
// 软回收两类目标：
// - drain：agents 注册表里已完成（idle 且 inbox 清空）的子代理按父代理分组调 drainChildren；
// - recycle：dispatch-gate 与 scout-relay 的模块层只增索引按活会话剪枝（权威事实在
//   session-state 文件与会话日志里，剪掉的条目按需重建），不碰在用的条目。
//
// 开关与阈值（CASEOS_* 惯例）：CASEOS_MEM_GUARD=0 全关；CASEOS_MEM_CHECK_MS 默认 60000；
// CASEOS_MEM_SOFT_BYTES / CASEOS_MEM_HARD_BYTES 默认按 V8 顶棚比例（60% / 80%，4GiB 顶棚即
// 2.4GiB / 3.2GiB）；显式设置时按 env 覆盖。drain/recycle 共享 5 分钟冷却；硬阈值不参与冷却
// （只告警，不改状态）。
// 动作落 monitor：kind = mem-guard-boot（激活自报：heapLimitBytes / nodeArgv / pid /
// thresholdsSource）/ mem-guard-drain / mem-guard-recycle / mem-guard-skip。
import v8 from "node:v8";
import { homedir } from "node:os";
import { monitorEvent } from "./monitor-log.js";
import { releaseIdleCaches as releaseDispatchCaches } from "./dispatch-gate.js";
import { releaseIdleCaches as releaseRelayCaches } from "./scout-relay.js";

const GUARD_ENV = "CASEOS_MEM_GUARD";
const CHECK_MS_ENV = "CASEOS_MEM_CHECK_MS";
const SOFT_BYTES_ENV = "CASEOS_MEM_SOFT_BYTES";
const HARD_BYTES_ENV = "CASEOS_MEM_HARD_BYTES";
const DEFAULT_CHECK_MS = 60000;
const GIB = 1024 ** 3;
const FALLBACK_HEAP_LIMIT_BYTES = 4 * GIB;
const SOFT_RATIO = 0.6;
const HARD_RATIO = 0.8;
const COOLDOWN_MS = 5 * 60 * 1000;
const IDLE_MS = 90 * 1000;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// 少了「显式设置」与「未设置」的区分，比例阈值就无从判断该不该让位给 env。
function envNumberExplicit(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : void 0;
}

// 顶棚按进程实际读数取（V8 构建上限会吃掉过大的 --max-old-space-size，见 README）；
// 读不到时退回 4GiB，让阈值等价于旧行为而不是把看门狗整个拖垮。
export function heapLimitBytes() {
  try {
    const limit = v8.getHeapStatistics().heap_size_limit;
    if (Number.isFinite(limit) && limit > 0) return limit;
  } catch {}
  return FALLBACK_HEAP_LIMIT_BYTES;
}

// 比例阈值是纯函数：测试可直接核对 4GiB / 8GiB 顶棚的 60% / 80% 取值。
export function proportionalThresholds(limit) {
  return { softBytes: Math.floor(limit * SOFT_RATIO), hardBytes: Math.floor(limit * HARD_RATIO) };
}

// 短路顺序即处置优先级：未越软阈值不动作；越硬阈值只告警（忙闲决定 reason 与提示）；冷却
// 窗口内跳过；否则软回收。硬阈值不参与冷却，heapUsed 回落后也不需要额外状态。
export function memoryDecision({ heapUsed, softBytes, hardBytes, busy, lastActionAt, now }) {
  if (!(heapUsed >= softBytes)) return { kind: "below" };
  if (heapUsed >= hardBytes) return { kind: busy ? "hard-busy" : "hard-idle" };
  if (lastActionAt > 0 && now - lastActionAt < COOLDOWN_MS) {
    return { kind: "cooldown", remainingMs: COOLDOWN_MS - (now - lastActionAt) };
  }
  return { kind: "soft" };
}

export default {
  name: "caseos-memory-guard",
  // 只硬依赖 profileContext（落盘根）：agents/subagents 用 ctx.get 惰性取，缺了也照样做缓存
  // 回收与硬阈值告警，不会因为某个宿主服务缺失就整个看门狗不激活。
  inject: ["profileContext"],
  apply(ctx) {
    // 整体开关：关掉即不注册定时器、不挂监听，host 回到无治理状态。
    if (process.env[GUARD_ENV] === "0") return;

    const dshHome = ctx.profileContext?.home ?? process.env.DSH_HOME ?? `${homedir()}/.dsh`;
    const checkMs = envNumber(CHECK_MS_ENV, DEFAULT_CHECK_MS);
    const limit = heapLimitBytes();
    const proportional = proportionalThresholds(limit);
    const softEnv = envNumberExplicit(SOFT_BYTES_ENV);
    const hardEnv = envNumberExplicit(HARD_BYTES_ENV);
    const softBytes = softEnv ?? proportional.softBytes;
    const hardBytes = hardEnv ?? proportional.hardBytes;
    const thresholdsSource = softEnv === void 0 && hardEnv === void 0 ? "proportional" : "env";
    const root = ctx.root ?? ctx;

    // 顶棚与阈值来源是后续一切实证的锚点：宿主换了堆上限（或哪天上游抬了顶）这里能直接看出来。
    monitorEvent(dshHome, {
      kind: "mem-guard-boot",
      heapLimitBytes: limit,
      softBytes,
      hardBytes,
      thresholdsSource,
      checkMs,
      pid: process.pid,
      nodeArgv: process.execArgv,
    });

    // 服务只在用时现取：面板改配置会重跑 apply，闭包里读到的旧作用域会失活。
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
    const liveAgents = () => {
      try {
        return service("agents")?.list?.() ?? [];
      } catch {
        return [];
      }
    };

    let lastToolAt = Date.now();
    let lastActionAt = 0;
    // 一次回收可能跨多个 60s 周期（drainChildren 等宿主释放完成），定时器与 end 事件不得叠加。
    let checking = false;

    // 已排队待跑的输入（宿主 durable inbox 投影）：这样的空闲子代理还有活要干，不能当「已完成」。
    // inbox 属 agent-loop 的内部面，取不到就按「有活」保守处理，只放确认清空的。
    const hasPendingInput = (agent) => {
      try {
        return agent?.inbox?.hasPending !== false;
      } catch {
        return true;
      }
    };

    // 近 90s 有工具活动或仍有运行中子代理都算忙：硬阈值只在这种空闲态告警。
    const isBusy = (now) => {
      if (now - lastToolAt < IDLE_MS) return true;
      return liveAgents().some(
        (agent) => agent?.session?.header?.origin === "subagent" && agent?.status === "running",
      );
    };

    const drainIdleChildren = async () => {
      const subagents = service("subagents");
      const agents = service("agents");
      if (typeof subagents?.drainChildren !== "function" || typeof agents?.list !== "function") {
        return { released: 0 };
      }
      const live = agents.list();
      const byId = new Map(live.map((agent) => [agent?.id, agent]));
      const byParent = new Map();
      for (const agent of live) {
        const header = agent?.session?.header ?? {};
        if (header.origin !== "subagent" || agent.status !== "idle") continue;
        if (hasPendingInput(agent)) continue;
        const parent = byId.get(header.parentSession);
        if (!parent) continue;
        const ids = byParent.get(parent.id) ?? [];
        ids.push(agent.id);
        byParent.set(parent.id, ids);
      }
      let released = 0;
      for (const [parentId, ids] of byParent) {
        try {
          await subagents.drainChildren(byId.get(parentId), ids);
          // 宿主按 activation 释放，非驻留 id 是 no-op：只数已从注册表卸载的。
          released += ids.filter((id) => agents.get?.(id) === void 0).length;
        } catch (error) {
          monitorEvent(dshHome, {
            kind: "mem-guard-skip",
            reason: "drain-failed",
            parent: parentId,
            children: ids.length,
            error: String(error?.message ?? error).slice(0, 200),
          });
        }
      }
      return { released };
    };

    const recycleCaches = () => {
      const live = liveAgents();
      let released = 0;
      for (const [cache, release] of [["dispatch-gate", releaseDispatchCaches], ["scout-relay", releaseRelayCaches]]) {
        try {
          released += release(live);
        } catch (error) {
          monitorEvent(dshHome, {
            kind: "mem-guard-skip",
            reason: "recycle-failed",
            cache,
            error: String(error?.message ?? error).slice(0, 200),
          });
        }
      }
      return released;
    };

    const runCheck = async () => {
      if (checking) return;
      checking = true;
      try {
        const heapUsed = process.memoryUsage().heapUsed;
        const now = Date.now();
        const decision = memoryDecision({ heapUsed, softBytes, hardBytes, busy: isBusy(now), lastActionAt, now });
        if (decision.kind === "below") return;
        if (decision.kind === "cooldown") {
          monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "cooldown", heapUsed, remainingMs: decision.remainingMs });
          return;
        }
        if (decision.kind === "hard-busy") {
          monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "hard-threshold-busy", heapUsed, hardBytes });
          return;
        }
        if (decision.kind === "hard-idle") {
          monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "hard-threshold-no-auto-restart", heapUsed, hardBytes });
          process.stderr.write(
            `caseos-memory-guard: heapUsed ${(heapUsed / GIB).toFixed(1)}GiB 越过硬阈值 ${(hardBytes / GIB).toFixed(1)}GiB 且当前空闲；`
            + "宿主不会自动重启 host（exit 0 也算失败停止），请人工重启 DSH\n",
          );
          return;
        }
        lastActionAt = now;
        const drain = await drainIdleChildren();
        const recycled = recycleCaches();
        if (drain.released > 0) {
          monitorEvent(dshHome, { kind: "mem-guard-drain", reason: "soft-threshold", heapUsed, released: drain.released });
        }
        if (recycled > 0) {
          monitorEvent(dshHome, { kind: "mem-guard-recycle", reason: "soft-threshold", heapUsed, released: recycled });
        }
        if (drain.released === 0 && recycled === 0) {
          monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "soft-threshold-no-targets", heapUsed });
        }
      } catch (error) {
        monitorEvent(dshHome, { kind: "mem-guard-skip", reason: "check-failed", error: String(error?.message ?? error).slice(0, 200) });
      } finally {
        checking = false;
      }
    };

    // 工具活动标记开始与结束：长工具执行期间同样算忙。
    ctx.on("tools/pre-execute", async (exec, next) => {
      lastToolAt = Date.now();
      if (typeof next !== "function") return;
      try {
        return await next();
      } finally {
        lastToolAt = Date.now();
      }
    });
    // 子代理收尾是内存回落/跃升的关键时刻，不等下一轮定时器。
    root.on("subagent/end", () => {
      void runCheck();
    });

    const timer = setInterval(runCheck, checkMs);
    if (typeof timer?.unref === "function") timer.unref();
    ctx.effect(() => () => clearInterval(timer), "caseos-memory-guard: interval");
  },
};
