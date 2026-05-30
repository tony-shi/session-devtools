// ─── drilldown-real-fill.ts ───────────────────────────────────────────────────
// Derives display-ready metrics from real SessionDrilldown data.
// Each function is a "best-effort" fill — it uses what the backend provides
// and returns sensible nulls/zeros for fields not yet computed.
//
// Fill status per field:
//   ✓ = computed from real data
//   ~ = estimated / heuristic
//   ✗ = not yet available (returns mock placeholder)

import type { SessionDrilldown } from "./drilldown-types";

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
  // Totals across the **main session JSONL only**. Does NOT include
  // sub-agent calls or background API calls (haiku title gen, retries).
  totalCacheRead: number;
  totalCacheWrite: number;
  totalFreshIn: number;       // SUM of usage.input_tokens (non-cached, 1x billing)
  totalFreshOut: number;
  lastContext: number;          // ✓ contextSize of the final LLM call
  systemErrorCount: number;
  compactionCount: number;
  hasProxyData: boolean;
  durationMs: number;           // ✓ last_event - first_event
  durationStr: string;
  firstEventAt: string;
  lastEventAt: string;

  // ~ estimated
  cacheRatio: number | null;    // last call: cache_read / context_size
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

  // cacheRatio: based on the last LLM call (single-call view, most accurate)
  const allCalls = d.turns.flatMap(t => t.calls);
  const lastCall = allCalls.length > 0 ? allCalls[allCalls.length - 1] : null;
  const cacheRatio = lastCall && lastCall.contextSize > 0
    ? lastCall.cacheRead / lastCall.contextSize * 100
    : null;

  // Net context: last call ctx - first call ctx
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
    lastContext: d.lastContext,
    systemErrorCount: d.systemErrorCount,
    compactionCount: d.compactionCount ?? 0,
    hasProxyData: d.hasProxyData,
    durationMs,
    durationStr: fmtMs(durationMs),
    firstEventAt: d.firstEventAt,
    lastEventAt: d.lastEventAt,
    cacheRatio,
    netContext,
    modelNames,
    dominantModel,
    isSingleModel: modelNames.length <= 1,
  };
}
