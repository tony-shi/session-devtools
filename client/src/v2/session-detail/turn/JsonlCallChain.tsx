// JsonlCallChain —— 把一个 turn 的 calls + 其间的 JSONL 事件组织成"叙事链"渲染。
// 组合 call-chain-rows 的三个叶子原件。抽自 UserTurnDetailPanel.tsx，逻辑零改动。

import React, { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import type { IntervalEvent, IntervalEventKind, SubAgentSummary } from "../../drilldown-types";
import type { MockUserTurn, MockLlmCall } from "../../lib/mock-data";
import { fmtK, fmtDuration, formatJsonlLines, shortToolUseId, toolUseIdsFromIntervalEvent } from "../../lib/format";
import { ALL_KINDS, KIND_LABEL, KIND_COLOR } from "../../lib/palettes";
import { BRAND } from "../../shared/brand";
import { CallLedger } from "../../shared/CallLedger";
import { ForwardArrowIcon, LinkIcon } from "../../shared/EventUnitCard";
import { useAttributionGraph } from "../../attribution-graph-context";
import { RenderRawCopyActions } from "../../shared/RenderRawCopyActions";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ChainNarrativeNode, ToolCallRow, IntervalEventRow, AsyncReceiptNode, TeammateMessageNode } from "./call-chain-rows";
import { CommandGroupCard } from "./CommandGroupCard";

export function JsonlCallChain({
  turn, onSelectCall, onSubAgentClick,
}: {
  turn: MockUserTurn;
  onSelectCall: (c: MockLlmCall) => void;
  onSubAgentClick?: (sa: SubAgentSummary) => void;
}) {
  const { t } = useTranslation();
  // Filter state: null means "show all" (default); populated = active filter set
  const [hiddenKinds, setHiddenKinds] = useState<Set<IntervalEventKind>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [showFoldedSubAgentResults, setShowFoldedSubAgentResults] = useState(false);
  const [activeToolUseId, setActiveToolUseId] = useState<string | null>(null);
  // Hover 高亮的 sub-agent 行。与 activeToolUseId 分开：后者驱动 ToolCallRow 联动
  // 高亮（按 toolUseId），但 workflow 下一个 launch tool_use 挂 N 个 agent（1:N
  // 共享 toolUseId）——行自身的高亮/展开必须按全局唯一的 agentFileId 键控，否则
  // hover/展开任意一行会让同 launch 的所有行一起动。
  const [activeAgentFileId, setActiveAgentFileId] = useState<string | null>(null);
  // Per-sub-agent expanded state. Default = collapsed (one-line preview);
  // toggling via the header chevron shows full description / full result
  // (no truncation, no maxHeight cap). Keyed by agentFileId (globally unique).
  const [expandedSubAgentIds, setExpandedSubAgentIds] = useState<Set<string>>(new Set());
  const toggleSubAgentExpanded = useCallback((agentFileId: string) => {
    setExpandedSubAgentIds(prev => {
      const next = new Set(prev);
      if (next.has(agentFileId)) next.delete(agentFileId);
      else next.add(agentFileId);
      return next;
    });
  }, []);

  // When `onJumpToCall` fires from anywhere, the Provider sets
  // highlightedCallId. The matching call card flashes an amber outline so
  // the user can visually confirm where the jump landed.
  //
  // `linkedPanelMode` (set by LinkedPanelScope wrapping right-side
  // popups) suppresses forward-jump UI inside this Turn render so a click
  // here never spawns another right-side panel — strict one-direction
  // (left → right) flow.
  const { highlightedCallId, linkedPanelMode, onJumpToCall } = useAttributionGraph();

  if (!turn.calls.length) return null;

  // Bar length scale for the per-call CallLedger thumbnail — bar width =
  // this call's total billable tokens / max total across the Turn, so
  // adjacent rows are visually comparable. Use the non-overlapping bucket
  // breakdown CallLedger renders: API input_tokens (= ctx − read − write) +
  // cache_read + cache_write + output. Avoids the previous bug where
  // `c.freshIn` (parser's "context growth") double-counted cached content
  // and produced inflated bar widths.
  const maxCallTotal = Math.max(
    ...turn.calls.map(c => {
      const apiInputTokens = Math.max(0, c.contextSize - c.cacheRead - c.cacheWrite);
      return apiInputTokens + c.cacheRead + c.cacheWrite + c.outputTokens;
    }),
    1,
  );
  const subAgentByToolUseId = new Map<string, SubAgentSummary>();
  for (const call of turn.calls) {
    for (const sa of call.subAgents) {
      if (sa.toolUseId) subAgentByToolUseId.set(sa.toolUseId, sa);
    }
  }
  const finalOutput = turn.finalOutput?.trim()
    ? turn.finalOutput
    : ([...turn.calls].reverse().find(c => c.stopReason !== "tool_use" && c.assistantText)?.assistantText ?? "");
  const foldedSubAgentResultCount = turn.calls.reduce((sum, call) => {
    return sum + call.intervalEvents.filter(ev =>
      ev.kind === "user:tool_result"
      && toolUseIdsFromIntervalEvent(ev).some(id => subAgentByToolUseId.has(id))
    ).length;
  }, 0);

  function toggleKind(k: IntervalEventKind) {
    setHiddenKinds(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  return (
    <div>
      {/* ── Event graph filter bar ──────────────────────────────── */}
      <div style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={() => setFilterOpen(v => !v)}
          style={{
            fontSize: 10, padding: "3px 10px", borderRadius: 6, cursor: "pointer",
            border: "1px solid #e5e7eb", background: filterOpen ? BRAND.indigo500 : "#f9fafb",
            color: filterOpen ? "#fff" : "#6b7280", fontWeight: 600,
          }}
        >
          {t("terms.filterEventGraph")} {hiddenKinds.size > 0 && t("terms.hiddenCount", { n: hiddenKinds.size })}
        </button>
        {hiddenKinds.size > 0 && (
          <button onClick={() => setHiddenKinds(new Set())} style={{ fontSize: 10, color: BRAND.indigo500, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            {t("terms.showAll")}
          </button>
        )}
        <span style={{ fontSize: 9, color: "#d1d5db", marginLeft: "auto" }}>
          {t("terms.jsonlEventCount", {
            calls: turn.calls.length,
            events: turn.calls.reduce((s, c) => s + c.intervalEvents.length, 0),
          })}
        </span>
        {foldedSubAgentResultCount > 0 && (
          <button
            onClick={() => setShowFoldedSubAgentResults(v => !v)}
            style={{ fontSize: 10, color: BRAND.indigo600, background: BRAND.indigo50, border: "1px solid #c7d2fe", borderRadius: 6, cursor: "pointer", padding: "3px 8px", fontWeight: 700 }}
          >
            {showFoldedSubAgentResults
              ? t("terms.foldSubAgentResults")
              : t("terms.showFoldedSubAgentResults", { n: foldedSubAgentResultCount })}
          </button>
        )}
      </div>

      {/* Filter panel */}
      {filterOpen && (
        <div style={{ marginBottom: 10, padding: "8px 10px", background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 8, display: "flex", flexWrap: "wrap", gap: 5 }}>
          {ALL_KINDS.map(k => {
            const hidden = hiddenKinds.has(k);
            const col = KIND_COLOR[k];
            return (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                style={{
                  fontSize: 9, padding: "2px 7px", borderRadius: 4, cursor: "pointer",
                  background: hidden ? "#f3f4f6" : col.bg,
                  border: `1px solid ${hidden ? "#d1d5db" : col.border}`,
                  color: hidden ? "#9ca3af" : col.fg,
                  fontWeight: 600,
                  textDecoration: hidden ? "line-through" : "none",
                }}
              >
                {t(`eventKinds.${k.replace(/[:-]/g, "_")}`, { defaultValue: KIND_LABEL[k] })}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Call chain ──────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0, position: "relative" }}>
        {/* Vertical spine */}
        <div style={{ position: "absolute", left: 11, top: 8, bottom: 8, width: 2, background: "#e5e7eb", zIndex: 0 }} />

        {/* turn opener：人类输入 → USER INPUT 节点；后台任务回执
            （openerSource="task-notification"）→ 异步回执节点；teams 入站消息
            （openerSource="teammate-message"）→ 队友消息节点。 */}
        {turn.openerSource === "task-notification" ? (
          <AsyncReceiptNode turn={turn} />
        ) : turn.openerSource === "teammate-message" ? (
          <TeammateMessageNode turn={turn} />
        ) : (
          <ChainNarrativeNode
            kind="user"
            label={t("terms.userInput")}
            text={turn.userInput}
            meta={turn.startedAt ? turn.startedAt.slice(11, 19) : undefined}
            lineIdx={turn.userInputLineIdx}
          />
        )}
        {turn.midTurnInjections
          .filter(inj => inj.afterCallIndex === 0)
          .map((inj, injIdx) => {
            const firstCallId = turn.calls[0]?.id;
            const anchor = firstCallId != null ? `before #${firstCallId}` : "before first call";
            return (
              <ChainNarrativeNode
                key={`inj-before-${injIdx}`}
                kind="interrupt"
                label={t("turn.midTurnInput")}
                text={inj.text}
                meta={inj.timestamp ? `${anchor} · ${inj.timestamp.slice(11, 19)}` : anchor}
              />
            );
          })}

        {/* Leading metadata events between the user input and the first call
            (e.g. ai-title — generated by Haiku on first submit, written before
            the first main-model turn). Rendered here so they appear at their
            real position. */}
        {turn.leadingEvents
          .filter(ev => !hiddenKinds.has(ev.kind))
          .map((ev, ei) => (
            <div key={`leading-${ev.lineIdx}-${ei}`} style={{ marginLeft: 32, marginBottom: 2 }}>
              <IntervalEventRow
                ev={ev}
                activeToolUseId={activeToolUseId}
                onHoverToolUse={setActiveToolUseId}
              />
            </div>
          ))}

        {turn.calls.map((call, callArrIdx) => {
          // Consumer-call lookup for sub-agent results.
          // Anthropic API flow: assistant call N emits tool_use → tool_result
          // for the sub-agent is bundled into call N+1's user-side input.
          // So "the call that received this sub-agent's result" = the next
          // call in the same turn. If `call` is the last call of the turn,
          // the result wasn't consumed (no follow-up assistant call) and
          // we hide the jump-to-consumer button.
          const consumerCall = turn.calls[callArrIdx + 1] ?? null;
          // Look up the JSONL lineIdx of each sub-agent's tool_result so the
          // jump can auto-locate the matching leaf inside the consumer call's
          // Attribution Tree (request lens). Mirrors how IntervalEventRow
          // passes `{ lineIdx }` to onJumpToCall — same mechanism, just
          // wired in from the sub-agent card. Build a Map once per call,
          // keyed by toolUseId, so each sub-agent renders without rescanning.
          const toolResultLineIdxByToolUseId = (() => {
            const m = new Map<string, number>();
            for (const ev of call.intervalEvents) {
              if (ev.kind !== "user:tool_result") continue;
              for (const tuid of toolUseIdsFromIntervalEvent(ev)) {
                if (!m.has(tuid)) m.set(tuid, ev.lineIdx);
              }
            }
            return m;
          })();
          const delta    = call.significantDelta;
          // jsonlLines is shown only in the #id tooltip now; the proportional
          // context bar was replaced by the shared CallLedger (rendered below
          // with maxCallTotal as its scale).
          const jsonlLines = formatJsonlLines(call);
          const matchedSubAgentIds = new Set(call.toolCalls.map(tc => tc.toolUseId).filter(id => subAgentByToolUseId.has(id)));
          const isFoldedSubAgentResult = (ev: IntervalEvent) =>
            ev.kind === "user:tool_result"
            && toolUseIdsFromIntervalEvent(ev).some(id => matchedSubAgentIds.has(id));
          const visibleIntervals = call.intervalEvents.filter(ev =>
            !hiddenKinds.has(ev.kind)
            && (showFoldedSubAgentResults || !isFoldedSubAgentResult(ev))
          );
          const hideAssistantTextAsFinal = Boolean(finalOutput && call.id === turn.calls[turn.calls.length - 1]?.id && call.stopReason !== "tool_use");

          return (
            <React.Fragment key={call.id}>
            <div
              id={`turn-${turn.id}-call-${call.id}`}
              style={{
                position: "relative", zIndex: 1, marginBottom: 8,
                borderRadius: 8,
                // Flash outline driven by AttributionGraphContext: lights up
                // for ~2s after a jump points to this call.
                boxShadow: highlightedCallId === call.id ? "0 0 0 3px rgba(245,158,11,0.45)" : "none",
                transition: "box-shadow 350ms ease",
              }}>

              {/* ── LLM Call card ───────────────────────────── */}
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                {/* Spine dot */}
                <div style={{ flexShrink: 0, marginTop: 10, width: 24, display: "flex", justifyContent: "center" }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: "50%", border: "2px solid #fff",
                    background: call.isCompaction ? "#ef4444" : call.isSignificant ? BRAND.blue500 : BRAND.indigo500,
                    boxShadow: "0 0 0 2px " + (call.isCompaction ? "#ef444440" : "#6366f140"),
                  }} />
                </div>

                {/* Card — header row stays a simple flex; the "查看详情"
                    chip is the LAST flex item using the same indigo-solid
                    jump-chip style as EventUnitCard's link button, so all
                    "click here to navigate" affordances in the app share
                    one visual language. Whole-card click intentionally not
                    wired and hover-border removed — the chip is the only
                    interactive surface, no need to hint otherwise. */}
                <div
                  style={{
                    flex: 1,
                    background: "#f8fafc",
                    border: "none",
                    borderLeft: "3px solid #6366f1",
                    borderRadius: "6px",
                    padding: "8px 12px",
                    overflow: "hidden"
                  }}
                >
                  {/* Header row — title / ctx / delta / 查看详情 button.
                      Every chip uses fontSize 10 + lineHeight 1 + matching
                      padding so the row height is governed by the title's
                      font metrics alone, not by any chip's borders. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 0 6px 0", borderBottom: "1px solid #e2e8f0", marginBottom: 8 }}>
                    <span
                      style={{ fontSize: 12, fontWeight: 700, color: "#111827", lineHeight: 1 }}
                      title={
                        call.messageId
                          ? `message: ${call.messageId}${jsonlLines ? ` · jsonl ${jsonlLines}` : ""}`
                          : jsonlLines ? `jsonl ${jsonlLines}` : undefined
                      }
                    >
                      {/* 合成 compact call 的 id 是负 sentinel，不能直接 print；
                          换成 i18n 化的 "压缩调用" 标签。普通 call 走 `${callLabel} ${id}`。 */}
                      {call.isCompaction && call.id < 0
                        ? t("sessionOverview.compact.callLabel")
                        : (<>{t("terms.callLabel")} {call.id}</>)}
                      {call.isCompaction && call.id >= 0 && <span style={{ marginLeft: 5, fontSize: 10, color: "#ef4444" }}>◆</span>}
                    </span>
                    <span style={{ fontSize: 11, color: "#9ca3af", lineHeight: 1 }}>{fmtK(call.contextSize)}</span>
                    {delta !== 0 && (
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4, lineHeight: 1, color: delta > 0 ? "#d97706" : "#16a34a", background: delta > 0 ? "#fffbeb" : "#f0fdf4" }}>
                        {delta > 0 ? "+" : ""}{fmtK(delta)}
                      </span>
                    )}
                    {!linkedPanelMode && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onSelectCall(call); }}
                            className="hover:opacity-80 transition-opacity"
                            style={{
                              marginLeft: "auto",
                              display: "inline-flex", alignItems: "center", gap: 5,
                              border: "none", background: "transparent", color: BRAND.indigo600,
                              padding: "2px 4px", fontSize: 10, fontWeight: 700,
                              lineHeight: 1.3, letterSpacing: "0.02em",
                              cursor: "pointer",
                              transition: "color 0.12s, opacity 0.12s",
                            }}
                          >
                            <LinkIcon />
                            {t("terms.viewDetails")}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t("turn.viewRawChainTooltip")}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>

                  {/* Token ledger — Call thumbnail uses CallLedger (compact,
                      two-group "历史复用 / 本轮新处理" semantics) since each
                      row represents a single LLM call. Bar width is scaled
                      to the Turn's largest call total so adjacent rows are
                      visually comparable. `freshIn` here is the strict
                      API-reported uncached input (= ctx − cacheRead −
                      cacheWrite); the parser's `call.freshIn` field tracks
                      "context growth since previous call" which conflates
                      cache-loaded content with truly new tokens and would
                      mismatch the Call header's value. */}
                  <div style={{ padding: "4px 0 8px 0" }}>
                    <CallLedger
                      size="compact"
                      maxTotal={maxCallTotal}
                      freshIn={Math.max(0, call.contextSize - call.cacheRead - call.cacheWrite)}
                      cacheRead={call.cacheRead}
                      cacheWrite={call.cacheWrite}
                      output={call.outputTokens}
                    />
                  </div>

                  {/* Assistant text */}
                  {call.assistantText && !hideAssistantTextAsFinal && (
                    <AssistantResponseText text={call.assistantText} />
                  )}

                  {/* tool_use blocks are part of this assistant response. Sub-agent
                      executions are rendered below as derived JSONL events. */}
                  {call.toolCalls.length > 0 && (
                    <div style={{ padding: "0 0 4px 0" }}>
                      <div style={{ fontSize: 9, color: "#9ca3af", marginBottom: 3, letterSpacing: "0.04em", fontWeight: 700 }}>
                        {t("terms.toolUseRequests", { count: call.toolCalls.length })}
                      </div>
                      {call.toolCalls.map((tc, ti) => (
                        <ToolCallRow
                          key={tc.toolUseId || ti}
                          tc={tc}
                          callId={call.id}
                          active={activeToolUseId === tc.toolUseId}
                          onHoverToolUse={setActiveToolUseId}
                        />
                      ))}
                    </div>
                  )}
                </div>
	              </div>

	              {/* ── Sub-agent JSONL events derived from Agent tool_use ───
	                  Block aligns flush with the LLM call card above (both at
	                  marginLeft: 32 from the spine container). Each row has:
	                    · Body (left, flex:1): stats + description + result
	                      preview. Truncated by default; click `▾ 展开` at the
	                      bottom to inline-expand into full text + extra stats.
	                    · Two consistent action chips (right column):
	                        - Purple `查看完整` → opens sub-agent detail
	                        - Blue `🔗 #N`     → jumps to consumer call's
	                          request in the right-side LinkedPanel
	                      Both chips use the same shape / LinkIcon / typography;
	                      only the color differentiates intent. */}
		              {call.subAgents.length > 0 && (
	                <div style={{ marginLeft: 32, marginTop: 3 }}>
                    <div style={{ fontSize: 9, color: BRAND.indigo400, fontWeight: 800, letterSpacing: "0.04em", margin: "0 0 3px 0" }}>
                      ↳ {t("terms.subAgentEvents")}
                    </div>
	                  {call.subAgents.map(sa => {
                      const active = activeAgentFileId === sa.agentFileId;
                      const branchColor = active ? "#f59e0b" : BRAND.indigo500;
                      const handleHoverEnter = () => { setActiveAgentFileId(sa.agentFileId); setActiveToolUseId(sa.toolUseId); };
                      const handleHoverLeave = () => { setActiveAgentFileId(null); setActiveToolUseId(null); };
                      const expanded = expandedSubAgentIds.has(sa.agentFileId);
                      // Show the toggle whenever there's actual body content
                      // (description or result preview). Even short content
                      // benefits from the toggle so users can fold large
                      // sub-agent rows back down once they've read them.
                      const hasBodyContent = !!sa.description || !!sa.resultPreview;
                      return (
                      <div
                        key={sa.agentFileId}
                        onMouseEnter={handleHoverEnter}
                        onMouseLeave={handleHoverLeave}
                        style={{
                          width: "100%",
                          marginBottom: 4,
                          border: "none",
                          borderLeft: `3px solid ${branchColor}`,
                          background: active ? "#fff7ed" : "transparent",
                          overflow: "hidden",
                        }}
                      >
                        {/* Header row — stats on the left, two consistent
                            action chips on the right. No collapse/expand —
                            content below is always fully shown. */}
                        <div style={{
                          display: "flex", alignItems: "center", gap: 6,
                          padding: "5px 4px",
                          borderBottom: "none",
                        }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: BRAND.indigo700 }}>
                            {/* workflow agent：身份主键是 agent() 的 label，agentType 退居其次 */}
                            {sa.agentSource === "workflow" && sa.agentLabel ? sa.agentLabel : sa.agentType}
                          </span>
                          {sa.agentSource === "workflow" && sa.phaseName && (
                            <span style={{ fontSize: 9, fontWeight: 700, color: "#7e22ce", background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 3, padding: "0 5px" }}>
                              {sa.phaseName}
                            </span>
                          )}
                          <span style={{ fontSize: 9, color: BRAND.indigo500 }}>{sa.llmCallCount}c · {sa.toolCallCount}t · {fmtDuration(sa.durationMs)}</span>
                          <span style={{ fontSize: 9, color: BRAND.indigo500, background: "#eff6ff", borderRadius: 3, padding: "1px 5px" }}>+{fmtK(sa.totalOutputTokens)}</span>
                          <span style={{ fontSize: 9, color: active ? "#d97706" : "#c4c9d4" }}>{shortToolUseId(sa.toolUseId)}</span>
                          <div style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
                            {/* Expand / collapse toggle — plain text + arrow,
                                same shape as the CALL MINIMAP "▾ show / ▴ hide"
                                pattern. Default = collapsed; user toggles to
                                see full description + full result. */}
                            {hasBodyContent && (
                              <button
                                type="button"
                                onClick={() => toggleSubAgentExpanded(sa.agentFileId)}
                                style={{
                                  fontSize: 10, color: "#9ca3af",
                                  background: "none", border: "none", cursor: "pointer",
                                  padding: "0 4px", lineHeight: 1,
                                }}
                              >
                                {expanded ? t("terms.hide") : t("terms.show")}
                              </button>
                            )}
                            {/* Chip 1: 紫色 "查看完整" — opens sub-agent drawer.
                                Uses a forward-jump arrow icon (↗) rather than
                                the chain LinkIcon, since this is a "navigate
                                INTO another scope" action rather than a
                                "cross-reference link". */}
                            {onSubAgentClick && (
                              <button
                                type="button"
                                onClick={() => onSubAgentClick(sa)}
                                title={t("sessionOverview.subAgent.viewSubAgentDetailTooltip", { agentType: sa.agentType })}
                                className="hover:opacity-80 transition-opacity"
                                style={{
                                  display: "inline-flex", alignItems: "center", gap: 5,
                                  border: "none", background: "transparent", color: BRAND.violet600,
                                  padding: "2px 4px",
                                  fontSize: 10, fontWeight: 700, lineHeight: 1.3,
                                  letterSpacing: "0.02em",
                                  cursor: "pointer", whiteSpace: "nowrap",
                                  transition: "color 0.12s, opacity 0.12s",
                                }}
                              >
                                <ForwardArrowIcon />
                                {t("sessionOverview.subAgent.viewFullSubAgent")}
                              </button>
                            )}
                            {/* Chip 2: 蓝色 "首次注入于 Call #N" — opens
                                consumer call in right-side LinkedPanel. Uses
                                the chain LinkIcon (cross-reference semantics),
                                matching the JSONL event "首次注入于" pattern. */}
                            {consumerCall && onJumpToCall && !linkedPanelMode && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const lineIdx = toolResultLineIdxByToolUseId.get(sa.toolUseId);
                                  onJumpToCall(consumerCall.id, "request",
                                    lineIdx != null ? { lineIdx } : undefined);
                                }}
                                title={t("sessionOverview.subAgent.jumpToConsumerTooltip", { callId: consumerCall.id })}
                                className="hover:opacity-80 transition-opacity"
                                style={{
                                  display: "inline-flex", alignItems: "center", gap: 5,
                                  border: "none", background: "transparent", color: BRAND.blue600,
                                  padding: "2px 4px",
                                  fontSize: 10, fontWeight: 700, lineHeight: 1.3,
                                  letterSpacing: "0.02em",
                                  cursor: "pointer", whiteSpace: "nowrap",
                                  transition: "color 0.12s, opacity 0.12s",
                                }}
                              >
                                <LinkIcon />
                                {t("sessionOverview.subAgent.firstInjectedAt", { callId: consumerCall.id })}
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Body — description + result.
                            Collapsed (default): each block is one-line ellipsis.
                            Expanded: full text, no maxHeight cap, no slice. */}
                        {hasBodyContent && (
                          <div style={{ padding: "4px 4px 6px 4px", display: "flex", flexDirection: "column", gap: 3 }}>
                            {sa.description && (
                              <div style={{
                                fontSize: 10, color: "#6b7280",
                                ...(expanded
                                  ? { whiteSpace: "pre-wrap", wordBreak: "break-word" }
                                  : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
                              }}>
                                {sa.description}
                              </div>
                            )}
                            {sa.resultPreview && (
                              <div style={{
                                fontSize: 10, color: "#374151",
                                background: BRAND.violet50, borderRadius: 4, padding: "4px 7px",
                                ...(expanded
                                  ? { whiteSpace: "pre-wrap", wordBreak: "break-word" }
                                  : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }),
                              }}>
                                {expanded ? (sa.result ?? sa.resultPreview) : sa.resultPreview}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      );
                    })}
                </div>
              )}

              {/* ── Interval events (filtered) ────────────────── */}
	              {visibleIntervals.length > 0 && (
	                <div style={{ marginLeft: 32, marginTop: 3 }}>
	                  {visibleIntervals.map((ev, ei) => {
	                    const matchedToolCall = (() => {
	                      if (ev.kind !== "user:tool_result") return undefined;
	                      const ids = toolUseIdsFromIntervalEvent(ev);
	                      if (ids.length === 0) return undefined;
	                      return call.toolCalls.find(tc => ids.includes(tc.toolUseId));
	                    })();
	                    return ev.commandGroup ? (
	                      <CommandGroupCard
	                        key={`${ev.lineIdx}-${ei}`}
	                        ev={ev}
	                        producingCallId={call.id}
	                        activeToolUseId={activeToolUseId}
	                        onHoverToolUse={setActiveToolUseId}
	                      />
	                    ) : (
	                      <IntervalEventRow
	                        key={`${ev.lineIdx}-${ei}`}
	                        ev={ev}
	                        producingCallId={call.id}
	                        activeToolUseId={activeToolUseId}
	                        onHoverToolUse={setActiveToolUseId}
	                        toolCall={matchedToolCall}
	                      />
	                    );
	                  })}
	                </div>
	              )}

            </div>
            {turn.midTurnInjections
              .filter(inj => inj.afterCallIndex === call.indexInTurn)
              .map((inj, injIdx) => (
                <ChainNarrativeNode
                  key={`inj-${call.id}-${injIdx}`}
                  kind="interrupt"
                  label={t("turn.midTurnInput")}
                  text={inj.text}
                  meta={inj.timestamp ? `after #${call.id} · ${inj.timestamp.slice(11, 19)}` : `after #${call.id}`}
                />
              ))}
            </React.Fragment>
          );
        })}
        <ChainNarrativeNode
          kind="final"
          label={t("turn.finalAiOutput")}
          text={finalOutput}
          meta={turn.endedAt ? turn.endedAt.slice(11, 19) : undefined}
        />
      </div>
    </div>
  );
}

function AssistantResponseText({ text }: { text: string }) {
  const { t } = useTranslation();
  const [mdMode, setMdMode] = useState(true);

  return (
    <div style={{ padding: "0 0 8px 0" }}>
      {/* Header section with toggle and copy buttons */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: "#16a34a", fontFamily: "'Outfit', sans-serif", letterSpacing: "0.05em" }}>
          {t("terms.assistantResponseText").toUpperCase()}
        </div>
        <RenderRawCopyActions
          rawMode={!mdMode}
          onToggleRawMode={() => setMdMode(v => !v)}
          textToCopy={text}
        />
      </div>

      {/* Main text box */}
      <div style={{
        fontSize: 11,
        color: "#14532d",
        lineHeight: 1.6,
        background: "#f0fdf4",
        borderLeft: "2px solid #a7f3d0",
        borderRadius: "0 6px 6px 0",
        padding: "8px 12px",
        maxHeight: 240,
        overflow: "auto",
      }}>
        {mdMode ? (
          <div className="md-prose" style={{ fontSize: 11, lineHeight: 1.6 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        ) : (
          <pre style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
          }}>{text}</pre>
        )}
      </div>
    </div>
  );
}
