// Proxy traffic.jsonl 行解析器。
// 只暴露 parseTrafficLine（单行 → 结构化记录）；
// parseTrafficFile 已由 cache-sync-worker / cold-indexer 替代，不再导出。
import { createReadStream, existsSync } from "node:fs";
import readline from "node:readline";
import { extractProxyMeta } from "../proxy-v2/extractors/index.ts";
import type { ProxyMeta } from "../proxy-v2/extractors/index.ts";

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
  // SSE 专用字段
  sse_event_count: number;
  is_stream: boolean;
  // 文件定位（由调用方补充）
  jsonl_file: string;
  jsonl_byte_offset: number;
  // §5 meta (all nullable — extraction failure must not block the row)
  session_id: string | null;
  cli_tool: string | null;
  model: string | null;
  req_message_count: number | null;
  req_has_tools: number | null;   // stored as 0/1 for SQLite
  res_input_tokens: number | null;
  res_output_tokens: number | null;
  res_cache_creation_tokens: number | null;
  res_cache_read_tokens: number | null;
  res_stop_reason: string | null;
  error_class: string | null;
}

// Parse SSE text into a flat list of {eventType, data} for the extractor
function parseSseText(text: string): Array<{ eventType: string; data: string }> {
  const events: Array<{ eventType: string; data: string }> = [];
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    } else if (line === "" && dataLines.length > 0) {
      events.push({ eventType, data: dataLines.join("\n") });
      eventType = "message";
      dataLines.length = 0;
    }
  }
  return events;
}

// 解析单行 JSONL → ProxyRequest | null（非 response 类型跳过）
export function parseTrafficLine(line: string): Omit<ProxyRequest, "jsonl_file" | "jsonl_byte_offset"> | null {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (rec.kind !== "response") return null;

  const resBody = (rec.resBody as string) ?? "";
  const meta = (rec.meta as Record<string, unknown>) ?? {};

  let isStream: boolean;
  let sseEventCount: number;
  if (typeof meta.isStream === "boolean") {
    isStream = meta.isStream;
    sseEventCount = typeof meta.sseEventCount === "number" ? meta.sseEventCount : 0;
  } else {
    // 兼容旧格式：resBody 里 "[sse N events, M bytes]" 占位符
    const sseMatch = resBody.match(/^\[sse (\d+) events, (\d+) bytes\]$/);
    isStream = !!sseMatch;
    sseEventCount = sseMatch ? Number(sseMatch[1]) : 0;
  }

  const durationMs = typeof meta.durationMs === "number" ? meta.durationMs : null;
  const ts = (rec.ts as string) ?? new Date().toISOString();
  const startedAt = (rec.startedAt as string) ?? ts;

  const resHeaders = (rec.resHeaders as Record<string, string>) ?? {};
  const reqHeaders = (rec.reqHeaders as Record<string, string>) ?? {};
  const bytesOut = Number(resHeaders["content-length"] ?? resHeaders["Content-Length"] ?? 0);
  const bytesIn = Number(reqHeaders["content-length"] ?? reqHeaders["Content-Length"] ?? 0);
  const status = typeof rec.status === "number" ? rec.status : null;

  // Normalize to lowercase for extractor — JSONL preserves original casing (e.g. "X-Claude-Code-Session-Id")
  const reqHeadersLower: Record<string, string> = {};
  for (const [k, v] of Object.entries(reqHeaders)) reqHeadersLower[k.toLowerCase()] = v;

  // §5: extract meta — failure is silently swallowed, all fields default null
  let proxyMeta: ProxyMeta;
  try {
    const sseEvents = isStream ? parseSseText(resBody) : undefined;
    proxyMeta = extractProxyMeta({
      reqHeaders: reqHeadersLower,
      reqBody: typeof rec.reqBody === "string" ? rec.reqBody : null,
      resHeaders,
      resBody: typeof resBody === "string" ? resBody : null,
      status: status ?? 0,
      isStream,
      sseEvents,
    });
  } catch {
    proxyMeta = {
      cli_tool: null, session_id: null, model: null,
      req_message_count: null, req_has_tools: null,
      res_input_tokens: null, res_output_tokens: null,
      res_cache_creation_tokens: null, res_cache_read_tokens: null,
      res_stop_reason: null, error_class: null,
    };
  }

  return {
    ts,
    started_at: startedAt,
    sni: (rec.sni as string) ?? "",
    method: (rec.method as string) ?? "GET",
    url: (rec.url as string) ?? "",
    status,
    bytes_in: bytesIn,
    bytes_out: bytesOut,
    duration_ms: durationMs,
    req_headers: JSON.stringify(reqHeaders),
    res_headers: JSON.stringify(resHeaders),
    sse_event_count: sseEventCount,
    is_stream: isStream,
    ...proxyMeta,
    req_has_tools: proxyMeta.req_has_tools === null ? null : (proxyMeta.req_has_tools ? 1 : 0),
  };
}

// 保留仅供迁移脚本使用的文件全量解析（不再在 sync 主流程中调用）
export async function parseTrafficFile(filePath: string): Promise<Array<Omit<ProxyRequest, "jsonl_file" | "jsonl_byte_offset">>> {
  if (!existsSync(filePath)) return [];
  const results: Array<Omit<ProxyRequest, "jsonl_file" | "jsonl_byte_offset">> = [];
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
