// call-detail.ts
// Loads a single LLM call's proxy request body from JSONL and returns
// a lightweight summary the v2 UI consumes.
//
// PR8 起删除了 segment / diff 路径（前端不再消费；segment-level diff 由
// AttributionTreeDiff/DiffPanel 提供，attribution 视角由 loadAttributionTree 提供）。
// 现在 call-detail 只承担两件事：
//   1. 查询 proxy_requests 表里对应这个 call 的行（findProxyRowForCall）
//   2. 读出原始 reqBody JSON 给前端 raw tab 用

import { createReadStream, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import type { Database } from "better-sqlite3";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CallDetailTokens {
  contextSize: number;
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
  outputTokens: number;
}

// Per-call proxy linking quality.
//   'exact'     — JSONL.requestId matched proxy_requests.request_id (1:1, trustworthy)
//   'unmatched' — no proxy row found (either JSONL has no requestId, or proxy has
//                 no matching row). Time-window heuristics are intentionally NOT
//                 used: they routinely mis-attribute background probes / parallel
//                 sub-agent traffic to the wrong call.
export type ProxyMatchMode = "exact" | "unmatched";

export interface CallDetail {
  callId: number;
  sessionId: string;
  proxyRequestId: number | null;
  // 'unmatched' when proxyRequestId is null; otherwise reflects how the row
  // was located. Front-end uses this to badge calls whose proxy data is not
  // 100% trustworthy.
  proxyMatchMode: ProxyMatchMode;

  // Phase 1: always available from JSONL
  model: string;
  stopReason: string | null;
  timestamp: string;
  tokens: CallDetailTokens;

  // Phase 2: proxy-backed, null if no proxy record
  rawRequestJson: Record<string, unknown> | null;
}

// ─── JSONL read helpers (copied from proxy-traffic.controller.ts) ─────────────

// CORNER CASE: gzip decompression streams produce chunks whose boundaries can
// fall in the middle of a multi-byte UTF-8 sequence (e.g. a 3-byte CJK char
// like "下" = E4 B8 8B). Calling chunk.toString("utf8") on each chunk
// independently replaces the split bytes with U+FFFD, corrupting the string.
// Two proxy records at different offsets in different .gz files may hit the
// boundary differently → same content produces different rawText → different
// rawHash → computeTreeDiff marks the node "added/removed" instead of
// "unchanged", surfacing as a spurious "modified" leaf in the diff view.
// Fix: use StringDecoder, which buffers incomplete multi-byte sequences across
// chunk boundaries and flushes them when the next chunk arrives.
async function readLineFromGzip(filePath: string, offset: number): Promise<string> {
  const stream = createReadStream(filePath).pipe(createGunzip());
  const decoder = new StringDecoder("utf8");
  let consumed = 0;
  let buffer = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const chunkLen = chunk.length;
    if (consumed + chunkLen <= offset) { consumed += chunkLen; continue; }
    const skipInChunk = Math.max(0, offset - consumed);
    buffer += decoder.write(chunk.slice(skipInChunk));
    const newlineIdx = buffer.indexOf("\n");
    if (newlineIdx >= 0) return buffer.slice(0, newlineIdx);
    consumed += chunkLen;
  }
  return buffer + decoder.end();
}

async function readLineFromPlain(filePath: string, offset: number): Promise<string> {
  const { openSync, readSync, closeSync } = await import("node:fs");
  const fd = openSync(filePath, "r");
  try {
    const maxRead = 4 * 1024 * 1024; // 4 MB — large requests can be big
    const buf = Buffer.alloc(maxRead);
    const bytesRead = readSync(fd, buf, 0, maxRead, offset);
    const text = buf.slice(0, bytesRead).toString("utf8");
    const newlineIdx = text.indexOf("\n");
    return newlineIdx >= 0 ? text.slice(0, newlineIdx) : text;
  } finally {
    closeSync(fd);
  }
}

export async function readProxyRecord(
  jsonlFile: string,
  byteOffset: number,
): Promise<Record<string, unknown> | null> {
  if (!existsSync(jsonlFile)) return null;
  try {
    const line = jsonlFile.endsWith(".gz")
      ? await readLineFromGzip(jsonlFile, byteOffset)
      : await readLineFromPlain(jsonlFile, byteOffset);
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Main entry ───────────────────────────────────────────────────────────────

interface ProxyRow {
  id: number;
  jsonl_file: string;
  jsonl_byte_offset: number;
  req_headers: string | null;
  started_at: string | null;
}

// Look up the proxy row for a JSONL call by exact Anthropic `request-id`.
//
//   JSONL assistant event 顶层 `requestId` ⇄ proxy_requests.request_id
//   （从 resHeaders["request-id"] 抽出）。1:1 确定性匹配。
//
// 没有 requestId（旧版本 Claude Code 或某些 gateway 不透传 request-id）一律
// 返回 null —— 不再走 timestamp 兜底，宁可显示"无 proxy"也不接受可能错误
// 的归因（典型坑：sub-agent 与主会话共用 session_id，时间窗会把并行 sub-agent
// 的请求错挂到主 call 上）。
export function findProxyRowForCall(
  db: Database,
  sessionId: string,
  apiRequestId: string | null | undefined,
  excludeProxyId?: number,
): ProxyRow | null {
  if (!apiRequestId) return null;
  const row = db.prepare(`
    SELECT id, jsonl_file, jsonl_byte_offset, req_headers, started_at
    FROM proxy_requests
    WHERE session_id = ? AND request_id = ?
    ${excludeProxyId !== undefined ? "AND id != ?" : ""}
    LIMIT 1
  `).get(
    ...(excludeProxyId !== undefined
      ? [sessionId, apiRequestId, excludeProxyId]
      : [sessionId, apiRequestId])
  ) as ProxyRow | undefined;
  return row ?? null;
}

// Batch classifier for the session drilldown. One SQL query loads every
// proxy row for the session; per-call matching is then resolved in memory.
// Avoids N+1 lookups across a session with hundreds of calls.
export function computeCallProxyMatchModes(
  db: Database,
  sessionId: string,
  calls: ReadonlyArray<{ id: number; apiRequestId: string | null; timestamp: string }>,
): Map<number, ProxyMatchMode> {
  const result = new Map<number, ProxyMatchMode>();
  if (calls.length === 0) return result;

  const rows = db.prepare(`
    SELECT request_id FROM proxy_requests
    WHERE session_id = ? AND request_id IS NOT NULL
  `).all(sessionId) as Array<{ request_id: string }>;

  const byRequestId = new Set<string>(rows.map((r) => r.request_id));
  for (const c of calls) {
    result.set(c.id, c.apiRequestId && byRequestId.has(c.apiRequestId) ? "exact" : "unmatched");
  }
  return result;
}

export async function loadCallDetail(
  sessionId: string,
  callTimestamp: string,
  callModel: string,
  callTokens: CallDetailTokens,
  callStopReason: string | null,
  db: Database,
  callId: number,
  _prevCallTimestamp?: string,
  apiRequestId?: string | null,
  _prevApiRequestId?: string | null,
): Promise<CallDetail> {
  const base = {
    callId, sessionId,
    model: callModel, stopReason: callStopReason, timestamp: callTimestamp,
    tokens: callTokens,
  };
  const proxyRow = findProxyRowForCall(db, sessionId, apiRequestId);
  if (!proxyRow) return { ...base, proxyRequestId: null, proxyMatchMode: "unmatched", rawRequestJson: null };

  const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
  if (!rec) return { ...base, proxyRequestId: proxyRow.id, proxyMatchMode: "exact", rawRequestJson: null };

  const reqBody = rec.reqBody as string | undefined;
  let rawReqParsed: Record<string, unknown> | null = null;
  if (typeof reqBody === "string") {
    try { rawReqParsed = JSON.parse(reqBody) as Record<string, unknown>; }
    catch { /* not JSON */ }
  }
  return { ...base, proxyRequestId: proxyRow.id, proxyMatchMode: "exact", rawRequestJson: rawReqParsed };
}
