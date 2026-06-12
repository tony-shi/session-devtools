// TeamOverviewPanel —— agent teams 总览（navLevel="team" 主画布）。
//
// teams 域 = "session 分组 + 关联层"（05 文档 §7.5）：成员是平级完整 session，
// 本面板只做汇总与跳转，成员详情直接打开既有 session 视图。
// 两条显式不支持文案（不伪造）：任务板终态已被 CC 自动 compact；同名 team
// 跨时期无消歧键。

import React from "react";
import { useTranslation } from "react-i18next";
import type { TeamDomainResponse } from "../../api";
import { fmtK } from "../../lib/format";
import { HeaderStatRow, type HeaderStat } from "../../shared/HeaderStats";
import { TeamSequenceChart } from "./TeamSequenceChart";

const TEAL = { fg: "#0e7490", border: "#a5f3fc", bg: "#ecfeff" };

export function TeamOverviewPanel({
  team, currentSessionId, onOpenSession,
}: {
  team: TeamDomainResponse;
  currentSessionId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const lead = team.members.find((m) => m.role === "lead");

  const stats: HeaderStat[] = [
    { label: t("team.statMembers", { defaultValue: "成员" }), value: String(team.members.length) },
    { label: t("team.statEvents", { defaultValue: "消息事件" }), value: String(team.events.length) },
    {
      label: t("team.statSpan", { defaultValue: "起始" }),
      value: team.members.length ? team.members[0].firstEventAt.replace("T", " ").slice(5, 16) : "-",
    },
  ];

  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 800, color: "#111827" }}>
          {t("team.title", { defaultValue: "Team" })} {team.teamName}
        </span>
        {lead && (
          <span style={{ fontSize: 10, fontWeight: 700, color: TEAL.fg, background: TEAL.bg, border: `1px solid ${TEAL.border}`, borderRadius: 4, padding: "2px 7px" }}>
            lead: team-lead
          </span>
        )}
      </div>

      {/* 显式不支持（数据真值边界，不兜底） */}
      <div style={{ fontSize: 10, color: "#9ca3af", lineHeight: 1.7 }}>
        {t("team.noTaskBoard", { defaultValue: "任务板终态已被 Claude Code 自动 compact（早于 cleanup），本系统不展示任务板；事件流重放为后续批次。" })}
        <br />
        {t("team.noDisambiguation", { defaultValue: "同名 team 跨时期无消歧键——如成员时间跨度异常，可能混入了不同时期的同名 team。" })}
      </div>

      <HeaderStatRow stats={stats} />

      {/* ── 成员条 ── */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", letterSpacing: "0.05em", marginBottom: 4 }}>
          {t("team.membersHeader", { defaultValue: "MEMBERS" })}
        </div>
        {team.members.map((m) => {
          const isSelf = m.sessionId === currentSessionId;
          return (
            <div
              key={m.sessionId}
              onClick={isSelf ? undefined : () => onOpenSession(m.sessionId)}
              className={isSelf ? "" : "hover:bg-gray-50 transition-colors"}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "6px 8px",
                borderLeft: `3px solid ${m.role === "lead" ? TEAL.fg : TEAL.border}`,
                cursor: isSelf ? "default" : "pointer", marginBottom: 2,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, color: "#111827" }}>
                {m.agentName ?? "team-lead"}
              </span>
              <span style={{ fontSize: 9, fontWeight: 700, color: m.role === "lead" ? TEAL.fg : "#9ca3af", textTransform: "uppercase" }}>{m.role}</span>
              <span style={{ fontSize: 10, color: "#6b7280" }}>
                {fmtK(m.llmCallCount)} calls{m.subAgentCount > 0 ? ` · ${m.subAgentCount} subagent` : ""}
              </span>
              <span style={{ fontSize: 9, color: "#9ca3af", fontFamily: "monospace" }}>{m.sessionId.slice(0, 8)}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: isSelf ? "#9ca3af" : TEAL.fg }}>
                {isSelf
                  ? t("team.thisSession", { defaultValue: "(本会话)" })
                  : `${t("team.openSession", { defaultValue: "打开会话" })} →`}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── 消息时序图 ── */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", letterSpacing: "0.05em", margin: "6px 0 4px" }}>
          {t("team.timelineHeader", { defaultValue: "消息时序（点击行展开全文）" })}
        </div>
        <TeamSequenceChart
          members={team.members}
          events={team.events}
          currentSessionId={currentSessionId}
          onOpenSession={onOpenSession}
        />
      </div>
    </div>
  );
}

// 深链 /team 但该会话不属于任何 team —— 显式错误面板（不静默回退）。
export function TeamNotFoundPanel({ onBackToOverview }: { onBackToOverview: () => void }) {
  const { t } = useTranslation();
  return (
    <div style={{ padding: "40px 32px", display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
      <div style={{ fontSize: 14, fontWeight: 800, color: "#dc2626" }}>
        {t("team.notFoundTitle", { defaultValue: "该会话不属于任何 agent team" })}
      </div>
      <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.7 }}>
        {t("team.notFoundDetail", {
          defaultValue: "team 成员的判据是会话行级 teamName 字段（v16 起提取）。可能原因：该会话确实不是 team 成员；或库尚未按 v16 重新解析。",
        })}
      </div>
      <button
        onClick={onBackToOverview}
        className="hover:bg-gray-100 transition-colors"
        style={{ fontSize: 11, color: "#374151", border: "1px solid #d1d5db", borderRadius: 4, padding: "4px 12px", background: "#fff", cursor: "pointer" }}
      >
        {t("workflow.backToOverview", { defaultValue: "返回 session 总览" })}
      </button>
    </div>
  );
}
