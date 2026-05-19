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
//   'exact'       — JSONL.requestId matched proxy_requests.request_id (1:1, trustworthy)
//   'time-window' — JSONL has no requestId (典型：经代理站，Anthropic 的 request-id header
//                   被剥掉两端都空)，按 (session_id, 最近 started_at) 兜底匹配。临时开放，
//                   sub-agent 并发场景下可能错挂——可接受。
//   'unmatched'   — no proxy row found.
export type ProxyMatchMode = "exact" | "time-window" | "unmatched";

// 时间窗兜底容差。代理站常带可观察的延迟（排队 / 转发 / 重试），所以放到 ±60s。
const TIME_WINDOW_TOLERANCE_MS = 60_000;

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
  matchMode: ProxyMatchMode;  // "exact" | "time-window" — 调用方据此打 badge
}

// Look up the proxy row for a JSONL call.
//
// 优先级：
//   1. Exact —— JSONL assistant.requestId ⇄ proxy_requests.request_id
//      （proxy 从 resHeaders["request-id"] 抽出）。1:1 确定性匹配。
//   2. Time-window 兜底 —— 仅当 JSONL 这边没有 requestId 时启用。代理站通常会
//      剥掉 Anthropic 的 request-id 响应头，于是两端对称失明；这种情况下按
//      (session_id, 最近 started_at) 匹配总比直接 unmatched 强。容差 ±60s。
//      已知风险：sub-agent 与主会话共用 session_id 时可能错挂；临时开放。
//
// 当 JSONL 有 requestId 但找不到对应 proxy 行时，**不**走时间窗——这种情形要
// 么是 proxy 还没 ingest 完，要么是真的错配，再兜底反而会污染归因。
export function findProxyRowForCall(
  db: Database,
  sessionId: string,
  apiRequestId: string | null | undefined,
  excludeProxyId?: number,
  callTimestamp?: string | null,
): ProxyRow | null {
  // 1. Exact match path
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
    ) as Omit<ProxyRow, "matchMode"> | undefined;
    if (row) return { ...row, matchMode: "exact" };
    return null;
  }

  // 2. Time-window fallback — only when JSONL has no requestId.
  if (!callTimestamp) return null;
  const callTsMs = Date.parse(callTimestamp);
  if (!Number.isFinite(callTsMs)) return null;

  const rows = db.prepare(`
    SELECT id, jsonl_file, jsonl_byte_offset, req_headers, started_at
    FROM proxy_requests
    WHERE session_id = ? AND started_at IS NOT NULL
    ${excludeProxyId !== undefined ? "AND id != ?" : ""}
  `).all(
    ...(excludeProxyId !== undefined ? [sessionId, excludeProxyId] : [sessionId])
  ) as Array<Omit<ProxyRow, "matchMode">>;

  let best: { row: Omit<ProxyRow, "matchMode">; delta: number } | null = null;
  for (const r of rows) {
    const t = Date.parse(r.started_at!);
    if (!Number.isFinite(t)) continue;
    const delta = Math.abs(t - callTsMs);
    if (delta > TIME_WINDOW_TOLERANCE_MS) continue;
    if (!best || delta < best.delta) best = { row: r, delta };
  }
  return best ? { ...best.row, matchMode: "time-window" } : null;
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
    SELECT request_id, started_at FROM proxy_requests
    WHERE session_id = ?
  `).all(sessionId) as Array<{ request_id: string | null; started_at: string | null }>;

  const byRequestId = new Set<string>();
  const sortedTsMs: number[] = [];
  for (const r of rows) {
    if (r.request_id) byRequestId.add(r.request_id);
    if (r.started_at) {
      const t = Date.parse(r.started_at);
      if (Number.isFinite(t)) sortedTsMs.push(t);
    }
  }
  sortedTsMs.sort((a, b) => a - b);

  for (const c of calls) {
    if (c.apiRequestId && byRequestId.has(c.apiRequestId)) {
      result.set(c.id, "exact");
      continue;
    }
    if (!c.apiRequestId && sortedTsMs.length > 0) {
      const callTsMs = Date.parse(c.timestamp);
      if (Number.isFinite(callTsMs)) {
        // 二分找最近 started_at
        let lo = 0, hi = sortedTsMs.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sortedTsMs[mid]! < callTsMs) lo = mid + 1; else hi = mid;
        }
        const candidates: number[] = [];
        if (lo < sortedTsMs.length) candidates.push(sortedTsMs[lo]!);
        if (lo > 0) candidates.push(sortedTsMs[lo - 1]!);
        const bestDelta = candidates.length > 0
          ? Math.min(...candidates.map((t) => Math.abs(t - callTsMs)))
          : Infinity;
        if (bestDelta <= TIME_WINDOW_TOLERANCE_MS) {
          result.set(c.id, "time-window");
          continue;
        }
      }
    }
    result.set(c.id, "unmatched");
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
  const proxyRow = findProxyRowForCall(db, sessionId, apiRequestId, undefined, callTimestamp);
  if (!proxyRow) return { ...base, proxyRequestId: null, proxyMatchMode: "unmatched", rawRequestJson: null };

  const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
  if (!rec) return { ...base, proxyRequestId: proxyRow.id, proxyMatchMode: proxyRow.matchMode, rawRequestJson: null };

  const reqBody = rec.reqBody as string | undefined;
  let rawReqParsed: Record<string, unknown> | null = null;
  if (typeof reqBody === "string") {
    try { rawReqParsed = JSON.parse(reqBody) as Record<string, unknown>; }
    catch { /* not JSON */ }
  }
  return { ...base, proxyRequestId: proxyRow.id, proxyMatchMode: proxyRow.matchMode, rawRequestJson: rawReqParsed };
}
