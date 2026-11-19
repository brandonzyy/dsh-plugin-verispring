#!/usr/bin/env node
// smoke-composition 判据的注入验红：启动器输出、组合了别的树、缺标记、失败诊断各一条，外加一条绿。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkComposition, REQUIRED_MARKERS } from "./smoke-composition.mjs";

const base = mkdtempSync(join(tmpdir(), "smoke-composition-"));
try {
  const tested = join(base, "dsh-plugin-verispring");
  const other = join(base, "main", "dsh-plugin-verispring");
  mkdirSync(join(tested, "gates"), { recursive: true });
  mkdirSync(join(other, "gates"), { recursive: true });
  const linkDir = join(base, "profile", "node_modules");
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(tested, join(linkDir, "dsh-plugin-verispring"));

  const dump = (pluginDir, markers = REQUIRED_MARKERS, extra = "") => [
    "# == @deepseek-ai/dsh-base",
    `  file://${pluginDir}/gates/dispatch-gate.js`,
    ...markers,
    extra,
  ].join("\n");

  // 绿：组合经 profile 的 node_modules 软链指向被测树
  assert.deepEqual(checkComposition(dump(join(linkDir, "dsh-plugin-verispring")), tested), []);

  // 启动器输出：一句提示、0 退出——必须判成「不是组合配置」，而不是逐条缺标记
  const launcher = checkComposition("DeepSeek Harness 桌面版已启动，继续使用现有会话和配置。\n", tested);
  assert.equal(launcher.length, 1);
  assert.match(launcher[0], /不是组合配置/);

  // 组合了另一棵树（worktree 测试时 profile 仍 link 主检出）
  assert.ok(checkComposition(dump(other), tested).some((f) => f.includes("不是被测这棵树")));

  // 组合里没有插件入口
  assert.ok(checkComposition("# == @deepseek-ai/dsh-base\n" + REQUIRED_MARKERS.join("\n"), tested)
    .some((f) => f.includes("没有 dsh-plugin-verispring 的入口文件")));

  // 缺一个标记
  const missing = checkComposition(dump(tested, REQUIRED_MARKERS.slice(1)), tested);
  assert.deepEqual(missing, [`组合配置缺少 ${REQUIRED_MARKERS[0]}`]);

  // 失败诊断
  assert.ok(checkComposition(dump(tested, REQUIRED_MARKERS, "x failed to import y"), tested)
    .some((f) => f.includes("failed to import")));

  console.log("test-smoke-composition: 全部通过");
} finally {
  rmSync(base, { recursive: true, force: true });
}
