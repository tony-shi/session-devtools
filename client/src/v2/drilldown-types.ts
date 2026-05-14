// ─── Session Drilldown Contract ──────────────────────────────────────────────
// Shared type definitions for the /api/v2/sessions/:id/drilldown endpoint.
// Backend returns this shape; frontend consumes it directly.

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

export interface ModelStats {
  calls: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
}

// ─── Sub agent summary (attached to the LlmCall that triggered it) ──────────

export interface SubAgentSummary {
  // Derived from subagents/agent-{agentFileId}.jsonl + .meta.json
  agentFileId: string;        // e.g. "a373036faaffe1b06"
  agentType: string;          // "Explore" | "general-purpose" | custom name
  description: string;        // from meta.json
  toolUseId: string;          // matching tool_use.id in parent call content
  toolUseName: string;        // usually "Agent"

  // Token / call stats from sub agent JSONL
  llmCallCount: number;
  toolCallCount: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalFreshIn: number;
  totalOutputTokens: number;

  // Peak context size (input + cacheRead + cacheWrite) across the sub-agent's own LLM calls.
  // Drives the counterfactual "what the main context would have peaked at had this run inline".
  peakContext: number;
  // Context size on the sub-agent's last LLM call.
  lastContext: number;

  startedAt: string;
  endedAt: string;
  durationMs: number;

  // The text returned in the tool_result to the parent session
  resultPreview: string;      // first 300 chars of tool_result content
}

export type IntervalEventKind =
  | "user:human" | "user:tool_result" | "user:command"
  | "system:api_error" | "system:local_command" | "system:turn_duration"
  | "system:stop_hook_summary" | "system:away_summary"
  | "attachment:skill_listing" | "attachment:task_reminder" | "attachment:queued_command"
  | "attachment:edited_text_file" | "attachment:file"
  | "file-history-snapshot" | "last-prompt" | "unknown";

export interface IntervalEvent {
  kind: IntervalEventKind;
  lineIdx: number;
  timestamp: string;
  contentPreview: string;
  contentSize: number;
  rawJson: string;
}

export interface ToolCallSlot {
  toolUseId: string;
  name: string;
  inputPreview: string;
  inputSize: number;
  outputPreview: string;
  outputSize: number;
  isError: boolean;
}

export interface LlmCall {
  // Position within the session (1-based, globally across all turns)
  id: number;
  // Position within the parent turn (1-based)
  indexInTurn: number;

  // JSONL provenance for the logical assistant message behind this call.
  // Indices are 0-based line offsets in the source JSONL file.
  messageId: string | null;
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
  // Net delta vs previous call in the session (positive = growth)
  significantDelta: number;

  // null when no proxy record matches this call
  proxy: ProxyCallData | null;

  // Sub-agents spawned by this call (one per Agent tool_use; usually 0-1, rarely >1)
  subAgents: SubAgentSummary[];

  // Empty array in v1 backend — frontend fills with mock when empty
  incomingDiff: DiffEntry[];

  // Tool names dispatched in this call's content (tool_use blocks)
  toolNames: string[];
  // Structured tool_use + tool_result pairs for this call
  toolCalls: ToolCallSlot[];
  // Text blocks from assistant message (first 500 chars)
  assistantText: string;
  // All JSONL events following this call up to the next assistant call
  intervalEvents: IntervalEvent[];
}

export interface MidTurnInjection {
  text: string;
  timestamp: string;
  // approximate position: after which LLM call index (0 = before any call)
  afterCallIndex: number;
}

export interface UserTurn {
  // 1-based index within the session
  id: number;
  userInput: string;
  // Full text of the model's final end_turn response (null if not available)
  finalOutput: string | null;
  // User messages injected while LLM was executing tool calls within this turn
  midTurnInjections: MidTurnInjection[];
  startedAt: string;
  endedAt: string;
  // Wall-clock ms from first user event to last assistant end_turn
  durationMs: number;

  llmCallCount: number;
  toolCallCount: number;
  netContextDelta: number;
  peakContext: number;
  cacheRead: number;
  cacheWrite: number;

  // v1 backend: always 0 (unknown attribution not yet computed)
  unknownDelta: number;

  hasCompaction: boolean;
  // v1 backend: always false
  hasUnknownSpike: boolean;
  errorCount: number;

  calls: LlmCall[];
}

// ─── Inter-turn block ─────────────────────────────────────────────────────────
// Events between two turns (bash commands, /exit, etc.) — they enter context
// but do NOT trigger an LLM call on their own.
export interface InterTurnBlock {
  index: number;
  prevTurnId: number | null;
  nextTurnId: number | null;
  timestamp: string;
  label: string;
  enteredContext: boolean;
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
  totalFreshIn: number;   // sum of per-call context deltas — new content injected each call
  totalFreshOut: number;
  lastContext: number;    // contextSize of the final LLM call — current window usage
  systemErrorCount: number;
  compactionCount: number;
  modelBreakdown: Record<string, ModelStats>;
  toolDistribution: ToolUsageEntry[];

  // true if at least one proxy_requests row is linked to this session
  hasProxyData: boolean;
  // true if source_file exists on disk at the time of the request
  hasJsonlSource: boolean;

  // Sub agents spawned during this session (all turns combined)
  subAgentCount: number;
  subAgents: SubAgentSummary[];

  turns: UserTurn[];
  interTurnBlocks: InterTurnBlock[];
}

// ─── Call detail (per-call drilldown) ────────────────────────────────────────

export interface CallSegment {
  id: string;
  section: "system" | "tools" | "messages" | "metadata" | "unknown";
  category: string;
  label: string;
  role?: string;
  charCount: number;
  rawText: string;
  cacheHint: "read" | "write" | "none" | "unknown";
  rawHash: string;
}

export type DiffOp = "added" | "removed" | "changed" | "unchanged";

export interface SegmentDiff {
  op: DiffOp;
  section: "system" | "tools" | "messages" | "metadata" | "unknown";
  category: string;
  label: string;
  role?: string;
  charCount: number;
  charDelta: number;
  rawHash: string;
  rawText: string;
  prevRawText?: string;
}

export interface CallDetailTokens {
  contextSize: number;
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
  outputTokens: number;
}

export interface CallDetail {
  callId: number;
  sessionId: string;
  proxyRequestId: number | null;

  model: string;
  stopReason: string | null;
  timestamp: string;
  tokens: CallDetailTokens;

  // null when no proxy data available
  segments: CallSegment[] | null;
  diff: SegmentDiff[] | null;
  rawRequestJson: Record<string, unknown> | null;
}
