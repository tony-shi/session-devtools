// TeamSequenceChart —— agent teams 消息时序图（纵向 sequence diagram：
// 成员为列 lifeline，时间向下，消息为列间水平箭头）。
//
// 设计依据（05 文档 §7.5 + 决策日志）：事后查看器，拓扑已锁死，离线布局；
// 纵向与全站时间轴方向一致（横向泳道被否）。完整样式：peer DM 箭头跨列照画
// 不简化（用户决策 2026-06-12）。
//
// 行布局按事件序等距（不按真实时间比例——消息密集段按比例会叠成一团），
// 真实时刻标在每行左侧。lifeline 用列内贯穿竖线，行高恒定不受内容影响。

import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TeamMember, TeamTimelineEvent } from "../../api";

// teams 域色（青系，与 user:teammate-message 事件色一致）
const TEAL = { line: "#a5f3fc", arrow: "#0e7490", dim: "#67e8f9", bg: "#ecfeff" };
const KIND_COLOR: Record<TeamTimelineEvent["kind"], string> = {
  spawn: "#0e7490",
  message: "#0891b2",
  shutdown_request: "#c2410c",
  idle: "#94a3b8",
  terminated: "#dc2626",
  shutdown: "#dc2626",
};

const TIME_COL_W = 64;
const ROW_H = 34;

export function TeamSequenceChart({
  members, events, currentSessionId, onOpenSession,
}: {
  members: TeamMember[];
  events: TeamTimelineEvent[];
  currentSessionId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const [showIdle, setShowIdle] = useState(true);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // 列模型：lead 恒第一列（members 由后端按 first_event_at 排，lead 通常最早；
  // 防御性重排保证 lead 在前）。列名 = agentName，lead 用 "team-lead"
  // （与 events.from/to 的取值一致——发送者名就是这套词汇）。
  const columns = useMemo(() => {
    const sorted = [...members].sort((a, b) => (a.role === "lead" ? -1 : 0) - (b.role === "lead" ? -1 : 0));
    return sorted.map((m) => ({ name: m.agentName ?? "team-lead", member: m }));
  }, [members]);
  const colIndex = useMemo(() => new Map(columns.map((c, i) => [c.name, i])), [columns]);
  const centerPct = (i: number) => ((i + 0.5) / columns.length) * 100;

  const visible = events
    .map((ev, idx) => ({ ev, idx }))
    .filter(({ ev }) => showIdle || ev.kind !== "idle");
  const idleCount = events.filter((e) => e.kind === "idle").length;

  return (
    <div>
      {idleCount > 0 && (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, color: "#6b7280", marginBottom: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={showIdle} onChange={(e) => setShowIdle(e.target.checked)} />
          {t("team.showIdle", { defaultValue: "显示 idle 通知（{{count}}）", count: idleCount })}
        </label>
      )}

      {/* ── 列头 ── */}
      <div style={{ display: "flex", marginLeft: TIME_COL_W, borderBottom: "1px solid #e5e7eb", paddingBottom: 4 }}>
        {columns.map((c) => (
          <div key={c.name} style={{ flex: 1, textAlign: "center", minWidth: 0 }}>
            <div style={{
              fontSize: 11, fontWeight: 700,
              color: c.member.role === "lead" ? "#0e7490" : "#374151",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "0 4px",
            }}>
              {c.name}
              {c.member.sessionId === currentSessionId && (
                <span style={{ fontWeight: 400, color: "#9ca3af", marginLeft: 4 }}>
                  {t("team.thisSession", { defaultValue: "(本会话)" })}
                </span>
              )}
            </div>
            <div style={{ fontSize: 9, color: "#9ca3af" }}>{c.member.role}</div>
          </div>
        ))}
      </div>

      {/* ── 事件行（lifeline 由每行的列竖线段拼接，行高恒定不断线）── */}
      <div>
        {visible.map(({ ev, idx }) => {
          const fromIdx = colIndex.get(ev.from);
          const toName = ev.to ?? (ev.kind === "idle" ? "team-lead" : undefined);
          const toIdx = toName != null ? colIndex.get(toName) : undefined;
          const color = KIND_COLOR[ev.kind];
          const expanded = expandedIdx === idx;
          const label = ev.summary ?? ev.textPreview.slice(0, 40);
          return (
            <React.Fragment key={idx}>
              <div
                onClick={() => setExpandedIdx(expanded ? null : idx)}
                className="hover:bg-gray-50 transition-colors"
                style={{ display: "flex", height: ROW_H, cursor: "pointer", position: "relative" }}
              >
                <div style={{ width: TIME_COL_W, flexShrink: 0, fontSize: 9, color: "#9ca3af", display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 8, fontFamily: "monospace" }}>
                  {ev.timestamp.slice(11, 19)}
                </div>
                <div style={{ flex: 1, position: "relative" }}>
                  {/* lifelines */}
                  {columns.map((c, i) => (
                    <div key={c.name} style={{
                      position: "absolute", left: `${centerPct(i)}%`, top: 0, bottom: 0,
                      width: 1, background: TEAL.line, transform: "translateX(-0.5px)",
                    }} />
                  ))}
                  {/* 事件图形 */}
                  {fromIdx != null && (
                    <EventGlyph
                      fromPct={centerPct(fromIdx)}
                      toPct={toIdx != null && toIdx !== fromIdx ? centerPct(toIdx) : null}
                      color={color}
                      dashed={ev.kind === "idle"}
                      hollow={ev.kind === "idle"}
                      label={label}
                    />
                  )}
                </div>
              </div>
              {expanded && (
                <div style={{
                  marginLeft: TIME_COL_W, marginBottom: 6, padding: "8px 12px",
                  background: TEAL.bg, border: `1px solid ${TEAL.line}`, borderRadius: 6, fontSize: 11,
                }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 5, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 800, color, fontSize: 10, letterSpacing: "0.04em" }}>{ev.kind.toUpperCase()}</span>
                    <span style={{ fontWeight: 700, color: "#111827" }}>{ev.from}{toName ? ` → ${toName}` : ""}</span>
                    <span style={{ color: "#9ca3af", fontSize: 10 }}>{ev.timestamp.replace("T", " ").slice(0, 19)}</span>
                    <span style={{ color: "#9ca3af", fontSize: 10 }}>
                      {ev.textLength.toLocaleString()} chars{ev.textLength > 300 ? t("team.previewTruncated", { defaultValue: "（预览截断至 300）" }) : ""} · jsonl #{ev.lineIdx}
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); onOpenSession(ev.sessionId); }}
                      className="hover:bg-cyan-100 transition-colors"
                      style={{ marginLeft: "auto", fontSize: 10, color: TEAL.arrow, background: "#fff", border: `1px solid ${TEAL.line}`, borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}
                    >
                      {t("team.openTranscriptSession", { defaultValue: "打开留痕会话" })} →
                    </button>
                  </div>
                  <pre style={{ margin: 0, fontSize: 11, color: "#374151", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "inherit", lineHeight: 1.6 }}>
                    {ev.textPreview}
                  </pre>
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// 单行事件图形：起点圆 + 水平线 + 终点三角（朝向 to）。无 to（自事件）只画点+短标签。
function EventGlyph({ fromPct, toPct, color, dashed, hollow, label }: {
  fromPct: number;
  toPct: number | null;
  color: string;
  dashed: boolean;
  hollow: boolean;
  label: string;
}) {
  const dot = (
    <div style={{
      position: "absolute", left: `${fromPct}%`, top: "50%",
      transform: "translate(-50%, -50%)",
      width: 8, height: 8, borderRadius: "50%",
      background: hollow ? "#fff" : color,
      border: `2px solid ${color}`,
      zIndex: 2,
    }} />
  );
  if (toPct === null) {
    return (
      <>
        {dot}
        <span style={{
          position: "absolute", left: `${fromPct}%`, top: "50%",
          transform: "translate(8px, -50%)",
          fontSize: 9, color: "#9ca3af", whiteSpace: "nowrap", maxWidth: 180,
          overflow: "hidden", textOverflow: "ellipsis", zIndex: 2,
        }}>{label}</span>
      </>
    );
  }
  const leftPct = Math.min(fromPct, toPct);
  const widthPct = Math.abs(toPct - fromPct);
  const rightward = toPct > fromPct;
  return (
    <>
      {dot}
      <div style={{
        position: "absolute", left: `${leftPct}%`, width: `${widthPct}%`, top: "50%",
        height: 0, borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}`,
        transform: "translateY(-1px)", zIndex: 1, opacity: 0.8,
      }} />
      {/* 终点三角（unicode，朝向收件人） */}
      <span style={{
        position: "absolute", left: `${toPct}%`, top: "50%",
        transform: `translate(${rightward ? "-100%" : "0"}, -50%)`,
        fontSize: 10, color, lineHeight: 1, zIndex: 2,
      }}>{rightward ? "▶" : "◀"}</span>
      {/* 中点 label */}
      <span style={{
        position: "absolute", left: `${(fromPct + toPct) / 2}%`, top: "50%",
        transform: "translate(-50%, -130%)",
        fontSize: 9, color: "#6b7280", whiteSpace: "nowrap",
        maxWidth: `${Math.max(widthPct - 4, 10)}%`,
        overflow: "hidden", textOverflow: "ellipsis",
        background: "rgba(255,255,255,0.85)", padding: "0 3px", borderRadius: 2, zIndex: 2,
      }}>{label}</span>
    </>
  );
}
