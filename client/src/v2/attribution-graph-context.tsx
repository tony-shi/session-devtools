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
import { useTranslation } from "react-i18next";
import { apiV2 } from "./api";
import type { JsonlEventAnnotation, SessionAttributionGraph, UnauditedCall, UnauditedKind } from "./attribution-graph-types";
import { NoProxyDot } from "./shared/NoProxyDot";
import { BRAND } from "./shared/brand";

/** Hint passed to a destination Call detail panel to auto-select a leaf. */
export type PendingFocus =
  | { lineIdx: number }
  | { toolUseId: string };

export interface AttributionGraphContextValue {
  /**
   * True iff this subtree is rendering inside a *linked panel* (the right-
   * side popup that opens when a leaf back-jumps to a Turn). Components
   * inspect this and hide their own forward-jump affordances so we don't
   * spawn another linked panel from within one (anti-recursion). Combined
   * with `LinkedPanelScope` which also nulls out `onJumpToCall` /
   * `flashEvent` / `flashCall` so any leftover click sites are inert.
   */
  linkedPanelMode: boolean;
  graph: SessionAttributionGraph | null;
  /** Quick O(1) lookup by jsonl lineIdx. */
  getEventAnnotation: (lineIdx: number) => JsonlEventAnnotation | null;
  loading: boolean;
  error: string | null;
  /**
   * Jump-to-Call navigation callback — auto-wraps the parent-provided
   * dispatcher to also scroll the main timeline to that call and flash
   * its border for ~2s, so jumps land somewhere the eye can confirm.
   *
   * `focus` (optional) requests that the destination panel auto-select a
   * specific leaf:
   *   - `{ lineIdx }`   → AttributionTreeLensPanel matches a jsonl-origin
   *                       leaf by `origin.jsonlLineIdx === lineIdx`.
   *   - `{ toolUseId }` → ResponseTreePanel matches a tool_use block by
   *                       `wireMeta.toolUseId === toolUseId`.
   * Consumed once by the panel via `pendingFocus` + `clearPendingFocus`.
   */
  onJumpToCall:
    | ((callId: number, lens?: "request" | "response", focus?: PendingFocus) => void)
    | null;
  /**
   * One-shot focus hint set by `onJumpToCall(callId, lens, focus)`.
   * Call detail panels read it on mount + when the value changes, apply
   * the matching selection, then call `clearPendingFocus`. Returns to null
   * after consumption.
   */
  pendingFocus: PendingFocus | null;
  clearPendingFocus: () => void;
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
   * The tool_use_id currently flashing from a recent reverse-jump
   * (Attribution leaf detail → Turn view). ToolCallRow reads this and
   * adds an amber outline when its `tc.toolUseId` matches. Cleared
   * after ~2s. Allows back-links from `tool_use` Attribution leaves to
   * land directly on the specific ToolCallRow rather than just the
   * enclosing call card.
   */
  highlightedToolUseId: string | null;
  /**
   * Reverse-direction navigation: open the Turn view (linked panel) and
   * scroll+flash the IntervalEventRow at this jsonl line. Called by
   * Attribution leaf detail when its underlying event is a tool_result /
   * user_input / etc that has a known jsonlLineIdx.
   */
  flashEvent: (lineIdx: number) => void;
  /**
   * Reverse-direction navigation: scroll to and flash the Call card
   * anchor (`[id$="-call-N"]`) in the Turn view. Used as the back-link
   * target for `tool_use` leaves (their "source" is the call that
   * emitted them, so the natural landing is the call card itself rather
   * than a specific jsonl row).
   */
  flashCall: (callId: number) => void;
  /**
   * Reverse-direction navigation: scroll to and flash the specific
   * ToolCallRow keyed by tool_use_id (`[data-tool-use-id="..."]`) in
   * the Turn view. More precise than `flashCall` for `tool_use`
   * Attribution leaves — instead of just outlining the whole call
   * card, lands on the exact tool_use row whose input the leaf was
   * derived from.
   */
  flashToolUse: (toolUseId: string) => void;
}

const Ctx = createContext<AttributionGraphContextValue>({
  linkedPanelMode: false,
  graph: null,
  getEventAnnotation: () => null,
  loading: false,
  error: null,
  onJumpToCall: null,
  pendingFocus: null,
  clearPendingFocus: () => {},
  highlightedCallId: null,
  highlightedLineIdx: null,
  highlightedToolUseId: null,
  flashEvent: () => {},
  flashCall: () => {},
  flashToolUse: () => {},
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
  const [highlightedToolUseId, setHighlightedToolUseId] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);

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

  const clearPendingFocus = useCallback(() => setPendingFocus(null), []);

  // Wrap the parent-provided onJumpToCall so every jump also:
  //   (a) stashes `focus` (one-shot) for the destination panel to
  //       auto-select the matching leaf
  //   (b) sets highlightedCallId so any call card currently in the
  //       timeline viewport flashes amber as a visual confirmation
  //
  // Intentionally NOT scrolling the main timeline to the target call:
  // every dispatched jump opens a right-side panel which IS the
  // user-facing destination. A timeline-scroll on the left would yank
  // the page out from under the user while they're already reading the
  // freshly-opened panel on the right. If a future use case ever needs
  // "jump within the timeline only" we'll add an explicit affordance
  // for that — don't conflate it with the panel-jump path.
  const wrappedJumpToCall = useMemo(() => {
    if (!onJumpToCall) return null;
    return (callId: number, lens?: "request" | "response", focus?: PendingFocus) => {
      // Stash focus BEFORE the panel mounts/re-renders so its first paint
      // already has the hint available. Cleared by the panel itself when
      // it applies the selection.
      setPendingFocus(focus ?? null);
      onJumpToCall(callId, lens);
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

  // Same lifecycle for highlightedToolUseId.
  useEffect(() => {
    if (highlightedToolUseId == null) return;
    const t = setTimeout(() => {
      setHighlightedToolUseId(prev => prev === highlightedToolUseId ? null : prev);
    }, FLASH_DURATION_MS);
    return () => clearTimeout(t);
  }, [highlightedToolUseId]);

  // flashEvent / flashCall — reverse-link scroll helpers.
  //
  // Race condition fix: when these are invoked right after onLinkSource(...)
  // opens a fresh linked panel, the target DOM element doesn't exist yet
  // (React still has to render the panel subtree + paint). A single
  // requestAnimationFrame isn't always enough — the panel may mount across
  // multiple frames depending on what state updates triggered. Previously
  // users had to click the back-link twice: the first click opened the
  // panel but missed the scroll, the second click scrolled into the now-
  // mounted DOM.
  //
  // Fix: retry the DOM query a few times (every 50ms) until we find the
  // element OR run out of attempts. Each attempt is cheap (one selector
  // lookup), and stops as soon as the target shows up so we never wait
  // longer than necessary.
  function scrollWithRetry(selector: string, maxAttempts: number) {
    let attempts = maxAttempts;
    const tryScroll = () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (--attempts > 0) setTimeout(tryScroll, 50);
    };
    // First attempt on the next frame (covers the common "panel paints in
    // a single frame" case at zero cost). Subsequent attempts on a timer.
    requestAnimationFrame(tryScroll);
  }

  const flashEvent = useCallback((lineIdx: number) => {
    setHighlightedLineIdx(lineIdx);
    scrollWithRetry(`[data-jsonl-line="${lineIdx}"]`, 8); // 8 × 50ms ≈ 400ms max
  }, []);

  const flashCall = useCallback((callId: number) => {
    setHighlightedCallId(callId);
    scrollWithRetry(`[id$="-call-${callId}"]`, 8);
  }, []);

  const flashToolUse = useCallback((toolUseId: string) => {
    setHighlightedToolUseId(toolUseId);
    // CSS attribute selectors don't escape quotes — toolUseId tokens come
    // from the wire (`toolu_…`) and contain only ASCII alphanumerics +
    // underscores in practice, but CSS.escape covers the edge case.
    scrollWithRetry(`[data-tool-use-id="${CSS.escape(toolUseId)}"]`, 8);
  }, []);

  const value: AttributionGraphContextValue = {
    linkedPanelMode: false,
    graph,
    getEventAnnotation,
    loading,
    error,
    onJumpToCall: wrappedJumpToCall,
    pendingFocus,
    clearPendingFocus,
    highlightedCallId,
    highlightedLineIdx,
    highlightedToolUseId,
    flashEvent,
    flashCall,
    flashToolUse,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAttributionGraph(): AttributionGraphContextValue {
  return useContext(Ctx);
}

/**
 * Wrap any subtree to render in "linked-panel mode" — Turn / Call rendering
 * components see `linkedPanelMode: true` (so they hide forward-jump
 * affordances) AND the jump dispatcher + flash helpers are nulled out (so
 * any leftover click sites are inert). The parent context's read-only data
 * (graph / annotations / highlight state) passes through unchanged so the
 * panel can still render annotations.
 *
 * Anti-recursion: prevents the right-side linked panel from spawning
 * another right-side panel when the user clicks something inside it.
 */
export function LinkedPanelScope({ children }: { children: React.ReactNode }) {
  const parent = useContext(Ctx);
  const masked = useMemo<AttributionGraphContextValue>(() => ({
    ...parent,
    linkedPanelMode: true,
    onJumpToCall: null,
    flashEvent: () => {},
    flashCall: () => {},
    flashToolUse: () => {},
  }), [parent]);
  return <Ctx.Provider value={masked}>{children}</Ctx.Provider>;
}

// 为单条 unaudited 拼一行 hover 文案。kind 决定走哪条 i18n key，reason 兜底
// 拼到 detail 占位里（"parse error: {detail}"）。
function formatUnauditedReason(
  t: (k: string, opts?: Record<string, unknown>) => string,
  u: UnauditedCall,
): string {
  const key = `attribution.skip.reason.${
    u.kind === "no-proxy"        ? "noProxy"        :
    u.kind === "drilldown-miss"  ? "drilldownMiss"  :
    u.kind === "parse-error"     ? "parseError"     :
                                   "other"
  }`;
  return t(key, { detail: u.reason });
}

/**
 * Inline chip rendered in modal/page headers — surfaces graph load status:
 *
 *   归因加载中…       — request in flight
 *   归因 ✓             — full session graph live
 *   归因加载失败       — error
 *   归因 ✓  ● 2        — full session graph but some calls skipped
 *
 * Skip indicator visual rules:
 *   - All-no-proxy → NoProxyDot (yellow) + count, matches the per-call yellow
 *     dot in sidebar / chrome.
 *   - Mixed reasons → neutral amber dot + count, keeps the "something else
 *     is wrong" feel distinct from the pure no-proxy case.
 * Hover tooltip is fully i18n-driven (no raw server reason strings leak).
 */
export function AuditBoundaryStatus() {
  const { t } = useTranslation();
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
        {t("attribution.loadFailed")}
      </span>
    );
  }
  if (!graph) {
    if (loading) {
      return (
        <span style={{
          fontSize: 10, color: BRAND.indigo500, background: BRAND.indigo50,
          border: "1px solid #c7d2fe", borderRadius: 4, padding: "2px 8px",
        }}>
          {t("attribution.loading")}
        </span>
      );
    }
    return null;
  }
  const unaudited = graph.unauditedCallIds;
  const unauditedCount = unaudited.length;
  const kinds = new Set<UnauditedKind>(unaudited.map((u) => u.kind));
  const allNoProxy = unauditedCount > 0 && kinds.size === 1 && kinds.has("no-proxy");

  const summaryLine = unauditedCount === 0
    ? t("attribution.skip.headerOk")
    : allNoProxy
      ? t("attribution.skip.summaryAllNoProxy", { n: unauditedCount })
      : t("attribution.skip.summaryMixed", { n: unauditedCount });

  const tooltip = unauditedCount === 0
    ? summaryLine
    : summaryLine + "\n\n" + unaudited
        .map((u) => t("attribution.skip.callLine", {
          callId: u.callId,
          reason: formatUnauditedReason(t, u),
        }))
        .join("\n");

  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontSize: 10, color: "#374151",
        background: "#f0fdf4", border: "1px solid #bbf7d0",
        borderRadius: 4, padding: "2px 8px",
      }}
      title={tooltip}
    >
      <span style={{ fontWeight: 700, color: "#6b7280", letterSpacing: "0.04em" }}>
        {t("attribution.skip.headerLabel")}
      </span>
      <span style={{ color: "#15803d", fontWeight: 600 }}>✓</span>
      {unauditedCount > 0 && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {allNoProxy ? (
            <NoProxyDot size={7} title={t("rawTab.noProxyDotTooltip")} />
          ) : (
            <span style={{
              width: 7, height: 7, borderRadius: 999,
              background: "#d97706", flexShrink: 0, display: "inline-block",
            }} />
          )}
          <span style={{ color: allNoProxy ? "#b45309" : "#b45309", fontWeight: 600 }}>
            {unauditedCount}
          </span>
        </span>
      )}
    </span>
  );
}
