// 真实组合检查（`dsh --profile <p> --dump-config` 的输出）判据，纯函数，夹具可直接喂。
//
// 判例（2026-11-19）：DSH_BIN 指向了 ~/.local/bin/dsh——那是桌面版启动器脚本，忽略参数、
// 拉起桌面 App、打印一句「已启动」并以 0 退出。旧判据只查标记在不在，于是把一句启动提示
// 当成组合配置读，报「缺少 preset-verispring-subagent」等四条，看上去像插件在 main 上坏了。
// 另一半：被测树是 worktree 时，profile 里的 link 仍指向主检出，组合检查验的是**另一棵树**，
// 绿也不代表被测代码能组合。两件事都要先判清楚，才轮到标记。
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FAILURE_DIAGNOSTICS = [
  "failed to import",
  "did not activate",
  "persona is no longer supported",
  "toolFilter is no longer supported",
  'unknown prompt variable "{{cwd}}"',
];

export const REQUIRED_MARKERS = [
  "caseos-dispatch-gate",
  "caseos-idle-compact",
  "verispring-config",
  "preset-verispring-subagent",
  "id: verispring-subagent",
];

// 组合树的段头：`# == <bundle>`。没有它，输出就不是 --dump-config 的产物。
const SECTION_HEADER = /^# == \S/m;
const PLUGIN_FILE = /file:\/\/(\S*?\/dsh-plugin-verispring)\/[^\s]+\.js/;

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function checkComposition(output, root, { bin = "DSH_BIN", profile = "" } = {}) {
  if (!SECTION_HEADER.test(output)) {
    const head = output.trim().split("\n")[0] || "（空输出）";
    return [`${bin} --profile ${profile} --dump-config 的输出不是组合配置（首行：${head}）——` +
      "DSH_BIN 要指向 dsh CLI（npm 包 @deepseek-ai/dsh 的 bin，如 /opt/homebrew/bin/dsh），" +
      "不是桌面版启动器（如 ~/.local/bin/dsh）"];
  }
  const failures = [];
  const m = output.match(PLUGIN_FILE);
  if (!m) {
    failures.push(`profile ${profile} 的组合里没有 dsh-plugin-verispring 的入口文件`);
  } else {
    const composed = real(fileURLToPath(`file://${m[1]}`));
    const tested = real(root);
    if (composed !== tested) {
      failures.push(`profile ${profile} 组合的插件是 ${composed}，不是被测这棵树 ${tested}` +
        "——组合检查验的是另一棵树；用指向被测树的 profile（link:）再跑");
    }
  }
  for (const d of FAILURE_DIAGNOSTICS) {
    if (output.includes(d)) failures.push(`组合配置包含失败诊断：${d}`);
  }
  for (const mk of REQUIRED_MARKERS) {
    if (!output.includes(mk)) failures.push(`组合配置缺少 ${mk}`);
  }
  return failures;
}
