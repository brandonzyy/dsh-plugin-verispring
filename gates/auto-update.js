// 自动更新：周期对比 GitHub main 上的 version 与本地已装 version，不一致时经宿主
// pluginManager.installBundle 重装同一条 spec——这就是 README 写的官方更新语义
// （「卸载后重装同一条 spec」），桌面版默认 HMR，换树即时生效，无需重启。
//
// 宿主服务取法走作用域 get()（dispatch-gate 的 serviceOf 判定的正当入口，不要求
// inject 声明）；pluginManager 缺席（headless/SDK 宿主）时不启定时器，一句话说明后
// 返回——没有管理面就不能在 gate 里自己跑 pnpm：与宿主并发改 node_modules 会绕过
// installBundle 的文件恢复/安装状态机，属于登记运行时之外的旁路。
//
// 检查只做版本对比：远端读 raw.githubusercontent main 的 package.json（宿主进程的
// node fetch），网络失败静默等下一周期，绝不重试轰炸。本地 version 从本插件自身
// package.json 现读——installBundle 换树后同一路径读到新版本，无需额外状态。
//
// 开关（CASEOS_* 惯例）：CASEOS_AUTO_UPDATE=0 关闭；CASEOS_UPDATE_CHECK_MS 默认 6 小时、
// 下限 10 分钟；CASEOS_UPDATE_SPEC 覆盖重装 spec（默认 github:brandonzyy/dsh-plugin-verispring）；
// CASEOS_UPDATE_BRANCH 默认 main。首次检查延迟 2 分钟，避开宿主启动竞态。
// 观测面：auto-update-check（同版本 skip / 远端读取失败）/ auto-update-applied（old → new）/
// auto-update-failed（重装失败，等下一周期再试）；updating 标志防并发。
// 决策与 IO 分离：runCheck 是纯决策函数（依赖全部注入），测试不打桩就能覆盖全部分叉。
import fs from "node:fs";
import { homedir } from "node:os";
import { monitorEvent } from "./monitor-log.js";

const REPO = "brandonzyy/dsh-plugin-verispring";
const remotePackageUrl = (branch) =>
  `https://raw.githubusercontent.com/${REPO}/${branch}/package.json`;

const ENV_SWITCH = "CASEOS_AUTO_UPDATE";
const ENV_CHECK_MS = "CASEOS_UPDATE_CHECK_MS";
const ENV_SPEC = "CASEOS_UPDATE_SPEC";
const ENV_BRANCH = "CASEOS_UPDATE_BRANCH";
const DEFAULT_BRANCH = "main";
const DEFAULT_CHECK_MS = 6 * 60 * 60 * 1000;
const MIN_CHECK_MS = 10 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
const LOCAL_PACKAGE_URL = new URL("../package.json", import.meta.url);

export function autoUpdateEnabled(env = process.env) {
  return env[ENV_SWITCH] !== "0";
}

export function checkIntervalMs(env = process.env) {
  const raw = Number(env[ENV_CHECK_MS]);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CHECK_MS;
  return Math.max(raw, MIN_CHECK_MS);
}

export function updateSpec(env = process.env) {
  return env[ENV_SPEC] || `github:${REPO}`;
}

export function updateBranch(env = process.env) {
  return env[ENV_BRANCH] || DEFAULT_BRANCH;
}

// 版本判定：main 是前滚发布，不相等即更新（不做 semver 比较，也不防回退——
// main 上放什么版本是发布者的决定，本地面只服从）。任一侧解析不出来时不动作。
export function needsUpdate(localVersion, remoteVersion) {
  if (typeof localVersion !== "string" || localVersion === "") return false;
  if (typeof remoteVersion !== "string" || remoteVersion === "") return false;
  return localVersion !== remoteVersion;
}

export function localVersion(read = (u) => fs.readFileSync(u, "utf8"), url = LOCAL_PACKAGE_URL) {
  try {
    return JSON.parse(read(url)).version ?? null;
  } catch {
    return null;
  }
}

export async function remoteVersion(fetchImpl = fetch, branch = DEFAULT_BRANCH) {
  try {
    const resp = await fetchImpl(remotePackageUrl(branch), { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return null;
    return (await resp.json()).version ?? null;
  } catch {
    return null;
  }
}

// 一次检查的完整决策：读两侧版本 → 同版本/远端不可读即止 → 重装 → 按安装结果分叉。
// 返回结果串（same-version / remote-unreadable / applied / failed），观测面在这里落账。
export async function runCheck({ spec, readLocalVersion, fetchRemoteVersion, install, monitor }) {
  const local = await readLocalVersion();
  const remote = await fetchRemoteVersion();
  if (remote === null) {
    monitor({ kind: "auto-update-check", local, result: "remote-unreadable" });
    return "remote-unreadable";
  }
  if (!needsUpdate(local, remote)) {
    monitor({ kind: "auto-update-check", local, result: "same-version" });
    return "same-version";
  }
  try {
    await install(spec);
  } catch (error) {
    monitor({
      kind: "auto-update-failed",
      from: local,
      to: remote,
      reason: String(error?.message ?? error).slice(0, 200),
    });
    process.stderr.write(`caseos-auto-update: 重装失败，等下一周期：${error?.message ?? error}\n`);
    return "failed";
  }
  const installed = await readLocalVersion();
  if (installed === remote) {
    monitor({ kind: "auto-update-applied", from: local, to: installed });
    process.stderr.write(`caseos-auto-update: ${local} → ${installed}（HMR 已生效，新会话用新树）\n`);
    return "applied";
  }
  monitor({ kind: "auto-update-failed", from: local, to: remote, reason: `installed=${installed}` });
  return "failed";
}

export default {
  name: "caseos-auto-update",
  apply(ctx) {
    const env = process.env;
    // 总开关：关掉即不注册定时器、不取服务，回到无自动更新状态。
    if (!autoUpdateEnabled(env)) return;
    const manager = ctx.get?.("pluginManager");
    if (!manager?.installBundle) {
      process.stderr.write("caseos-auto-update: 宿主无 pluginManager 管理面（headless/SDK），自动更新不激活\n");
      return;
    }
    const dshHome = ctx.profileContext?.home ?? env.DSH_HOME ?? `${homedir()}/.dsh`;
    const spec = updateSpec(env);
    let updating = false;

    const check = async () => {
      if (updating) {
        process.stderr.write("caseos-auto-update: 上一轮更新仍在进行，跳过本轮\n");
        return "in-flight";
      }
      updating = true;
      try {
        return await runCheck({
          spec,
          readLocalVersion: () => Promise.resolve(localVersion()),
          fetchRemoteVersion: () => remoteVersion(fetch, updateBranch(env)),
          install: (s) => manager.installBundle(s),
          monitor: (event) => monitorEvent(dshHome, event),
        });
      } finally {
        updating = false;
      }
    };

    const timer = setInterval(() => void check(), checkIntervalMs(env));
    if (typeof timer.unref === "function") timer.unref();
    const first = setTimeout(() => void check(), FIRST_CHECK_DELAY_MS);
    if (typeof first.unref === "function") first.unref();
    // effect 释放清定时器，插件重载/卸载不累积检查循环。
    ctx.effect(() => () => {
      clearInterval(timer);
      clearTimeout(first);
    }, "caseos-auto-update: timers");
    process.stderr.write(`caseos-auto-update: activated (spec=${spec}, every=${Math.round(checkIntervalMs(env) / 60000)}min)\n`);
  },
};
