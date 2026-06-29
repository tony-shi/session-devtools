// AsyncReceiptNode —— openerSource="task-notification" 的 turn-opener 节点。
// 后台任务完成回执（<task-notification> 注入，其后的 call 是真实推理，turn 切分
// 保留）。锚点缺失（Monitor 事件型通知无 <tool-use-id>）→ 显式标注，不提供假链接。
//
// JSONL-only：runId / workflowName 由 findWorkflowLaunchByToolUseId 从 launch-ack
// 的 JSONL（toolUseResult）回查 —— notification 本身只带 tool-use-id，不带 runId。
// 不再反查 drilldown.workflowRuns（重建）。「回到 launch」用 resolveLaunchAnchor
// 扫 drilldown.turns（JSONL 真值），也非重建。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { UserTurn } from "../../../drilldown-types";
import { useSessionDetail } from "../../SessionDetailContext";
import { resolveLaunchAnchor } from "../../workflow/runJoin";
import { findWorkflowLaunchByToolUseId } from "../tool-adapters";

export function AsyncReceiptNode({ turn }: { turn: UserTurn }) {
  const { t } = useTranslation();
  const { drilldown, navigate } = useSessionDetail();
  const [expanded, setExpanded] = useState(false);

  // JSONL-only：从 launch-ack 回查 runId/workflowName（非 drilldown.workflowRuns）。
  const wf = turn.openerToolUseId && drilldown
    ? findWorkflowLaunchByToolUseId(drilldown, turn.openerToolUseId)
    : null;
  // 「回到 launch」锚点 —— 扫 drilldown.turns 找含该 tool_use 的 call（JSONL 真值）。
  const launchAnchor = turn.openerToolUseId && drilldown
    ? resolveLaunchAnchor(turn.openerToolUseId, drilldown.turns)
    : null;

  const tone = { bg: "#faf5ff", border: "#e9d5ff", fg: "#581c87", dot: "#7e22ce" };
  const summary = [
    t("workflow.receiptTask", { defaultValue: "任务" }),
    turn.openerTaskId ?? "?",
    wf ? `· ${wf.workflowName}` : "",
  ].filter(Boolean).join(" ");

  return (
    <div style={{ position: "relative", zIndex: 1, display: "flex", gap: 10, padding: "6px 0", alignItems: "flex-start" }}>
      <div style={{ width: 24, display: "flex", justifyContent: "center", flexShrink: 0, paddingTop: 3 }}>
        <div style={{ width: 10, height: 10, borderRadius: "50%", background: tone.dot, border: "2px solid #fff", boxShadow: "0 0 0 1px " + tone.border }} />
      </div>
      <div style={{ flex: 1, minWidth: 0, background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 6, padding: "7px 11px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 9, fontWeight: 800, color: tone.dot, letterSpacing: "0.05em" }}>
            {t("workflow.receiptLabel", { defaultValue: "异步任务回执" })}
          </span>
          <span style={{ fontSize: 11, fontWeight: 600, color: tone.fg }}>{summary}</span>
          {turn.startedAt && <span style={{ fontSize: 9, color: "#9ca3af" }}>{turn.startedAt.slice(11, 19)}</span>}
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
            {launchAnchor && (
              <button
                onClick={() => navigate({ level: "call", turnId: launchAnchor.turnId, callId: launchAnchor.callId })}
                className="hover:bg-purple-100 transition-colors"
                style={{ fontSize: 10, color: tone.dot, background: "transparent", border: `1px solid ${tone.border}`, borderRadius: 4, padding: "1px 7px", cursor: "pointer" }}
              >
                ↑ {t("workflow.backToLaunch", { defaultValue: "回到 launch" })} ({t("sessionOverview.turn.label")} {launchAnchor.turnId})
              </button>
            )}
            {wf && (
              <button
                onClick={() => navigate({ level: "workflow-run", runId: wf.runId })}
                className="hover:bg-purple-100 transition-colors"
                style={{ fontSize: 10, fontWeight: 700, color: tone.dot, background: "#fff", border: `1px solid ${tone.border}`, borderRadius: 4, padding: "1px 7px", cursor: "pointer" }}
              >
                {t("workflow.openRunPanel", { defaultValue: "run 面板" })} ›
              </button>
            )}
            {!turn.openerToolUseId && (
              <span style={{ fontSize: 10, color: "#9ca3af" }}>
                {t("workflow.receiptNoAnchor", { defaultValue: "无回链锚点（事件型通知）" })}
              </span>
            )}
          </span>
        </div>
        {/* 原文 XML 默认折叠 —— 全文已截断过（notification 本身截断 result），
            完整结果以 run 面板的 journal result 为准。 */}
        <div style={{ marginTop: 4 }}>
          <button
            onClick={() => setExpanded((v) => !v)}
            style={{ fontSize: 10, color: "#9ca3af", background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            {expanded ? `▴ ${t("workflow.receiptHideRaw", { defaultValue: "收起原文" })}` : `▾ ${t("workflow.receiptShowRaw", { defaultValue: "查看通知原文" })}`}
          </button>
          {expanded && (
            <pre style={{
              fontSize: 10, color: "#6b7280", whiteSpace: "pre-wrap", wordBreak: "break-word",
              margin: "4px 0 0", maxHeight: 320, overflowY: "auto",
              background: "#fff", border: `1px solid ${tone.border}`, borderRadius: 4, padding: "6px 8px",
            }}>{turn.userInput}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
