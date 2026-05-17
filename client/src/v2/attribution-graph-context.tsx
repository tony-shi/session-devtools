// AttributionGraphContext — session 级 reverse-attribution 数据下发。
//
// 设计原则：
//   - 进入 session 时**一次性加载**全量 graph（incremental 算法 + 服务端 5min
//     cache，单次 ~3-15s，后续访问命中 cache 亚秒级）。
//   - 通过 Context 下发到所有子组件（ToolCallRow / IntervalEventRow /
//     SelectedDetail / ...），避免 5571 行 SessionDetailV2 内的 prop drilling。
//   - 缺数据时回退优雅：`getEventAnnotation` 返回 null，调用方按现有行为
//     渲染（不展示新 META 字段），不阻塞。

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiV2 } from "./api";
import type { JsonlEventAnnotation, SessionAttributionGraph } from "./attribution-graph-types";

export interface AttributionGraphContextValue {
  graph: SessionAttributionGraph | null;
  /** Quick O(1) lookup by jsonl lineIdx. */
  getEventAnnotation: (lineIdx: number) => JsonlEventAnnotation | null;
  loading: boolean;
  error: string | null;
  /**
   * Jump-to-Call navigation callback — auto-wraps the parent-provided
   * dispatcher to also scroll the main timeline to that call and flash
   * its border for ~2s, so jumps land somewhere the eye can confirm.
   */
  onJumpToCall: ((callId: number, lens?: "request" | "response") => void) | null;
  /**
   * The call currently flashing from a recent jump. Call cards in the
   * main timeline read this and add an amber outline when their id
   * matches. Cleared automatically after ~2s.
   */
  highlightedCallId: number | null;
  /**
   * The jsonl line currently flashing from a recent reverse-jump (Call
   * detail → Turn view). IntervalEventRow reads this and adds an amber
   * outline when its lineIdx matches. Cleared after ~2s.
   */
  highlightedLineIdx: number | null;
  /**
   * Reverse-direction navigation: open the Turn view (linked panel) and
   * scroll+flash the IntervalEventRow at this jsonl line. Called by
   * Attribution leaf detail when its underlying event is a tool_result /
   * user_input / etc that has a known jsonlLineIdx.
   */
  flashEvent: (lineIdx: number) => void;
}

const Ctx = createContext<AttributionGraphContextValue>({
  graph: null,
  getEventAnnotation: () => null,
  loading: false,
  error: null,
  onJumpToCall: null,
  highlightedCallId: null,
  highlightedLineIdx: null,
  flashEvent: () => {},
});

const FLASH_DURATION_MS = 2000;

export function AttributionGraphProvider({
  sessionId, onJumpToCall = null, children,
}: {
  sessionId: string;
  /** Jump-to-Call dispatcher (see AttributionGraphContextValue.onJumpToCall). */
  onJumpToCall?: ((callId: number, lens?: "request" | "response") => void) | null;
  children: React.ReactNode;
}) {
  const [graph, setGraph] = useState<SessionAttributionGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightedCallId, setHighlightedCallId] = useState<number | null>(null);
  const [highlightedLineIdx, setHighlightedLineIdx] = useState<number | null>(null);

  // Single full-session load. Server caches the result for 5min, so opening
  // a session you've already visited is near-instant; the cold path runs
  // the incremental algorithm (~3-15s depending on session size).
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiV2.attributionGraph(sessionId)
      .then(g => { if (!cancelled) setGraph(g); })
      .catch(err => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Map index for O(1) lookup by lineIdx.
  const byLine = useMemo(() => {
    if (!graph) return null;
    const m = new Map<number, JsonlEventAnnotation>();
    for (const ev of graph.events) m.set(ev.lineIdx, ev);
    return m;
  }, [graph]);

  const getEventAnnotation = useCallback(
    (lineIdx: number) => byLine?.get(lineIdx) ?? null,
    [byLine],
  );

  // Wrap the parent-provided onJumpToCall so every jump also:
  //   (a) scrolls the main timeline to the call's anchor `[id$="-call-N"]`
  //   (b) sets highlightedCallId for ~2s so the target card flashes amber
  // Both are no-ops when the parent didn't provide a dispatcher.
  const wrappedJumpToCall = useMemo(() => {
    if (!onJumpToCall) return null;
    return (callId: number, lens?: "request" | "response") => {
      onJumpToCall(callId, lens);
      // Defer scroll until after parent's state updates (e.g. opening linked
      // panel) have a chance to land, so the layout reflows once.
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[id$="-call-${callId}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      setHighlightedCallId(callId);
    };
  }, [onJumpToCall]);

  // Auto-clear the flash after FLASH_DURATION_MS. The dependency on
  // highlightedCallId means each new jump restarts the timer (the previous
  // timeout closures are GC'd when the effect re-runs).
  useEffect(() => {
    if (highlightedCallId == null) return;
    const t = setTimeout(() => {
      setHighlightedCallId(prev => prev === highlightedCallId ? null : prev);
    }, FLASH_DURATION_MS);
    return () => clearTimeout(t);
  }, [highlightedCallId]);

  // Same lifecycle for highlightedLineIdx.
  useEffect(() => {
    if (highlightedLineIdx == null) return;
    const t = setTimeout(() => {
      setHighlightedLineIdx(prev => prev === highlightedLineIdx ? null : prev);
    }, FLASH_DURATION_MS);
    return () => clearTimeout(t);
  }, [highlightedLineIdx]);

  // flashEvent: scroll to and amber-outline the IntervalEventRow at this
  // jsonl line. Used by Attribution leaf back-link to focus the source
  // event in the Turn view that the legacy onLinkSource just opened.
  const flashEvent = useCallback((lineIdx: number) => {
    setHighlightedLineIdx(lineIdx);
    // Defer a frame so any newly mounted linked panel has time to paint
    // its IntervalEventRow into the DOM before we try to scroll to it.
    requestAnimationFrame(() => {
      // Try linked panel first (most common: reverse-jump from Call detail
      // opens turn-excerpt in the right panel). Fall back to main view.
      const el = document.querySelector<HTMLElement>(`[data-jsonl-line="${lineIdx}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  const value: AttributionGraphContextValue = {
    graph,
    getEventAnnotation,
    loading,
    error,
    onJumpToCall: wrappedJumpToCall,
    highlightedCallId,
    highlightedLineIdx,
    flashEvent,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAttributionGraph(): AttributionGraphContextValue {
  return useContext(Ctx);
}

/**
 * Inline chip rendered in modal/page headers — surfaces graph load status:
 *
 *   归因加载中…   — request in flight
 *   归因 ✓        — full session graph live
 *   归因加载失败  — error
 *
 * Also shows a "K skipped" indicator when any calls were unaudited (no
 * proxy data); hover to see per-call reasons.
 */
export function AuditBoundaryStatus() {
  const { graph, loading, error } = useAttributionGraph();
  if (error) {
    return (
      <span
        title={error}
        style={{
          fontSize: 10, color: "#b91c1c", background: "#fef2f2",
          border: "1px solid #fecaca", borderRadius: 4, padding: "2px 8px",
        }}
      >
        归因加载失败
      </span>
    );
  }
  if (!graph) {
    if (loading) {
      return (
        <span style={{
          fontSize: 10, color: "#6366f1", background: "#eef2ff",
          border: "1px solid #c7d2fe", borderRadius: 4, padding: "2px 8px",
        }}>
          归因加载中…
        </span>
      );
    }
    return null;
  }
  const unaudited = graph.unauditedCallIds.length;
  const reasonSummary = unaudited > 0
    ? graph.unauditedCallIds.map(u => `#${u.callId}: ${u.reason}`).join("\n")
    : "";
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontSize: 10, color: "#374151",
        background: "#f0fdf4", border: "1px solid #bbf7d0",
        borderRadius: 4, padding: "2px 8px",
      }}
      title={
        "audit 已覆盖整 session — firstSeenInCall 准确" +
        (reasonSummary ? `\n\n以下 call 因边界条件被跳过：\n${reasonSummary}` : "")
      }
    >
      <span style={{ fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em" }}>归因</span>
      <span style={{ color: "#15803d", fontWeight: 600 }}>✓</span>
      {unaudited > 0 && (
        <span style={{ color: "#b45309" }}>{unaudited} skipped</span>
      )}
    </span>
  );
}
