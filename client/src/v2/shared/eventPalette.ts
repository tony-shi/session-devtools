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

// 不进入 LLM context 的会话元数据（piK policy=always 的状态记录：标题/权限模式/
// worktree/排队/agent 名/文件快照…）统一用这一档样式，让它们读起来是连贯的一组、
// 与承载上下文的 user/tool/system 事件区分开。淡靛底 + 中性字，区别于 unknown 的纯灰。
const META_NONCONTEXT: EventPalette = { bg: "#f8fafc", border: "#e6e8f0", fg: "#7c83a3" };

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

  // ── 不进 context 的会话元数据：统一 META_NONCONTEXT 样式 ──────────────────
  // (ai-title 的 proxy 跳转 chip 仍是靛色 LinkIcon，作为“动作”强调；行底色归入元数据组)
  "file-history-snapshot":    META_NONCONTEXT,
  "last-prompt":              META_NONCONTEXT,
  "ai-title":                 META_NONCONTEXT,
  "permission-mode":          META_NONCONTEXT,
  "custom-title":             META_NONCONTEXT,
  "agent-name":               META_NONCONTEXT,
  "queue-operation":          META_NONCONTEXT,
  "worktree-state":           META_NONCONTEXT,
  "unknown":                  SLATE_MUTED,
};
