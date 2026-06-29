// ToolCallRow —— 一次 tool_use 调用行（assistant 响应里携带的 tool_use）。
//
// 层级感：本组件只拥有 EventUnitCard 外壳（类型色/标题/jump/flash），per-tool 的
// preview/description/segments 全部由 tool-adapters 的 renderToolUse 产出。
// 加一个 tool 的特化 → 去 tool-adapters 注册 adapter，不动这里。

import { useTranslation } from "react-i18next";
import type { ToolCallSlot } from "../../../drilldown-types";
import { EventUnitCard } from "../../../shared/EventUnitCard";
import { useAttributionGraph } from "../../../attribution-graph-context";
import { renderToolUse } from "../tool-adapters";

export function ToolCallRow({
  tc, callId, active, onHoverToolUse,
}: {
  tc: ToolCallSlot;
  /** The LLM call that emitted this tool_use — its response is where the
   *  `›` jump opens (the user's mental model: "this Tool Use came back in
   *  call #N's response"). */
  callId: number;
  active: boolean;
  onHoverToolUse: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const { onJumpToCall, highlightedToolUseId } = useAttributionGraph();
  // Amber flash outline when an Attribution-leaf back-link targets this
  // specific tool_use row. Cleared automatically after ~2s by the context.
  const isFlashing = highlightedToolUseId !== null && highlightedToolUseId === tc.toolUseId;

  const r = renderToolUse(tc, { t });

  return (
    <div
      data-tool-use-id={tc.toolUseId}
      style={{
        marginBottom: 3,
        boxShadow: isFlashing ? "0 0 0 3px rgba(245,158,11,0.45)" : "none",
        transition: "box-shadow 350ms ease",
      }}
    >
      <EventUnitCard
        borderless={true}
        // dot color is the *event type* (Tool Use = orange), not the tool's
        // individual chip color — tool identity is conveyed by the `title`
        // chip + tool name text. This keeps the type-color visual anchor
        // ("orange = tool_use anywhere in the app") intact across calls.
        color="#f59e0b"
        kindLabel="Tool Use"
        title={tc.name}
        // tool_use 是 LLM 输出的 wire 字段 —— direction 应为 "out"。
        // 不再展示 `toolu_xxx` shortId：那是 Anthropic API 服务端生成的配对
        // token，不属于 LLM 语义产出。要看 wire 原物，通过 jump chip 跳到右侧
        // ResponseTreePanel（那里是 HTTP response 权威 view）。
        size={{ bytes: tc.inputSize, direction: "out" }}
        preview={r.preview}
        description={r.description}
        segments={r.segments}
        active={active}
        onMouseEnter={() => onHoverToolUse(tc.toolUseId)}
        onMouseLeave={() => onHoverToolUse(null)}
        onJump={onJumpToCall ? () => onJumpToCall(callId, "response", { toolUseId: tc.toolUseId }) : undefined}
        jumpLabel={t("terms.returnedByCall", { callId })}
        jumpTooltip={t("terms.openCallResponseTooltip", { callId })}
      />
    </div>
  );
}
