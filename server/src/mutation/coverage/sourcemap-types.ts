// Ground-truth JSONL event types enumerated from two sources:
//
//   Source A — claude-code-sourcemap/restored-src/src/types/logs.ts (v2.1.88)
//              Entry union + subtype literals
//
//   Source B — Reverse-engineered from installed binary v2.1.139 (2026-05-11)
//              cZK routing table extracted from Bun SEA bundle (__BUN/__bun section)
//              strings(1) + brace-matching on the appendEntry dispatch switch
//
// Diff v2.1.88 → v2.1.139:
//   NEW:     fork-context-ref  (route-by-agent) — agent-forked context reference
//            frame-link        (always)          — linked frame/session reference
//            isolation-latch   (always)          — worktree isolation lock
//            progress          (dedup-transcript) — mid-turn progress indicator
//   REMOVED from cZK: task-summary (still in binary strings; may use separate path)

export interface SourcemapTypeEntry {
  key: string; // canonical key used across all coverage maps
  label: string; // human-readable label
  category: "transcript" | "meta" | "runtime" | "system_sub" | "attachment_sub";
  // Whether this type is in the official logs.ts Entry union
  inLogsUnion: boolean;
  // Source: "sourcemap" | "live" | "both"
  source: "sourcemap" | "live" | "both";
  description?: string;
}

export const SOURCEMAP_TYPES: SourcemapTypeEntry[] = [
  // ── Core transcript (TranscriptMessage) ──────────────────────────────────
  { key: "user", label: "user", category: "transcript", inLogsUnion: true, source: "both", description: "Human input or tool result turn" },
  { key: "assistant", label: "assistant", category: "transcript", inLogsUnion: true, source: "both", description: "Model response turn" },

  // ── Meta/lifecycle (logs.ts Entry union, non-TranscriptMessage) ──────────
  { key: "summary", label: "summary", category: "meta", inLogsUnion: true, source: "sourcemap", description: "SummaryMessage — /compact summary" },
  { key: "custom-title", label: "custom-title", category: "meta", inLogsUnion: true, source: "both", description: "User-set session title" },
  { key: "ai-title", label: "ai-title", category: "meta", inLogsUnion: true, source: "both", description: "AI-generated session title" },
  { key: "last-prompt", label: "last-prompt", category: "meta", inLogsUnion: true, source: "both", description: "Cached last user prompt" },
  { key: "task-summary", label: "task-summary", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Periodic fork-generated summary (claude ps)" },
  { key: "tag", label: "tag", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Session tag (searchable in /resume)" },
  { key: "agent-name", label: "agent-name", category: "meta", inLogsUnion: true, source: "both", description: "Agent's custom name (/rename or swarm)" },
  { key: "agent-color", label: "agent-color", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Agent color in swarm" },
  { key: "agent-setting", label: "agent-setting", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Agent definition (--agent flag)" },
  { key: "pr-link", label: "pr-link", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Linked GitHub pull request" },
  { key: "mode", label: "mode", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Session mode: coordinator | normal" },
  { key: "worktree-state", label: "worktree-state", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Worktree enter/exit state" },
  { key: "content-replacement", label: "content-replacement", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Replaced content blocks (resume stub)" },
  { key: "file-history-snapshot", label: "file-history-snapshot", category: "meta", inLogsUnion: true, source: "both", description: "File edit history snapshot" },
  { key: "attribution-snapshot", label: "attribution-snapshot", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Character attribution per file" },
  { key: "queue-operation", label: "queue-operation", category: "meta", inLogsUnion: true, source: "both", description: "Message queue enqueue/dequeue" },
  { key: "speculation-accept", label: "speculation-accept", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Speculative response accepted" },
  { key: "marble-origami-commit", label: "marble-origami-commit", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Context-collapse commit (archived span)" },
  { key: "marble-origami-snapshot", label: "marble-origami-snapshot", category: "meta", inLogsUnion: true, source: "sourcemap", description: "Context-collapse staged queue snapshot" },

  // ── Runtime injections (observed live, not in logs.ts Entry union) ───────
  { key: "permission-mode", label: "permission-mode", category: "runtime", inLogsUnion: false, source: "both", description: "Permission mode change" },
  { key: "attachment", label: "attachment", category: "runtime", inLogsUnion: false, source: "both", description: "UI attachment injection (tool list, files, etc.)" },
  // ── New in v2.1.139 (reverse-engineered from cZK routing table) ──────────
  { key: "progress", label: "progress", category: "transcript", inLogsUnion: false, source: "sourcemap", description: "Mid-turn progress indicator (dedup-transcript; not persisted to disk in normal flow)" },
  { key: "frame-link", label: "frame-link", category: "meta", inLogsUnion: false, source: "sourcemap", description: "Linked frame/session reference (always-write; new in v2.1.139)" },
  { key: "isolation-latch", label: "isolation-latch", category: "meta", inLogsUnion: false, source: "sourcemap", description: "Worktree isolation lock — prevents cross-session bleeds (always-write; new in v2.1.139)" },
  { key: "fork-context-ref", label: "fork-context-ref", category: "meta", inLogsUnion: false, source: "sourcemap", description: "Agent-forked context reference, written to subagent sidechain (route-by-agent; new in v2.1.139)" },

  // ── system.subtype values ─────────────────────────────────────────────────
  { key: "system::subtype::api_error", label: "system/api_error", category: "system_sub", inLogsUnion: false, source: "both", description: "API error (rate limit, auth, etc.)" },
  { key: "system::subtype::stop_hook_summary", label: "system/stop_hook_summary", category: "system_sub", inLogsUnion: false, source: "both", description: "Stop-hook execution summary" },
  { key: "system::subtype::turn_duration", label: "system/turn_duration", category: "system_sub", inLogsUnion: false, source: "both", description: "Turn wall-clock duration" },
  { key: "system::subtype::away_summary", label: "system/away_summary", category: "system_sub", inLogsUnion: false, source: "both", description: "Away-mode summary" },
  { key: "system::subtype::local_command", label: "system/local_command", category: "system_sub", inLogsUnion: false, source: "both", description: "Local shell command result" },
  { key: "system::subtype::compact_boundary", label: "system/compact_boundary", category: "system_sub", inLogsUnion: false, source: "both", description: "Context compaction boundary marker" },
  { key: "system::subtype::scheduled_task_fire", label: "system/scheduled_task_fire", category: "system_sub", inLogsUnion: false, source: "both", description: "Scheduled task fired" },
  // sourcemap-only system subtypes
  { key: "system::subtype::post_turn_summary", label: "system/post_turn_summary", category: "system_sub", inLogsUnion: false, source: "sourcemap", description: "Post-turn display summary" },
  { key: "system::subtype::file_snapshot", label: "system/file_snapshot", category: "system_sub", inLogsUnion: false, source: "sourcemap", description: "File snapshot checkpoint" },
  { key: "system::subtype::informational", label: "system/informational", category: "system_sub", inLogsUnion: false, source: "sourcemap", description: "Informational system message" },
  { key: "system::subtype::generate_session_title", label: "system/generate_session_title", category: "system_sub", inLogsUnion: false, source: "sourcemap", description: "Session title generation trigger" },
  { key: "system::subtype::task_progress", label: "system/task_progress", category: "system_sub", inLogsUnion: false, source: "sourcemap", description: "Swarm task progress update" },
  { key: "system::subtype::task_started", label: "system/task_started", category: "system_sub", inLogsUnion: false, source: "sourcemap", description: "Swarm task started" },
  { key: "system::subtype::task_notification", label: "system/task_notification", category: "system_sub", inLogsUnion: false, source: "sourcemap", description: "Swarm task notification" },
  { key: "system::subtype::status", label: "system/status", category: "system_sub", inLogsUnion: false, source: "sourcemap", description: "Bridge status message" },
  { key: "system::subtype::end_session", label: "system/end_session", category: "system_sub", inLogsUnion: false, source: "sourcemap", description: "Session end signal" },
  { key: "system::subtype::result", label: "system/result", category: "system_sub", inLogsUnion: false, source: "sourcemap", description: "SDK result message" },

  // ── attachment.type values ─────────────────────────────────────────────────
  { key: "attachment::type::task_reminder", label: "attachment/task_reminder", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Task/todo reminder injection" },
  { key: "attachment::type::skill_listing", label: "attachment/skill_listing", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Available skills injection" },
  { key: "attachment::type::edited_text_file", label: "attachment/edited_text_file", category: "attachment_sub", inLogsUnion: false, source: "both", description: "File recently edited notification" },
  { key: "attachment::type::queued_command", label: "attachment/queued_command", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Queued command injection" },
  { key: "attachment::type::agent_listing_delta", label: "attachment/agent_listing_delta", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Available agents injection" },
  { key: "attachment::type::file", label: "attachment/file", category: "attachment_sub", inLogsUnion: false, source: "both", description: "File attachment" },
  { key: "attachment::type::todo_reminder", label: "attachment/todo_reminder", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Todo list reminder" },
  { key: "attachment::type::deferred_tools_delta", label: "attachment/deferred_tools_delta", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Deferred tool additions" },
  { key: "attachment::type::date_change", label: "attachment/date_change", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Date change notification" },
  { key: "attachment::type::plan_mode", label: "attachment/plan_mode", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Plan mode entry attachment" },
  { key: "attachment::type::command_permissions", label: "attachment/command_permissions", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Command permissions injection" },
  { key: "attachment::type::plan_mode_exit", label: "attachment/plan_mode_exit", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Plan mode exit attachment" },
  { key: "attachment::type::already_read_file", label: "attachment/already_read_file", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Already-read file dedup" },
  { key: "attachment::type::compact_file_reference", label: "attachment/compact_file_reference", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Compact file reference" },
  { key: "attachment::type::selected_lines_in_ide", label: "attachment/selected_lines_in_ide", category: "attachment_sub", inLogsUnion: false, source: "both", description: "IDE selected lines injection" },
  { key: "attachment::type::plan_file_reference", label: "attachment/plan_file_reference", category: "attachment_sub", inLogsUnion: false, source: "both", description: "Plan file reference" },
  { key: "attachment::type::opened_file_in_ide", label: "attachment/opened_file_in_ide", category: "attachment_sub", inLogsUnion: false, source: "both", description: "IDE opened file notification" },
];

// SSE event types captured by proxy
export const SSE_EVENT_TYPES = [
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
  "error",
];

export function getSourcemapTypeByKey(key: string): SourcemapTypeEntry | undefined {
  return SOURCEMAP_TYPES.find((t) => t.key === key);
}
