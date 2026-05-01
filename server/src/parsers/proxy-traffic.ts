// Proxy traffic.jsonl 解析器 —— B2.1。
// 读取 ~/.api-dashboard/proxy/traffic.jsonl，解析为 ProxyRequest 记录。
// 复用既有的 watcher + parser 模式（sync.ts），新增数据源。
import { createReadStream, existsSync } from "node:fs";
import readline from "node:readline";

export interface ProxyRequest {
  ts: string;
  started_at: string;
  sni: string;
  method: string;
  url: string;
  status: number | null;
  bytes_in: number;
  bytes_out: number;
  duration_ms: number | null;
  req_headers: string; // JSON 字符串
  res_headers: string; // JSON 字符串
  req_body: string;
  res_body: string;
  // B1.3: body 编码标记（"utf8" | "base64"）；老数据缺省为 "utf8"
  req_body_encoding: "utf8" | "base64";
  res_body_encoding: "utf8" | "base64";
  // SSE 专用字段
  sse_event_count: number;
  is_stream: boolean;
}

// 解析单行 JSONL → ProxyRequest | null（非 response 类型跳过）
export function parseTrafficLine(line: string): ProxyRequest | null {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (rec.kind !== "response") return null;

  const resBody = (rec.resBody as string) ?? "";
  const meta = (rec.meta as Record<string, unknown>) ?? {};

  // B1.3: 优先读 meta.isStream / meta.sseEventCount（新格式）；
  // 旧格式回退到 resBody 里 "[sse N events, M bytes]" 的 placeholder 解析（兼容历史 jsonl）。
  let isStream: boolean;
  let sseEventCount: number;
  if (typeof meta.isStream === "boolean") {
    isStream = meta.isStream;
    sseEventCount = typeof meta.sseEventCount === "number" ? meta.sseEventCount : 0;
  } else {
    const sseMatch = resBody.match(/^\[sse (\d+) events, (\d+) bytes\]$/);
    isStream = !!sseMatch;
    sseEventCount = sseMatch ? Number(sseMatch[1]) : 0;
  }

  const durationMs = typeof meta.durationMs === "number" ? meta.durationMs : null;
  const ts = (rec.ts as string) ?? new Date().toISOString();
  const startedAt = (rec.startedAt as string) ?? ts;

  // 估算字节数（从 headers 中读 content-length，否则用 body 长度估算）
  const resHeaders = (rec.resHeaders as Record<string, string>) ?? {};
  const reqHeaders = (rec.reqHeaders as Record<string, string>) ?? {};
  const bytesOut = Number(resHeaders["content-length"] ?? resHeaders["Content-Length"] ?? 0);
  const bytesIn = Number(reqHeaders["content-length"] ?? reqHeaders["Content-Length"] ?? 0);

  const reqBodyEncoding = ((rec.reqBodyEncoding as string) ?? "utf8") === "base64" ? "base64" : "utf8";
  const resBodyEncoding = ((rec.resBodyEncoding as string) ?? "utf8") === "base64" ? "base64" : "utf8";

  return {
    ts,
    started_at: startedAt,
    sni: (rec.sni as string) ?? "",
    method: (rec.method as string) ?? "GET",
    url: (rec.url as string) ?? "",
    status: typeof rec.status === "number" ? rec.status : null,
    bytes_in: bytesIn,
    bytes_out: bytesOut,
    duration_ms: durationMs,
    req_headers: JSON.stringify(reqHeaders),
    res_headers: JSON.stringify(resHeaders),
    req_body: (rec.reqBody as string) ?? "",
    res_body: resBody,
    req_body_encoding: reqBodyEncoding,
    res_body_encoding: resBodyEncoding,
    sse_event_count: sseEventCount,
    is_stream: isStream,
  };
}

// 解析整个 traffic.jsonl 文件，返回所有 response 记录
export async function parseTrafficFile(filePath: string): Promise<ProxyRequest[]> {
  if (!existsSync(filePath)) return [];
  const results: ProxyRequest[] = [];
  const rl = readline.createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const rec = parseTrafficLine(line);
    if (rec) results.push(rec);
  }
  return results;
}
