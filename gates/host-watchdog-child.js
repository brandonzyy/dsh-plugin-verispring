#!/usr/bin/env node
// host 子进程看门狗：独立 node 进程，只观测、只留证——绝不杀进程、不发信号、不重启 host。
//
// 为什么必须独立：进程内看门狗（gates/memory-guard.js:908 的 15s setInterval）在 host 事件循环
// 被同步代码或微任务空转占住时一条都写不出来。2026-10-21 10:48 的 OOM 就是实例：host 被占住
// 45 秒，monitor 里没有任何 mem-guard 记录。子进程有独立事件循环，父进程卡死时它照样能采、
// 照样能落盘；父进程死亡时它自己退出，绝不留孤儿。
//
// 数据面：
// - 父进程每 1000ms 经 IPC 发心跳 {seq, t, heapUsed, heapTotal, rss}；本进程只认最后一条。
// - 每 CASEOS_WATCHDOG_SAMPLE_MS（默认 5000）用 `ps -o rss= -p <父 pid>` 采父进程 RSS（异步，带
//   超时；macOS 上 ps 的 rss 单位是 KB，落盘统一换算成字节）。
// - 卡死：最后一次心跳距今 >= CASEOS_WATCHDOG_STALL_MS（默认 10000）且父进程仍活着 → 一条
//   host-stall；卡死期间每个采样周期一条 host-stall-tick（RSS 曲线）；心跳恢复 → host-stall-end。
// - 暴涨：任意 30s 窗口 RSS 增长 >= CASEOS_WATCHDOG_SURGE_BYTES（默认 512MiB），或 RSS 首次越过
//   CASEOS_WATCHDOG_RSS_ALERT_BYTES（默认 2.6GiB）→ host-mem-surge；同类 60s 节流。
// - 父进程死亡：IPC disconnect 或 process.kill(ppid, 0) 失败 → host-exit（最后心跳距今、最后
//   heapUsed/rss、最近 10 个 RSS 样本），列出 crash-*.log 文件名（只列名字、不读内容），然后退出。
// - 每 5 分钟一条 host-watchdog-sample 汇总；启动时一条 host-watchdog-boot（pid/ppid/execPath/阈值）。
//
// monitor 格式与 gates/monitor-log.js 完全一致：{time, kind, ...} 一行 JSON，append 到
// ${DSH_HOME}/verispring-monitor.jsonl；任何写入失败静默吞掉（监控绝不反过来影响被观测进程）。
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_MS_ENV = "CASEOS_WATCHDOG_SAMPLE_MS";
const STALL_MS_ENV = "CASEOS_WATCHDOG_STALL_MS";
const SURGE_BYTES_ENV = "CASEOS_WATCHDOG_SURGE_BYTES";
const RSS_ALERT_BYTES_ENV = "CASEOS_WATCHDOG_RSS_ALERT_BYTES";
const DEFAULT_SAMPLE_MS = 5000;
const DEFAULT_STALL_MS = 10000;
const DEFAULT_SURGE_BYTES = 512 * 1024 * 1024;
const DEFAULT_RSS_ALERT_BYTES = Math.floor(2.6 * 1024 ** 3);
const SURGE_WINDOW_MS = 30 * 1000;
const SURGE_THROTTLE_MS = 60 * 1000;
const SUMMARY_MS = 5 * 60 * 1000;
const PS_TIMEOUT_MS = 2000;
const PS_MAX_BUFFER = 64 * 1024;
// 至少保住一小时 5s 采样；超出后丢最旧的，卡死期间的峰值另存，不受这个上限影响。
const RSS_HISTORY_LIMIT = 720;
const EXIT_SAMPLE_LIMIT = 10;
const CRASH_DIR = `${homedir()}/Library/Logs/DeepSeek Harness`;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// 与 gates/monitor-log.js 同格式；失败静默。
function monitorEvent(dshHome, payload) {
  try {
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...payload })}\n`;
    mkdirSync(`${dshHome}/caseos`, { recursive: true });
    appendFileSync(`${dshHome}/verispring-monitor.jsonl`, line);
  } catch {}
}

// macOS `ps -o rss=` 输出 KB（Linux 同）；解析失败返回 undefined，缺一次采样不算父进程死亡。
export function parsePsRss(stdout) {
  if (typeof stdout !== "string") return void 0;
  const kilobytes = Number(stdout.trim().split(/\s+/)[0]);
  if (!Number.isFinite(kilobytes) || kilobytes <= 0) return void 0;
  return Math.round(kilobytes * 1024);
}

// 暴涨判定是纯函数：测试直接核对窗口、首越告警与不再重复告警。
// samples 按时间升序；窗口取 [now - windowMs, now]，用窗口内最低点与当前值的差判增长。
export function surgeDecision({
  samples,
  now,
  surgeBytes,
  alertBytes,
  windowMs = SURGE_WINDOW_MS,
  alerted = false,
}) {
  if (!Array.isArray(samples) || samples.length === 0) return void 0;
  const current = samples[samples.length - 1];
  if (alerted !== true && Number.isFinite(alertBytes) && current.rss >= alertBytes) {
    return { reason: "rss-alert", fromRss: void 0, toRss: current.rss, windowStartAt: current.t, windowMs: 0 };
  }
  const windowStart = now - windowMs;
  const inWindow = samples.filter((sample) => sample.t >= windowStart && sample.t <= now);
  if (inWindow.length < 2) return void 0;
  let low = inWindow[0];
  for (const sample of inWindow) {
    if (sample.rss < low.rss) low = sample;
  }
  if (low === current) return void 0;
  if (current.rss - low.rss >= surgeBytes) {
    return {
      reason: "rss-surge",
      fromRss: low.rss,
      toRss: current.rss,
      windowStartAt: low.t,
      windowMs: current.t - low.t,
    };
  }
  return void 0;
}

// 只列文件名、不读内容：证据是「父进程死后宿主有没有留下 crash 日志」，不是日志正文。
function recentCrashLogs(startedAt, dir = CRASH_DIR) {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith("crash-") && name.endsWith(".log"))
      .filter((name) => {
        try {
          return statSync(join(dir, name)).mtimeMs > startedAt;
        } catch {
          return false;
        }
      })
      .sort()
      .slice(-50);
  } catch {
    return [];
  }
}

function runPs(ppid, onDone) {
  const args = ["-o", "rss=", "-p", String(ppid)];
  const options = { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER };
  execFile("/bin/ps", args, options, (error, stdout) => {
    // PATH 异常或非 macOS 上看不到 /bin/ps 时退回 PATH 里的 ps。
    if (error?.code === "ENOENT") {
      execFile("ps", args, options, (fallbackError, fallbackStdout) => onDone(fallbackError, fallbackStdout));
      return;
    }
    onDone(error, stdout);
  });
}

function main() {
  const dshHome = process.argv[2] || process.env.DSH_HOME || `${homedir()}/.dsh`;
  const ppid = process.ppid;
  const startedAt = Date.now();
  const sampleMs = envNumber(SAMPLE_MS_ENV, DEFAULT_SAMPLE_MS);
  const stallMs = envNumber(STALL_MS_ENV, DEFAULT_STALL_MS);
  const surgeBytes = envNumber(SURGE_BYTES_ENV, DEFAULT_SURGE_BYTES);
  const rssAlertBytes = envNumber(RSS_ALERT_BYTES_ENV, DEFAULT_RSS_ALERT_BYTES);

  let lastBeat = null;
  let lastBeatAt = startedAt;
  let lastRss;
  let lastRssAt = 0;
  let exiting = false;
  let psBusy = false;
  let sampleTimer;
  let summaryTimer;
  let stalls = 0;
  let surges = 0;
  let psFailures = 0;
  let alertCrossed = false;
  const samples = [];
  const surgeLastAt = new Map();
  const stall = { active: false, startedAt: 0, lastBeatAt: startedAt, peakRss: 0 };

  const write = (payload) => monitorEvent(dshHome, payload);
  const parentAlive = () => {
    if (!Number.isInteger(ppid) || ppid <= 1) return false;
    try {
      process.kill(ppid, 0);
      return true;
    } catch (error) {
      // EPERM 表示进程存在但无权限发信号；只有 ESRCH 才是死了。
      return error?.code === "EPERM";
    }
  };
  const peakRss = () => samples.reduce((max, sample) => Math.max(max, sample.rss), 0);

  const finishExit = (reason) => {
    if (exiting) return;
    exiting = true;
    clearInterval(sampleTimer);
    clearInterval(summaryTimer);
    const now = Date.now();
    write({
      kind: "host-exit",
      reason,
      pid: process.pid,
      ppid,
      lastHeartbeatAgeMs: lastBeat === null ? void 0 : now - lastBeatAt,
      lastSeq: lastBeat?.seq ?? null,
      lastHeapUsed: lastBeat?.heapUsed,
      lastHeartbeatRss: lastBeat?.rss,
      rss: lastRss,
      samples: samples.slice(-EXIT_SAMPLE_LIMIT),
      crashLogs: recentCrashLogs(startedAt),
    });
    process.exit(0);
  };

  const onHeartbeat = (message) => {
    if (exiting || message === null || typeof message !== "object") return;
    const now = Date.now();
    lastBeat = {
      seq: Number.isFinite(message.seq) ? message.seq : null,
      t: Number.isFinite(message.t) ? message.t : now,
      heapUsed: Number.isFinite(message.heapUsed) ? message.heapUsed : void 0,
      heapTotal: Number.isFinite(message.heapTotal) ? message.heapTotal : void 0,
      rss: Number.isFinite(message.rss) ? message.rss : void 0,
    };
    lastBeatAt = now;
    if (!stall.active) return;
    stall.active = false;
    write({
      kind: "host-stall-end",
      // stalledMs = 整段静默（最后一次心跳到恢复），detectedMs = 判定后到恢复。
      stalledMs: now - stall.lastBeatAt,
      detectedMs: now - stall.startedAt,
      peakRss: stall.peakRss > 0 ? stall.peakRss : lastRss,
      lastSeq: lastBeat.seq,
      lastHeapUsed: lastBeat.heapUsed,
    });
  };

  const onParentRss = (error, stdout) => {
    psBusy = false;
    if (exiting) return;
    const now = Date.now();
    if (!parentAlive()) {
      finishExit("parent-gone");
      return;
    }
    const rss = error === null || error === void 0 ? parsePsRss(stdout) : void 0;
    if (rss === void 0) psFailures += 1;
    if (rss !== void 0) {
      lastRss = rss;
      lastRssAt = now;
      samples.push({ t: now, rss });
      if (samples.length > RSS_HISTORY_LIMIT) samples.splice(0, samples.length - RSS_HISTORY_LIMIT);
      if (stall.active) stall.peakRss = Math.max(stall.peakRss, rss);
    }

    // 卡死判定不依赖 ps 是否成功：只要父进程还活着、心跳断够久，就是事件循环被占住。
    const silentMs = now - lastBeatAt;
    if (!stall.active && silentMs >= stallMs) {
      stall.active = true;
      stall.startedAt = now;
      stall.lastBeatAt = lastBeatAt;
      stall.peakRss = rss ?? lastRss ?? 0;
      stalls += 1;
      write({
        kind: "host-stall",
        stalledMs: silentMs,
        lastSeq: lastBeat?.seq ?? null,
        lastHeapUsed: lastBeat?.heapUsed,
        lastHeartbeatAgeMs: silentMs,
        rss,
      });
    } else if (stall.active) {
      write({
        kind: "host-stall-tick",
        stalledMs: now - stall.lastBeatAt,
        rss,
        peakRss: stall.peakRss > 0 ? stall.peakRss : lastRss,
        lastSeq: lastBeat?.seq ?? null,
      });
    }

    if (rss === void 0) return;
    const decision = surgeDecision({
      samples,
      now,
      surgeBytes,
      alertBytes: rssAlertBytes,
      windowMs: SURGE_WINDOW_MS,
      alerted: alertCrossed,
    });
    if (decision === void 0) return;
    if (decision.reason === "rss-alert") alertCrossed = true;
    const lastAt = surgeLastAt.get(decision.reason) ?? 0;
    if (now - lastAt < SURGE_THROTTLE_MS) return;
    surgeLastAt.set(decision.reason, now);
    surges += 1;
    write({
      kind: "host-mem-surge",
      reason: decision.reason,
      windowStartRss: decision.fromRss,
      windowEndRss: decision.toRss,
      windowMs: decision.windowMs,
      heapUsed: lastBeat?.heapUsed,
      rss,
      surgeBytes,
      rssAlertBytes,
      stalled: stall.active,
    });
  };

  const sample = () => {
    if (exiting || psBusy) return;
    psBusy = true;
    runPs(ppid, onParentRss);
  };

  write({
    kind: "host-watchdog-boot",
    pid: process.pid,
    ppid,
    execPath: process.execPath,
    electron: process.versions.electron,
    node: process.versions.node,
    dshHome,
    sampleMs,
    stallMs,
    surgeBytes,
    rssAlertBytes,
    surgeWindowMs: SURGE_WINDOW_MS,
    surgeThrottleMs: SURGE_THROTTLE_MS,
    summaryMs: SUMMARY_MS,
  });

  // 父进程在 fork 后立刻发心跳；子进程若一启动就没父进程（被遗弃），直接留证退出。
  if (ppid <= 1) {
    finishExit("orphan-at-boot");
    return;
  }

  process.on("message", onHeartbeat);
  // IPC 断开 = 父进程没了（或被主动释放）；必须退出，孤儿进程会一直占着 ps 采样。
  process.on("disconnect", () => finishExit("ipc-disconnect"));
  process.on("uncaughtException", () => finishExit("child-error"));

  sample();
  sampleTimer = setInterval(sample, sampleMs);
  summaryTimer = setInterval(() => {
    if (exiting) return;
    write({
      kind: "host-watchdog-sample",
      uptimeMs: Date.now() - startedAt,
      rss: lastRss,
      rssAgeMs: lastRssAt > 0 ? Date.now() - lastRssAt : void 0,
      peakRss: peakRss(),
      lastSeq: lastBeat?.seq ?? null,
      lastHeapUsed: lastBeat?.heapUsed,
      lastHeartbeatAgeMs: Date.now() - lastBeatAt,
      stalled: stall.active,
      stalls,
      surges,
      psFailures,
      samples: samples.length,
    });
  }, SUMMARY_MS);
}

// 直接执行才跑主循环；被测试 import 时只暴露纯函数。
const invokedDirectly = process.argv[1] !== void 0 && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
