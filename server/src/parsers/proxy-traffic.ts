// Proxy traffic.jsonl 解析器 —— B2.1。
// 读取 ~/.api-dashboard/proxy/traffic.jsonl，解析为 ProxyRequest 记录。
// 复用既有的 watcher + parser 模式（sync.ts），新增数据源。
import { createReadStream, existsSync } from "node:fs";
import readline from "node:readline";

export interface ProxyRequest {
  ts: string;
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
  // B1.1: 流式响应的 resBody 格式为 "[sse N events, M bytes]"
  const sseMatch = resBody.match(/^\[sse (\d+) events, (\d+) bytes\]$/);
  const isStream = !!sseMatch;
  const sseEventCount = sseMatch ? Number(sseMatch[1]) : 0;

  const meta = (rec.meta as Record<string, unknown>) ?? {};
  const durationMs = typeof meta.durationMs === "number" ? meta.durationMs : null;

  // 估算字节数（从 headers 中读 content-length，否则用 body 长度估算）
  const resHeaders = (rec.resHeaders as Record<string, string>) ?? {};
  const reqHeaders = (rec.reqHeaders as Record<string, string>) ?? {};
  const bytesOut = Number(resHeaders["content-length"] ?? resHeaders["Content-Length"] ?? 0);
  const bytesIn = Number(reqHeaders["content-length"] ?? reqHeaders["Content-Length"] ?? 0);

  return {
    ts: (rec.ts as string) ?? new Date().toISOString(),
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
