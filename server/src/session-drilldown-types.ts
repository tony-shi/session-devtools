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
  | "user:skill_injection" // isMeta=true user.text 行，外层 sourceToolUseID 命中 Skill tool_use
  | "user:compact_summary" // jsonl user.isCompactSummary=true，CompactEvent 合成 turn 用
  | "system:api_error"   // API error / retry
  | "system:local_command"
  | "system:compact_boundary" // jsonl system.subtype=compact_boundary，CompactEvent 合成 turn 用
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
  // 当本 event 与某个 tool_use 有 cli.js 外层关联键（jsonl 的 sourceToolUseID
  // 字段）时填充。仅由 cli.js SkillTool 在 tagMessagesWithToolUseID 路径上
  // 写入 user/system 消息，attachment 消息不带这个字段。
  // 用于：(1) hover 联动高亮整个 envelope；(2) skill_injection 行展示 skill 名。
  sourceToolUseID?: string;
  // 当 sourceToolUseID 命中本 turn 内 name="Skill" 的 tool_use 时，反查到的
  // skill 名（即该 tool_use.input.skill）。parser 在 turn 构建阶段一次性填好。
  skillName?: string;
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
  // 仅当 name === "Skill" 时填充：本次 skill 调用产出的副作用归因。
  // 数据全部来自 jsonl 原生字段（tool_result.tool_use_id + 外层 sourceToolUseID），
  // 100% 确定性，零 proxy 查询、零跨 call 遍历。详见 SkillInjectionInfo 注释。
  skillInjection?: SkillInjectionInfo;
}

// Skill tool_use 的副作用归因。两种执行模式由 cli.js SkillTool.ts 在
// command.context === "fork" 时分支决定（SKILL.md frontmatter 字段 `context: fork`）。
// inline = 主对话注入 SKILL.md body + 其他 attachment；
// forked = 起 sub-agent 子进程执行，主对话只剩一条 tool_result ack。
//
// 识别方式（确定性）：tool_result.content 文本以
//   `Skill "{name}" completed (forked execution)` 开头 → forked，否则 inline。
// sourcemap: restored-src/src/tools/SkillTool/SkillTool.ts:621, :852
export type SkillInjectionInfo =
  | {
      mode: "inline";
      // 紧邻 Skill tool_use 的 tool_result 行（含 "Launching skill: ..." 短 ack）
      ackLineIdx: number;
      // 所有外层 sourceToolUseID === toolUseId 的 user / attachment 行号
      // （包括 SKILL.md body、command_permissions 等）。按 jsonl 出现顺序升序。
      injectedLineIdxs: number[];
      // 拼接的注入文本：所有 user.text 块顺序拼起来，行间 `\n\n` 分隔。
      // 这是 chip 展开时给用户看的 SKILL.md 全文。
      bodyText: string;
      // 总字符 = ack content + bodyText.length。供 chip 标题显示"注入 X.Xk"。
      totalChars: number;
    }
  | {
      mode: "forked";
      ackLineIdx: number;
      // forked 模式下 tool_result.content 长度（包含 "Result:\n..." 子 agent 返回文本）
      forkedResultChars: number;
    };

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

// ─── Event 归属语义 ───────────────────────────────────────────────────────────
// 描述一个非 LLM 事件相对于 turn 列表的位置。Compact 是首个落地用户；未来
// closure（/exit、/clear）/ setup（/login、/model）/ ambient（/status、/help）
// 等类别可以复用同一套 belonging 描述。
//
//   in-turn        — 事件发生在 turn N 内部（midTurnInjection 等场景）
//   postlude       — 事件紧贴 turn N 之后（closure 语义；上一个 turn 的封底）
//   prelude        — 事件紧贴 turn N+1 之前（setup 语义；下一个 turn 的引子）
//   between-turns  — 独立 sibling，归属于"turn N 和 turn N+1 之间"，不属于任何一边
//                    （maintenance 语义，典型代表：/compact）
//   pre-session    — 全部 turn 之前（session 开头还没有 turn 时）
//   post-session   — 全部 turn 之后（session 结尾 turn N 已经结束）
export type EventBelonging =
  | { kind: "in-turn"; turnId: number }
  | { kind: "postlude"; turnId: number }
  | { kind: "prelude"; turnId: number }
  | { kind: "between-turns"; afterTurnId: number; beforeTurnId: number }
  | { kind: "pre-session"; beforeTurnId: number }
  | { kind: "post-session"; afterTurnId: number };

// ─── CompactEvent ────────────────────────────────────────────────────────────
// `/compact` 在 jsonl 里的足迹：
//   主锚（决定性）：type=system, subtype=compact_boundary，compactMetadata 齐全
//   副锚（决定性）：紧跟其后的 user 事件，isCompactSummary=true，parentUuid 指回主锚
//   触发命令（可选）：boundary 之前最近的 user 事件，content 含 <command-name>/compact
//                  当 /compact 带参数（如 `/compact focus on parser`）时 args 非空
//   富化（可选）：proxy_requests 中 prompt 指纹命中 compaction template 的那条调用
//
// 这次 LLM call 本身在 jsonl 里没有 assistant 事件 —— 主锚 + 副锚 + (可选) proxy
// 三源交叉拼出完整画像。
export interface CompactProxyInfo {
  proxyRequestId: number;
  requestId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  startedAt: string;
}

export interface CompactEvent {
  // 0-based sequential index. UI 用于稳定排序。
  index: number;
  // 相对 turn 列表的归属位置（详见 EventBelonging）。
  // /compact 永远是 between-turns / post-session 二选一 —— pre-session 不可能
  // （第一条 turn 之前不会有 compact），in-turn / postlude / prelude 也不会
  // （compact 在结构上严格独立于任何 turn）。
  belonging: EventBelonging;

  // ── 主锚：jsonl L21 ──────────────────────────────────────────────
  boundaryLineIdx: number;
  boundaryUuid: string;
  // boundary 事件自身的 timestamp，时间轴排序的权威值。
  timestamp: string;

  // compactMetadata 透传 —— 全部来自 jsonl boundary 事件的同名字段。
  // trigger: 'manual' 是用户敲 /compact；'auto' 是 harness 自动触发（token
  // 预算压力）；'micro' 是更轻量的自动压缩（CLI 内部细分）。
  trigger: "manual" | "auto" | "micro" | string;
  preTokens: number;
  postTokens: number;
  // CLI 报告的 compact 整体耗时（含 LLM call + 本地处理）。
  durationMs: number;

  // ── 副锚：jsonl L22 ──────────────────────────────────────────────
  // 紧跟 boundary 之后的 user 事件，parentUuid === boundaryUuid，
  // isCompactSummary === true。这是真正被注入到 post-compact 第一次推理
  // prompt 的 summary 文本（是 LLM 响应的有损子串：CLI 加前缀 + 截取 <summary>
  // 段 + 加 jsonl path 后缀）。
  summaryLineIdx: number | null;
  summaryUuid: string | null;
  // L22.content 全文。前端展示时可能截断，但 server 端不截。
  summaryText: string | null;

  // ── 用户附加指令：/compact <args> ─────────────────────────────────
  // boundary 之前最近的 user 事件中 <command-args> 块。空字符串 / 缺失 = null。
  // 当用户 `/compact focus on parser` 时 = "focus on parser"。
  // 这个字段是关键：它揭示 compaction 的"语义意图"，UI 必须显眼地展示。
  commandLineIdx: number | null;
  userInstructions: string | null;

  // ── 富化：proxy_requests ─────────────────────────────────────────
  // 通过 prompt 指纹 + session_id + 时间窗匹配 proxy 记录，得到 compaction
  // LLM call 的真实模型 / token / cost 信息。匹配失败时 null（不阻塞渲染）。
  proxy: CompactProxyInfo | null;
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
  // /compact 事件。按 timestamp 升序。当前是 session 顶层第一个非 turn 的 sibling
  // 事件类别 —— 未来 closure / setup / ambient 等也会以平行数组形式加入。
  compactEvents: CompactEvent[];
}

export interface ModelStats {
  calls: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
}
