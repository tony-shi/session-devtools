// call-detail.ts
// Loads a single LLM call's proxy request body from JSONL, parses it via
// context-ledger/proxy/snapshot-parser, and produces a structured CallDetail
// plus a diff against the previous call.
//
// Data sources:
//   Phase 1 (JSONL only):  top-level call metadata from session-drilldown-parser
//   Phase 2 (proxy JSONL): segment breakdown + inter-call diff via parseClaudeProxyRequest

import { createReadStream, existsSync } from "node:fs";
import { createGunzip } from "node:zlib";
import type { Database } from "better-sqlite3";
import { parseClaudeProxyRequest } from "./context-ledger/proxy/snapshot-parser.ts";
import type { ContextSegment } from "./context-ledger/types.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CallSegment {
  id: string;
  section: "system" | "tools" | "messages" | "metadata" | "unknown";
  category: string;
  label: string;
  role?: string;
  charCount: number;
  rawText: string;        // full text — frontend truncates as needed
  cacheHint: "read" | "write" | "none" | "unknown";
  rawHash: string;
}

export type DiffOp = "added" | "removed" | "changed" | "unchanged";

export interface SegmentDiff {
  op: DiffOp;
  section: "system" | "tools" | "messages" | "metadata" | "unknown";
  category: string;
  label: string;
  role?: string;
  charCount: number;
  charDelta: number;       // positive = grew, negative = shrank, 0 = unchanged/new/removed
  rawHash: string;
  rawText: string;
  prevRawText?: string;    // for "changed" segments: what it was before
}

export interface CallDetailTokens {
  contextSize: number;
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
  outputTokens: number;
}

export interface CallDetail {
  callId: number;          // global call id (LlmCall.id)
  sessionId: string;
  proxyRequestId: number | null;   // proxy_requests.id, null if no proxy data

  // Phase 1: always available from JSONL
  model: string;
  stopReason: string | null;
  timestamp: string;
  tokens: CallDetailTokens;

  // Phase 2: proxy-backed, null if no proxy record
  segments: CallSegment[] | null;
  diff: SegmentDiff[] | null;      // vs previous call; null if no proxy or first call
  rawRequestJson: Record<string, unknown> | null;
}

// ─── JSONL read helpers (copied from proxy-traffic.controller.ts) ─────────────

async function readLineFromGzip(filePath: string, offset: number): Promise<string> {
  const stream = createReadStream(filePath).pipe(createGunzip());
  let consumed = 0;
  let buffer = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const chunkLen = chunk.length;
    if (consumed + chunkLen <= offset) { consumed += chunkLen; continue; }
    const skipInChunk = Math.max(0, offset - consumed);
    buffer += chunk.slice(skipInChunk).toString("utf8");
    const newlineIdx = buffer.indexOf("\n");
    if (newlineIdx >= 0) return buffer.slice(0, newlineIdx);
    consumed += chunkLen;
  }
  return buffer;
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

// ─── Segment conversion ───────────────────────────────────────────────────────

function toCallSegment(seg: ContextSegment): CallSegment {
  return {
    id: seg.id,
    section: seg.section as CallSegment["section"],
    category: seg.category,
    label: seg.label,
    role: seg.role,
    charCount: seg.charCount ?? seg.rawText?.length ?? 0,
    rawText: seg.rawText ?? "",
    cacheHint: (seg.cacheHint as CallSegment["cacheHint"]) ?? "unknown",
    rawHash: seg.rawHash ?? "",
  };
}

// ─── Diff computation ─────────────────────────────────────────────────────────

function makeAdded(c: ContextSegment): SegmentDiff {
  return {
    op: "added",
    section: c.section as SegmentDiff["section"],
    category: c.category,
    label: c.label,
    role: c.role,
    charCount: c.charCount ?? c.rawText?.length ?? 0,
    charDelta: c.charCount ?? c.rawText?.length ?? 0,
    rawHash: c.rawHash ?? "",
    rawText: c.rawText ?? "",
  };
}

function makeRemoved(p: ContextSegment): SegmentDiff {
  return {
    op: "removed",
    section: p.section as SegmentDiff["section"],
    category: p.category,
    label: p.label,
    role: p.role,
    charCount: 0,
    charDelta: -(p.charCount ?? p.rawText?.length ?? 0),
    rawHash: p.rawHash ?? "",
    rawText: p.rawText ?? "",
  };
}

function makeCompared(p: ContextSegment, c: ContextSegment): SegmentDiff {
  const pChars = p.charCount ?? p.rawText?.length ?? 0;
  const cChars = c.charCount ?? c.rawText?.length ?? 0;
  if (p.rawHash && c.rawHash && p.rawHash === c.rawHash) {
    return {
      op: "unchanged",
      section: c.section as SegmentDiff["section"],
      category: c.category, label: c.label, role: c.role,
      charCount: cChars, charDelta: 0,
      rawHash: c.rawHash, rawText: c.rawText ?? "",
    };
  }
  return {
    op: "changed",
    section: c.section as SegmentDiff["section"],
    category: c.category, label: c.label, role: c.role,
    charCount: cChars, charDelta: cChars - pChars,
    rawHash: c.rawHash ?? "", rawText: c.rawText ?? "",
    prevRawText: p.rawText ?? "",
  };
}

function computeSegmentDiff(
  prev: ContextSegment[],
  curr: ContextSegment[],
): SegmentDiff[] {
  const result: SegmentDiff[] = [];
  const sections = ["system", "tools", "messages", "metadata", "unknown"] as const;

  for (const section of sections) {
    const prevSegs = prev.filter(s => s.section === section);
    const currSegs = curr.filter(s => s.section === section);

    if (section === "messages") {
      // Conversation messages only grow — new turns are appended at the end.
      // Align by common prefix (hash-based), then mark the tail as added.
      // This avoids false "changed" when new segments shift indices.
      const commonLen = Math.min(prevSegs.length, currSegs.length);
      for (let i = 0; i < commonLen; i++) {
        result.push(makeCompared(prevSegs[i], currSegs[i]));
      }
      // Anything beyond common prefix
      for (let i = commonLen; i < prevSegs.length; i++) result.push(makeRemoved(prevSegs[i]));
      for (let i = commonLen; i < currSegs.length; i++) result.push(makeAdded(currSegs[i]));
    } else {
      // system / tools: align by position (these don't shift on new turns)
      const maxLen = Math.max(prevSegs.length, currSegs.length);
      for (let i = 0; i < maxLen; i++) {
        const p = prevSegs[i], c = currSegs[i];
        if (!p && c) result.push(makeAdded(c));
        else if (p && !c) result.push(makeRemoved(p));
        else if (p && c) result.push(makeCompared(p, c));
      }
    }
  }

  return result;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

interface ProxyRow {
  id: number;
  jsonl_file: string;
  jsonl_byte_offset: number;
  req_headers: string | null;
  started_at: string | null;
}

// Look up the proxy row for a JSONL call. Exact match via API request-id
// (1:1 link between JSONL `requestId` and proxy_requests.request_id, extracted
// from response headers). Falls back to "closest proxy started at or before
// the JSONL timestamp" when request_id is unavailable — used both for legacy
// rows without request_id and as a safety net.
export function findProxyRowForCall(
  db: Database,
  sessionId: string,
  apiRequestId: string | null | undefined,
  fallbackTimestamp: string,
  excludeProxyId?: number,
): ProxyRow | null {
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
    if (row) return row;
  }
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
  return fallback ?? null;
}

export async function loadCallDetail(
  sessionId: string,
  callTimestamp: string,
  callModel: string,
  callTokens: CallDetailTokens,
  callStopReason: string | null,
  db: Database,
  callId: number,
  prevCallTimestamp?: string,
  apiRequestId?: string | null,
  prevApiRequestId?: string | null,
): Promise<CallDetail> {
  const proxyRow = findProxyRowForCall(db, sessionId, apiRequestId, callTimestamp);

  if (!proxyRow) {
    return {
      callId, sessionId, proxyRequestId: null,
      model: callModel, stopReason: callStopReason, timestamp: callTimestamp,
      tokens: callTokens,
      segments: null, diff: null, rawRequestJson: null,
    };
  }

  const rec = await readProxyRecord(proxyRow.jsonl_file, proxyRow.jsonl_byte_offset);
  if (!rec) {
    return {
      callId, sessionId, proxyRequestId: proxyRow.id,
      model: callModel, stopReason: callStopReason, timestamp: callTimestamp,
      tokens: callTokens,
      segments: null, diff: null, rawRequestJson: null,
    };
  }

  const reqBody = rec.reqBody as string | undefined;
  const reqHeaders = (() => {
    try { return JSON.parse(proxyRow.req_headers ?? "{}") as Record<string, string>; }
    catch { return {}; }
  })();

  let rawReqParsed: Record<string, unknown> | null = null;
  if (typeof reqBody === "string") {
    try { rawReqParsed = JSON.parse(reqBody) as Record<string, unknown>; }
    catch { /* not JSON */ }
  }

  if (!rawReqParsed) {
    return {
      callId, sessionId, proxyRequestId: proxyRow.id,
      model: callModel, stopReason: callStopReason, timestamp: callTimestamp,
      tokens: callTokens,
      segments: null, diff: null, rawRequestJson: null,
    };
  }

  // Parse current call via context-ledger
  const snapshot = parseClaudeProxyRequest({
    ts: proxyRow.started_at ?? callTimestamp,
    reqHeaders,
    reqBody: rawReqParsed as Parameters<typeof parseClaudeProxyRequest>[0]["reqBody"],
  }, { proxyFile: proxyRow.jsonl_file });

  const segments = snapshot.segments.map(toCallSegment);

  // Diff: find the previous call's proxy row using the same strategy
  let diff: SegmentDiff[] | null = null;
  if (prevCallTimestamp) {
    const prevRow = findProxyRowForCall(
      db, sessionId, prevApiRequestId, prevCallTimestamp, proxyRow.id,
    );
    if (prevRow) {
      const prevRec = await readProxyRecord(prevRow.jsonl_file, prevRow.jsonl_byte_offset);
      const prevReqBody = prevRec?.reqBody as string | undefined;
      let prevReqParsed: Record<string, unknown> | null = null;
      if (typeof prevReqBody === "string") {
        try { prevReqParsed = JSON.parse(prevReqBody) as Record<string, unknown>; }
        catch { /* ignore */ }
      }
      if (prevReqParsed) {
        const prevReqHeaders = (() => {
          try { return JSON.parse(prevRow.req_headers ?? "{}") as Record<string, string>; }
          catch { return {}; }
        })();
        const prevSnapshot = parseClaudeProxyRequest({
          ts: prevRow.started_at ?? prevCallTimestamp,
          reqHeaders: prevReqHeaders,
          reqBody: prevReqParsed as Parameters<typeof parseClaudeProxyRequest>[0]["reqBody"],
        }, { proxyFile: prevRow.jsonl_file });
        diff = computeSegmentDiff(prevSnapshot.segments, snapshot.segments);
      }
    }
  }

  return {
    callId, sessionId, proxyRequestId: proxyRow.id,
    model: callModel, stopReason: callStopReason, timestamp: callTimestamp,
    tokens: callTokens,
    segments, diff, rawRequestJson: rawReqParsed,
  };
}
