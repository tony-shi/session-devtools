// SessionDetailHeader —— drawer 顶部条：可点的 title + turn/call/compact/subagent
// 面包屑 + loading/error 状态 + AuditBoundaryStatus + 关闭按钮。
//
// 纯展示 + 回调：selection 由 props 传入（编排器是唯一来源），点击经回调走 goNav
// 漏斗。抽自 SessionDetailV2.tsx，逻辑零改动。

import React from "react";
import { useTranslation } from "react-i18next";
import type { SubAgentSummary } from "../drilldown-types";
import type { MockUserTurn, MockLlmCall } from "../lib/mock-data";
import type { NavLevel, SessionNav } from "./session-nav";
import { BRAND } from "../shared/brand";
import { ForkIcon } from "../shared/SessionBadges";
import { AuditBoundaryStatus } from "../attribution-graph-context";

export function SessionDetailHeader({
  title, sessionId, navLevel, selectedTurn, selectedCall,
  selectedCompactEventIdx, selectedSubAgent, subAgentParentTurn,
  loadState, onNavSession, onNavigate, onClose,
}: {
  title: string;
  sessionId: string;
  navLevel: NavLevel;
  selectedTurn: MockUserTurn | null;
  selectedCall: MockLlmCall | null;
  selectedCompactEventIdx: number | null;
  selectedSubAgent: SubAgentSummary | null;
  subAgentParentTurn: MockUserTurn | null;
  loadState: "loading" | "ok" | "error";
  onNavSession: () => void;
  onNavigate: (nav: SessionNav) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: "1px solid #e5e7eb", flexShrink: 0, background: "#fff", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
        <button onClick={onNavSession} style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: navLevel === "session" ? BRAND.indigo500 : "#111827" }}>{title}</span>
        </button>
        {title !== sessionId && (
          <span style={{ fontSize: 10, color: "#9ca3af", fontFamily: "monospace", flexShrink: 0 }}>{sessionId}</span>
        )}
        {/* turn 面包屑：sub-agent 视图下显示其真实父 turn（parentCallId 反查），
            其余视图显示当前 selectedTurn。两种都点击 → 导航到该 turn。 */}
        {(() => {
          const crumbTurn = navLevel === "subagent" ? subAgentParentTurn : selectedTurn;
          if (!crumbTurn) return null;
          return (
            <>
              <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
              <button onClick={() => onNavigate({ level: "turn", turnId: crumbTurn.id })}
                style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, flexShrink: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: navLevel === "turn" && !selectedCall ? BRAND.indigo500 : "#374151" }}>{t("sessionOverview.turn.label")} {crumbTurn.id}</span>
              </button>
            </>
          );
        })()}
        {selectedCall && (
          <>
            <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: BRAND.indigo500, flexShrink: 0 }}>
              {t("terms.callLabel")} {selectedCall.id}
            </span>
          </>
        )}
        {/* Compact-event 进入后挂在 breadcrumb 上 —— 跟 turn/call 平行。
            "压缩 N" 是 compact-event 自身；如果再点进 call detail 还会追加
            "压缩调用" 子级。点回可以跳回上一级。 */}
        {selectedCompactEventIdx !== null
          && (navLevel === "compact-event" || navLevel === "compact-call") && (
          <>
            <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
            <button
              onClick={() => onNavigate({ level: "compact-event", compactIdx: selectedCompactEventIdx })}
              style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, flexShrink: 0 }}
            >
              <span style={{
                fontSize: 13, fontWeight: 600,
                color: navLevel === "compact-event" ? "#c2410c" : "#374151",
              }}>
                {t("sessionOverview.compact.label")} {selectedCompactEventIdx + 1}
              </span>
            </button>
            {navLevel === "compact-call" && (
              <>
                <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: "#c2410c", flexShrink: 0 }}>
                  {t("sessionOverview.compact.callLabel")}
                </span>
              </>
            )}
          </>
        )}
        {selectedSubAgent && navLevel === "subagent" && (
          <>
            <span style={{ color: "#d1d5db", flexShrink: 0 }}>›</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 13, fontWeight: 600, color: BRAND.violet600, flexShrink: 0 }}>
              <ForkIcon size={12} color={BRAND.violet600} />
              {selectedSubAgent.agentType}
            </span>
          </>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        {loadState === "loading" && (
          <span style={{ fontSize: 10, color: BRAND.indigo500, background: "#eff6ff", borderRadius: 4, padding: "2px 8px" }}>{t("sessionOverview.status.loading")}</span>
        )}
        {loadState === "error" && (
          <span style={{ fontSize: 10, color: "#dc2626", background: "#fef2f2", borderRadius: 4, padding: "2px 8px" }}>{t("sessionOverview.status.error")}</span>
        )}
        <AuditBoundaryStatus />
        <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: "#9ca3af", fontSize: 20, lineHeight: 1, padding: 4 }}>×</button>
      </div>
    </div>
  );
}
