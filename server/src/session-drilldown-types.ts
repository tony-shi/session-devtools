// ─── Session Drilldown Contract ──────────────────────────────────────────────
// Mirror of client/src/v2/drilldown-types.ts.
// This file defines the shape returned by GET /api/v2/sessions/:id/drilldown.

export interface DiffEntry {
  id: string;
  category: string;
  label: string;
  delta: number;
  changeType: "added" | "removed" | "changed" | "retained";
  cause: string;
  confidence: "High" | "Medium" | "Low" | "Unknown";
  evidence?: string;
}

export interface ProxyCallData {
  requestId: number;
  reqMessageCount: number | null;
  reqHasTools: boolean | null;
  resInputTokens: number | null;
  resOutputTokens: number | null;
  resCacheCreation: number | null;
  resCacheRead: number | null;
  resStopReason: string | null;
  errorClass: string | null;
  durationMs: number | null;
}

export interface SubAgentSummary {
  agentFileId: string;
  agentType: string;
  description: string;
  toolUseId: string;
  toolUseName: string;
  llmCallCount: number;
  toolCallCount: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalFreshIn: number;
  totalOutputTokens: number;
  // Peak context size (input + cacheRead + cacheWrite) across the sub-agent's own LLM calls.
  // Represents how big the foreign context grew at its tallest point — the counterfactual
  // "main context would have peaked here had this exploration happened inline".
  peakContext: number;
  // Context size on the sub-agent's last LLM call (useful for tooltips / debugging).
  lastContext: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  resultPreview: string;
}

// ─── Interval events: all raw JSONL events between two LLM calls ─────────────
// eventType mirrors the JSONL "type" field; subtype/attachmentType provide detail.
// contentPreview is a short human-readable summary (first 300 chars).
// rawJson is the full stringified event for inspector / raw view.

export type IntervalEventKind =
  | "user:human"         // user turn start — human typed text
  | "user:tool_result"   // tool_result block(s) in user event
  | "user:command"       // <local-command-caveat> / <command-name> etc.
  | "system:api_error"   // API error / retry
  | "system:local_command"
  | "system:turn_duration"
  | "system:stop_hook_summary"
  | "system:away_summary"
  | "attachment:skill_listing"
  | "attachment:task_reminder"
  | "attachment:queued_command"
  | "attachment:edited_text_file"
  | "attachment:file"
  | "file-history-snapshot"
  | "last-prompt"
  | "unknown";           // catch-all for future JSONL types

export interface IntervalEvent {
  kind: IntervalEventKind;
  lineIdx: number;        // 0-based line index in the JSONL file
  timestamp: string;
  contentPreview: string; // first 300 chars of meaningful text
  contentSize: number;    // byte length of full content
  rawJson: string;        // full JSON string of the event
}

// One tool_use block paired with its tool_result (if found in the next user event)
export interface ToolCallSlot {
  toolUseId: string;
  name: string;
  // JSON.stringify(input) preview — first 300 chars
  inputPreview: string;
  inputSize: number;      // chars of JSON.stringify(input)
  // tool_result.content preview — first 300 chars
  outputPreview: string;
  outputSize: number;     // chars of stringified content
  isError: boolean;
}

export interface LlmCall {
  id: number;
  indexInTurn: number;
  // JSONL provenance for the logical assistant message behind this call.
  // Indices are 0-based line offsets in the source JSONL file.
  messageId: string | null;
  // Anthropic API request-id from JSONL assistant event top-level `requestId`.
  // Exact 1:1 key to proxy_requests.request_id (extracted from resHeaders).
  apiRequestId: string | null;
  jsonlLineIdx: number | null;
  jsonlFrameLineIdxs: number[];
  contextSize: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: string;
  model: string;
  stopReason: string | null;
  isCompaction: boolean;
  isUnknownHeavy: boolean;
  freshIn: number;
  isSignificant: boolean;
  significantDelta: number;
  proxy: ProxyCallData | null;
  // All sub-agents spawned by this call (one per Agent tool_use block; usually 0-1, rarely >1)
  subAgents: SubAgentSummary[];
  incomingDiff: DiffEntry[];
  // Tool names dispatched in this call's content (tool_use blocks)
  toolNames: string[];
  // Structured tool_use + tool_result pairs for this call
  toolCalls: ToolCallSlot[];
  // Text blocks from assistant message (preview, first 500 chars)
  assistantText: string;
  // All JSONL events that follow this call (up to but not including the next assistant call)
  // Includes tool_results, system events, attachments, human injections, etc.
  intervalEvents: IntervalEvent[];
}

export interface MidTurnInjection {
  text: string;
  timestamp: string;
  afterCallIndex: number;
}

export interface UserTurn {
  id: number;
  userInput: string;
  finalOutput: string | null;
  midTurnInjections: MidTurnInjection[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  llmCallCount: number;
  toolCallCount: number;
  netContextDelta: number;
  peakContext: number;
  cacheRead: number;
  cacheWrite: number;
  unknownDelta: number;
  hasCompaction: boolean;
  hasUnknownSpike: boolean;
  errorCount: number;
  calls: LlmCall[];
}

// ─── Inter-turn block ─────────────────────────────────────────────────────────
// Events that occur between two turns (or after the last turn).
// These are user-driven actions (bash commands, /exit, etc.) that get injected
// into context but do NOT trigger an LLM call on their own.
// prevTurnId: the turn that ended before this block (null = before first turn)
// nextTurnId: the turn that starts after this block (null = session ended here)
export interface InterTurnBlock {
  // Sequential index (0-based) — for ordering alongside turns
  index: number;
  prevTurnId: number | null;
  nextTurnId: number | null;
  timestamp: string;
  // Summary label: "/exit", "!bash ×3", etc.
  label: string;
  // Whether this block was ever consumed by an LLM call (false when session ended first)
  enteredContext: boolean;
  // Raw events in this block
  events: IntervalEvent[];
}

export interface ToolUsageEntry {
  name: string;
  count: number;
}

export interface SessionDrilldown {
  sessionId: string;
  tool: string;
  project: string;
  cwd: string;
  title: string | null;
  firstEventAt: string;
  lastEventAt: string;
  totalLlmCalls: number;
  totalToolCalls: number;
  peakContext: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalFreshIn: number;   // sum of API input_tokens (non-cached) — billing unit
  totalFreshOut: number;
  lastContext: number;    // contextSize of the final LLM call — current window usage
  systemErrorCount: number;
  compactionCount: number;
  // Per-model breakdown: model name → { calls, outputTokens, cacheRead, cacheWrite }
  modelBreakdown: Record<string, ModelStats>;
  // Top tool names by usage count, descending
  toolDistribution: ToolUsageEntry[];
  hasProxyData: boolean;
  hasJsonlSource: boolean;
  subAgentCount: number;
  subAgents: SubAgentSummary[];
  turns: UserTurn[];
  interTurnBlocks: InterTurnBlock[];
}

export interface ModelStats {
  calls: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
}
