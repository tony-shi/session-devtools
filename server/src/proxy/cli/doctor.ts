// 一键诊断 —— B3.3。
// 运行 preflight + 拉 /_health + 分析最近 100 条 traffic 成功率，输出报告。
import { existsSync, readFileSync, createReadStream } from "node:fs";
import http from "node:http";
import readline from "node:readline";
import { DEFAULT_LISTEN_PORT, PATHS } from "../config";
import { runPreflight } from "../preflight";

function log(msg: string) {
  console.log(`[doctor] ${msg}`);
}

function pingHealth(port: number, timeoutMs = 3000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { req.destroy(); resolve(null); }, timeoutMs);
    const req = http.get(`http://127.0.0.1:${port}/_health`, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        clearTimeout(t);
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    req.on("error", () => { clearTimeout(t); resolve(null); });
  });
}

// 读取最近 N 行 JSONL（从文件末尾）
async function readLastNLines(filePath: string, n: number): Promise<string[]> {
  if (!existsSync(filePath)) return [];
  const lines: string[] = [];
  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) {
      lines.push(line);
      if (lines.length > n * 3) lines.splice(0, lines.length - n); // 滑动窗口，避免全量加载
    }
  }
  return lines.slice(-n);
}

async function main() {
  const args = process.argv.slice(2);
  const portArg = args.indexOf("--port");
  const port = portArg >= 0 ? Number(args[portArg + 1]) : DEFAULT_LISTEN_PORT;

  console.log("═".repeat(60));
  console.log(" Session Dashboard Proxy — 诊断报告");
  console.log("═".repeat(60));

  // ── 1. Preflight ──────────────────────────────────────────────────────────
  console.log("\n[1/3] Preflight 检查...");
  const report = await runPreflight({ ourPort: port });
  let preflightOk = true;
  for (const r of report.results) {
    const icon = r.severity === "OK" ? "  ✓" : r.severity === "WARN" ? "  ⚠" : "  ✗";
    console.log(`${icon} [${r.id}] ${r.name}: ${r.message}`);
    if (r.hint) console.log(`      → ${r.hint}`);
    if (r.severity === "BLOCK") preflightOk = false;
  }
  console.log(preflightOk ? "  → preflight: 全部通过" : "  → preflight: 有 BLOCK 项");

  // ── 2. /_health ───────────────────────────────────────────────────────────
  console.log("\n[2/3] Daemon 健康检查...");
  const health = await pingHealth(port);
  if (!health) {
    console.log(`  ✗ /_health 无响应（127.0.0.1:${port}）`);
    console.log("  → daemon 未运行？尝试: bun run proxy:install");
  } else {
    const icon = health.ok ? "  ✓" : "  ⚠";
    console.log(`${icon} ${JSON.stringify(health)}`);
  }

  // ── 3. 最近 100 条 traffic 成功率 ─────────────────────────────────────────
  console.log("\n[3/3] 最近流量分析...");
  if (!existsSync(PATHS.trafficLog)) {
    console.log("  （traffic.jsonl 不存在，尚无流量记录）");
  } else {
    const lines = await readLastNLines(PATHS.trafficLog, 100);
    let total = 0, ok2xx = 0, err5xx = 0, events = 0;
    const errMsgs: string[] = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.kind === "response") {
          total++;
          if (rec.status >= 200 && rec.status < 300) ok2xx++;
          else if (rec.status >= 500) {
            err5xx++;
            errMsgs.push(`${rec.status} ${rec.url}`);
          }
        } else if (rec.kind === "event") {
          events++;
          if (rec.msg === "mitm_upstream_error" || rec.msg === "tunnel_fail") {
            errMsgs.push(`event:${rec.msg} sni=${rec.sni ?? "?"}`);
          }
        }
      } catch {}
    }
    if (total === 0 && events === 0) {
      console.log("  （无 response/event 记录）");
    } else {
      const rate = total > 0 ? Math.round((ok2xx / total) * 100) : 100;
      const icon = rate >= 95 ? "  ✓" : rate >= 80 ? "  ⚠" : "  ✗";
      console.log(`${icon} 最近 ${total} 条请求，成功率 ${rate}%（2xx=${ok2xx}, 5xx=${err5xx}），事件=${events}`);
      if (errMsgs.length > 0) {
        console.log("  最近错误（最多 5 条）:");
        for (const m of errMsgs.slice(-5)) console.log(`    • ${m}`);
      }
    }
  }

  console.log("\n" + "═".repeat(60));
}

main().catch((err) => {
  console.error("[doctor] 错误:", err);
  process.exit(1);
});
