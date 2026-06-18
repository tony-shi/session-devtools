// 跨多个 session-detail 视图共享的纯数据 palettes（无 JSX、无 hooks）。
//
// 抽取标准：被 ≥3 个组件引用且是 plain data。只在单个 tab 里使用的窄 palette
// （如 RequestTab 的 DIFF_OP_STYLE、AttributionTab 的 NATURE_BADGE）保留在
// 那个面板文件里。
//
// 来源：原 SessionDetailV2.tsx —— 这里的值未改动，只是物理位置变了。

import type { IntervalEventKind } from "../drilldown-types";
import { EVENT_PALETTES } from "../shared/eventPalette";

// ─── IntervalEventKind 元数据 ─────────────────────────────────────────────────
// 共享于 IntervalEventRow、JsonlCallChain、UserTurnDetailPanel 的 filter UI。

export const ALL_KINDS: IntervalEventKind[] = [
  "user:human", "user:tool_result", "user:command", "user:task-notification", "user:teammate-message",
  "system:api_error", "system:local_command", "system:turn_duration",
  "system:stop_hook_summary", "system:away_summary",
  "attachment:skill_listing", "attachment:task_reminder", "attachment:queued_command",
  "attachment:edited_text_file", "attachment:file", "attachment:hook_additional_context",
  "file-history-snapshot", "last-prompt", "ai-title", "permission-mode",
  "custom-title", "agent-name", "queue-operation", "worktree-state", "unknown",
];

export const KIND_LABEL: Record<IntervalEventKind, string> = {
  "user:human":               "User input",
  "user:tool_result":         "Tool result",
  "user:command":             "Command",
  "user:task-notification":   "Task 回执",
  "user:teammate-message":    "队友消息",
  "user:skill_injection":     "激活 SKILL",
  "user:compact_summary":     "Compact summary",
  "system:api_error":         "API error",
  "system:local_command":     "Local cmd",
  "system:compact_boundary":  "Compact boundary",
  "system:turn_duration":     "Turn duration",
  "system:stop_hook_summary": "Stop hook",
  "system:away_summary":      "Away summary",
  "attachment:skill_listing": "Skills",
  "attachment:task_reminder": "Task reminder",
  "attachment:queued_command": "Queued msg",
  "attachment:edited_text_file": "File edited",
  "attachment:file":          "File attach",
  "attachment:hook_additional_context": "Hook context",
  "file-history-snapshot":    "File snapshot",
  "last-prompt":              "Last prompt",
  "ai-title":                 "AI title",
  "permission-mode":          "Permission mode",
  "custom-title":             "Custom title",
  "agent-name":               "Agent name",
  "queue-operation":          "Queue op",
  "worktree-state":           "Worktree state",
  "unknown":                  "Unknown",
};

// 以 alias 的形式跟 EVENT_PALETTES 对齐。颜色映射在 shared/eventPalette.ts。
export const KIND_COLOR = EVENT_PALETTES;

// "原始 JSON only" 类型集合：这些 kind 没有渲染层语义，只有 raw 视图。
export const RAW_ONLY_KINDS: ReadonlySet<IntervalEventKind> = new Set([
  "unknown",
  "system:api_error",
  "system:stop_hook_summary",
]);
