// Single source of truth for JSONL interval-event row colors.
// Keeps "USER INPUT", "Tool result", "SUB-AGENT EVENTS", error / system rows
// visually aligned across the call chain, badge strip and detail panes.

import type { IntervalEventKind } from "../drilldown-types";

export interface EventPalette {
  bg: string;
  border: string;
  fg: string;
}

const SLATE_NEUTRAL:  EventPalette = { bg: "#f8fafc", border: "#e2e8f0", fg: "#64748b" };
const SLATE_MUTED:    EventPalette = { bg: "#f8fafc", border: "#e2e8f0", fg: "#94a3b8" };

/**
 * Sub-agent purple uses `#a855f7` (the chart-theme `subAgent` token) rather than
 * the older `#7c3aed` so it lines up with the minimap triangle marker.
 */
export const EVENT_PALETTES: Record<IntervalEventKind, EventPalette> = {
  "user:human":               { bg: "#faf5ff", border: "#d8b4fe", fg: "#a855f7" },
  "user:tool_result":         { bg: "#f0fdf4", border: "#86efac", fg: "#16a34a" },
  "user:command":             { bg: "#fffbeb", border: "#fde68a", fg: "#d97706" },
  // skill_injection：用 attachment:skill_listing 同款灰，与右侧 proxy 视图对齐
  "user:skill_injection":     { bg: "#f8fafc", border: "#e2e8f0", fg: "#475569" },
  // Compact 类事件统一橙色色板：与 left rail 的 🗜 行 / CompactEventNavItem 对齐。
  "user:compact_summary":     { bg: "#fff7ed", border: "#fed7aa", fg: "#c2410c" },

  "system:api_error":         { bg: "#fef2f2", border: "#fca5a5", fg: "#dc2626" },
  "system:local_command":     SLATE_NEUTRAL,
  "system:compact_boundary":  { bg: "#ffedd5", border: "#fdba74", fg: "#9a3412" },
  "system:turn_duration":     SLATE_NEUTRAL,
  "system:stop_hook_summary": SLATE_NEUTRAL,
  "system:away_summary":      { bg: "#fefce8", border: "#fde68a", fg: "#92400e" },

  "attachment:skill_listing":     { bg: "#f8fafc", border: "#e2e8f0", fg: "#475569" },
  "attachment:task_reminder":     { bg: "#fffbeb", border: "#fde68a", fg: "#92400e" },
  "attachment:queued_command":    { bg: "#fff7ed", border: "#fed7aa", fg: "#c2410c" },
  "attachment:edited_text_file":  { bg: "#ecfeff", border: "#a5f3fc", fg: "#0e7490" },
  "attachment:file":              { bg: "#f0f9ff", border: "#bae6fd", fg: "#0369a1" },

  "file-history-snapshot":    SLATE_MUTED,
  "last-prompt":              SLATE_NEUTRAL,
  // ai-title：标题由后台 Haiku 生成，用浅靛色区别于普通 slate 元数据。
  "ai-title":                 { bg: "#eef2ff", border: "#c7d2fe", fg: "#4f46e5" },
  "unknown":                  SLATE_MUTED,
};

export function getEventPalette(kind: IntervalEventKind): EventPalette {
  return EVENT_PALETTES[kind] ?? SLATE_MUTED;
}
