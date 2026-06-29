// Workflow tool adapter.
//
// 设计点（用户确认）：从 main session 看，一次 dynamic Workflow 就是一次普通的
// tool_use（launch script）+ 一条普通的 tool_result（launch-ack）+ 一条异步
// task-notification 开新 turn。UI 上只做「一个特别渲染 + 一个跳转」，**不抽取**
// 重建出来的 workflow 内部信息（agents/phases/tokens/status-from-run）。所有数据
// 只读 proxy & 我们的 JSONL：
//   - use:    tc.inputPreview 里的 {script}
//   - result: ev.rawJson.toolUseResult 里的 {runId, workflowName, status}
//             （CC 在 launch 回执里写入的元数据，JSONL 内禀，非转录重建）
// 完整 agents/phases/dataflow 留在 Workflow 面板，这里只保留一个跳转。

import React from "react";
import type { ToolCallSlot, IntervalEvent, SessionDrilldown } from "../../../drilldown-types";
import type { ToolUseRender, ToolUseCtx, ToolResultRender, ToolResultCtx } from "./types";
import { defaultToolUse } from "./default";

// ── use 侧：还原成普通 tool_use —— 展示 launch 的 script（JSONL 真值），不带任何
//    run 面板按钮 / 重建汇总。跳转落在 result 侧。 ──────────────────────────────
export function workflowUse(tc: ToolCallSlot, ctx: ToolUseCtx): ToolUseRender {
  const { t } = ctx;
  const parsed = (() => {
    try { return JSON.parse(tc.inputPreview) as Record<string, unknown>; } catch { return undefined; }
  })();
  const script = parsed && typeof parsed.script === "string" ? parsed.script : undefined;
  if (!script) return defaultToolUse(tc, ctx);
  const preview = t("workflow.launchToolPreview", { defaultValue: "提交 Workflow 脚本" });
  return {
    preview,
    description: preview,
    segments: [{ label: "SCRIPT", content: script, monospace: true, truncateAt: 2000, rawJson: parsed }],
  };
}

// launch-ack 的 JSONL 解析（只读 ev.rawJson.toolUseResult，零 reconstruction）。
// runId 以 "wf_" 开头才认定为 workflow launch-ack。
interface LaunchAck {
  runId: string;
  workflowName: string;
  status?: string;
  launchToolUseId?: string;
}
function parseLaunchAck(ev: IntervalEvent): LaunchAck | null {
  if (ev.kind !== "user:tool_result") return null;
  const parsed = (() => {
    try { return JSON.parse(ev.rawJson) as Record<string, unknown>; } catch { return undefined; }
  })();
  const tur = parsed?.toolUseResult as
    | { runId?: string; workflowName?: string; status?: string }
    | undefined;
  if (!tur || typeof tur.runId !== "string" || !tur.runId.startsWith("wf_")) return null;
  // launch toolUseId = 本 tool_result 的 tool_use_id（JSONL 内禀）。用它精确匹配
  // 回执 turn（其 openerToolUseId 回指本 launch）。
  const launchToolUseId = (() => {
    const content = (parsed?.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const b of content as Array<{ type?: string; tool_use_id?: string }>) {
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string") return b.tool_use_id;
      }
    }
    return undefined;
  })();
  return { runId: tur.runId, workflowName: tur.workflowName ?? tur.runId, status: tur.status, launchToolUseId };
}

/**
 * True iff this tool_result is a Workflow launch-ack ("submit success").
 * JsonlCallChain 用它把 launch-ack 排除出「子代理结果折叠」—— workflow 的多个
 * agent 共享 launch toolUseId，会被误判成子代理结果折叠隐藏；但它语义上是 launch
 * 回执，应当可见（带 ⚙ 特别渲染 + 跳转）。
 */
export function isWorkflowLaunchAck(ev: IntervalEvent): boolean {
  return parseLaunchAck(ev) != null;
}

/**
 * 跨 turn 按 launch toolUseId 找到对应的 launch-ack，返回 {runId, workflowName}
 * （都来自 JSONL launch-ack 的 toolUseResult，零 reconstruction）。供 task-notification
 * 回执节点用：notification 只带 tool-use-id（= launch toolUseId），runId/workflowName
 * 要回查 launch-ack。找不到返回 null。
 */
export function findWorkflowLaunchByToolUseId(
  drilldown: SessionDrilldown,
  launchToolUseId: string,
): { runId: string; workflowName: string } | null {
  for (const turn of drilldown.turns) {
    for (const call of turn.calls) {
      for (const ev of call.intervalEvents) {
        const ack = parseLaunchAck(ev);
        if (ack && ack.launchToolUseId === launchToolUseId) {
          return { runId: ack.runId, workflowName: ack.workflowName };
        }
      }
    }
  }
  return null;
}

// ── result 侧：launch-ack tool_result 的特别渲染 + 跳转 ──────────────────────────
// 仅当 tool_result 是 workflow launch-ack 时激活；否则 null（走通用渲染）。
export function workflowResult(ev: IntervalEvent, ctx: ToolResultCtx): ToolResultRender | null {
  const ack = parseLaunchAck(ev);
  if (!ack) return null;

  const { t, navigate, mainTurns } = ctx;
  const { runId, workflowName, launchToolUseId } = ack;
  const receiptTurn = launchToolUseId
    ? mainTurns.find((tn) => tn.openerToolUseId === launchToolUseId) ?? null
    : null;

  const statusLabel = ack.status === "async_launched"
    ? t("workflow.statusLaunched", { defaultValue: "已提交后台" })
    : ack.status;
  const preview = `⚙ Workflow «${workflowName}»${statusLabel ? ` · ${statusLabel}` : ""}`;

  const pill: React.CSSProperties = {
    fontSize: 10, fontWeight: 700, color: "#7e22ce", background: "#faf5ff",
    border: "1px solid #e9d5ff", borderRadius: 4, padding: "2px 8px", cursor: "pointer",
  };
  const attachment = (
    <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "3px 0 5px 18px", flexWrap: "wrap" }}>
      <button
        onClick={() => navigate({ level: "workflow-run", runId })}
        className="hover:bg-purple-100 transition-colors"
        style={pill}
      >
        {t("workflow.openRunPanel", { defaultValue: "run 面板" })} ›
      </button>
      {receiptTurn && (
        <button
          onClick={() => navigate({ level: "turn", turnId: receiptTurn.id })}
          className="hover:bg-purple-100 transition-colors"
          style={{ ...pill, background: "transparent" }}
        >
          {t("workflow.jumpToReceipt", { defaultValue: "回执" })} → {t("sessionOverview.turn.label")} {receiptTurn.id}
        </button>
      )}
    </div>
  );

  return { preview, attachment };
}
