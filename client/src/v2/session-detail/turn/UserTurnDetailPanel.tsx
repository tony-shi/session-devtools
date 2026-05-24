// UserTurnDetailPanel —— 单个 user turn 的详情视图（header + minimap + 通过
// JsonlCallChain 渲染该 turn 的 call chain）。
//
// 在 4 种模式下渲染（主视图 / compact 合成 turn / sub-agent 内 / linked 摘要），
// 各模式的 onSelectCall / onSubAgentClick / onClose 接法不同，是真正的变化点，
// 故保留为 props。逻辑零改动。

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { TurnMinimap } from "../../TurnMinimap";
import type { InterTurnBlock, SubAgentSummary } from "../../drilldown-types";
import type { MockUserTurn, MockLlmCall } from "../../lib/mock-data";
import { attachMockSubAgents } from "../../drilldown-mock-fill";
import { fmtDuration } from "../../lib/format";
import { BRAND } from "../../shared/brand";
import { UnifiedHeader, StatusBadgeStrip, type StatusBadge } from "../../shared/HeaderStats";
import { renderStatusIcon, SectionLabel } from "../../shared/SessionBadges";
import { useAttributionGraph } from "../../attribution-graph-context";
import { InterTurnBlockDetail } from "../compact/CompactEventPanel";
import { JsonlCallChain } from "./JsonlCallChain";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export function UserTurnDetailPanel({
  turn, onSelectCall, isMockSession = false, onSubAgentClick, trailingInterTurnBlock = null,
  onClose, onOpenAsMain,
}: {
  turn: MockUserTurn;
  onSelectCall: (c: MockLlmCall) => void;
  isMockSession?: boolean;
  onSubAgentClick?: (sa: SubAgentSummary) => void;
  trailingInterTurnBlock?: InterTurnBlock | null;
  sessionId?: string;
  /** Chrome buttons — same shape as LlmCallDetailPanel. Each button is
   *  rendered only when its callback is wired. Linked panel passes both;
   *  main view leaves them undefined. */
  onClose?: () => void;
  onOpenAsMain?: () => void;
}) {
  const { t } = useTranslation();

  // synthesizeCompactTurn 用负 id 避开真实 turn 的 key 撞车；这里把它翻译回
  // 用户友好的 "压缩 N" 标签，不让 sentinel 漏到 UI。判定条件：hasCompaction
  // + 负 id —— 仅合成 turn 满足，真实 turn 即使有 compaction 也是正 id。
  const isCompactSyntheticTurn = turn.hasCompaction && turn.id < 0;
  const turnHeadLabel = isCompactSyntheticTurn
    ? t("sessionOverview.compact.label")
    : t("sessionOverview.turn.label");
  const turnHeadValue = isCompactSyntheticTurn ? String(-turn.id) : String(turn.id);

  const callsWithSubAgents = turn.calls.map((c, ci) => {
    // For mock sessions, inject mock sub-agent if none present
    const mockSa = isMockSession && c.subAgents.length === 0
      ? attachMockSubAgents(c, turn.id, ci)
      : null;
    return {
      ...c,
      subAgents: mockSa ? [mockSa] : c.subAgents,
    };
  });
  const enrichedTurn = { ...turn, calls: callsWithSubAgents };
  const dur = fmtDuration(turn.durationMs);
  // In linked-panel mode the user is "drilling into" the turn from a leaf
  // back-link — the summary header is just chrome taking vertical space.
  // Start collapsed. In main mode start expanded for the overview-first
  // feel. Either mode: chevron toggles.
  const { linkedPanelMode } = useAttributionGraph();
  const [summaryCollapsed, setSummaryCollapsed] = useState(linkedPanelMode);
  // Minimap default-state: expanded in the main Turn view (overview-first
  // feel — you want the heat map without an extra click), collapsed when
  // the Turn is opened as a linked panel from a Call detail (the call list
  // is already in focus; the bird's-eye nav would just steal vertical
  // space). Tool-less turns also collapse since there's nothing to map.
  const noTools = turn.toolCallCount === 0;
  const [minimapOpen, setMinimapOpen] = useState(!linkedPanelMode && !noTools);
  const minimapAnchorId = `turn-${turn.id}-call-minimap`;

  const turnSubAgents = callsWithSubAgents.flatMap(c => c.subAgents);

  const totalFreshIn  = turn.calls.reduce((s, c) => s + Math.max(c.contextSize - c.cacheRead - c.cacheWrite, 0), 0);
  const totalFreshOut = turn.calls.reduce((s, c) => s + c.outputTokens, 0);
  const cacheInputTotal = turn.cacheRead + turn.cacheWrite + totalFreshIn;
  const cacheRatio = cacheInputTotal > 0 ? turn.cacheRead / cacheInputTotal * 100 : null;

  const risks: Array<{ type: "compaction" | "unknown-spike" | "large-growth" | "near-limit" | "tool-heavy" }> = [];
  if (turn.hasCompaction)   risks.push({ type: "compaction" });
  if (turn.hasUnknownSpike) risks.push({ type: "unknown-spike" });

  // Status badges (icon + count, unified format across the app)
  const turnStatusBadges: StatusBadge[] = (() => {
    const subAgentCount = turn.calls.reduce((s, c) => s + c.subAgents.length, 0);
    const commandCount = turn.calls.reduce(
      (s, c) => s + c.intervalEvents.filter(e => e.kind === "user:command").length, 0);
    const unknownCount = turn.calls.reduce(
      (s, c) => s + c.intervalEvents.filter(e => e.kind === "unknown").length, 0);
    const items: StatusBadge[] = [];
    if (turn.hasCompaction)   items.push({ kind: "compaction", count: 1,              tooltip: t("sessionOverview.badges.compaction") });
    if (turn.errorCount > 0)  items.push({ kind: "error",      count: turn.errorCount,tooltip: t("sessionOverview.badges.errors") });
    if (subAgentCount > 0)    items.push({ kind: "subAgent",   count: subAgentCount,  tooltip: t("sessionOverview.badges.subAgents") });
    if (commandCount > 0)     items.push({ kind: "command",    count: commandCount,   tooltip: t("sessionOverview.badges.commands") });
    if (unknownCount > 0)     items.push({ kind: "unknown",    count: unknownCount,   tooltip: t("sessionOverview.badges.unknown") });
    const noProxyCount = turn.calls.filter(c => c.proxyMatchMode === "unmatched").length;
    if (noProxyCount > 0)     items.push({ kind: "noProxy",    count: noProxyCount,   tooltip: t("sessionOverview.badges.noProxyDetail", { count: noProxyCount })});
    return items;
  })();

  return (
    <div style={{ padding: "20px 24px", flex: 1, overflowY: "auto" }}>
      {/* ── Summary header — stats · ledger · badges, single row ────
          In linked-panel mode this starts collapsed (one-line gist) so
          the call timeline gets the vertical space; click 展开 ▾ to
          unfold. */}
      {summaryCollapsed ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "6px 10px", marginBottom: 16,
          background: "#fafafa", border: "1px solid #f3f4f6", borderRadius: 6,
          fontSize: 11, color: "#6b7280",
        }}>
          <span style={{ fontWeight: 700, color: "#374151" }}>{turnHeadLabel} {turnHeadValue}</span>
          <span>{turn.llmCallCount} {t("terms.callsSuffix")}</span>
          <span>{turn.toolCallCount} {t("terms.toolsSuffix")}</span>
          {turnSubAgents.length > 0 && <span style={{ color: "#a855f7" }}>{turnSubAgents.length} {t("terms.subAgentsSuffix")}</span>}
          {dur && <span>{dur}</span>}
          {cacheRatio != null && <span>{t("terms.cacheSuffix")} <strong style={{ color: "#374151" }}>{cacheRatio.toFixed(0)}%</strong></span>}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            {onOpenAsMain && (
              <button
                type="button"
                onClick={onOpenAsMain}
                title={t("terms.openAsMain")}
                style={{ border: "1px solid #c7d2fe", background: BRAND.indigo50, color: BRAND.indigo700, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
              >
                {t("terms.openAsMain")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setSummaryCollapsed(false)}
              title={t("terms.turnExpand")}
              style={{
                background: "transparent", border: "none",
                cursor: "pointer", fontSize: 11, color: BRAND.indigo500, fontWeight: 600,
                padding: "0 4px",
              }}
            >
              {t("terms.turnExpand")}
            </button>
            {onClose && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
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
      ) : (
        <div style={{ position: "relative" }}>
          <UnifiedHeader
            leadingLabel={{ label: turnHeadLabel, value: turnHeadValue }}
            stats={[
              { label: t("sessionOverview.activity.llmCalls"),  value: String(turn.llmCallCount) },
              { label: t("sessionOverview.activity.toolCalls"), value: String(turn.toolCallCount) },
              ...(turnSubAgents.length > 0
                ? [{ label: t("sessionOverview.badges.subAgents"), value: String(turnSubAgents.length), color: "#a855f7" }]
                : []),
              { label: t("sessionOverview.activity.duration"),  value: dur || "—" },
            ]}
            ledger={{
              mode: "aggregate",
              freshIn: totalFreshIn,
              cacheRead: turn.cacheRead,
              cacheWrite: turn.cacheWrite,
              output: totalFreshOut,
              cacheRatio,
            }}
            rightSlot={
              <StatusBadgeStrip badges={turnStatusBadges} renderIcon={renderStatusIcon} />
            }
          />
          {/* Chrome actions — Open as main / 折叠 / 关闭. All abs-positioned
              top-right of the UnifiedHeader so they overlay the badge slot
              without changing the header layout. linkedPanelMode triggers
              the collapse chevron + close (main view's overview stays
              sticky-expanded). */}
          {(linkedPanelMode || onOpenAsMain || onClose) && (
            <div style={{ position: "absolute", top: 4, right: 4, display: "flex", alignItems: "center", gap: 6 }}>
              {onOpenAsMain && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onOpenAsMain}
                      style={{ border: "1px solid #c7d2fe", background: BRAND.indigo50, color: BRAND.indigo700, borderRadius: 6, padding: "3px 8px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
                    >
                      {t("terms.openAsMain")}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Promote linked content into the main view</TooltipContent>
                </Tooltip>
              )}
              {linkedPanelMode && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setSummaryCollapsed(true)}
                      style={{
                        background: "transparent", border: "none",
                        cursor: "pointer", fontSize: 11, color: "#9ca3af",
                        padding: "2px 6px",
                      }}
                    >
                      折叠 ▴
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>折叠 turn 概览</TooltipContent>
                </Tooltip>
              )}
              {onClose && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
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
          )}
        </div>
      )}

      {/* ── Call Minimap (heat map) ──────────────────────────────────
          Bird's-eye view: context step line + per-call tool heatmap.
          Default-state computed at mount: expanded in main view, collapsed
          when this Turn is rendered as a linked panel (linkedPanelMode).
          Toggle hide/show is sticky for this Turn's mount lifetime.
          Click on any cell or line marker jumps to the corresponding Call
          card via the anchor `turn-${turn.id}-call-${callId}`. */}
      {!noTools && (
        <div id={minimapAnchorId} style={{ marginBottom: 16, scrollMarginTop: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: minimapOpen ? 8 : 0 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em" }}>
              {t("terms.callMinimap")}
            </span>
            <button
              onClick={() => setMinimapOpen(v => !v)}
              style={{ fontSize: 10, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: "0 4px", lineHeight: 1 }}
            >
              {minimapOpen ? t("terms.hide") : t("terms.show")}
            </button>
          </div>
          {minimapOpen && (
            <TurnMinimap
              turn={enrichedTurn}
              onSelectCall={id => {
                // Click on a heatmap cell / context line column → scroll the
                // corresponding LLM Call card into view. The anchor id is
                // produced by ChainView when rendering each call row.
                const anchor = document.getElementById(`turn-${turn.id}-call-${id}`);
                anchor?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            />
          )}
        </div>
      )}

      {/* ── Semantic call chain + raw JSONL event graph ────────────── */}
      <div style={{ marginBottom: 20 }}>
        <JsonlCallChain
          turn={enrichedTurn}
          onSelectCall={onSelectCall}
          onSubAgentClick={onSubAgentClick}
        />
      </div>

      {/* ── Trailing inter-turn block (commands after this turn ended) ── */}
      {trailingInterTurnBlock && (
        <div style={{ marginBottom: 20 }}>
          <SectionLabel>After This Turn</SectionLabel>
          <InterTurnBlockDetail block={trailingInterTurnBlock} />
        </div>
      )}
    </div>
  );
}

// ─── LLM Call Detail Panel (v2) ───────────────────────────────────────────────

// ─── Confidence level helpers ─────────────────────────────────────────────────

// ─── Attribution Flow (bridge-events overview) ────────────────────────────────

