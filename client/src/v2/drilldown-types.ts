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
  toolUseId: string;          // matching tool_use.id in parent call content; "" if unmatched
  toolUseName: string;        // usually "Agent"
  // Parent assistant event line index in the main JSONL — UI can jump back to
  // the triggering call. -1 when parent match failed.
  parentLineIdx: number;
  // Parent LlmCall.id (user-visible call number). 0 when parent match failed.
  parentCallId: number;

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
  result?: string;            // full tool_result text (verbatim, no truncation)
}

// Mirrors server `IntervalEventKind`. Keep in sync with
// server/src/session-drilldown-types.ts.
export type IntervalEventKind =
  | "user:human" | "user:tool_result" | "user:command"
  | "user:skill_injection"
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
  /** cli.js 写入的 jsonl 外层字段。供 hover 联动 + skill_injection 特化渲染。 */
  sourceToolUseID?: string;
  /** parser 回填：sourceToolUseID 命中本 turn name="Skill" 的 tool_use 时填 skill 名。 */
  skillName?: string;
}

export interface ToolCallSlot {
  toolUseId: string;
  name: string;
  inputPreview: string;
  inputSize: number;
  outputPreview: string;
  outputSize: number;
  isError: boolean;
  // Mirrors server SkillInjectionInfo — populated only when name === "Skill".
  skillInjection?: SkillInjectionInfo;
}

// Mirrors server `SkillInjectionInfo`. See server/src/session-drilldown-types.ts
// for the full doc; key points:
//   - mode === "inline":  SKILL.md body 注入到主对话，bodyText 携带全文
//   - mode === "forked":  起 sub-agent 子进程执行，主对话只剩 1 条 ack
export type SkillInjectionInfo =
  | {
      mode: "inline";
      ackLineIdx: number;
      injectedLineIdxs: number[];
      bodyText: string;
      totalChars: number;
    }
  | {
      mode: "forked";
      ackLineIdx: number;
      forkedResultChars: number;
    };

export interface LlmCall {
  // Position within the session (1-based, globally across all turns)
  id: number;
  // Position within the parent turn (1-based)
  indexInTurn: number;

  // JSONL provenance for the logical assistant message behind this call.
  // Indices are 0-based line offsets in the source JSONL file.
  messageId: string | null;
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
  // Net delta vs previous call in the session (positive = growth)
  significantDelta: number;

  // null when no proxy record matches this call
  proxy: ProxyCallData | null;

  // Quality of this call's proxy ↔ JSONL link.
  //   'exact'     — matched on Anthropic request-id (1:1, trustworthy).
  //                 proxy 端会对缺失 request-id 的响应注入 `proxy-<uuid>`
  //                 合成 ID（server/proxy-v2/server/index.ts:injectSyntheticRequestId），
  //                 因此代理站用户也走 exact，没有兜底通道。
  //   'unmatched' — no proxy row matches; treat proxy data as absent.
  proxyMatchMode: "exact" | "unmatched";

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
  /** Jsonl event index for the turn-opener user event. Use with
   *  `useAttributionGraph().getEventAnnotation(lineIdx)` to surface a
   *  jump chip on the human-input card. */
  userInputLineIdx: number | null;
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
  // Totals across the **main session JSONL only**. Does NOT include:
  //   - sub-agent calls (browse the sub-agent drilldown for its own totals)
  //   - background API calls Claude Code makes itself (haiku title gen,
  //     retries, quota probes) — these never land in JSONL.
  totalCacheRead: number;
  totalCacheWrite: number;
  totalFreshIn: number;   // SUM of usage.input_tokens — non-cached fresh input (1x billing)
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
//
// PR8 起 CallDetail 不再携带 segments / diff —— attribution + tree-diff 视角分别
// 由 AttributionTreeResult（loadAttributionTree）和 DiffTreeResult（loadDiffTree）
// 通过独立端点提供。这里只保留 raw 请求体和元数据。

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
  // See Call.proxyMatchMode for semantics.
  proxyMatchMode: "exact" | "unmatched";

  model: string;
  stopReason: string | null;
  timestamp: string;
  tokens: CallDetailTokens;

  // null when no proxy data available
  rawRequestJson: Record<string, unknown> | null;
}
