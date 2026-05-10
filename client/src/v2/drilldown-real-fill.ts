// ─── drilldown-real-fill.ts ───────────────────────────────────────────────────
// Derives display-ready metrics from real SessionDrilldown data.
// Each function is a "best-effort" fill — it uses what the backend provides
// and returns sensible nulls/zeros for fields not yet computed.
//
// Fill status per field:
//   ✓ = computed from real data
//   ~ = estimated / heuristic
//   ✗ = not yet available (returns mock placeholder)

import type { SessionDrilldown, UserTurn, LlmCall } from "./drilldown-types";

// ─── Duration formatter ───────────────────────────────────────────────────────

export function fmtMs(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// ─── Session-level derived metrics ───────────────────────────────────────────

export interface SessionMetrics {
  // ✓ real
  title: string | null;
  subAgentCount: number;      // ✓ from drilldown.subAgentCount
  totalLlmCalls: number;
  totalToolCalls: number;
  peakContext: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalFreshIn: number;
  totalFreshOut: number;
  systemErrorCount: number;
  contextWindowSize: number;
  hasProxyData: boolean;
  durationMs: number;           // ✓ last_event - first_event
  durationStr: string;

  // ~ estimated
  cacheRatio: number | null;    // ~ cache_read / total input tokens
  netContext: number | null;    // ✓ last call ctx - first call ctx

  // Model info
  modelNames: string[];         // ✓ from modelBreakdown keys
  dominantModel: string | null; // ✓ model with most calls
  isSingleModel: boolean;       // ✓
}

export function deriveSessionMetrics(d: SessionDrilldown): SessionMetrics {
  const durationMs = d.firstEventAt && d.lastEventAt
    ? Math.max(0, new Date(d.lastEventAt).getTime() - new Date(d.firstEventAt).getTime())
    : 0;

  const totalInput = d.totalFreshIn + d.totalCacheWrite + d.totalCacheRead;
  const cacheRatio = totalInput > 0 ? d.totalCacheRead / totalInput * 100 : null;

  // Net context: last call in last turn → first call in first turn
  const allCalls = d.turns.flatMap(t => t.calls);
  const netContext = allCalls.length >= 2
    ? allCalls[allCalls.length - 1].contextSize - allCalls[0].contextSize
    : null;

  const modelNames = Object.keys(d.modelBreakdown ?? {});
  const dominantModel = modelNames.length > 0
    ? modelNames.sort((a, b) => (d.modelBreakdown[b]?.calls ?? 0) - (d.modelBreakdown[a]?.calls ?? 0))[0]
    : null;

  return {
    title: d.title,
    subAgentCount: d.subAgentCount,
    totalLlmCalls: d.totalLlmCalls,
    totalToolCalls: d.totalToolCalls,
    peakContext: d.peakContext,
    totalCacheRead: d.totalCacheRead,
    totalCacheWrite: d.totalCacheWrite,
    totalFreshIn: d.totalFreshIn,
    totalFreshOut: d.totalFreshOut,
    systemErrorCount: d.systemErrorCount,
    contextWindowSize: d.contextWindowSize,
    hasProxyData: d.hasProxyData,
    durationMs,
    durationStr: fmtMs(durationMs),
    cacheRatio,
    netContext,
    modelNames,
    dominantModel,
    isSingleModel: modelNames.length <= 1,
  };
}

// ─── Turn-level derived metrics ───────────────────────────────────────────────

export interface TurnMetrics {
  // ✓ real
  userInput: string;
  finalOutput: string | null;
  durationMs: number;
  durationStr: string;
  llmCallCount: number;
  toolCallCount: number;
  peakContext: number;
  cacheRead: number;
  cacheWrite: number;
  hasCompaction: boolean;

  // ✓ computed
  netContextDelta: number;      // last call ctx - first call ctx in turn
  freshIn: number;              // sum of (ctx - cacheRead - cacheWrite) per call
  freshOut: number;             // sum of outputTokens
  cacheRatio: number | null;

  // ~ estimated
  unknownDelta: number;         // always 0 in v1 (not computed)

  // Risk flags
  isNearLimit: boolean;         // peak > 85% of window
  riskFlags: Array<"compaction" | "near-limit" | "large-growth" | "tool-heavy">;
}

export function deriveTurnMetrics(turn: UserTurn, contextWindowSize: number): TurnMetrics {
  const calls = turn.calls;
  const firstCtx = calls[0]?.contextSize ?? 0;
  const lastCtx  = calls[calls.length - 1]?.contextSize ?? 0;
  const netContextDelta = lastCtx - firstCtx;

  const freshIn  = calls.reduce((s, c) => s + Math.max(c.contextSize - c.cacheRead - c.cacheWrite, 0), 0);
  const freshOut = calls.reduce((s, c) => s + c.outputTokens, 0);
  const totalInput = freshIn + turn.cacheWrite + turn.cacheRead;
  const cacheRatio = totalInput > 0 ? turn.cacheRead / totalInput * 100 : null;

  const isNearLimit = turn.peakContext > contextWindowSize * 0.85;
  const riskFlags: TurnMetrics["riskFlags"] = [];
  if (turn.hasCompaction) riskFlags.push("compaction");
  if (isNearLimit)        riskFlags.push("near-limit");
  if (Math.abs(netContextDelta) > 20_000) riskFlags.push("large-growth");

  return {
    userInput: turn.userInput,
    finalOutput: turn.finalOutput,
    durationMs: turn.durationMs,
    durationStr: fmtMs(turn.durationMs),
    llmCallCount: turn.llmCallCount,
    toolCallCount: turn.toolCallCount,
    peakContext: turn.peakContext,
    cacheRead: turn.cacheRead,
    cacheWrite: turn.cacheWrite,
    hasCompaction: turn.hasCompaction,
    netContextDelta,
    freshIn,
    freshOut,
    cacheRatio,
    unknownDelta: turn.unknownDelta,
    isNearLimit,
    riskFlags,
  };
}

// ─── Call-level derived metrics ───────────────────────────────────────────────

export interface CallMetrics {
  // ✓ real
  id: number;
  indexInTurn: number;
  contextSize: number;
  contextWindowSize: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: string;
  model: string;
  stopReason: string | null;
  isCompaction: boolean;
  significantDelta: number;

  // ✓ computed
  freshIn: number;
  cacheRatio: number;           // cache_read / context_size
  windowUsedPct: number;        // context_size / context_window_size %
  isNearLimit: boolean;

  // Proxy-backed (null when no proxy)
  proxyDurationMs: number | null;
  proxyStopReason: string | null;
  hasProxy: boolean;
}

export function deriveCallMetrics(call: LlmCall): CallMetrics {
  const freshIn = Math.max(call.contextSize - call.cacheRead - call.cacheWrite, 0);
  const cacheRatio = call.contextSize > 0 ? Math.round(call.cacheRead / call.contextSize * 100) : 0;
  const windowUsedPct = Math.round(call.contextSize / call.contextWindowSize * 100);
  const isNearLimit = call.contextSize > call.contextWindowSize * 0.85;

  return {
    id: call.id,
    indexInTurn: call.indexInTurn,
    contextSize: call.contextSize,
    contextWindowSize: call.contextWindowSize,
    outputTokens: call.outputTokens,
    cacheRead: call.cacheRead,
    cacheWrite: call.cacheWrite,
    timestamp: call.timestamp,
    model: call.model,
    stopReason: call.stopReason,
    isCompaction: call.isCompaction,
    significantDelta: call.significantDelta,
    freshIn,
    cacheRatio,
    windowUsedPct,
    isNearLimit,
    proxyDurationMs: call.proxy?.durationMs ?? null,
    proxyStopReason: call.proxy?.resStopReason ?? null,
    hasProxy: !!call.proxy,
  };
}

// ─── Session overview hotspot summary ────────────────────────────────────────

export interface SessionHotspots {
  largestGrowthTurn: UserTurn | null;    // ✓ turn with max netContextDelta
  compactionTurns: UserTurn[];           // ✓ turns with compaction calls
  nearLimitCalls: LlmCall[];             // ✓ calls > 85% window
  peakCall: LlmCall | null;              // ✓ call with max contextSize
}

export function deriveSessionHotspots(d: SessionDrilldown): SessionHotspots {
  const allCalls = d.turns.flatMap(t => t.calls);

  const largestGrowthTurn = d.turns.length > 0
    ? [...d.turns].sort((a, b) => b.netContextDelta - a.netContextDelta)[0]
    : null;

  const compactionTurns = d.turns.filter(
    t => t.hasCompaction || t.calls.some(c => c.isCompaction),
  );

  const nearLimitCalls = allCalls.filter(
    c => c.contextSize > d.contextWindowSize * 0.85,
  );

  const peakCall = allCalls.length > 0
    ? allCalls.reduce((best, c) => c.contextSize > best.contextSize ? c : best)
    : null;

  return { largestGrowthTurn, compactionTurns, nearLimitCalls, peakCall };
}
