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
//   'fallback'  — degraded time-window match (see findProxyRowForCall block comment)
//   'unmatched' — no proxy row found for this call at all
export type ProxyMatchMode = "exact" | "fallback" | "unmatched";

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

// Look up the proxy row for a JSONL call.
//
// Preferred path — exact match by Anthropic `request-id`:
//   JSONL assistant event 顶层 `requestId` ⇄ proxy_requests.request_id
//   （从 resHeaders["request-id"] 抽出）。这是 1:1 的确定性匹配，根治
//   "quota probe / 后台请求被误挂到真实 call 上" 之类的 false-positive。
//
// Fallback path — "closest proxy started at or before the JSONL timestamp":
//   ⚠️ This is a HACK and is NOT robust. It exists only because not every
//   upstream returns Anthropic's `request-id` header (notably the
//   `mcli.sankuai.com` gateway behind our local `mcli-proxy.dev`, which
//   issues its own `M-TraceId` instead). When that happens both sides lose
//   the exact key and we degrade to:
//       WHERE session_id = ? AND started_at <= ? ORDER BY ... DESC LIMIT 1
//
//   Known failure modes:
//     - 任何在 JSONL 之前发生、又没有对应 JSONL 记录的 proxy 请求都会"夹塞"
//       到真实 call 前面（quota probe / haiku 标题探测 / 重试 / 并发其它
//       会话共用同一 session_id 的请求）。
//     - 误差随并发度和延迟敏感：upstream 慢响应时 JSONL 时间戳可能晚于
//       某个无关请求的 started_at，从而被"最近的那个"贪婪地吃掉。
//     - excludeProxyId 只能避开"上一次刚选过的那一条"，挡不住更早的探测。
//
//   不修是因为：上游 `mcli.sankuai.com` 不透传 request-id，本地两层都没法
//   补出来；走 Anthropic 直连的 session 不受影响，精确路径已 100% 命中。
//   如果哪天 mcli 路径的误判频率高了，需要从上游网关层根治，而不是在这里
//   加更复杂的启发式（model / max_tokens / content 黑名单 等只是绕回老路）。
export interface ProxyRowMatch {
  row: ProxyRow;
  mode: "exact" | "fallback";
}

export function findProxyRowForCall(
  db: Database,
  sessionId: string,
  apiRequestId: string | null | undefined,
  fallbackTimestamp: string,
  excludeProxyId?: number,
): ProxyRowMatch | null {
  if (apiRequestId) {
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
    if (row) return { row, mode: "exact" };
  }
  // ⚠️ HACK fallback — see block comment above. Not robust; only correct
  // when the closest preceding proxy request happens to be the right one.
  const fallback = db.prepare(`
    SELECT id, jsonl_file, jsonl_byte_offset, req_headers, started_at
    FROM proxy_requests
    WHERE session_id = ?
      AND COALESCE(started_at, ts) <= ?
      ${excludeProxyId !== undefined ? "AND id != ?" : ""}
    ORDER BY COALESCE(started_at, ts) DESC
    LIMIT 1
  `).get(
    ...(excludeProxyId !== undefined
      ? [sessionId, fallbackTimestamp, excludeProxyId]
      : [sessionId, fallbackTimestamp])
  ) as ProxyRow | undefined;
  return fallback ? { row: fallback, mode: "fallback" } : null;
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
    SELECT request_id, COALESCE(started_at, ts) AS ts
    FROM proxy_requests
    WHERE session_id = ?
  `).all(sessionId) as Array<{ request_id: string | null; ts: string | null }>;

  if (rows.length === 0) {
    for (const c of calls) result.set(c.id, "unmatched");
    return result;
  }

  const byRequestId = new Set<string>();
  let minTs: string | null = null;
  for (const r of rows) {
    if (r.request_id) byRequestId.add(r.request_id);
    if (r.ts && (minTs === null || r.ts < minTs)) minTs = r.ts;
  }

  for (const c of calls) {
    if (c.apiRequestId && byRequestId.has(c.apiRequestId)) {
      result.set(c.id, "exact");
    } else if (minTs !== null && minTs <= c.timestamp) {
      // Some proxy row started at or before this call → fallback path
      // would have picked one. We don't replay the picker; existence is
      // enough to distinguish "fallback-matched" from "no proxy at all".
      result.set(c.id, "fallback");
    } else {
      result.set(c.id, "unmatched");
    }
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
  const match = findProxyRowForCall(db, sessionId, apiRequestId, callTimestamp);
  if (!match) return { ...base, proxyRequestId: null, proxyMatchMode: "unmatched", rawRequestJson: null };

  const { row: proxyRow, mode } = match;
  const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
  if (!rec) return { ...base, proxyRequestId: proxyRow.id, proxyMatchMode: mode, rawRequestJson: null };

  const reqBody = rec.reqBody as string | undefined;
  let rawReqParsed: Record<string, unknown> | null = null;
  if (typeof reqBody === "string") {
    try { rawReqParsed = JSON.parse(reqBody) as Record<string, unknown>; }
    catch { /* not JSON */ }
  }
  return { ...base, proxyRequestId: proxyRow.id, proxyMatchMode: mode, rawRequestJson: rawReqParsed };
}
