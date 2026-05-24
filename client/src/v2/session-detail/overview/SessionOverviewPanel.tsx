// SessionOverviewPanel —— session 总览（顶部统计 + ledger + badges、context
// timeline 图、tool 分布、user turn 列表）。还含两个子件 ModelBreakdownBlock /
// ContextTimelineChart。
//
// Phase 3：从 SessionDetailV2 抽出。turns / drilldown / 导航都改读 useSessionDetail()，
// 不再透传 props —— 编排器只渲染 <SessionOverviewPanel />。逻辑零改动。

import React from "react";
import { useTranslation } from "react-i18next";
import type { MockUserTurn } from "../../lib/mock-data";
import { deriveSessionMetrics, type SessionMetrics } from "../../drilldown-real-fill";
import { shortModelName, modelColor } from "../../lib/format";
import { BRAND } from "../../shared/brand";
import { UnifiedHeader, StatusBadgeStrip, type StatusBadge } from "../../shared/HeaderStats";
import { MockBadge, renderStatusIcon } from "../../shared/SessionBadges";
import { getToolPalette } from "../../shared/toolRegistry";
import { useSessionDetail } from "../SessionDetailContext";
import { TurnCard } from "../turn/TurnCard";
import { ModelBreakdownBlock } from "./ModelBreakdownBlock";
import { ContextTimelineChart } from "./ContextTimelineChart";

export function SessionOverviewPanel() {
  const { t } = useTranslation();
  const { turns, drilldown, navigate } = useSessionDetail();
  const onSelectTurn = (turn: MockUserTurn) => navigate({ level: "turn", turnId: turn.id });
  const isMock = drilldown === null;

  // Use deriveSessionMetrics when real data available; fallback to turn-computed values
  const sm: SessionMetrics | null = drilldown ? deriveSessionMetrics(drilldown) : null;

  const totalCalls       = sm?.totalLlmCalls   ?? turns.reduce((s, t) => s + t.llmCallCount, 0);
  const totalToolCalls   = sm?.totalToolCalls   ?? turns.reduce((s, t) => s + t.toolCallCount, 0);
  const totalCacheRead   = sm?.totalCacheRead   ?? turns.reduce((s, t) => s + t.cacheRead, 0);
  const totalCacheWrite  = sm?.totalCacheWrite  ?? turns.reduce((s, t) => s + t.cacheWrite, 0);
  // totalFreshIn ≡ SUM of every call's API usage.input_tokens — the
  // non-cached fresh input (1x billing). The server now sums the actual
  // usage field directly (post-fix), so we trust sm.totalFreshIn; fallback
  // computes the same value locally from each call's freshIn field.
  const totalFreshIn = sm?.totalFreshIn ?? turns.reduce(
    (s, t) => s + t.calls.reduce((cs, c) => cs + c.freshIn, 0),
    0,
  );
  const totalFreshOut    = sm?.totalFreshOut    ?? null;
  const durationStr      = sm?.durationStr      ?? "—";
  // Re-derive cache ratio from the locally-computed totals so denominator
  // matches what we render (input + cacheRead + cacheWrite). Falls back to
  // the server's cacheRatio when no calls are available.
  const cacheInputTotal  = totalFreshIn + totalCacheRead + totalCacheWrite;
  const cacheRatio       = cacheInputTotal > 0
    ? (totalCacheRead / cacheInputTotal) * 100
    : sm?.cacheRatio ?? null;
  const modelBreakdown   = drilldown?.modelBreakdown ?? null;

  // Fix B2：压缩计数来自 CompactEvent（真实来源）。turn.hasCompaction 现在恒 false
  // （压缩不再误标在 turn 上），所以不能再数 turn —— 直接数 compactEvents。
  const compactEvents = drilldown?.compactEvents ?? [];

  // ── Badge summary (session-level counts) ──────────────────────────────────
  const badgeSummary = React.useMemo(() => {
    const compactionCount  = compactEvents.length;
    const errorCount       = turns.reduce((s, t) => s + t.errorCount, 0);
    const subAgentTurns    = turns.filter(t => t.calls.some(c => c.subAgents.length > 0)).length;
    const subAgentTotal    = turns.reduce((s, t) => s + t.calls.reduce((cs, c) => cs + c.subAgents.length, 0), 0);
    const commandTurns     = turns.filter(t =>
      t.calls.some(c => c.intervalEvents.some(e => e.kind === "user:command"))
    ).length;
    const unknownTurns     = turns.filter(t =>
      t.calls.some(c => c.intervalEvents.some(e => e.kind === "unknown"))
    ).length;
    const noProxyCalls     = turns.reduce((s, t) => s + t.calls.filter(c => c.proxyMatchMode === "unmatched").length, 0);
    return { compactionCount, errorCount, subAgentTurns, subAgentTotal, commandTurns, unknownTurns, noProxyCalls };
  }, [turns, compactEvents.length]);

  const [modelsExpanded, setModelsExpanded] = React.useState(false);
  const multiModel = modelBreakdown && Object.keys(modelBreakdown).length > 1;
  const singleModel = modelBreakdown && Object.keys(modelBreakdown).length === 1
    ? Object.keys(modelBreakdown)[0] : null;

  // Build status badges (icon + count, unified across Session/Turn/Call/nav)
  const sessionStatusBadges: StatusBadge[] = (() => {
    if (isMock) return [];
    const { compactionCount, errorCount, subAgentTotal, commandTurns, unknownTurns, noProxyCalls } = badgeSummary;
    const items: StatusBadge[] = [];
    if (compactionCount > 0) items.push({ kind: "compaction", count: compactionCount, tooltip: t("sessionOverview.badges.compaction") });
    if (errorCount > 0)      items.push({ kind: "error",      count: errorCount,      tooltip: t("sessionOverview.badges.errors") });
    if (subAgentTotal > 0)   items.push({ kind: "subAgent",   count: subAgentTotal,   tooltip: t("sessionOverview.badges.subAgents") });
    if (commandTurns > 0)    items.push({ kind: "command",    count: commandTurns,    tooltip: t("sessionOverview.badges.commands") });
    if (unknownTurns > 0)    items.push({ kind: "unknown",    count: unknownTurns,    tooltip: t("sessionOverview.badges.unknown") });
    if (noProxyCalls > 0)    items.push({ kind: "noProxy",    count: noProxyCalls,    tooltip: t("sessionOverview.badges.noProxyDetail", { count: noProxyCalls }) });
    return items;
  })();

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* ── Overview: stats · ledger · badges in one flex row ─────── */}
      <UnifiedHeader
        stats={[
          { label: t("sessionOverview.activity.userTurns"), value: String(drilldown?.turns.length ?? turns.length) },
          { label: t("sessionOverview.activity.llmCalls"),  value: String(totalCalls) },
          { label: t("sessionOverview.activity.toolCalls"), value: String(totalToolCalls) },
          { label: t("sessionOverview.activity.duration"),  value: durationStr },
        ]}
        ledger={{
          mode: "aggregate",
          freshIn: totalFreshIn ?? 0,
          cacheRead: totalCacheRead,
          cacheWrite: totalCacheWrite,
          output: totalFreshOut ?? 0,
          cacheRatio,
        }}
        rightSlot={
          <>
            <StatusBadgeStrip badges={sessionStatusBadges} renderIcon={renderStatusIcon} />
            {singleModel && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 7, height: 7, borderRadius: 2, background: modelColor(singleModel), flexShrink: 0 }} />
                <span style={{ fontSize: 11, color: "#6b7280" }}>{shortModelName(singleModel)}</span>
              </div>
            )}
            {multiModel && (
              <button
                onClick={() => setModelsExpanded(v => !v)}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  fontSize: 11, padding: "3px 8px", borderRadius: 6,
                  border: "1px solid #e5e7eb", background: modelsExpanded ? BRAND.indigo50 : "#f9fafb",
                  color: modelsExpanded ? BRAND.indigo500 : "#6b7280", cursor: "pointer",
                }}
              >
                {t("sessionOverview.activity.models", { n: Object.keys(modelBreakdown!).length })}
                <svg width="9" height="9" fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  style={{ transform: modelsExpanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            )}
            {isMock && <MockBadge />}
          </>
        }
      />


      {/* Models expanded panel — kept outside UnifiedHeader since it spans full width */}
      {multiModel && modelsExpanded && (
        <div style={{ marginTop: -8, marginBottom: 12 }}>
          <ModelBreakdownBlock breakdown={modelBreakdown!} />
        </div>
      )}

      {/* Context Overview Timeline */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
          {t("sessionOverview.charts.contextTimeline")} {isMock && <MockBadge />}
        </div>
        <ContextTimelineChart turns={turns} compactEvents={compactEvents} isMock={isMock} />
      </div>


      {/* Tool Distribution */}
      {(() => {
        const dist = drilldown?.toolDistribution ?? [];
        if (dist.length === 0) return null;
        const maxCount = dist[0].count;
        return (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>{t("sessionOverview.charts.toolUsage")}</div>
            <div>
              {dist.map(entry => {
                const accent = getToolPalette(entry.name).accent;
                return (
                  <div key={entry.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                    <span style={{ fontSize: 11, color: "#374151", width: 120, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                    <div style={{ flex: 1, height: 5, background: "#f3f4f6", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ width: `${(entry.count / maxCount) * 100}%`, height: "100%", background: accent, borderRadius: 2 }} />
                    </div>
                    <span style={{ fontSize: 11, color: "#6b7280", width: 36, textAlign: "right", flexShrink: 0 }}>{entry.count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* User Turn List — timeline + bordered card (mirrors Turn detail's
          Call list). The old USER/AGENT side rails are gone; the dialog feel
          lives inside each card via the blue/green bubbles. */}
      <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 10 }}>{t("sessionOverview.charts.userTurns")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 0, position: "relative" }}>
        {/* Vertical spine — same geometry as the Call list spine, so the
            two views read as one design system. */}
        <div style={{ position: "absolute", left: 11, top: 8, bottom: 8, width: 2, background: "#e5e7eb", zIndex: 0 }} />

        {turns.map((turn) => {
          // Spine dot color: red on hard problems, indigo otherwise.
          const dotColor = (turn.hasCompaction || turn.errorCount > 0) ? "#ef4444" : BRAND.indigo500;
          return (
            <div key={turn.id} style={{ position: "relative", zIndex: 1, marginBottom: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                {/* Spine dot — anchors this turn to the timeline */}
                <div style={{ flexShrink: 0, marginTop: 10, width: 24, display: "flex", justifyContent: "center" }}>
                  <div style={{
                    width: 14, height: 14, borderRadius: "50%",
                    border: "2px solid #fff",
                    background: dotColor,
                    boxShadow: `0 0 0 2px ${dotColor}40`,
                  }} />
                </div>
                {/* Card body */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TurnCard turn={turn} onClick={() => onSelectTurn(turn)} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
