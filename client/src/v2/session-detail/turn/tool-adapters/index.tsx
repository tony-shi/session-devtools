// Tool adapter registry —— per-tool 渲染的唯一入口。
//
// 加一个 tool 的特化 = 在这里注册一个 adapter，而不是改 ToolCallRow /
// IntervalEventRow 这两个大组件。没注册的 tool 走 defaultToolUse（行为不变）。

import type { ToolCallSlot, IntervalEvent } from "../../../drilldown-types";
import type { ToolUseRender, ToolUseCtx, ToolResultRender, ToolResultCtx } from "./types";
import { defaultToolUse } from "./default";
import { skillUse } from "./skill";
import { workflowUse, workflowResult } from "./workflow";

export type { ToolUseRender, ToolUseCtx, ToolResultRender, ToolResultCtx } from "./types";
export { isWorkflowLaunchAck, findWorkflowLaunchByToolUseId } from "./workflow";

// tool name → use-side 渲染器。
const USE_ADAPTERS: Record<string, (tc: ToolCallSlot, ctx: ToolUseCtx) => ToolUseRender> = {
  Workflow: workflowUse,
  Skill: skillUse,
};

/** tool_use 行渲染：查注册表，未命中走 default。 */
export function renderToolUse(tc: ToolCallSlot, ctx: ToolUseCtx): ToolUseRender {
  return (USE_ADAPTERS[tc.name] ?? defaultToolUse)(tc, ctx);
}

// result 侧目前只有 Workflow 有特化（launch-ack）。tool_result 事件不携带 tool
// name，所以按结构特征（ev.rawJson.toolUseResult.runId）识别，而非 name 查表。
// 其余 tool_result → null（通用渲染）。
const RESULT_ADAPTERS: Array<(ev: IntervalEvent, ctx: ToolResultCtx) => ToolResultRender | null> = [
  workflowResult,
];

/** tool_result 行特化渲染：命中任一 adapter 即返回，否则 null（走通用渲染）。 */
export function renderToolResult(ev: IntervalEvent, ctx: ToolResultCtx): ToolResultRender | null {
  for (const adapter of RESULT_ADAPTERS) {
    const r = adapter(ev, ctx);
    if (r) return r;
  }
  return null;
}
