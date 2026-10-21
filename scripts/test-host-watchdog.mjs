#!/usr/bin/env node
// host 子进程看门狗行为测试：真实 fork gates/host-watchdog-child.js，阈值经 env 调到几十到
// 几百毫秒，monitor 写到临时目录。只观测、只留证是本功能的边界，因此用例只 fork 自己的替身，
// 绝不对当前 DSH host 的 pid 做任何事；每个用例结束都确保子进程已退出。
//
// 覆盖：surge 纯函数（30s 窗口、首越告警、只报一次、窗口外样本不参与）、ps 输出解析、
// 心跳停止 → host-stall + host-stall-tick、心跳恢复 → host-stall-end、父进程（替身）退出 →
// host-exit 且子进程在 2s 内消失、boot 自报（pid/ppid/execPath/阈值）。
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePsRss, surgeDecision } from "../gates/host-watchdog-child.js";

const CHILD = fileURLToPath(new URL("../gates/host-watchdog-child.js", import.meta.url));
const SAMPLE_MS = 50;
const STALL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitFor(check, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== void 0 && value !== false && value !== null) return value;
    if (Date.now() > deadline) throw new Error("等待事件超时");
    await sleep(stepMs);
  }
}

function makeHome() {
  return mkdtempSync(join(tmpdir(), "host-watchdog-"));
}

function childEnv(home, extra = {}) {
  return {
    ...process.env,
    DSH_HOME: home,
    CASEOS_WATCHDOG_SAMPLE_MS: String(SAMPLE_MS),
    CASEOS_WATCHDOG_STALL_MS: String(STALL_MS),
    // 真实环境的阈值（512MiB / 2.6GiB）在测试里不会触发；这里推高避免噪声。
    CASEOS_WATCHDOG_SURGE_BYTES: String(512 * 1024 * 1024),
    CASEOS_WATCHDOG_RSS_ALERT_BYTES: String(8 * 1024 ** 3),
    ...extra,
  };
}

function spawnChild(home, extraEnv = {}) {
  return fork(CHILD, [home], {
    execPath: process.execPath,
    env: childEnv(home, extraEnv),
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "json",
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.kill();
  } catch {}
  await Promise.race([exited, sleep(1000)]);
}

function writeStubParent(dir) {
  const path = join(dir, "stub-parent.mjs");
  writeFileSync(path, [
    "import { fork } from \"node:child_process\";",
    "import { writeFileSync } from \"node:fs\";",
    "const [childPath, home, pidFile] = process.argv.slice(2);",
    "const child = fork(childPath, [home], {",
    "  env: process.env,",
    "  stdio: [\"ignore\", \"ignore\", \"ignore\", \"ipc\"],",
    "  serialization: \"json\",",
    "});",
    "child.on(\"spawn\", () => {",
    "  writeFileSync(pidFile, String(child.pid));",
    "  child.send({ seq: 1, t: Date.now(), heapUsed: 1024, heapTotal: 2048, rss: 4096 }, () => {",
    "    setTimeout(() => process.exit(0), 120);",
    "  });",
    "});",
    "",
  ].join("\n"));
  return path;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("surge 纯函数：30s 窗口增长、首越告警只报一次、窗口外样本不参与", () => {
  const surgeBytes = 500;
  const alertBytes = 650;

  const grown = surgeDecision({
    samples: [{ t: 0, rss: 100 }, { t: 10000, rss: 200 }, { t: 20000, rss: 700 }],
    now: 20000,
    surgeBytes,
    alertBytes: 8000,
    windowMs: 30000,
  });
  assert.equal(grown?.reason, "rss-surge");
  assert.equal(grown.fromRss, 100);
  assert.equal(grown.toRss, 700);
  assert.equal(grown.windowStartAt, 0);

  const small = surgeDecision({
    samples: [{ t: 0, rss: 100 }, { t: 20000, rss: 400 }],
    now: 20000,
    surgeBytes,
    alertBytes: 8000,
  });
  assert.equal(small, void 0, "窗口增长不足不报");

  const stale = surgeDecision({
    samples: [{ t: 0, rss: 100 }, { t: 40000, rss: 900 }],
    now: 40000,
    surgeBytes,
    alertBytes: 8000,
    windowMs: 30000,
  });
  assert.equal(stale, void 0, "30s 之前的低点不算窗口起点");

  const alert = surgeDecision({
    samples: [{ t: 0, rss: 660 }],
    now: 0,
    surgeBytes,
    alertBytes,
  });
  assert.equal(alert?.reason, "rss-alert");
  assert.equal(alert.toRss, 660);
  assert.equal(
    surgeDecision({ samples: [{ t: 0, rss: 660 }], now: 0, surgeBytes, alertBytes, alerted: true }),
    void 0,
    "首越只报一次",
  );
});

test("ps 输出解析：KB 换算为字节，空/非法输出不产生样本", () => {
  assert.equal(parsePsRss("  484224\n"), 484224 * 1024);
  assert.equal(parsePsRss("1024"), 1024 * 1024);
  assert.equal(parsePsRss(""), void 0);
  assert.equal(parsePsRss("not-a-number"), void 0);
  assert.equal(parsePsRss(void 0), void 0);
});

test("boot 自报：pid/ppid/execPath/阈值；心跳停 → host-stall/tick，恢复 → host-stall-end", async () => {
  const home = makeHome();
  const child = spawnChild(home);
  try {
    const boot = await waitFor(() => readJsonl(join(home, "verispring-monitor.jsonl"))
      .find((entry) => entry.kind === "host-watchdog-boot"));
    assert.equal(boot.pid, child.pid);
    assert.equal(boot.ppid, process.pid);
    assert.equal(boot.execPath, process.execPath);
    assert.equal(boot.sampleMs, SAMPLE_MS);
    assert.equal(boot.stallMs, STALL_MS);
    assert.equal(typeof boot.surgeBytes, "number");
    assert.equal(typeof boot.rssAlertBytes, "number");

    child.send({ seq: 7, t: Date.now(), heapUsed: 123, heapTotal: 456, rss: 789 });

    // 心跳停够 STALL_MS：等 host-stall 落盘，再多等几个采样周期拿 tick。
    const stall = await waitFor(() => readJsonl(join(home, "verispring-monitor.jsonl"))
      .find((entry) => entry.kind === "host-stall"));
    assert.ok(stall.stalledMs >= STALL_MS, "stalledMs 至少是阈值");
    assert.equal(stall.lastSeq, 7);
    assert.equal(stall.lastHeapUsed, 123);
    assert.equal(typeof stall.rss, "number", "macOS 上 ps 应能采到父进程 RSS");

    await sleep(SAMPLE_MS * 4);
    const ticks = readJsonl(join(home, "verispring-monitor.jsonl"))
      .filter((entry) => entry.kind === "host-stall-tick");
    assert.ok(ticks.length >= 1, "卡死期间每个采样周期一条 tick");
    assert.ok(ticks.every((entry) => typeof entry.rss === "number"));

    child.send({ seq: 8, t: Date.now(), heapUsed: 124, heapTotal: 456, rss: 790 });
    const end = await waitFor(() => readJsonl(join(home, "verispring-monitor.jsonl"))
      .find((entry) => entry.kind === "host-stall-end"));
    assert.ok(end.stalledMs >= STALL_MS);
    assert.equal(typeof end.peakRss, "number");
    assert.equal(end.lastSeq, 8);

    // 恢复后不再继续写 tick：以 host-stall-end 的时间戳为界，之后不允许有 tick。
    await sleep(SAMPLE_MS * 3);
    const lateTicks = readJsonl(join(home, "verispring-monitor.jsonl"))
      .filter((entry) => entry.kind === "host-stall-tick" && entry.time > end.time);
    assert.equal(lateTicks.length, 0, "心跳恢复后停止 tick");
  } finally {
    await stopChild(child);
  }
  assert.equal(child.exitCode !== null || child.signalCode !== null, true, "用例结束不残留子进程");
});

test("父进程（替身）退出：host-exit 落盘，子进程 2s 内退出且 pid 消失", async () => {
  const home = makeHome();
  const dir = makeHome();
  const pidFile = join(dir, "child.pid");
  const stub = writeStubParent(dir);
  const parent = fork(stub, [CHILD, home, pidFile], {
    execPath: process.execPath,
    env: childEnv(home),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
  });
  let childPid;
  try {
    childPid = Number(await waitFor(() => {
      try {
        return readFileSync(pidFile, "utf8").trim() || void 0;
      } catch {
        return void 0;
      }
    }));
    assert.ok(Number.isInteger(childPid) && childPid > 0);

    const exit = await waitFor(() => readJsonl(join(home, "verispring-monitor.jsonl"))
      .find((entry) => entry.kind === "host-exit"));
    assert.ok(exit.reason === "ipc-disconnect" || exit.reason === "parent-gone");
    assert.equal(exit.ppid, parent.pid);
    assert.equal(typeof exit.lastHeapUsed, "number");
    assert.ok(Array.isArray(exit.samples), "带 rss 样本数组");
    assert.ok(exit.samples.length <= 10, "最多最近 10 个样本");
    assert.ok(Array.isArray(exit.crashLogs), "列出 crash-*.log 文件名");

    const gone = await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 2000);
    assert.equal(gone, true, "父进程死后子进程必须退出，2s 内 pid 消失");
  } finally {
    if (childPid !== void 0) {
      try {
        process.kill(childPid, 0);
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    try {
      parent.kill();
    } catch {}
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  let failure;
  try {
    await fn();
  } catch (error) {
    failure = error;
  }
  if (failure === void 0) {
    console.log(`ok - ${name}`);
  } else {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(String(failure?.stack ?? failure).split("\n").slice(0, 10).join("\n"));
  }
}
console.log(`host-watchdog: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
