// SubAgentSessionPanel —— sub-agent 侧分支的会话视图：顶部面包屑（返回父 turn）
// + 200px 左 nav（sub-agent 自己的 turns/calls）+ 主画布复用 UserTurnDetailPanel
// / LlmCallDetailPanel。
//
// 受控组件：内部 turn/call 由 URL 驱动（lift up 到 SessionDetailV2），从 props 拿
// 选中 id、点击经回调上报。本批为纯抽取，逻辑零改动。

import React from "react";
import { useTranslation } from "react-i18next";
import type { SessionDrilldown, UserTurn, LlmCall } from "../../drilldown-types";
import { fmtK } from "../../lib/format";
import { BRAND } from "../../shared/brand";
import { StatusBadgeStrip, type StatusBadge } from "../../shared/HeaderStats";
import { ForkIcon, renderStatusIcon } from "../../shared/SessionBadges";
import { AttributionGraphProvider } from "../../attribution-graph-context";
import { NavItem } from "../nav";
import { UserTurnDetailPanel } from "../turn/UserTurnDetailPanel";
import { LlmCallDetailPanel } from "../call/LlmCallDetailPanel";

export function SubAgentSessionPanel({
  drilldown,
  loadState,
  parentSessionId,
  agentFileId,
  parentLabel,
  onReturnToParent,
  selectedTurnId,
  selectedCallId,
  onSelectTurn,
  onSelectCall,
  onClearCall,
}: {
  drilldown: SessionDrilldown | null;
  loadState: "loading" | "ok" | "error";
  /** Parent session id — used for proxy/attribution lookups on sub-agent calls
   *  (sub-agent proxy rows live under the parent session id). */
  parentSessionId: string;
  /** Identifies which sub-agent JSONL the inner panels should route their
   *  call-detail / attribution-tree / response-tree / diff-tree fetches to. */
  agentFileId: string;
  parentLabel?: string;          // e.g. "Turn 3"
  onReturnToParent?: () => void; // closes sub-turn, returns to parent turn detail
  // Phase 4：内部 turn/call 由 URL 驱动（lift up 到 SessionDetailV2）。本面板
  // 变成受控组件 —— 从 props 拿选中 id，点击通过回调上报，不再持有 local state。
  selectedTurnId: number | null;
  selectedCallId: number | null;
  onSelectTurn: (turnId: number) => void;
  onSelectCall: (callId: number) => void;
  onClearCall: () => void;       // 面包屑点 turn 时清掉 call，回到 turn 详情
}) {
  const { t } = useTranslation();

  // innerTurn/innerCall 从 props id + drilldown 派生（不再是 local state）。
  // selectedTurnId 为 null（bare，redirect 前的瞬间）时回退到首 turn，避免闪烁 ——
  // redirect 会立刻把 URL 设成首 turn id，派生结果一致，无跳变。
  const innerTurn: UserTurn | null =
    (selectedTurnId != null ? drilldown?.turns.find(t => t.id === selectedTurnId) : null)
    ?? drilldown?.turns[0]
    ?? null;
  const innerCall: LlmCall | null =
    (selectedCallId != null ? innerTurn?.calls.find(c => c.id === selectedCallId) : null) ?? null;

  if (loadState === "loading") {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
        {t("sessionOverview.subAgent.loading")}
      </div>
    );
  }
  if (loadState === "error" || !drilldown) {
    return (
      <div style={{ padding: 40, textAlign: "center", color: "#dc2626", fontSize: 13 }}>
        {t("sessionOverview.subAgent.loadFailed")}
      </div>
    );
  }

  const turns = drilldown.turns;
  const turnPrefix = t("sessionOverview.turn.label");
  const callPrefix = t("terms.callLabel");

  // 受控：点击只上报，URL 变化后由父组件回灌 selectedTurnId/CallId。
  function handleSelectTurn(turn: UserTurn) { onSelectTurn(turn.id); }
  function handleSelectCall(call: LlmCall) { onSelectCall(call.id); }

  // Cross-link kill-switch for the sub-agent scope (see earlier comment):
  // empty sessionId skips the attribution-graph API fetch; null onJumpToCall
  // suppresses every "↗ jump to call #N" UI inside descendant components.
  // Re-enabling is Phase 2 (banner explains).
  return (
    <AttributionGraphProvider sessionId="" onJumpToCall={null}>
      <div style={{ display: "flex", flex: 1, overflow: "hidden", flexDirection: "column" }}>
        {/* ── Top breadcrumb-style bar: back-to-parent + side-branch meta ── */}
        {onReturnToParent && parentLabel && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 16px", background: BRAND.violetGradient50,
            borderBottom: "1px dashed #c4b5fd", flexShrink: 0,
          }}>
            <button
              onClick={onReturnToParent}
              style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                fontSize: 11, fontWeight: 600, color: BRAND.violet800,
                background: BRAND.violet100, border: "1px solid #c4b5fd",
                borderRadius: 4, padding: "2px 8px", cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 12, lineHeight: 1 }}>↩</span>
              {t("sessionOverview.subAgent.backTo", { name: parentLabel })}
            </button>
            <span style={{ fontSize: 10, color: BRAND.violet600, letterSpacing: "0.04em" }}>
              <ForkIcon size={10} color={BRAND.violet600} /> {t("sessionOverview.subAgent.sideBranch")} · {turns.length} · {drilldown.subAgents.length > 0 ? t("sessionOverview.subAgent.nested", { n: drilldown.subAgents.length }) : t("sessionOverview.subAgent.leaf")}
            </span>
            {/* Mini inline breadcrumb so the position inside the sub-agent
                is always visible — parallels the main session's header. */}
            {innerTurn && (
              <>
                <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  color: !innerCall ? BRAND.indigo500 : "#374151",
                  cursor: innerCall ? "pointer" : "default",
                }}
                  onClick={() => { if (innerCall) onClearCall(); }}
                >
                  {turnPrefix} {innerTurn.id}
                </span>
              </>
            )}
            {innerCall && (
              <>
                <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
                <span style={{ fontSize: 11, fontWeight: 600, color: BRAND.indigo500 }}>
                  {callPrefix} {innerCall.id}
                </span>
              </>
            )}
          </div>
        )}

        {/* ── Body: 200px left nav + Main Canvas — same structure as main session ── */}
        <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
          {/* Left nav — NavItem rows, one per sub-agent turn, with badges +
              indented Call sub-rows under the currently selected turn.
              Mirrors SessionDetailV2's left rail (lines ~5495+) but scoped
              to this sub-agent's drilldown. */}
          <div style={{ width: 200, borderRight: "1px solid #e5e7eb", overflowY: "auto", flexShrink: 0, background: "#fafafa" }}>
            <div style={{ padding: "12px 12px 4px", fontSize: 10, fontWeight: 700, color: "#9ca3af", letterSpacing: "0.07em" }}>
              {t("sessionOverview.subAgent.turnsHeader")}
            </div>
            {turns.map(turn => {
              const isThisTurnSelected = innerTurn?.id === turn.id;
              const turnInput = turn.userInput.trim();
              const preview = turnInput.slice(0, 16).trimEnd() + (turnInput.length > 16 ? "…" : "");
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
              const subAgentCount = turn.calls.reduce((s, c) => s + (c.subAgents?.length ?? 0), 0);
              const commandCount = turn.calls.reduce(
                (s, c) => s + c.intervalEvents.filter(e => e.kind === "user:command").length, 0);
              const unknownCount = turn.calls.reduce(
                (s, c) => s + c.intervalEvents.filter(e => e.kind === "unknown").length, 0);
              const navBadgeItems: StatusBadge[] = [];
              if (turn.hasCompaction)   navBadgeItems.push({ kind: "compaction", count: 1,              tooltip: t("sessionOverview.badges.compaction") });
              if (turn.errorCount > 0)  navBadgeItems.push({ kind: "error",      count: turn.errorCount,tooltip: t("sessionOverview.badges.errors") });
              if (subAgentCount > 0)    navBadgeItems.push({ kind: "subAgent",   count: subAgentCount,  tooltip: t("sessionOverview.badges.subAgents") });
              if (commandCount > 0)     navBadgeItems.push({ kind: "command",    count: commandCount,   tooltip: t("sessionOverview.badges.commands") });
              if (unknownCount > 0)     navBadgeItems.push({ kind: "unknown",    count: unknownCount,   tooltip: t("sessionOverview.badges.unknown") });
              const turnBadges = (
                <StatusBadgeStrip badges={navBadgeItems} size="compact" renderIcon={renderStatusIcon} />
              );
              return (
                <React.Fragment key={`sa-turn-${turn.id}`}>
                  <NavItem
                    label={turnLabel}
                    sublabel={`${turn.netContextDelta > 0 ? "+" : ""}${fmtK(turn.netContextDelta)} · ${turn.llmCallCount} ${t("terms.callsSuffix")}${turn.toolCallCount > 0 ? ` · ${turn.toolCallCount} ${t("terms.toolsSuffix")}` : ""}`}
                    active={isThisTurnSelected && !innerCall}
                    badges={turnBadges}
                    onClick={() => handleSelectTurn(turn)}
                  />
                  {isThisTurnSelected && turn.calls.map(call => {
                    const toolCount = call.toolCalls?.length ?? 0;
                    const deltaTxt = call.isSignificant && call.significantDelta !== 0
                      ? ` · ${call.significantDelta > 0 ? "+" : ""}${fmtK(call.significantDelta)}`
                      : "";
                    const toolsTxt = toolCount > 0
                      ? ` · ${toolCount} ${t("terms.toolsSuffix")}`
                      : "";
                    return (
                      <NavItem
                        key={`sa-call-${call.id}`}
                        indent
                        label={call.isCompaction ? `${callPrefix} ${call.id} ◆` : `${callPrefix} ${call.id}`}
                        sublabel={`${fmtK(call.contextSize)}${deltaTxt}${toolsTxt}`}
                        active={innerCall?.id === call.id}
                        onClick={() => handleSelectCall(call)}
                      />
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>

          {/* Main Canvas — reuses the exact same Turn/Call panels as the
              main session, so all interactions (Token ledger hover, Diff vs
              prev, sub-agent fork, etc.) work identically. */}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", minWidth: 0 }}>
            {innerTurn && !innerCall && (
              <UserTurnDetailPanel
                turn={innerTurn}
                onSelectCall={handleSelectCall}
                isMockSession={false}
                sessionId={parentSessionId}
              />
            )}
            {innerCall && (
              <LlmCallDetailPanel
                call={innerCall}
                onSelectEntry={() => {}}
                sessionId={parentSessionId}
                agentFileId={agentFileId}
                onClose={onClearCall}
              />
            )}
            {!innerTurn && (
              <div style={{ padding: 40, textAlign: "center", color: "#9ca3af", fontSize: 13 }}>
                {t("sessionOverview.subAgent.empty")}
              </div>
            )}
          </div>
        </div>
      </div>
    </AttributionGraphProvider>
  );
}
