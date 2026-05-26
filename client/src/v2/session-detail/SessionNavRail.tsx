// SessionNavRail —— session drawer 左侧 200px 导航栏：Overview + 每个 user turn
// （及其展开的 call 子行）+ 夹在 turn 之间的 compact 事件行。
//
// 纯展示 + 回调：选中态由 props 传入（编排器是 selection 的唯一来源），点击通过
// 回调上报（实际走 goNav 漏斗）。抽自 SessionDetailV2.tsx，逻辑零改动。

import React from "react";
import { useTranslation } from "react-i18next";
import type { CompactEvent } from "../drilldown-types";
import type { MockUserTurn, MockLlmCall } from "../lib/mock-data";
import type { NavLevel } from "./session-nav";
import type { LinkedPanelState } from "./SessionDetailContext";
import { fmtK } from "../lib/format";
import { BRAND } from "../shared/brand";
import { StatusBadgeStrip, type StatusBadge } from "../shared/HeaderStats";
import { renderStatusIcon } from "../shared/SessionBadges";
import { NoProxyDot } from "../shared/NoProxyDot";
import { NavItem, CompactEventNavItem } from "./nav";

export function SessionNavRail({
  turns, compactEvents, navLevel, selectedTurn, selectedCall,
  selectedCompactEventIdx, linkedPanel, allCallsForNav,
  onNavSession, onSelectTurn, onSelectCall, onSelectCompact, onNavBackground,
}: {
  turns: MockUserTurn[];
  compactEvents: CompactEvent[];
  navLevel: NavLevel;
  selectedTurn: MockUserTurn | null;
  selectedCall: MockLlmCall | null;
  selectedCompactEventIdx: number | null;
  linkedPanel: LinkedPanelState | null;
  allCallsForNav: MockLlmCall[];
  onNavSession: () => void;
  onSelectTurn: (turn: MockUserTurn) => void;
  onSelectCall: (call: MockLlmCall) => void;
  onSelectCompact: (idx: number) => void;
  // 后台 side call（标题生成 / quota / suggestion 等）入口。与 turns 并列在左栏，
  // 否则用户很难发现/点到这些不在对话主线里的请求。
  onNavBackground: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ width: 200, borderRight: "1px solid #e5e7eb", overflowY: "auto", flexShrink: 0, background: "#fafafa" }}>
      <div style={{ padding: "12px 12px 4px", fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>{t("sessionOverview.nav.session")}</div>
      <NavItem
        label={t("sessionOverview.nav.overview")}
        active={navLevel === "session"}
        onClick={onNavSession}
      />

      <div style={{ padding: "10px 12px 4px", fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>{t("sessionOverview.nav.userTurns")}</div>
      {(() => {
        const turnPrefix = t("sessionOverview.turn.label");
        const callPrefix = t("terms.callLabel");
        return turns.map(turn => {
          const isThisTurnSelected = selectedTurn?.id === turn.id;
          const turnInput = turn.userInput.trim();
          const preview = turnInput.slice(0, 16).trimEnd() + (turnInput.length > 16 ? "…" : "");
          // Two inline spans (no flex container) so the outer NavItem
          // ellipsis still kicks in. The prefix is bold + foreground;
          // the user-input preview is lighter weight + muted grey.
          const turnLabel = (
            <>
              <strong style={{ fontWeight: 700, color: isThisTurnSelected ? BRAND.indigo700 : "#111827" }}>
                {turnPrefix} {turn.id}
              </strong>
              {preview && (
                <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 6 }}>
                  {preview}
                </span>
              )}
            </>
          );
          // Status badges — same source-of-truth + same icon+count format
          // as the right-slot pills in UserTurnDetailPanel.
          const subAgentCount = turn.calls.reduce((s, c) => s + (c.subAgents?.length ?? 0), 0);
          const commandCount = turn.calls.reduce(
            (s, c) => s + c.intervalEvents.filter(e => e.kind === "user:command").length, 0);
          const unknownCount = turn.calls.reduce(
            (s, c) => s + c.intervalEvents.filter(e => e.kind === "unknown").length, 0);
          const noProxyCount = turn.calls.filter(c => c.proxyMatchMode === "unmatched").length;
          const navBadgeItems: StatusBadge[] = [];
          if (turn.hasCompaction)   navBadgeItems.push({ kind: "compaction", count: 1,              tooltip: t("sessionOverview.badges.compaction") });
          if (turn.errorCount > 0)  navBadgeItems.push({ kind: "error",      count: turn.errorCount,tooltip: t("sessionOverview.badges.errors") });
          if (subAgentCount > 0)    navBadgeItems.push({ kind: "subAgent",   count: subAgentCount,  tooltip: t("sessionOverview.badges.subAgents") });
          if (commandCount > 0)     navBadgeItems.push({ kind: "command",    count: commandCount,   tooltip: t("sessionOverview.badges.commands") });
          if (unknownCount > 0)     navBadgeItems.push({ kind: "unknown",    count: unknownCount,   tooltip: t("sessionOverview.badges.unknown") });
          if (noProxyCount > 0)     navBadgeItems.push({ kind: "noProxy",    count: noProxyCount,   tooltip: t("sessionOverview.badges.noProxyDetail", { count: noProxyCount })});
          const turnBadges = (
            <StatusBadgeStrip badges={navBadgeItems} size="compact" renderIcon={renderStatusIcon} />
          );
          return (
            <React.Fragment key={`turn-${turn.id}`}>
              <NavItem
                label={turnLabel}
                sublabel={`${turn.netContextDelta > 0 ? "+" : ""}${fmtK(turn.netContextDelta)} · ${turn.llmCallCount} ${t("terms.callsSuffix")}${turn.toolCallCount > 0 ? ` · ${turn.toolCallCount} ${t("terms.toolsSuffix")}` : ""}`}
                active={navLevel === "turn" && isThisTurnSelected && !selectedCall}
                badges={turnBadges}
                onClick={() => onSelectTurn(turn)}
              />
              {isThisTurnSelected && allCallsForNav.length > 0 && allCallsForNav.map(call => {
                // Call-level nav: a single global id everywhere.
                // Label is `${callPrefix} ${call.id}` (e.g. `LLM 调用 4`)
                // — the same numbering used in the call card header,
                // call detail title and the breadcrumb. The sublabel no
                // longer repeats #id since it's already in the label.
                const callLabel = call.isCompaction
                  ? `${callPrefix} ${call.id} ◆`
                  : `${callPrefix} ${call.id}`;
                const toolCount = call.toolCalls?.length ?? 0;
                const deltaTxt = call.isSignificant && call.significantDelta !== 0
                  ? ` · ${call.significantDelta > 0 ? "+" : ""}${fmtK(call.significantDelta)}`
                  : "";
                const toolsTxt = toolCount > 0
                  ? ` · ${toolCount} ${t("terms.toolsSuffix")}`
                  : "";
                const callNavBadges: StatusBadge[] = call.isCompaction
                  ? [{ kind: "compaction", count: 1, tooltip: t("sessionOverview.badges.compaction") }]
                  : [];
                // Proxy-link quality dot: 与右侧 chrome 的 NoProxyDot
                // 同色同形 —— 让 sidebar 和 detail 顶部对同一条 call 的
                // "无 proxy" 提示完全一致。
                const hasProxyDot = call.proxyMatchMode === "unmatched";
                const badgesNode = (hasProxyDot || callNavBadges.length > 0) ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    {hasProxyDot && (
                      <NoProxyDot size={8} title={t("rawTab.noProxyDotTooltip")} />
                    )}
                    {callNavBadges.length > 0 && (
                      <StatusBadgeStrip badges={callNavBadges} size="compact" renderIcon={renderStatusIcon} />
                    )}
                  </div>
                ) : undefined;
                return (
                  <NavItem
                    key={call.id}
                    indent
                    label={callLabel}
                    sublabel={`${fmtK(call.contextSize)}${deltaTxt}${toolsTxt}`}
                    active={
                      selectedCall?.id === call.id
                      || (linkedPanel?.type === "call" && linkedPanel.call.id === call.id)
                      || (linkedPanel?.type === "turn-excerpt" && linkedPanel.focusCall?.id === call.id)
                    }
                    badges={badgesNode}
                    onClick={() => onSelectCall(call)}
                  />
                );
              })}
              {/* 在 turn N 之后插入归属于 "afterTurnId === turn.id" 的
                  compact 事件 sibling 行。同一个 turn 之后可能有多个
                  compact（罕见但允许），按 belonging 顺序渲染。 */}
              {compactEvents
                .filter(ev =>
                  (ev.belonging.kind === "between-turns" && ev.belonging.afterTurnId === turn.id)
                  || (ev.belonging.kind === "post-session" && ev.belonging.afterTurnId === turn.id)
                )
                .map(ev => (
                  <CompactEventNavItem
                    key={`compact-${ev.index}`}
                    ev={ev}
                    active={navLevel === "compact-event" && selectedCompactEventIdx === ev.index}
                    onClick={() => onSelectCompact(ev.index)}
                  />
                ))}
            </React.Fragment>
          );
        });
      })()}

      {/* 后台请求 —— 与 user turns 并列的独立分区。集中陈列对话主线之外的
          side call（标题生成 / quota / prompt suggestion …）。 */}
      <div style={{ padding: "10px 12px 4px", fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>
        {t("sessionOverview.nav.background", { defaultValue: "后台请求" })}
      </div>
      <NavItem
        label={t("sessionOverview.nav.backgroundCalls", { defaultValue: "Background calls" })}
        active={navLevel === "background" || navLevel === "side-call"}
        onClick={onNavBackground}
      />
    </div>
  );
}
