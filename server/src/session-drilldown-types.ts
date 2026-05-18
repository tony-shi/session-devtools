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
  // Parent's Agent tool_use.id this sub-agent was spawned from. Empty string when
  // the deterministic (promptId, prompt-text) match against the main JSONL could
  // not pin a unique tool_use — we accept "unknown parent" rather than fall back
  // to positional/dictionary-order guessing (which silently mis-attributes when
  // a turn spawns multiple sub-agents).
  toolUseId: string;
  toolUseName: string;
  // Parent assistant event line index in the main JSONL (lineIdx of the event
  // that emitted the Agent tool_use). Front-end can use this to render the
  // causal jump-link back to the triggering call. -1 when unmatched.
  parentLineIdx: number;
  // Parent LlmCall.id (the user-visible call number). Filled in post-hoc after
  // LlmCalls are built and the toolUseId→callId map is known. 0 when unmatched.
  parentCallId: number;
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
  // Full sub-agent tool_result text (markdown report typically) — verbatim
  // from the parent JSONL's tool_result block, no truncation. Powers the
  // sub-agent card's expanded view; `resultPreview` (300-char head) is kept
  // for compact contexts (mock lists / collapsed card). Optional so older
  // payloads stay shape-compatible.
  result?: string;
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
  // Quality of this call's proxy ↔ JSONL link. See call-detail.ts ProxyMatchMode.
  // Populated by sessionDrilldown after computeCallProxyMatchModes runs;
  // defaults to 'unmatched' in code paths that don't enrich (e.g. sub-agent stubs).
  proxyMatchMode: "exact" | "unmatched";
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
  /**
   * Index of the turn-opener user event in the post-filter `events` array.
   * Matches the same `lineIdx` scheme used by IntervalEvent / LinkableJsonlEvent
   * so the client can call `getEventAnnotation(userInputLineIdx)` to fetch
   * reverse-attribution (firstSeenInCall / consumedByCallIds) for the
   * human input — same UX as any other jsonl event in the Turn view.
   * Null if the parser somehow didn't capture a line for this turn (defensive).
   */
  userInputLineIdx: number | null;
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
  // Token totals are computed from JSONL `usage` fields of canonical
  // assistant frames of the **main session only**. They do NOT include:
  //   - sub-agent calls (browse the sub-agent drilldown for its own totals)
  //   - background API calls Claude Code makes itself but doesn't write to
  //     JSONL (haiku title generation, quota probes, retries)
  // This intentionally mirrors what's visible in the conversation; for
  // `/cost`-shape billing aggregates the source-of-truth lives in Claude
  // Code's own ~/.claude.json (per-project last session) and isn't
  // reconstructable from JSONL alone.
  totalCacheRead: number;
  totalCacheWrite: number;
  totalFreshIn: number;   // SUM of usage.input_tokens — non-cached fresh input
  totalFreshOut: number;
  lastContext: number;    // contextSize of the final LLM call — current window usage
  systemErrorCount: number;
  compactionCount: number;
  // Per-model breakdown across the main session's JSONL canonical frames.
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
