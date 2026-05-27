// SessionNavRail —— session drawer 左侧 200px 导航栏：Overview + 每个 user turn
// （及其展开的 call 子行）+ 夹在 turn 之间的 compact 事件行。
//
// 纯展示 + 回调：选中态由 props 传入（编排器是 selection 的唯一来源），点击通过
// 回调上报（实际走 goNav 漏斗）。抽自 SessionDetailV2.tsx，逻辑零改动。

import React from "react";
import { useTranslation } from "react-i18next";
import type { CompactEvent } from "../drilldown-types";
import type { MockUserTurn, MockLlmCall } from "../lib/mock-data";
import type { SideCall, SideCallKind } from "../api";
import type { NavLevel } from "./session-nav";
import type { LinkedPanelState } from "./SessionDetailContext";
import { fmtK } from "../lib/format";
import { BRAND } from "../shared/brand";
import { StatusBadgeStrip, type StatusBadge } from "../shared/HeaderStats";
import { renderStatusIcon } from "../shared/SessionBadges";
import { NoProxyDot } from "../shared/NoProxyDot";
import { NavItem, CompactEventNavItem } from "./nav";

// side call kind → 平面文本标签（与 BackgroundCallsPanel 一致，暂不加 icon）。
const SIDE_CALL_KIND_LABEL: Record<SideCallKind, string> = {
  generate_session_title: "标题生成",
  quota: "Quota 探测",
  prompt_suggestion: "提示建议",
  agent_summary: "Agent 摘要",
  auto_dream: "Auto dream",
  extract_memories: "记忆抽取",
  away_summary: "离开摘要",
};

export function SessionNavRail({
  turns, compactEvents, navLevel, selectedTurn, selectedCall,
  selectedCompactEventIdx, linkedPanel, allCallsForNav,
  onNavSession, onSelectTurn, onSelectCall, onSelectCompact, onNavBackground,
  sideCalls, selectedProxyRequestId, onSelectSideCall,
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
  // 后台 side call（标题生成 / quota / suggestion 等）入口。放在顶部、与 turns 并列，
  // 否则长会话要滚到底才发现。展开成编号子项（#1/#2…，按 started_at），与 turn→call 对齐。
  onNavBackground: () => void;
  sideCalls: SideCall[];
  selectedProxyRequestId: number | null;
  onSelectSideCall: (proxyRequestId: number) => void;
}) {
  const { t } = useTranslation();
  const inBackground = navLevel === "background" || navLevel === "side-call";
  return (
    <div style={{ width: 200, borderRight: "1px solid #e5e7eb", flexShrink: 0, background: "#fafafa", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* 总览：独立置顶项，在 tab 栏之上、始终可见。 */}
      <NavItem
        label={t("sessionOverview.nav.overview")}
        active={navLevel === "session"}
        onClick={onNavSession}
      />
      {/* 两个 tab：用户轮次(N) / 后台请求(M)。点击切换左栏列表（导航到对应 family 的根）。
          次数徽标放在 tab 右侧。 */}
      <div style={{ display: "flex", flexShrink: 0, borderTop: "1px solid #e5e7eb", borderBottom: "1px solid #e5e7eb" }}>
        {([
          { key: "turns", label: t("sessionOverview.nav.userTurns"), active: !inBackground, count: turns.length, onClick: () => { if (inBackground) onNavSession(); } },
          { key: "bg", label: t("sessionOverview.nav.background", { defaultValue: "后台请求" }), active: inBackground, count: sideCalls.length, onClick: () => { if (!inBackground) onNavBackground(); } },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={tab.onClick}
            className={!tab.active ? "hover:bg-gray-100 transition-colors" : ""}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
              padding: "9px 6px", border: "none", cursor: "pointer",
              background: tab.active ? "#fff" : "transparent",
              color: tab.active ? BRAND.indigo600 : "#6b7280",
              fontSize: 11, fontWeight: 700,
              borderBottom: tab.active ? `2px solid ${BRAND.indigo500}` : "2px solid transparent",
            }}
          >
            <span>{tab.label}</span>
            {tab.count > 0 && (
              <span style={{
                fontSize: 9, fontWeight: 700,
                color: tab.active ? BRAND.indigo600 : "#9ca3af",
                background: tab.active ? "#eef2ff" : "#f1f5f9",
                borderRadius: 8, padding: "1px 6px", lineHeight: 1.4,
              }}>{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
      {!inBackground && (
        <>
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
        </>
      )}
      {inBackground && (
        <>
          <NavItem
            label={t("sessionOverview.nav.backgroundAll", { defaultValue: "全部后台请求" })}
            active={navLevel === "background"}
            onClick={onNavBackground}
          />
          {sideCalls.length === 0 && (
            <div style={{ padding: "8px 16px", fontSize: 11, color: "#9ca3af" }}>
              {t("sessionOverview.nav.backgroundEmpty", { defaultValue: "（无后台请求 / 扫描中…）" })}
            </div>
          )}
          {sideCalls.map((sc, i) => {
            const label = `#${i + 1} ${SIDE_CALL_KIND_LABEL[sc.kind] ?? sc.kind}`;
            if (sc.proxyRequestId == null) {
              // 未捕获（proxy 未抓到，仅 JSONL 留痕）：无详情页可跳，置灰、不可点。
              return (
                <div key={`sc-uncap-${i}`} style={{ padding: "5px 10px 5px 28px", fontSize: 11, color: "#cbd5e1" }}>
                  {label} <span style={{ fontSize: 9 }}>· 未捕获</span>
                </div>
              );
            }
            const pid = sc.proxyRequestId;
            return (
              <NavItem
                key={`sc-${pid}`}
                indent
                label={label}
                sublabel={sc.title ?? undefined}
                active={navLevel === "side-call" && selectedProxyRequestId === pid}
                onClick={() => onSelectSideCall(pid)}
              />
            );
          })}
        </>
      )}
      </div>
    </div>
  );
}
