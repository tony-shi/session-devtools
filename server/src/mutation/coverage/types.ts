// JSONL event type definitions derived from:
//   1. claude-code-sourcemap: restored-src/src/types/logs.ts
//   2. Live scan of ~/.claude/**/*.jsonl
//
// TranscriptMessage (type = "user" | "assistant") and system sub-types are
// enumerated separately because they're the primary content carriers.

export type JsonlEventType =
  // ── core transcript ──────────────────────────────────────────────────────
  | "user"
  | "assistant"
  | "system"
  // ── meta / session lifecycle (logs.ts Entry union) ──────────────────────
  | "summary"
  | "custom-title"
  | "ai-title"
  | "last-prompt"
  | "task-summary"
  | "tag"
  | "agent-name"
  | "agent-color"
  | "agent-setting"
  | "pr-link"
  | "mode"
  | "worktree-state"
  | "content-replacement"
  | "file-history-snapshot"
  | "attribution-snapshot"
  | "queue-operation"
  | "speculation-accept"
  | "marble-origami-commit"
  | "marble-origami-snapshot"
  // ── runtime injections (observed in live scans) ──────────────────────────
  | "permission-mode"
  | "attachment";

// system.subtype values observed in live scans + sourcemap
export type SystemSubtype =
  | "api_error"
  | "stop_hook_summary"
  | "turn_duration"
  | "away_summary"
  | "local_command"
  | "compact_boundary"
  | "scheduled_task_fire"
  | "post_turn_summary"
  | "file_snapshot"
  // sourcemap-derived (not yet observed in local JSONL)
  | "result"
  | "informational"
  | "generate_session_title"
  | "task_progress"
  | "task_started"
  | "task_notification"
  | "status"
  | "end_session";

// attachment.type values observed in live scans
export type AttachmentType =
  | "task_reminder"
  | "skill_listing"
  | "edited_text_file"
  | "queued_command"
  | "agent_listing_delta"
  | "file"
  | "todo_reminder"
  | "deferred_tools_delta"
  | "date_change"
  | "plan_mode"
  | "command_permissions"
  | "plan_mode_exit"
  | "already_read_file"
  | "compact_file_reference"
  | "selected_lines_in_ide"
  | "plan_file_reference"
  | "opened_file_in_ide";

// SSE event types from proxy traffic
export type SseEventType =
  | "message_start"
  | "content_block_start"
  | "content_block_delta"
  | "content_block_stop"
  | "message_delta"
  | "message_stop"
  | "ping"
  | "error";

export interface EventTypeInfo {
  type: string;
  // How we classify it
  category: "transcript" | "meta" | "runtime" | "system_sub" | "attachment_sub";
  // Source of knowledge
  source: "live" | "sourcemap" | "both";
  // Count from live JSONL scan (0 = not seen)
  count: number;
  // Minimal example JSON (stringified, truncated)
  example?: string;
  // For system/attachment: parent type
  parent?: string;
  // For system/attachment: sub-key
  subKey?: string;
  // Whether we have a proxy request that covers this (can reconstruct from proxy)
  proxyCoverable: boolean;
}

export interface SessionCoverageInfo {
  sessionId: string;
  filePath: string;
  modifiedAt: number; // ms epoch
  sizeBytes: number;
  typesPresent: string[]; // event type keys present
  subTypesPresent: string[]; // system.subtype or attachment.type values
  score: number; // how many unique type/subtype combos
}
