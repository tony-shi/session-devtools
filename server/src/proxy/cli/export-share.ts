// 导出/分享工具 —— B1.3。
// 产出"安全可外发"的快照：脱敏 + 大 body 截断 + 时间窗口过滤。
// 默认本地存储仍然明文（与 sessions.db 同级隐私模型）。
// 用法: bun run proxy:export-share [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--out snapshot.jsonl]
import { existsSync, createReadStream, createWriteStream } from "node:fs";
import readline from "node:readline";
import { PATHS } from "../config";

const BODY_TRUNCATE = 4 * 1024; // 脱敏快照里 body 最多保留 4KB
const REDACT_HEADERS = new Set(["authorization", "x-api-key", "proxy-authorization"]);

function redactHeaders(h: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!h) return h;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (REDACT_HEADERS.has(k.toLowerCase())) {
      out[k] = v.length > 12 ? `${v.slice(0, 8)}…[redacted]` : "[redacted]";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function truncateBody(body: string | undefined): string | undefined {
  if (!body) return body;
  if (body.length <= BODY_TRUNCATE) return body;
  return `${body.slice(0, BODY_TRUNCATE)}…[truncated ${body.length - BODY_TRUNCATE} chars]`;
}

async function main() {
  const args = process.argv.slice(2);
  const fromIdx = args.indexOf("--from");
  const toIdx = args.indexOf("--to");
  const outIdx = args.indexOf("--out");

  const fromDate = fromIdx >= 0 ? args[fromIdx + 1] : undefined;
  const toDate = toIdx >= 0 ? args[toIdx + 1] : undefined;
  const outPath = outIdx >= 0 ? args[outIdx + 1] : `traffic-share-${new Date().toISOString().slice(0, 10)}.jsonl`;

  if (!existsSync(PATHS.trafficLog)) {
    console.error(`[export-share] traffic.jsonl 不存在: ${PATHS.trafficLog}`);
    process.exit(1);
  }

  const out = createWriteStream(outPath, { mode: 0o644 });
  const rl = readline.createInterface({ input: createReadStream(PATHS.trafficLog), crlfDelay: Infinity });

  let total = 0, exported = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    total++;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // 时间窗口过滤
    const ts = rec.ts as string | undefined;
    if (ts) {
      if (fromDate && ts < fromDate) continue;
      if (toDate && ts > toDate + "T23:59:59Z") continue;
    }
    // 脱敏
    const sanitized = {
      ...rec,
      reqHeaders: redactHeaders(rec.reqHeaders as Record<string, string> | undefined),
      reqBody: truncateBody(rec.reqBody as string | undefined),
      resBody: truncateBody(rec.resBody as string | undefined),
      sseData: truncateBody(rec.sseData as string | undefined),
    };
    out.write(JSON.stringify(sanitized) + "\n");
    exported++;
  }
  out.end();

  console.log(`[export-share] 共 ${total} 条记录，导出 ${exported} 条 → ${outPath}`);
  if (fromDate || toDate) {
    console.log(`  时间范围: ${fromDate ?? "(起始)"} ~ ${toDate ?? "(现在)"}`);
  }
  console.log("  已脱敏: Authorization / x-api-key / Proxy-Authorization");
  console.log(`  body 截断至 ${BODY_TRUNCATE / 1024}KB`);
}

main().catch((err) => {
  console.error("[export-share] 错误:", err);
  process.exit(1);
});
