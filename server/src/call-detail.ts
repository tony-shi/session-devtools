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
//   'unmatched' — no proxy row found.
//
// 代理站会剥掉 Anthropic 的 `request-id` 响应头，导致两端都拿不到。
// proxy-v2/server/index.ts 的 injectSyntheticRequestId 在响应转发前补一个
// 合成 `proxy-<uuid>`，确保两侧字符串一致 —— 因此 exact 永远成立，没有
// 兜底通道，所有匹配失败一律 unmatched，不做时间窗 / 启发式归因。
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
  rawResponseJson?: Record<string, unknown> | null;
  rawResponseText?: string | null;
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

// 用 JSONL 这一面已知的"证据"来定位 proxy 行。
// hint 对象保留是为了将来增加替代匹配键（比如 x-stainless-request-id 之类）时
// 不需要再动 5 个 callsite。当前只用 apiRequestId 做 1:1 精确匹配。
export interface ProxyMatchHint {
  // Anthropic-issued request-id（JSONL.assistant.requestId）。1:1 匹配的硬证据。
  // 代理站剥掉响应头时，proxy-v2/server/index.ts:injectSyntheticRequestId 会合成
  // 一个 `proxy-<uuid>` 注入响应头，保证 JSONL 与 proxy_requests 两侧字符串一致。
  apiRequestId?: string | null;
  // 排除某个 proxy 行 id（attribution 比较 prev/cur 时去重用）。
  excludeProxyId?: number;
}

// 根据 JSONL 端给的 requestId 在 proxy_requests 里查 1:1 行。
// 没有 requestId 或查不到时一律返回 null（→ matchMode: "unmatched"），
// 不做任何启发式归因——proxy 注入了合成 ID，正常流量永远走 exact。
export function findProxyRowForCall(
  db: Database,
  sessionId: string,
  hint: ProxyMatchHint,
): ProxyRow | null {
  const { apiRequestId, excludeProxyId } = hint;
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
// Batch 输入条目。结构开放，将来增加替代匹配键时不需要改 caller 形状。
export interface CallMatchInput {
  id: number;
  apiRequestId: string | null;
}

export function computeCallProxyMatchModes(
  db: Database,
  sessionId: string,
  calls: ReadonlyArray<CallMatchInput>,
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
  const proxyRow = findProxyRowForCall(db, sessionId, { apiRequestId });
  if (!proxyRow) return { ...base, proxyRequestId: null, proxyMatchMode: "unmatched", rawRequestJson: null };

  const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
  if (!rec) return { ...base, proxyRequestId: proxyRow.id, proxyMatchMode: "exact", rawRequestJson: null };

  const reqBody = rec.reqBody as string | undefined;
  const resBody = rec.resBody as string | undefined;
  let rawReqParsed: Record<string, unknown> | null = null;
  if (typeof reqBody === "string") {
    try { rawReqParsed = JSON.parse(reqBody) as Record<string, unknown>; }
    catch { /* not JSON */ }
  }
  let rawResParsed: Record<string, unknown> | null = null;
  if (typeof resBody === "string") {
    try { rawResParsed = JSON.parse(resBody) as Record<string, unknown>; }
    catch { /* not JSON */ }
  }
  return {
    ...base,
    proxyRequestId: proxyRow.id,
    proxyMatchMode: "exact",
    rawRequestJson: rawReqParsed,
    rawResponseJson: rawResParsed,
    rawResponseText: resBody ?? null
  };
}
