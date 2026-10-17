#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageData = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expectedEngine = ">=0.2.0-rc.2 <0.2.2-0";
const patchText = readFileSync(join(root, "cordis.patch.yml"), "utf8");
const configText = readFileSync(join(root, "gates/verispring-config.js"), "utf8");
const clientText = readFileSync(join(root, "client.js"), "utf8");

function fail(message) {
  console.error(`smoke-test: FAIL: ${message}`);
  process.exitCode = 1;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

if (packageData.engines?.dsh !== expectedEngine) fail(`engines.dsh 必须是 ${expectedEngine}`);
if (!packageData.peerDependencies?.["@deepseek-ai/cordis"]) fail("缺少 Cordis peerDependency");
if (!patchText.includes("agentPreset: verispring-subagent")) fail("tool-subagent 缺少 agentPreset");
if (/^\s+persona:\s/m.test(patchText)) fail("cordis.patch.yml 仍包含已废弃的 persona 配置");
if (/^\s+toolFilter:\s/m.test(patchText)) fail("cordis.patch.yml 仍包含已废弃的 toolFilter 配置");
if (patchText.includes("{{cwd}}")) fail("cordis.patch.yml 仍引用 DSH 0.2.1-rc.1 不再注册的 cwd 变量");
if (!patchText.includes("id: llm-deepseek") || !patchText.includes("name: deepseek-flash") || !patchText.includes("name: deepseek-v4-pro")) fail("官方 DeepSeek 模型显示名未使用准确标识");
if (!configText.includes("delete tool.persona") || !configText.includes("delete tool.toolFilter")) fail("profile patch 迁移未清理旧字段");
if (!clientText.includes("modelConfigForm?.subscribe") || !clientText.includes("catalogStore?.reload()")) fail("模型目录未配置动态刷新");
if (!clientText.includes('return String(model.id || model.name || "")')) fail("插件配置页模型未使用原始模型 ID 显示");
const dispatchText = readFileSync(join(root, "gates/dispatch-gate.js"), "utf8");
if (!dispatchText.includes("${routeText(route)} · ${role} · ${label}")) fail("子代理显示标题未包含实际模型路由");
if (!dispatchText.includes("【实际路由：${role} · ${routeText(route)}】")) fail("子代理任务未携带实际模型路由元信息");
if (!dispatchText.includes("sessionTitle.rename(agent.session, title)")) fail("子代理标题未调用 DSH sessionTitle.rename");
if (!dispatchText.includes("ctx.sessionTitle ?? ctx.get(\"sessionTitle\")")) fail("子代理未使用官方 sessionTitle 服务");
if (!dispatchText.includes("renameChildTitleAfterAutoTitle(ctx, child.childId, roleLabel)")) fail("子代理启动完成后未延迟写入持久标题");
if (!clientText.includes("conversation.composer.dock")) fail("客户端未注册子代理路由展示栏");
if (!clientText.includes("`${provider} · ${model} · ${effort}`")) fail("客户端路由展示栏未使用简化格式");
if (!clientText.includes('background: "transparent"')) fail("客户端路由展示栏仍使用卡片背景");
if (!clientText.includes('padding: "1px 8px"')) fail("客户端路由展示栏未对齐统计项内边距");
if (!clientText.includes('alignItems: "center"')) fail("客户端路由展示栏未垂直居中");
if (!clientText.includes('fontVariantNumeric: "tabular-nums"')) fail("客户端路由展示栏未对齐统计项字体样式");

const sourceFiles = [
  "client.js",
  ...readdirSync(join(root, "gates"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => join("gates", name)),
];
for (const file of sourceFiles) {
  try { run(process.execPath, ["--check", file]); }
  catch (error) { fail(String(error)); }
}

const dsh = process.env.DSH_BIN;
const profile = process.env.DSH_SMOKE_PROFILE;
if (dsh && profile) {
  try {
    const output = run(dsh, ["--profile", profile, "--dump-config"]);
    for (const failure of [
      "failed to import",
      "did not activate",
      "persona is no longer supported",
      "toolFilter is no longer supported",
      'unknown prompt variable "{{cwd}}"',
    ]) {
      if (output.includes(failure)) fail(`组合配置包含失败诊断：${failure}`);
    }
    for (const marker of ["caseos-dispatch-gate", "verispring-config", "preset-verispring-subagent", "id: verispring-subagent"]) {
      if (!output.includes(marker)) fail(`组合配置缺少 ${marker}`);
    }
  } catch (error) {
    fail(String(error));
  }
} else {
  console.log("smoke-test: 未设置 DSH_BIN 与 DSH_SMOKE_PROFILE，跳过运行时组合检查");
}

if (process.exitCode) process.exit();
console.log(`smoke-test: PASS: ${packageData.name}@${packageData.version}`);
