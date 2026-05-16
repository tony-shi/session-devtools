// AttributionGraphContext — session 级 reverse-attribution 数据下发。
//
// 设计原则：
//   - 进入 session 时**渐进加载**：先 lastN=20（hot path，亚秒级），用户主动
//     需要全量时再调用 `loadFull()` 跑全 session（150-call session ~13s）。
//   - 通过 Context 下发到所有子组件（ToolCallRow / IntervalEventRow /
//     SelectedDetail / ...），避免 5571 行 SessionDetailV2 内的 prop drilling。
//   - 缺数据时回退优雅：`getEventAnnotation` 返回 null，调用方按现有行为
//     渲染（不展示新 META 字段），不阻塞。

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiV2 } from "./api";
import type { JsonlEventAnnotation, SessionAttributionGraph } from "./attribution-graph-types";

const DEFAULT_LAST_N = 20;

export interface AttributionGraphContextValue {
  graph: SessionAttributionGraph | null;
  /** Quick O(1) lookup by jsonl lineIdx. */
  getEventAnnotation: (lineIdx: number) => JsonlEventAnnotation | null;
  /** Currently loaded window: number = lastN, null = full session. */
  loadedLastN: number | null;
  loading: boolean;
  error: string | null;
  /** Promote to full-session load. Idempotent. */
  loadFull: () => void;
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
}

const Ctx = createContext<AttributionGraphContextValue>({
  graph: null,
  getEventAnnotation: () => null,
  loadedLastN: null,
  loading: false,
  error: null,
  loadFull: () => {},
  onJumpToCall: null,
  highlightedCallId: null,
});

const FLASH_DURATION_MS = 2000;

export function AttributionGraphProvider({
  sessionId, initialLastN = DEFAULT_LAST_N, onJumpToCall = null, children,
}: {
  sessionId: string;
  /** Default last-N window for the initial fetch. Pass null to skip initial
   *  load and require explicit `loadFull()`. */
  initialLastN?: number | null;
  /** Jump-to-Call dispatcher (see AttributionGraphContextValue.onJumpToCall). */
  onJumpToCall?: ((callId: number, lens?: "request" | "response") => void) | null;
  children: React.ReactNode;
}) {
  const [graph, setGraph] = useState<SessionAttributionGraph | null>(null);
  const [loadedLastN, setLoadedLastN] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullRequested, setFullRequested] = useState(false);
  const [highlightedCallId, setHighlightedCallId] = useState<number | null>(null);

  // Initial fetch: lastN window (cheap). Refetch when sessionId changes.
  useEffect(() => {
    if (!sessionId || initialLastN == null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiV2.attributionGraph(sessionId, { lastN: initialLastN })
      .then(g => {
        if (cancelled) return;
        setGraph(g);
        setLoadedLastN(initialLastN);
      })
      .catch(err => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, initialLastN]);

  // Full session load (on demand). Same query path but no lastN.
  useEffect(() => {
    if (!fullRequested || !sessionId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiV2.attributionGraph(sessionId, {})
      .then(g => {
        if (cancelled) return;
        setGraph(g);
        setLoadedLastN(null);
      })
      .catch(err => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fullRequested, sessionId]);

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

  const loadFull = useCallback(() => setFullRequested(true), []);

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

  const value: AttributionGraphContextValue = {
    graph,
    getEventAnnotation,
    loadedLastN,
    loading,
    error,
    loadFull,
    onJumpToCall: wrappedJumpToCall,
    highlightedCallId,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAttributionGraph(): AttributionGraphContextValue {
  return useContext(Ctx);
}

/**
 * Inline chip rendered in modal/page headers — exposes the audit boundary:
 *   - which window is loaded (lastN vs full)
 *   - count of calls that were *skipped* (mcli / no proxy / fork)
 *   - "load full" promotion button
 *
 * Renders nothing when the graph hasn't loaded at all (first paint).
 */
export function AuditBoundaryStatus() {
  const { graph, loadedLastN, loading, error, loadFull } = useAttributionGraph();
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
        fontSize: 10, color: "#374151", background: "#f9fafb",
        border: "1px solid #e5e7eb", borderRadius: 4, padding: "2px 8px",
      }}
      title={
        (loadedLastN != null ? `当前 audit 窗口：最近 ${loadedLastN} 个 call` : "audit 已覆盖全部 call") +
        (reasonSummary ? `\n\n以下 call 因边界条件被跳过：\n${reasonSummary}` : "")
      }
    >
      <span style={{ fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em" }}>归因</span>
      {loadedLastN != null ? (
        <>
          <span>last {loadedLastN}</span>
          <button
            type="button"
            disabled={loading}
            onClick={loadFull}
            style={{
              border: "none", background: "transparent", cursor: loading ? "default" : "pointer",
              fontSize: 10, color: loading ? "#9ca3af" : "#6366f1", fontWeight: 600, padding: 0,
            }}
          >
            {loading ? "loading…" : "load full ›"}
          </button>
        </>
      ) : (
        <span style={{ color: "#9ca3af" }}>full</span>
      )}
      {unaudited > 0 && (
        <span style={{ color: "#b45309" }}>{unaudited} skipped</span>
      )}
    </span>
  );
}
