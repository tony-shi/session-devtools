// Phase 甘特 —— workflow run 内 agent 的真实墙钟时间线（CSS 条，非 SVG）。
//
// 时间真值来自 agent 转录的 startedAt/endedAt（ISO），不是 workflowProgress 的
// startedAt（后者对 cached 回放记录的是回放时刻，不是原始执行时刻）。
//
// 多次物理执行（resume）的 run：全量 agent（含 cached）忠实绘制——跨执行的
// 大空窗本身就是事实（退出/限流间隔），用断轴压缩呈现并标注真实时长（见
// ganttAxis.ts 头注释）。
//
// 明确不支持：无转录 / 时间戳不可解析的 agent 不画条，列出名单。

import React from "react";
import { useTranslation } from "react-i18next";
import { fmtDuration } from "../../lib/format";
import { BRAND } from "../../shared/brand";
import type { JoinedRunAgent } from "./runJoin";
import { buildBrokenAxis } from "./ganttAxis";

// phase 序号 → 条色。循环使用；同 phase 同色，扫读时并行组一眼可辨。
const PHASE_COLORS = ["#6366f1", "#0ea5e9", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];

interface Row {
  agent: JoinedRunAgent;
  startMs: number;
  endMs: number;
}

export function PhaseGantt({
  agents, onSelectAgent,
}: {
  agents: JoinedRunAgent[];
  onSelectAgent: (agentFileId: string) => void;
}) {
  const { t } = useTranslation();

  const rows: Row[] = [];
  const unplottable: JoinedRunAgent[] = [];
  for (const a of agents) {
    const startMs = a.transcript ? Date.parse(a.transcript.startedAt) : NaN;
    const endMs = a.transcript ? Date.parse(a.transcript.endedAt) : NaN;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      rows.push({ agent: a, startMs, endMs });
    } else {
      unplottable.push(a);
    }
  }

  if (rows.length === 0) {
    return (
      <div style={{ padding: "14px 4px", fontSize: 12, color: "#9ca3af" }}>
        {t("workflow.ganttNoData", { defaultValue: "无可用的转录时间数据，无法绘制甘特。" })}
      </div>
    );
  }

  const axis = buildBrokenAxis(rows.map((r) => [r.startMs, r.endMs]));
  const minStart = Math.min(...rows.map((r) => r.startMs));
  const maxEnd = Math.max(...rows.map((r) => r.endMs));
  const phaseIndexes = [...new Set(agents.map((a) => a.progress.phaseIndex ?? 0))];
  // 断轴带（每行轨道复用同一组显示位置）
  const breakBands = axis.breaks.map((b) => ({
    leftPct: (b.atDisplay / axis.displayTotal) * 100,
    widthPct: (b.displayLen / axis.displayTotal) * 100,
    gapMs: b.gapMs,
  }));

  return (
    <div style={{ padding: "10px 0" }}>
      {/* 时间轴标尺：起点 → 终点（本地时刻）+ 总跨度 */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#9ca3af", padding: "0 4px 6px" }}>
        <span>{new Date(minStart).toLocaleTimeString()}</span>
        <span>{t("workflow.ganttSpan", { defaultValue: "总跨度" })} {fmtDuration(maxEnd - minStart)}</span>
        <span>{new Date(maxEnd).toLocaleTimeString()}</span>
      </div>
      {rows.map(({ agent, startMs, endMs }, idx) => {
        const pa = agent.progress;
        const phaseHeader = idx === 0 || rows[idx - 1].agent.progress.phaseTitle !== pa.phaseTitle ? pa.phaseTitle : null;
        const colorIdx = phaseIndexes.indexOf(pa.phaseIndex ?? 0);
        const color = PHASE_COLORS[Math.max(0, colorIdx) % PHASE_COLORS.length];
        const leftPct = (axis.mapMs(startMs) / axis.displayTotal) * 100;
        const widthPct = Math.max(0.6, ((axis.mapMs(endMs) - axis.mapMs(startMs)) / axis.displayTotal) * 100);
        return (
          <React.Fragment key={pa.agentFileId}>
            {phaseHeader && (
              <div style={{ fontSize: 10, fontWeight: 800, color: "#6b7280", letterSpacing: "0.05em", padding: "8px 4px 2px" }}>
                {pa.phaseIndex != null ? `${pa.phaseIndex}. ` : ""}{phaseHeader}
              </div>
            )}
            <div
              onClick={() => onSelectAgent(pa.agentFileId)}
              className="hover:bg-gray-50 transition-colors"
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 4px", cursor: "pointer" }}
              title={`${pa.label} · ${fmtDuration(endMs - startMs)}${pa.cached ? ` · ${t("workflow.legendCached", { defaultValue: "cached 回放（上一轮转录）" })}` : ""}`}
            >
              <span style={{
                width: 150, flexShrink: 0, fontSize: 11, color: "#374151",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{pa.label}</span>
              <div style={{ flex: 1, position: "relative", height: 14, background: "#f8fafc", borderRadius: 3, overflow: "hidden" }}>
                {/* 断轴带：被压缩的跨执行空窗（斜纹），标注真实时长 */}
                {breakBands.map((b, bi) => (
                  <div
                    key={bi}
                    title={t("workflow.ganttBreakTooltip", { defaultValue: "压缩空窗：{{dur}}（跨物理执行的真实间隔）", dur: fmtDuration(b.gapMs) })}
                    style={{
                      position: "absolute", left: `${b.leftPct}%`, width: `${b.widthPct}%`,
                      top: 0, bottom: 0,
                      background: "repeating-linear-gradient(135deg, #e2e8f0 0 3px, #f8fafc 3px 7px)",
                    }}
                  />
                ))}
                <div style={{
                  position: "absolute", left: `${leftPct}%`, width: `${widthPct}%`,
                  top: 2, bottom: 2, borderRadius: 2,
                  background: color, opacity: pa.cached ? 0.35 : 0.85,
                }} />
              </div>
              <span style={{ width: 64, flexShrink: 0, fontSize: 10, color: "#6b7280", textAlign: "right" }}>
                {fmtDuration(endMs - startMs)}
              </span>
            </div>
          </React.Fragment>
        );
      })}
      {breakBands.length > 0 && (
        <div style={{ fontSize: 10, color: "#9ca3af", padding: "6px 4px 0" }}>
          {t("workflow.ganttBreakNote", {
            defaultValue: "断轴：压缩了 {{count}} 段超过 5 分钟的空窗（斜纹带）——",
            count: breakBands.length,
          })}
          {breakBands.map((b) => fmtDuration(b.gapMs)).join(" · ")}
          {t("workflow.ganttBreakNoteTail", { defaultValue: "。空窗是跨物理执行（resume）的真实间隔。" })}
        </div>
      )}
      {unplottable.length > 0 && (
        <div style={{ fontSize: 10, color: "#9ca3af", padding: "6px 4px 0" }}>
          {t("workflow.ganttUnplottable", { defaultValue: "{{count}} 个 agent 无转录时间数据，未绘制", count: unplottable.length })}
          {": "}{unplottable.map((a) => a.progress.label).join(", ")}
        </div>
      )}
      <div style={{ display: "flex", gap: 12, padding: "8px 4px 0", fontSize: 10, color: "#9ca3af" }}>
        <span><span style={{ display: "inline-block", width: 10, height: 8, background: BRAND.indigo500, opacity: 0.85, borderRadius: 2, marginRight: 4 }} />{t("workflow.legendLive", { defaultValue: "本次执行" })}</span>
        <span><span style={{ display: "inline-block", width: 10, height: 8, background: BRAND.indigo500, opacity: 0.35, borderRadius: 2, marginRight: 4 }} />{t("workflow.legendCached", { defaultValue: "cached 回放（上一轮转录）" })}</span>
      </div>
    </div>
  );
}
