// Tool adapter layer —— shared types.
//
// 层级感（见目录 README 思路）：
//   Layer0  EventUnitCard       视觉原语（header/content/footer/jump/折叠）
//   Layer1  ToolCallRow / IntervalEventRow   行组件，拥有 EventUnitCard 外壳
//   Layer2  tool-adapters       per-tool 渲染：把一个 tool 的 use / result
//           映射成 EventUnitCard 的 preview/description/segments + 一个可选
//           "附加渲染"（attachment，比如 workflow 的跳转 chips）
//
// adapter 只读 proxy & 我们的 JSONL（tc.inputPreview / ev.rawJson），不反查
// 重建出来的 workflow domain 汇总（drilldown.workflowRuns）。domain 信息留在
// Workflow 面板，主流只保留一个跳转。

import type React from "react";
import type { TFunction } from "i18next";
import type { EventSegment } from "../../../shared/EventUnitCard";
import type { UserTurn } from "../../../drilldown-types";
import type { SessionNav } from "../../session-nav";

export type TFn = TFunction;

/** tool_use 行的渲染产物（喂给 EventUnitCard）。 */
export interface ToolUseRender {
  preview?: string;
  description?: string;
  segments: EventSegment[];
}

/** tool_result 行的特化渲染产物。null = 该 tool 无特化，走通用渲染。 */
export interface ToolResultRender {
  /** 覆盖折叠态 preview（如 workflow 的 "⚙ Workflow «name» · 已提交"）。 */
  preview?: string;
  /** 卡片下方的附加渲染（如跳转 chips）。 */
  attachment?: React.ReactNode;
}

export interface ToolUseCtx {
  t: TFn;
}

export interface ToolResultCtx {
  t: TFn;
  navigate: (nav: SessionNav) => void;
  /** 主 session 的 turns —— 用于 openerToolUseId 精确匹配回执 turn（JSONL 内禀）。 */
  mainTurns: UserTurn[];
}
