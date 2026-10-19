// 门禁监控落盘：把运行时事实（角色漂移、门禁拦截、子代理生命周期）追加到
// ${DSH_HOME}/verispring-monitor.jsonl，供事后审计与告警，不依赖桌面日志/stderr。
// 单条一行 JSON；任何失败静默吞掉（监控绝不反过来影响执法路径）。
import { appendFileSync, mkdirSync } from "node:fs";

export function monitorEvent(dshHome, payload) {
  try {
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...payload })}\n`;
    mkdirSync(`${dshHome}/caseos`, { recursive: true });
    appendFileSync(`${dshHome}/verispring-monitor.jsonl`, line);
  } catch {}
}
