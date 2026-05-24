// LlmCallDetailPanel —— 单个 LLM call 的详情视图：顶部 ledger header + Tabs
// （Attribution lens / Response / Raw）。含两个 file-internal 子件 RawTab /
// RawCopyButton。
//
// 这个面板在 4 种模式下渲染（主 call / compact-call / sub-agent call / linked
// panel），各模式的 onClose / onShowTurnContext / onLinkCall / onLinkSource /
// compactIdx / agentFileId / prevCall 接法不同，是真正的变化点 —— 保留为 props。
// 本批为纯抽取，逻辑零改动。

import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { apiV2 } from "../../api";
import type { CallDetail } from "../../drilldown-types";
import type { MockLlmCall, MockDiffEntry } from "../../lib/mock-data";
import type { CallTab } from "../session-nav";
import { fmtK, fmtGap, fmtDateShort, shortModelName, modelColor } from "../../lib/format";
import { BRAND } from "../../shared/brand";
import { UnifiedHeader, StatusBadgeStrip, type StatusBadge } from "../../shared/HeaderStats";
import { renderStatusIcon, RiskBadge } from "../../shared/SessionBadges";
import { NoProxyDot } from "../../shared/NoProxyDot";
import { CodeBlock } from "../../shared/CodeBlock";
import { AttributionTreeLensPanel } from "../../AttributionTreeLensPanel";
import { ResponseTreePanel } from "../../ResponseTreePanel";
import { ProxyMissingEmptyState } from "../proxy/ProxyMissingEmptyState";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Check, Copy } from "lucide-react";

function RawCopyButton({ text }: { text: string }) {
  const [copiedAt, setCopiedAt] = useState<number>(0);
  // Date.now() in render is intentional: copiedAt is a one-shot timestamp set on
  // click + cleared by a 1.5s timeout; the comparison just gates a transient "已复制"
  // flash and never needs to be reactive.
  // eslint-disable-next-line react-hooks/purity
  const isCopied = copiedAt > 0 && Date.now() - copiedAt < 1500;
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(
      () => { setCopiedAt(Date.now()); setTimeout(() => setCopiedAt(0), 1500); },
      () => {},
    );
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={isCopied ? "已复制" : "复制"}
      style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        border: "1px solid",
        borderColor: isCopied ? "#16a34a" : "#d1d5db",
        background: isCopied ? "#dcfce7" : "transparent",
        color: isCopied ? "#15803d" : "#9ca3af",
        borderRadius: 3, fontSize: 9, fontWeight: 600,
        padding: "1px 6px", cursor: "pointer", lineHeight: 1.3,
        flexShrink: 0,
        transition: "background 0.12s, border-color 0.12s, color 0.12s",
      }}
      className={!isCopied ? "hover:!border-gray-400 hover:!text-gray-700" : ""}
    >
      {isCopied ? <Check size={8} strokeWidth={3} /> : <Copy size={8} />}
      {isCopied ? "已复制" : "复制"}
    </button>
  );
}

function RawTab({ call, freshIn, callDetail, callDetailLoading }: {
  call: MockLlmCall;
  freshIn: number;
  callDetail: CallDetail | null;
  callDetailLoading: boolean;
}) {
  const { t } = useTranslation();
  const jsonlText = JSON.stringify(
    { call_id: call.id, index_in_turn: call.indexInTurn, model: call.model, timestamp: call.timestamp, usage: { context_size: call.contextSize, fresh_in: freshIn, cache_read: call.cacheRead, cache_write: call.cacheWrite, output_tokens: call.outputTokens }, stop_reason: call.stopReason, ...(call.proxy ? { proxy_request_id: call.proxy.requestId, duration_ms: call.proxy.durationMs } : {}) },
    null, 2,
  );
  const requestText = callDetail?.rawRequestJson
    ? JSON.stringify(callDetail.rawRequestJson, null, 2)
    : null;

  if (callDetailLoading) {
    return <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>Loading…</div>;
  }

  return (
    <>
      <div style={{ fontSize: 10, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "5px 10px", marginBottom: 12, color: "#374151" }}>
        Proxy — full request body available.
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {t("terms.jsonlMetadata")}
        </div>
        <RawCopyButton text={jsonlText} />
      </div>
      <CodeBlock variant="json" style={{ marginBottom: 14 }}>
        {jsonlText}
      </CodeBlock>

      {requestText && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {t("terms.proxyRequestBody")}
            </div>
            <RawCopyButton text={requestText} />
          </div>
          <CodeBlock variant="json">
            {requestText}
          </CodeBlock>
        </>
      )}
    </>
  );
}

export function LlmCallDetailPanel({
  call, sessionId, agentFileId, compactIdx, mode = "main", requestedTab, jumpVersion,
  onShowTurnContext, onLinkCall, onLinkSource,
  onClose, onOpenAsMain,
}: {
  call: MockLlmCall;
  /** Previous LlmCall (id = call.id − 1). Optional — when present and the
   *  call has cache token data, DiffPanel renders a cache-impact row. */
  prevCall?: MockLlmCall | null;
  onSelectEntry: (e: MockDiffEntry) => void;
  sessionId: string;
  /** Present iff this call belongs to a sub-agent — routes all downstream
   *  panel API calls (callDetail / attributionTree / responseTree / diffTree)
   *  through their sub-agent variants. Parent (main) sessions leave undefined. */
  agentFileId?: string;
  /** Present iff rendering a compact summarization call. 互斥于 agentFileId。
   *  路由 callDetail / attributionTree / responseTree 走 compact 专用端点；
   *  diffTree 端点没有，AttributionTreeLensPanel 会自动跳过 diff fetch。 */
  compactIdx?: number;
  mode?: "main" | "panel";
  /** Initial / forced tab. When `jumpVersion` bumps, this overrides the
   *  user's prior manual tab choice — so a fresh "返回于 call #N Response"
   *  click always lands on the response tab even if the user previously
   *  switched away. */
  requestedTab?: CallTab;
  /** Counter that bumps each time the dispatcher fires a new jump. The
   *  panel useEffect listens to this so it can force-reset the tab even
   *  when call.id + requestedTab look identical to the previous render. */
  jumpVersion?: number;
  onShowTurnContext?: () => void;
  /** 双向 link 回调：点击 Response 中的 forwarding link 时触发，传入下游 call id */
  onLinkCall?: (callId: number) => void;
  /** 反向 link 回调：点击 Request 中某个 leaf（jsonl 来源带 sourceCallId）时触发，
   *  跳到产生这个 tool_use/tool_result 的源 call。仅在 main 模式提供——
   *  panel 模式下省略以避免链接面板再派生面板（无限嵌套）。*/
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
  /**
   * Chrome-bar callbacks. When provided, render the corresponding button in
   * a top frame above the panel header. Same shape used by the linked-panel
   * wrapper (LinkedContextPanel) so the bar reads identically in both
   * contexts. Each button is hidden when its callback is undefined — main
   * mode typically gets `onClose` only (open-as-main is meaningless there
   * and stays hidden by default).
   */
  onClose?: () => void;
  onOpenAsMain?: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<CallTab>(requestedTab ?? "attribution");
  const [callDetail, setCallDetail] = useState<CallDetail | null>(null);
  const [callDetailLoading, setCallDetailLoading] = useState(true);
  // Top ledger summary: in main mode it starts expanded for the at-a-glance
  // overview, then auto-collapses on first interaction. In panel mode the
  // user is "drilling into" something specific — the summary is just chrome
  // taking vertical space, so it starts collapsed. Either mode, user can
  // click the chevron to toggle.
  const [summaryCollapsed, setSummaryCollapsed] = useState(mode === "panel");
  const collapseSummary = () => { if (!summaryCollapsed) setSummaryCollapsed(true); };
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Load eagerly on mount — needed for Attribution (real segments) from first render
  useEffect(() => {
    if (callDetail?.callId === call.id) return;
    // 数据加载 effect：进入 loading 态再 fetch，是标准 React 数据同步模式。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCallDetailLoading(true);
    const fetcher = compactIdx != null
      ? apiV2.compactCallDetail(sessionId, compactIdx)
      : agentFileId
        ? apiV2.subAgentCallDetail(sessionId, agentFileId, call.id)
        : apiV2.callDetail(sessionId, call.id);
    fetcher
      .then(d => setCallDetail(d))
      .catch(() => setCallDetail(null))
      .finally(() => setCallDetailLoading(false));
  }, [call.id, sessionId, agentFileId, compactIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset summary state when switching to a different call (panel reuse).
  // Re-initializes per mode (panel = collapsed, main = expanded).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setSummaryCollapsed(mode === "panel"); }, [call.id, mode]);

  // Force-apply the requested tab on every fresh jump (jumpVersion bumps).
  // Listening on jumpVersion alone — rather than [requestedTab] — means
  // even if the dispatcher sends the same tab twice in a row, we still
  // reset (the user may have manually switched between them). Without this
  // hard reset the user's manual selection would "stick" and the next
  // jump would land on the wrong tab.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (requestedTab && jumpVersion != null) setTab(requestedTab);
  }, [jumpVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to top whenever the displayed call changes (call switch or fresh
  // jump) so the header is always visible and the user doesn't land mid-page.
  useEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, [call.id, jumpVersion]);

  const hasProxy = !!callDetail?.proxyRequestId;
  const freshIn  = call.contextSize - call.cacheRead - call.cacheWrite;
  const nearLimit = false;
  const prevCallId = call.id > 1 ? call.id - 1 : null;

  const TAB_DEFS: Array<{ id: CallTab; label: string }> = [
    { id: "attribution", label: t("callTab.attribution") },     // 请求（含 来源/Diff/Cache/Audit 多 lens）
    { id: "response",    label: t("callTab.responseAnalysis") },// 响应分析
    { id: "raw",         label: t("callTab.raw") },             // 原始数据
  ];

  return (
    <div ref={scrollContainerRef} style={{ flex: 1, overflowY: "auto", padding: mode === "panel" ? "12px 14px" : "16px 22px", minWidth: 0 }}>

      {/* ── Header ──────────────────────────────── */}
      {/* No outer paddingBottom/border here — UnifiedHeader below provides
          the divider line, so we don't stack two borders. */}
      <div>

        {/* Title row — single global call id everywhere.
            Right-side action chips adapt to mode:
              · main mode  → 查看所在轮次 + 关闭
              · panel mode → Open as main + 关闭
            Both modes share the trailing `×` close button so the same
            shape reads across left/right views. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: "#111827" }}>
            {t("terms.callLabel")} {call.id}
          </span>
          {call.isCompaction && <RiskBadge type="compaction" />}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {/* Mode-specific primary action. onOpenAsMain takes precedence
                (panel mode); falls back to onShowTurnContext (main mode);
                neither shown if neither callback provided. */}
            {onOpenAsMain ? (
              <button
                onClick={onOpenAsMain}
                style={{ border: "1px solid #c7d2fe", background: BRAND.indigo50, color: BRAND.indigo700, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
                title={t("terms.openAsMain")}
              >
                {t("terms.openAsMain")}
              </button>
            ) : onShowTurnContext && (
              <button onClick={onShowTurnContext} style={{ border: "1px solid #c7d2fe", background: BRAND.indigo50, color: BRAND.indigo500, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
                {t("terms.showInTurn")}
              </button>
            )}
            {call.model && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 7, height: 7, borderRadius: 2, background: modelColor(call.model), flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: "#6b7280" }}>{shortModelName(call.model)}</span>
              </div>
            )}
            <span style={{ fontSize: 10, color: "#9ca3af" }}>{call.timestamp ? fmtDateShort(call.timestamp) : "—"}</span>
            {call.stopReason && (
              <span style={{ fontSize: 9, color: "#6b7280", background: "#f3f4f6", borderRadius: 3, padding: "1px 6px" }}>stop: {call.stopReason}</span>
            )}
            {call.proxy?.durationMs != null && (
              <span style={{ fontSize: 9, color: "#6b7280" }}>{call.proxy.durationMs >= 1000 ? `${(call.proxy.durationMs / 1000).toFixed(1)}s` : `${call.proxy.durationMs}ms`}</span>
            )}
            {!callDetailLoading && !hasProxy && (
              <NoProxyDot title={t("rawTab.noProxyDotTooltip")} />
            )}
            {/* Single chevron toggles ledger collapse/expand. Lives in the
                title row so the position is stable across both states (the
                old inline "展开 ▾" / absolute "收起 ▴" pair jumped between
                the summary's compact bar and the UnifiedHeader's top-right
                corner — the latter even overlapped OUTPUT). */}
            <button
              type="button"
              onClick={() => setSummaryCollapsed(v => !v)}
              title={summaryCollapsed ? "展开 token ledger" : "折叠 token ledger"}
              style={{
                border: "1px solid #e5e7eb", background: "#fff", color: "#64748b",
                borderRadius: 6, padding: "1px 7px", fontSize: 11, lineHeight: 1.2,
                cursor: "pointer", fontWeight: 600,
              }}
            >
              {summaryCollapsed ? "ledger ▾" : "ledger ▴"}
            </button>
            {onClose && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={onClose}
                    style={{
                      border: "1px solid #e5e7eb", background: "#fff", color: "#64748b",
                      borderRadius: 6, padding: "1px 7px", fontSize: 14, lineHeight: 1,
                      cursor: "pointer", fontWeight: 700,
                    }}
                  >
                    ×
                  </button>
                </TooltipTrigger>
                <TooltipContent>关闭</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {(() => {
          // Cache hit ratio — denominator includes cache_write so the value
          // matches the Turn / Session header and the CallLedger thumbnail
          // inside the call card. Previously this used (fresh + cacheRead)
          // only, which dropped cache_write from the denominator and produced
          // a different number than the Turn-level view of the same call.
          const inputTotal = freshIn + call.cacheRead + call.cacheWrite;
          const cacheRatio = inputTotal > 0 ? call.cacheRead / inputTotal * 100 : null;
          // Call-level status badges — currently only "compaction" is meaningful
          // at this granularity. Kept here so Call shares the same right-slot
          // shape as Session/Turn (even when empty the slot stays consistent).
          const callBadges: StatusBadge[] = call.isCompaction
            ? [{ kind: "compaction", count: 1, tooltip: t("sessionOverview.badges.compaction") }]
            : [];
          // The first call in a session has no previous call → Δ vs prev is
          // meaningless (would just echo contextSize). Hide that stat entirely
          // in both collapsed and expanded summaries when prevCallId is null.
          const isFirstCall = prevCallId == null;
          if (summaryCollapsed) {
            return (
              <div style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "6px 10px", borderTop: "1px solid #f3f4f6",
                borderBottom: "1px solid #f3f4f6",
                fontSize: 11, color: "#6b7280",
              }}>
                <span>{t("terms.ctxSuffix")} <strong style={{ color: "#374151" }}>{fmtK(call.contextSize)}</strong></span>
                {!isFirstCall && (
                  <span>Δ <strong style={{ color: "#374151" }}>{call.significantDelta >= 0 ? "+" : ""}{fmtK(call.significantDelta)}</strong></span>
                )}
                <span>{t("terms.toolsSuffix")} <strong style={{ color: "#374151" }}>{call.toolCalls?.length ?? 0}</strong></span>
                <span>{t("terms.cacheSuffix")} <strong style={{ color: "#374151" }}>{cacheRatio != null ? `${cacheRatio.toFixed(0)}%` : "—"}</strong></span>
              </div>
            );
          }
          return (
            <UnifiedHeader
              stats={[
                { label: "Context",   value: fmtK(call.contextSize),
                  color: nearLimit ? "#ea580c" : undefined,
                  tooltip: "Total input context (fresh + cache_read + cache_write)" },
                ...(isFirstCall ? [] : [{
                  label: call.cacheMiss ? "Δ (cache miss)" : "Δ vs prev",
                  value: `${call.significantDelta >= 0 ? "+" : ""}${fmtK(call.significantDelta)}`,
                  // On a cache miss the negative Δ is a cache_read re-accounting
                  // artifact (accumulated cache_read snaps back to the clean
                  // re-created count), NOT content shrinkage — show it neutral/
                  // amber, never the green "content shrank" tint.
                  color: call.cacheMiss ? "#d97706"
                    : call.significantDelta > 10000 ? "#dc2626"
                    : call.significantDelta > 2000 ? "#d97706"
                    : call.significantDelta < -2000 ? "#16a34a" : undefined,
                  tooltip: call.cacheMiss
                    ? `缓存失效${call.gapSincePrevMs != null ? `（距上次调用 ${fmtGap(call.gapSincePrevMs)}，超过 ~1h 服务端缓存 TTL）` : ""}：整段前缀按 cache_creation 重算。累积命中的 cache_read 会比干净重建的计数略高，所以这个负 Δ 是缓存记账修正，不代表上下文内容缩水（内容增删请看 Diff）。`
                    : "Prompt size delta vs previous call. Includes cache_read + cache_write, so it can be much larger than Input when most content is served from cache (e.g. first call after a compaction).",
                }]),
                { label: "Tool Calls", value: String(call.toolCalls?.length ?? 0) },
              ]}
              ledger={{
                mode: "call",
                freshIn,
                cacheRead: call.cacheRead,
                cacheWrite: call.cacheWrite,
                output: call.outputTokens,
                cacheRatio,
                cacheMiss: call.cacheMiss,
                gapMs: call.gapSincePrevMs,
                ephemeral1h: call.cacheEphemeral1h,
                ephemeral5m: call.cacheEphemeral5m,
              }}
              rightSlot={callBadges.length > 0
                ? <StatusBadgeStrip badges={callBadges} renderIcon={renderStatusIcon} />
                : undefined}
            />
          );
        })()}
      </div>

      {/* No proxy — all three tabs collapse to the same prompt because
          Attribution / Diff / Raw all rely on the captured request body.
          Show the prompt once instead of repeating it under three tab labels. */}
      {!callDetailLoading && !hasProxy ? (
        <ProxyMissingEmptyState />
      ) : (
        <>
          {/* ── Tabs ────────────────────────────────────
              onClickCapture on the wrapper folds the top ledger summary on
              the first interaction the user makes anywhere inside the call
              detail body (tab switch, attribution drill-in, ...) so the
              tree gets more vertical room. The chevron in the collapsed
              summary lets users re-expand. */}
          <div onClickCapture={collapseSummary} style={{ display: "flex", flexDirection: "column" }}>
          <Tabs
            value={tab}
            onValueChange={(v) => { setTab(v as CallTab); collapseSummary(); }}
            className="mb-3.5"
          >
            <TabsList variant="line" className="h-auto border-b border-border w-full justify-start gap-0 rounded-none p-0">
              {TAB_DEFS.map(({ id, label }) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="text-[11px] font-normal data-[state=active]:font-bold data-[state=active]:text-indigo-500 text-muted-foreground px-3 py-1.5 -mb-px after:bg-indigo-500"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* ══ Attribution — 多 lens 统一视图（来源 / Diff / 缓存 / Audit） ══ */}
          {tab === "attribution" && (
            <AttributionTreeLensPanel
              sessionId={sessionId}
              agentFileId={agentFileId}
              compactIdx={compactIdx}
              callId={call.id}
              prevCallId={prevCallId}
              onLinkSource={onLinkSource}
            />
          )}

          {/* ══ Response — assistant blocks (thinking / text / tool_use) ══ */}
          {tab === "response" && (
            <ResponseTreePanel
              sessionId={sessionId}
              agentFileId={agentFileId}
              compactIdx={compactIdx}
              callId={call.id}
              onLinkCall={onLinkCall}
            />
          )}

          {/* ══ Raw / Evidence ═══════════════════════════ */}
          {tab === "raw" && (
            <RawTab
              call={call}
              freshIn={freshIn}
              callDetail={callDetail}
              callDetailLoading={callDetailLoading}
            />
          )}
          </div>
        </>
      )}

    </div>
  );
}



// ─── Sub-Agent Session Panel ──────────────────────────────────────────────────

