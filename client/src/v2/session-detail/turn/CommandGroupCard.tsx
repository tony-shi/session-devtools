// CommandGroupCard —— 把一次 local/slash 命令（/exit）或 bash（!ls）在 jsonl 里
// 展开成的多条连续事件（caveat 样板 + command-name + stdout）合并成**一张视觉卡片**。
//
// 关键约束：合并纯视觉。每条成员行保留自己的 lineIdx / 反向归因跳转 / context-status
// —— 卡片体里直接复用 <IntervalEventRow ev={member} />，它本就按 member.lineIdx 各自
// 查 getEventAnnotation 并渲染跳转 chip / 暂未消费等状态。caveat 成员默认折叠。
//
// 命令事件全部进 context（user 消息），故用正常（携带 context）色板，不做 muted。

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import type { IntervalEvent } from "../../drilldown-types";
import { BRAND } from "../../shared/brand";
import { useAttributionGraph } from "../../attribution-graph-context";
import { IntervalEventRow } from "./call-chain-rows";

function isCaveatMember(m: IntervalEvent): boolean {
  return m.rawJson.includes("<local-command-caveat>")
    || m.contentPreview.includes("<local-command-caveat>");
}

export function CommandGroupCard({
  ev, producingCallId, activeToolUseId, onHoverToolUse, suppressPendingState = false,
}: {
  ev: IntervalEvent;
  producingCallId?: number;
  activeToolUseId: string | null;
  onHoverToolUse: (id: string | null) => void;
  /** 抑制每行的 "暂未消费" 黄牌。trailing inter-turn 块（session 结束）传 true：
   *  那里的 pending 是集体宿命，由块级文案说明，不需要逐条重复。 */
  suppressPendingState?: boolean;
}) {
  const { t } = useTranslation();
  const group = ev.commandGroup;
  const [showCaveat, setShowCaveat] = useState(false);
  const { getEventAnnotation } = useAttributionGraph();

  // Defensive: if somehow there's no group payload, fall back to a single row.
  if (!group) {
    return (
      <IntervalEventRow
        ev={ev}
        producingCallId={producingCallId}
        activeToolUseId={activeToolUseId}
        onHoverToolUse={onHoverToolUse}
        suppressPendingState={suppressPendingState}
      />
    );
  }

  const members = group.members;
  const caveatMembers = members.filter(isCaveatMember);
  const bodyMembers = members.filter((m) => !isCaveatMember(m));

  // Header consolidation (nice-to-have): if every member shares the same
  // firstSeenInCall AND the same contextImpact, surface a single consolidated
  // chip on the header. Otherwise just leave the per-row chips to do the work.
  const annotations = members.map((m) => getEventAnnotation(m.lineIdx));
  const allAnnotated = annotations.every((a) => a != null);
  const firstSeen = annotations[0]?.firstSeenInCall ?? null;
  const impact = annotations[0]?.contextImpact ?? null;
  const consolidated = allAnnotated
    && annotations.every((a) => a!.firstSeenInCall === firstSeen && a!.contextImpact === impact);

  return (
    <div
      style={{
        marginBottom: 2,
        border: `1px solid ${BRAND.indigo200}`,
        borderLeftWidth: 3,
        borderLeftColor: BRAND.indigo400,
        borderRadius: 6,
        background: "#fff",
        overflow: "hidden",
      }}
    >
      {/* Header — "命令" label + command name + member count (+ consolidated chip) */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "5px 9px", borderBottom: "1px solid #f3f4f6", background: BRAND.indigo50,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 800, color: BRAND.indigo700,
          background: BRAND.indigo100, borderRadius: 3, padding: "1px 5px",
          letterSpacing: "0.04em", textTransform: "uppercase",
        }}>
          {group.commandType === "bash" ? t("commandGroup.bash") : t("commandGroup.command")}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#111827", fontFamily: "monospace", wordBreak: "break-all", minWidth: 0 }}>
          {ev.contentPreview || "—"}
        </span>
        <span style={{ fontSize: 9, color: BRAND.indigo400, flexShrink: 0 }}>{members.length} {t("commandGroup.countSuffix")}</span>
        {consolidated && firstSeen != null && (
          <span style={{
            marginLeft: "auto", flexShrink: 0,
            fontSize: 9, fontWeight: 700, color: BRAND.indigo600,
            background: BRAND.indigo50, border: `1px solid ${BRAND.indigo200}`,
            borderRadius: 4, padding: "1px 6px",
          }}>
            → call #{firstSeen}
          </span>
        )}
      </div>

      <div style={{ padding: "6px 9px" }}>
        {/* Caveat member(s) — boilerplate, collapsed by default. */}
        {caveatMembers.length > 0 && (
          <div style={{ marginBottom: showCaveat ? 4 : 0 }}>
            <button
              type="button"
              onClick={() => setShowCaveat((v) => !v)}
              style={{
                fontSize: 10, color: "#9ca3af", background: "none", border: "none",
                cursor: "pointer", padding: "0 0 2px 0", lineHeight: 1.3,
              }}
            >
              {showCaveat ? "▾" : "▸"} {t("commandGroup.caveat")}
            </button>
            {showCaveat && caveatMembers.map((m, mi) => (
              <IntervalEventRow
                key={`caveat-${m.lineIdx}-${mi}`}
                ev={m}
                producingCallId={producingCallId}
                activeToolUseId={activeToolUseId}
                onHoverToolUse={onHoverToolUse}
                suppressPendingState={suppressPendingState}
              />
            ))}
          </div>
        )}

        {/* Command + stdout members — always shown, each with own attribution. */}
        {bodyMembers.map((m, mi) => (
          <IntervalEventRow
            key={`member-${m.lineIdx}-${mi}`}
            ev={m}
            producingCallId={producingCallId}
            activeToolUseId={activeToolUseId}
            onHoverToolUse={onHoverToolUse}
            suppressPendingState={suppressPendingState}
          />
        ))}
      </div>
    </div>
  );
}
