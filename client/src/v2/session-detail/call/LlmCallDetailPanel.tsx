// LlmCallDetailPanel —— 单个 LLM call 的详情视图：顶部紧凑摘要 + Tabs
// （Attribution lens / Response / Raw）。含两个 file-internal 子件 RawTab /
// RawCopyButton。
//
// 这个面板在 4 种模式下渲染（主 call / compact-call / sub-agent call / linked
// panel），各模式的 onClose / onShowTurnContext / onLinkCall / onLinkSource /
// compactIdx / agentFileId / prevCall 接法不同，是真正的变化点 —— 保留为 props。

import React, { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { apiV2 } from "../../api";
import type { CallDetail } from "../../drilldown-types";
import type { MockLlmCall, MockDiffEntry } from "../../lib/mock-data";
import type { CallTab } from "../session-nav";
import type { VersionDiag } from "../../attribution-tree-types";
import { fmtK, fmtGap, fmtDateShort, fmtDuration, shortModelName, modelColor } from "../../lib/format";
import { BRAND } from "../../shared/brand";
import { RiskBadge } from "../../shared/SessionBadges";
import { CodeBlock } from "../../shared/CodeBlock";
import { AttributionTreeLensPanel } from "../../AttributionTreeLensPanel";
import { ResponseTreePanel } from "../../ResponseTreePanel";
import { ProxyMissingEmptyState } from "../proxy/ProxyMissingEmptyState";
import { SummaryStat, CacheSummaryStat } from "./CallSummaryStats";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Check, Copy } from "lucide-react";
import { SegmentedToggle } from "../../shared/SegmentedToggle";
import JsonView from "@uiw/react-json-view";

function RawCopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
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
      title={isCopied ? t("callDetail.copied") : t("callDetail.copy")}
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
      {isCopied ? t("callDetail.copied") : t("callDetail.copy")}
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
  const [subTab, setSubTab] = useState<"request" | "response" | "meta">("request");
  // SSE 流式响应的展示模式：默认「拼接 JSON」（语义对齐非流式响应），可切回
  // SSE 原文（wire ground truth）。非流式 / 重组失败时无此切换。
  const [respMode, setRespMode] = useState<"reconstructed" | "sse">("reconstructed");

  const jsonlObj = useMemo(() => ({
    call_id: call.id,
    index_in_turn: call.indexInTurn,
    model: call.model,
    timestamp: call.timestamp,
    usage: {
      context_size: call.contextSize,
      fresh_in: freshIn,
      cache_read: call.cacheRead,
      cache_write: call.cacheWrite,
      output_tokens: call.outputTokens
    },
    stop_reason: call.stopReason,
    ...(call.proxy ? { proxy_request_id: call.proxy.requestId, duration_ms: call.proxy.durationMs } : {})
  }), [call, freshIn]);

  const jsonlText = useMemo(() => JSON.stringify(jsonlObj, null, 2), [jsonlObj]);

  const requestText = callDetail?.rawRequestJson
    ? JSON.stringify(callDetail.rawRequestJson, null, 2)
    : null;
  const responseText = callDetail?.rawResponseText;

  const parsedResponse = useMemo(() => {
    if (callDetail?.rawResponseJson) return callDetail.rawResponseJson;
    if (!responseText) return null;
    const trimmed = responseText.trim();
    const isJson = trimmed.startsWith("{") || trimmed.startsWith("[");
    if (isJson) {
      try { return JSON.parse(responseText); }
      catch { return null; }
    }
    return null;
  }, [callDetail?.rawResponseJson, responseText]);

  const isResponseJson = !!parsedResponse;

  // SSE 流式响应的重组结果（派生物，后端 call-detail 由 SSE 原文拼接）。
  // 仅在响应不是 JSON（= 流式）且重组成功时有值。
  const reconstructedJson = !isResponseJson ? callDetail?.reconstructedResponseJson ?? null : null;
  const reconstructedText = useMemo(
    () => (reconstructedJson ? JSON.stringify(reconstructedJson, null, 2) : null),
    [reconstructedJson],
  );
  const showReconstructed = !!reconstructedJson && respMode === "reconstructed";

  if (callDetailLoading) {
    return <div style={{ fontSize: 11, color: "#9ca3af", padding: "20px 0" }}>{t("callDetail.loading")}</div>;
  }

  const subOptions = [
    { id: "request" as const, label: t("callDetail.tabRequest") },
    { id: "response" as const, label: t("callDetail.tabResponse") },
    { id: "meta" as const, label: t("callDetail.tabMeta") },
  ];

  const jsonViewStyle: React.CSSProperties = {
    backgroundColor: "transparent",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    fontSize: 11,
    lineHeight: 1.5,
  };

  return (
    <>
      <div style={{ fontSize: 10, background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "5px 10px", marginBottom: 12, color: "#374151" }}>
        {t("callDetail.proxyAvailable")}
      </div>

      <div style={{ marginBottom: 14 }}>
        <SegmentedToggle
          options={subOptions}
          value={subTab}
          onChange={setSubTab}
          align="start"
        />
      </div>

      {subTab === "request" && (
        <>
          {callDetail?.rawRequestJson ? (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {t("callDetail.titleRequestJson")}
                </div>
                <RawCopyButton text={requestText || ""} />
              </div>
              <div style={{
                padding: "10px 12px",
                backgroundColor: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6,
                maxHeight: 480, overflow: "auto",
              }}>
                <JsonView
                  value={callDetail.rawRequestJson as object}
                  collapsed={false}
                  displayDataTypes={false}
                  displayObjectSize={false}
                  enableClipboard
                  style={jsonViewStyle}
                />
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: "#9ca3af", padding: "10px 0" }}>{t("callDetail.emptyRequestJson")}</div>
          )}
        </>
      )}

      {subTab === "response" && (
        <>
          {responseText ? (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 8, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {showReconstructed ? t("callDetail.titleResponseReconstructed") : t("callDetail.titleResponseSse")}
                  </div>
                  {/* 流未正常结束：两种模式都外显（残缺是流本身的属性，不只是重组的） */}
                  {callDetail?.responseTruncated && (
                    <Badge variant="amber" className="text-[10px] px-1.5 py-0 rounded-sm">
                      {t("callDetail.respTruncated")}
                    </Badge>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {/* 仅流式且重组成功时提供切换；非流式 / 重组失败保持原有单视图 */}
                  {reconstructedJson && (
                    <SegmentedToggle
                      options={[
                        { id: "reconstructed" as const, label: t("callDetail.respModeReconstructed") },
                        { id: "sse" as const, label: t("callDetail.respModeSse") },
                      ]}
                      value={respMode}
                      onChange={setRespMode}
                    />
                  )}
                  <RawCopyButton text={showReconstructed ? (reconstructedText ?? "") : responseText} />
                </div>
              </div>
              {isResponseJson && parsedResponse ? (
                <div style={{
                  padding: "10px 12px",
                  backgroundColor: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6,
                  maxHeight: 480, overflow: "auto",
                }}>
                  <JsonView
                    value={parsedResponse as object}
                    collapsed={false}
                    displayDataTypes={false}
                    displayObjectSize={false}
                    enableClipboard
                    style={jsonViewStyle}
                  />
                </div>
              ) : showReconstructed && reconstructedJson ? (
                <div style={{
                  padding: "10px 12px",
                  backgroundColor: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6,
                  maxHeight: 480, overflow: "auto",
                }}>
                  <JsonView
                    value={reconstructedJson as object}
                    collapsed={false}
                    displayDataTypes={false}
                    displayObjectSize={false}
                    enableClipboard
                    style={jsonViewStyle}
                  />
                </div>
              ) : (
                <CodeBlock variant="preview" mono>
                  {responseText}
                </CodeBlock>
              )}
            </>
          ) : (
            <div style={{ fontSize: 11, color: "#9ca3af", padding: "10px 0" }}>{t("callDetail.emptyResponseSse")}</div>
          )}
        </>
      )}

      {subTab === "meta" && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              {t("callDetail.titleMetadataJsonl")}
            </div>
            <RawCopyButton text={jsonlText} />
          </div>
          <div style={{
            padding: "10px 12px",
            backgroundColor: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6,
            maxHeight: 480, overflow: "auto",
          }}>
            <JsonView
              value={jsonlObj}
              collapsed={false}
              displayDataTypes={false}
              displayObjectSize={false}
              enableClipboard
              style={jsonViewStyle}
            />
          </div>
        </>
      )}
    </>
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function extractCcVersionFromRawRequest(raw: Record<string, unknown> | null): string | null {
  const system = raw?.system;
  const blocks = Array.isArray(system) ? system : [system];
  for (const block of blocks) {
    const text = typeof block === "string"
      ? block
      : isRecord(block) && typeof block.text === "string"
        ? block.text
        : null;
    if (!text) continue;
    const match = /\bcc_version=(\d+\.\d+\.\d+\.[0-9a-fA-F]+)/.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

const summaryDividerStyle: React.CSSProperties = {
  alignSelf: "stretch",
  width: 1,
  minHeight: 27,
  background: "#e5e7eb",
  flex: "0 0 auto",
};

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
  const [versionDiag, setVersionDiag] = useState<VersionDiag | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Load eagerly on mount — needed for Attribution (real segments) from first render
  useEffect(() => {
    if (callDetail?.callId === call.id) return;
    setVersionDiag(null); // Reset version diag on call switch
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
  const freshIn  = Math.max(call.contextSize - call.cacheRead - call.cacheWrite, 0);
  const prevCallId = call.id > 1 ? call.id - 1 : null;
  const isFirstCall = prevCallId == null;
  const inputTotal = freshIn + call.cacheRead + call.cacheWrite;
  const cacheRatio = inputTotal > 0 ? call.cacheRead / inputTotal * 100 : null;
  const ccVersion = extractCcVersionFromRawRequest(callDetail?.rawRequestJson ?? null);
  const getCcStatus = (diag: VersionDiag | null) => {
    if (!diag) return { dotColor: undefined, tooltip: t("callSummary.cc.tooltip") };
    const failed = !diag.contextOk;
    const lv = diag.matchLevel;
    let dotColor = "#22c55e"; // default green
    if (failed || lv === "major-mismatch") {
      dotColor = "#ef4444"; // red
    } else if (lv === "minor-mismatch" || lv === "unparseable" || lv === "baseline-missing") {
      dotColor = "#f59e0b"; // yellow
    }

    const title = failed
      ? t("attribution.version.contextFailed")
      : (diag.ccVersion
          ? t("attribution.version.ccLabel", { version: diag.ccVersion })
          : t("attribution.version.ccUnknown"));

    const matchText = failed
      ? t("attribution.version.contextFailedHint")
      : t(`attribution.version.match.${lv}`);

    const tooltipContent = (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontWeight: 700 }}>{t("callSummary.cc.tooltip")}</div>
        <div style={{ borderTop: "1px solid #e5e7eb", margin: "2px 0" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 5, fontWeight: 700, color: failed || lv === "major-mismatch" ? "#b91c1c" : lv === "minor-mismatch" || lv === "unparseable" || lv === "baseline-missing" ? "#b45309" : "#15803d" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor }} />
          {title}
        </div>
        <div style={{ opacity: 0.85, lineHeight: 1.4 }}>{matchText}</div>
        {diag.baseline && (
          <div style={{ opacity: 0.6, fontSize: 10 }}>{t("attribution.version.baseline", { baseline: diag.baseline })}</div>
        )}
      </div>
    );

    return { dotColor, tooltip: tooltipContent };
  };

  const ccStatus = getCcStatus(versionDiag);
  const duration = call.proxy?.durationMs != null ? fmtDuration(call.proxy.durationMs) : "";
  const deltaColor = call.cacheMiss ? "#b45309"
    : call.significantDelta > 10000 ? "#b91c1c"
    : call.significantDelta > 2000 ? "#b45309"
    : call.significantDelta < -2000 ? "#15803d"
    : "#334155";
  const gapText = call.gapSincePrevMs != null ? ` · ${fmtGap(call.gapSincePrevMs)} gap` : "";
  const deltaTitle = call.cacheMiss
    ? t("callDetail.cacheDeltaTooltip", { gapText })
    : t("callSummary.delta.tooltip");

  const TAB_DEFS: Array<{ id: CallTab; label: string }> = [
    { id: "attribution", label: t("callTab.attribution") },     // 请求（含 来源/Diff/Cache/Audit 多 lens）
    { id: "response",    label: t("callTab.responseAnalysis") },// 响应分析
    { id: "raw",         label: t("callTab.raw") },             // 原始数据
  ];

  return (
    <div ref={scrollContainerRef} style={{ flex: 1, overflowY: "auto", padding: mode === "panel" ? "12px 14px" : "16px 22px", minWidth: 0 }}>

      {/* ── Compact call summary ───────────────────── */}
      <div style={{ paddingBottom: 10, marginBottom: 12, borderBottom: "1px solid #f3f4f6" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, minWidth: 0 }}>
          <div
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              overflowX: "auto",
              display: "flex",
              alignItems: "stretch",
              gap: 12,
              paddingBottom: 2,
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 6, flex: "0 0 auto" }}>
              <SummaryStat
                label={t("callSummary.model.label")}
                tooltip={t("callSummary.model.tooltip")}
                minWidth={96}
              >
                <span style={{ width: 6, height: 6, borderRadius: 2, background: modelColor(call.model), flexShrink: 0 }} />
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>
                  {call.model ? shortModelName(call.model) : "—"}
                </span>
              </SummaryStat>
              <SummaryStat label={t("callSummary.time.label")} tooltip={t("callSummary.time.tooltip")} minWidth={92}>
                {call.timestamp ? fmtDateShort(call.timestamp) : "—"}
              </SummaryStat>
              <SummaryStat label={t("callSummary.stop.label")} tooltip={t("callSummary.stop.tooltip")} minWidth={76}>
                {call.stopReason ?? "—"}
              </SummaryStat>
              <SummaryStat label={t("callSummary.tools.label")} tooltip={t("callSummary.tools.tooltip")} minWidth={34}>
                {call.toolCalls?.length ?? 0}
              </SummaryStat>
              <SummaryStat label={t("callSummary.duration.label")} tooltip={t("callSummary.duration.tooltip")} minWidth={54}>
                {duration || "—"}
              </SummaryStat>
              <SummaryStat
                label={t("callSummary.cc.label")}
                tooltip={ccStatus.tooltip}
                mono
                valueColor={ccVersion ? BRAND.indigo700 : "#64748b"}
                minWidth={96}
                dotColor={ccStatus.dotColor}
              >
                {callDetailLoading ? "..." : ccVersion ?? "—"}
              </SummaryStat>
            </div>
            <div style={summaryDividerStyle} />
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flex: "0 0 auto" }}>
              <SummaryStat label={t("callSummary.context.label")} tooltip={t("callSummary.context.tooltip")} size="metric" minWidth={48}>
                {fmtK(call.contextSize)}
              </SummaryStat>
              {!isFirstCall && (
                <SummaryStat label={t("callSummary.delta.label")} tooltip={deltaTitle} valueColor={deltaColor} size="metric" minWidth={46}>
                  {call.significantDelta >= 0 ? "+" : ""}{fmtK(call.significantDelta)}
                </SummaryStat>
              )}
              <CacheSummaryStat
                label={t("callSummary.cache.label")}
                tooltip={t("callSummary.cache.tooltip")}
                ratio={cacheRatio}
                freshIn={freshIn}
                cacheRead={call.cacheRead}
                cacheWrite={call.cacheWrite}
                output={call.outputTokens}
                cacheMiss={call.cacheMiss}
                gapMs={call.gapSincePrevMs}
                minWidth={52}
              />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {call.isCompaction && <RiskBadge type="compaction" />}
            {onOpenAsMain ? (
              <button
                onClick={onOpenAsMain}
                style={{ border: "1px solid #c7d2fe", background: BRAND.indigo50, color: BRAND.indigo700, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
                title={t("terms.openAsMain")}
              >
                {t("terms.openAsMain")}
              </button>
            ) : onShowTurnContext && (
              <button
                onClick={onShowTurnContext}
                style={{ border: "1px solid #c7d2fe", background: BRAND.indigo50, color: BRAND.indigo700, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
                title={t("terms.showInTurn")}
              >
                {t("terms.parentTurn")}
              </button>
            )}
            {mode === "panel" && onClose && (
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
                <TooltipContent>{t("callDetail.close")}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {/* No proxy — all three tabs collapse to the same prompt because
          Attribution / Diff / Raw all rely on the captured request body.
          Show the prompt once instead of repeating it under three tab labels. */}
      {!callDetailLoading && !hasProxy ? (
        <ProxyMissingEmptyState />
      ) : (
        <>
          {/* ── Tabs ──────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column" }}>
          <Tabs
            value={tab}
            onValueChange={(v) => { setTab(v as CallTab); }}
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
              onVersionDiagLoaded={setVersionDiag}
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
