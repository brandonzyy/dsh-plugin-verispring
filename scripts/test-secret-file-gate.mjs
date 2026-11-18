#!/usr/bin/env node
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const { readsSecretFile } = await import(join(root, "gates/manon-bridge.js"));

let passed = 0;
function fail(message) {
  console.error(`test-secret-file-gate: FAIL: ${message}`);
  process.exitCode = 1;
}
function expectBlocked(command) {
  if (readsSecretFile(command)) { passed++; return; }
  fail(`未被拦截：${command}`);
}
function expectAllowed(command) {
  if (!readsSecretFile(command)) { passed++; return; }
  fail(`被误拦：${command}`);
}

// —— 必须放行：sed 原地纯替换（GNU/BSD、连写后缀、--in-place、-e 多条、路径 sed、含空格脚本）——
expectAllowed('sed -i "s#/agents-verispring-channel#/agents-platform-channel#" /etc/changquan/updater.env');
expectAllowed("sed -i.bak 's#a#b#' x.env");
expectAllowed("sed --in-place -e 's#a#b#' x.env");
expectAllowed("sed -i '' 's#a#b#' x.env");
expectAllowed("sed -i 's/a/b/g; s/c/d/g' x.env");
expectAllowed("sed -E -i 's/a+/b/' x.env");
expectAllowed("sed -i -e 's#a#b#' -e 's#c#d#' x.env");
expectAllowed("/usr/bin/sed -i 's/verispring-channel/platform-channel/' /etc/changquan/updater.env");
expectAllowed('sed -i "s/a b/c d/" x.env');

// —— 必须拦截：九类回归 ——
expectBlocked("cat /etc/x/updater.env");
expectBlocked("sed -n 's/^KEY=//p' x.env");
expectBlocked("sed 's/a/b/' x.env");
expectBlocked("sed -i 's/a/b/p' x.env");
expectBlocked("sed -i 's/a/b/w /dev/stdout' x.env");
expectBlocked("sed -i -n 's/a/b/p' x.env");
expectBlocked("grep -c foo updater.env");
expectBlocked("sed -i 's/a/b/' x.env; cat x.env");
expectBlocked("sed -i 's/a/b/' manon.env");
expectBlocked("sed -i 's/a/b/' verispring.env");

// —— 必须拦截：豁免的边界 ——
expectBlocked("sed -i 's/a/b/' x.env && cat x.env");
expectBlocked("cat x.env && sed -i 's/a/b/' x.env");
expectBlocked("sed -i -f patch.sed x.env");
expectBlocked("sed --file=patch.sed x.env");
expectBlocked("sed -in 's/a/b/' x.env");
expectBlocked("sed -i 's/a/b/' $(grep KEY updater.env)");
expectBlocked("awk '{print}' x.env && sed -i 's/a/b/' x.env");

if (process.exitCode) process.exit();
console.log(`test-secret-file-gate: PASS: ${passed} 项断言`);
