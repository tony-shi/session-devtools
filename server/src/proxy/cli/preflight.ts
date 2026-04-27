// 命令行入口：bun run server/src/proxy/cli/preflight.ts [--port N]
import { runPreflight } from "../preflight";
import { DEFAULT_LISTEN_PORT } from "../config";

function parseArgs(): { port: number } {
  const idx = process.argv.indexOf("--port");
  const port = idx > 0 ? Number(process.argv[idx + 1]) : DEFAULT_LISTEN_PORT;
  return { port: Number.isFinite(port) && port > 0 ? port : DEFAULT_LISTEN_PORT };
}

const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
};

function severityIcon(s: string): string {
  if (s === "OK") return `${COLORS.green}✓${COLORS.reset}`;
  if (s === "WARN") return `${COLORS.yellow}⚠${COLORS.reset}`;
  return `${COLORS.red}✗${COLORS.reset}`;
}

const { port } = parseArgs();
const report = await runPreflight({ ourPort: port });

console.log(`\n[preflight] target port = 127.0.0.1:${port}\n`);
for (const r of report.results) {
  console.log(`  ${severityIcon(r.severity)} ${r.id} ${r.name}: ${r.message}`);
  if (r.hint) console.log(`     ${COLORS.dim}→ ${r.hint}${COLORS.reset}`);
}
console.log("");

if (report.blocked) {
  console.log(`${COLORS.red}Aborting install. No files were written.${COLORS.reset}\n`);
  process.exit(0); // 设计文档：BLOCK 也 exit 0，正常退出（退码 ≠ 0 仅留给自身崩溃）
}
console.log(`${COLORS.green}All checks passed. Safe to install.${COLORS.reset}\n`);
