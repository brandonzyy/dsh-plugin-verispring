#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageData = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expectedEngine = ">=0.2.0-rc.2 <0.2.2-0";

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
    for (const marker of ["caseos-dispatch-gate", "verispring-config", "preset-verispring-subagent"]) {
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
