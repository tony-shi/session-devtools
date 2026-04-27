// 状态命令。
// 不再把 pid/port 文件视为唯一事实来源，而是按 dashboard 托管模式读取 settings.json
// 推导期望端口，再 ping /_health 判断真实运行态。
import { getManagedProxyStatus } from "../managed";

async function main() {
  const report = await getManagedProxyStatus();
  const icon = report.daemonStatus === "OK" ? "✓" : report.daemonStatus === "DEGRADED" ? "⚠" : "✗";
  console.log(`${icon} 状态: ${report.daemonStatus}`);
  console.log(`  Configured: ${report.injected ? "yes" : "no"}`);
  console.log(`  Managed:    ${report.managed ? "yes" : "no"}`);
  console.log(`  PID:        ${report.pid ?? "(未知)"}`);
  console.log(`  Port:       ${report.port ?? "(未知)"}`);
  if (report.health) console.log(`  Health:     ${JSON.stringify(report.health)}`);
  if (report.statusHint) console.log(`  原因:       ${report.statusHint}`);
  process.exit(report.daemonStatus === "OK" ? 0 : report.daemonStatus === "DEGRADED" ? 1 : 2);
}

main().catch((err) => {
  console.error("[status] 错误:", err);
  process.exit(2);
});
