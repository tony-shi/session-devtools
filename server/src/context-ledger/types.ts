export type AgentKind =
  | "claude-code"
  | "codex"
  | "gemini"
  | "pi-mono"
  | "custom"
  | "unknown";

export type SourceKind =
  | "jsonl"
  | "proxy"
  | "memory_fs"
  | "harness_rule"
  | "hook"
  | "prior_session"
  | "unknown";

export type MutationSourceKind = Exclude<SourceKind, "proxy">;

export type SegmentSection =
  | "system"
  | "tools"
  | "messages"
  | "metadata"
  | "unknown";

export type SegmentRole = "user" | "assistant" | "system" | "tool" | "unknown";

export type SegmentCategory =
  | "user_message"
  | "assistant_text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "system_prompt"
  | "tools_schema"
  | "billing_noise"
  | "harness_injection"
  | "memory_injection"
  | "skill_listing"
  | "local_command_history"
  | "slash_command"
  | "prior_session_history"
  | "permission"
  | "hook_event"
  | "compaction"
  | "attachment"
  | "unknown";

export type MutationType =
  | "append"
  | "inject"
  | "replace"
  | "remove"
  | "compact"
  | "recall"
  | "clear"
  | "noise";

export type MatchKind =
  | "exact"
  | "normalized"
  | "heuristic"
  | "inferred"
  | "unmatched";

export type Confidence = "exact" | "estimated" | "inferred" | "unknown";

export type CacheHint = "read" | "write" | "none" | "unknown";

export type SegmentLifecycle =
  | "persistent"
  | "session"
  | "query"
  | "one_shot"
  | "noise"
  | "unknown";

export type SegmentFlag =
  | "large_segment"
  | "known_noise"
  | "injected"
  | "approximate"
  | "unexplained"
  | "merged"
  | "smooshed"         // reconstruction 侧：此 segment 被 smoosh 进相邻 tool_result
  | "smooshed_reminder"; // attribution 侧：此 tool_result rawText 尾部含 smoosh 注入

export type AlignmentBasis =
  | "raw_hash"
  | "normalized_hash"
  | "tool_use_id"
  | "rule_id"
  | "timestamp"
  | "order"
  | "category"
  | "harness_rule"
  | "manual_fixture";

export type FindingType =
  | "matched"
  | "approximate_match"
  // 无强证据（无 rawHash/normalizedHash/toolUseId/ruleId）时的 category+role heuristic 匹配，
  // 置信度低，不计入 evidenceBackedCoverage
  | "suspect_match"
  | "unmatched_proxy_segment"
  | "unmatched_expected_segment"
  | "token_mismatch"
  | "order_mismatch"
  | "lifecycle_mismatch"
  | "merge_alignment"
  | "one_to_many_alignment"
  | "api_error_retry"
  | "known_noise";

export type FindingSeverity = "info" | "warning" | "critical";

export type ContentRefKind = "inline" | "hash" | "external" | "omitted";

export interface JsonlSourceLocation {
  file: string;
  line?: number;
  uuid?: string;
  fieldPath?: string;
}

export interface ProxySourceLocation {
  file: string;
  jsonPath?: string;
  trafficLine?: number;
  // block 内的 char 范围（左闭右开），用于 sub-block section 引用
  // 缺省时表示引用整个 block
  charRange?: { start: number; end: number };
}

export interface MemorySourceLocation {
  file: string;
  section?: string;
}

export interface HarnessRuleSourceLocation {
  ruleId: string;
  version?: string;
}

export interface HookSourceLocation {
  name: string;
  phase?: string;
}

export interface PriorSessionSourceLocation {
  sessionId: string;
  queryId?: string;
  segmentId?: string;
}

export interface SourceRefBase {
  id?: string;
  label?: string;
  note?: string;
}

export type SourceRef =
  | (SourceRefBase & {
      kind: "jsonl";
      jsonl: JsonlSourceLocation;
    })
  | (SourceRefBase & {
      kind: "proxy";
      proxy: ProxySourceLocation;
    })
  | (SourceRefBase & {
      kind: "memory_fs";
      memory: MemorySourceLocation;
    })
  | (SourceRefBase & {
      kind: "harness_rule";
      harness: HarnessRuleSourceLocation;
    })
  | (SourceRefBase & {
      kind: "hook";
      hook: HookSourceLocation;
    })
  | (SourceRefBase & {
      kind: "prior_session";
      priorSession: PriorSessionSourceLocation;
    })
  | (SourceRefBase & {
      kind: "unknown";
      note: string;
    });

export type MutationSourceRef = Extract<SourceRef, { kind: MutationSourceKind }>;

export interface ContentRef {
  kind: ContentRefKind;
  text?: string;
  hash?: string;
  preview?: string;
  externalUri?: string;
  mimeType?: string;
  charCount?: number;
}

export interface ContextSegment {
  id: string;
  section: SegmentSection;
  category: SegmentCategory;
  label: string;
  sourceRefs: SourceRef[];
  role?: SegmentRole;
  contentRef?: ContentRef;
  rawHash?: string;
  normalizedHash?: string;
  // wire 层面的原始文本内容，供 attribution rule 做 pattern match。
  // parser 填充；attribution 单向消费；reconciliation/UI 不应依赖它。
  rawText?: string;
  charCount?: number;
  tokenEstimate?: number;
  cacheHint?: CacheHint;
  toolUseId?: string;
  lifecycle?: SegmentLifecycle;
  flags?: SegmentFlag[];
  order?: number;
  metadata?: Record<string, unknown>;
}

export interface QueryUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  freshInputTokens?: number;
  measuredInputTokens?: number;
}

export interface ProxyQuerySnapshot {
  id: string;
  agentKind: AgentKind;
  sessionId: string;
  queryId: string;
  timestamp: string;
  sourceRef: Extract<SourceRef, { kind: "proxy" }>;
  segments: ContextSegment[];
  rawRequestHash: string;
  agentId?: string;
  subagentId?: string;
  parentAgentId?: string;
  queryIndex?: number;
  request?: {
    model?: string;
    stream?: boolean;
    maxTokens?: number;
    contextManagement?: unknown;
    betaHeaders?: string[];
    // parser 从 reqBody 结构推断的 query 类型
    // "main_session"  : 主对话（tools>0，多条 message）
    // "side_query"    : queryHaiku/queryWithModel 等内部 side call（tools=0，1条 message）
    // "unknown"       : 无法判断
    queryKind?: "main_session" | "side_query" | "unknown";
    // output_config.format.type（使用 structured output 时）
    outputFormat?: string;
  };
  usage?: QueryUsage;
  metadata?: Record<string, unknown>;
}

export interface ProxySegmentAttribution {
  id: string;
  snapshotId: string;
  proxySegmentIds: string[];
  category: SegmentCategory;
  attributedSource: MutationSourceKind;
  sourceRefs: SourceRef[];
  mechanism:
    | "tool_use_id_match"
    | "system_prompt_pattern"
    | "tools_schema_pattern"
    | "billing_noise_pattern"
    | "system_reminder_pattern"
    | "local_command_pattern"
    | "large_segment_detector"
    | "cache_hint_detector"
    | "task_reminder_smoosh"
    | "manual_fixture"
    | "unknown";
  confidence: Confidence;
  ruleId?: string;
  charCount?: number;
  tokenEstimate?: number;
  notes?: string[];
  metadata?: Record<string, unknown>;
}

export interface ContextMutation {
  id: string;
  agentKind: AgentKind;
  sessionId: string;
  type: MutationType;
  category: SegmentCategory;
  source: MutationSourceKind;
  sourceRef: MutationSourceRef;
  confidence: Confidence;
  agentId?: string;
  subagentId?: string;
  parentAgentId?: string;
  timestamp?: string;
  contentRef?: ContentRef;
  toolUseId?: string;
  parentMutationIds?: string[];
  beforeQueryId?: string;
  afterQueryId?: string;
  charDeltaEstimate?: number;
  tokenDeltaEstimate?: number;
  metadata?: Record<string, unknown>;
}

export interface AppliedRule {
  ruleId: string;
  source: MutationSourceKind;
  version?: string;
  confidence: Confidence;
}

export interface ExpectedQueryContext {
  id: string;
  agentKind: AgentKind;
  sessionId: string;
  queryId: string;
  mutationIds: string[];
  segments: ContextSegment[];
  rulesApplied: AppliedRule[];
  generatedAt: string;
  agentId?: string;
  subagentId?: string;
  parentAgentId?: string;
  beforeQueryId?: string;
  metadata?: Record<string, unknown>;
}

export interface AlignmentRef {
  id: string;
  matchKind: MatchKind;
  confidence: Confidence;
  expectedSegmentIds: string[];
  proxySegmentIds: string[];
  basis: AlignmentBasis;
  mutationIds?: string[];
  attributionIds?: string[];
  charDiff?: number;
  tokenDiffEstimate?: number;
  note?: string;
}

export type SegmentLink = AlignmentRef;

export interface ReconciliationFinding {
  id: string;
  type: FindingType;
  severity: FindingSeverity;
  message: string;
  category?: SegmentCategory;
  expectedSegmentIds?: string[];
  proxySegmentIds?: string[];
  mutationIds?: string[];
  alignmentIds?: string[];
  attributionIds?: string[];
  charDiff?: number;
  tokenDiffEstimate?: number;
  evidence?: SourceRef[];
  metadata?: Record<string, unknown>;
}

export interface CoverageByCategory {
  category: SegmentCategory;
  proxySegmentCount: number;
  matchedProxySegmentCount: number;
  proxyChars: number;
  matchedProxyChars: number;
  proxyTokenEstimate?: number;
  matchedProxyTokenEstimate?: number;
}

export interface CoverageSummary {
  proxySegmentCount: number;
  matchedProxySegmentCount: number;
  unmatchedProxySegmentCount: number;
  proxyChars: number;
  matchedProxyChars: number;
  unexplainedProxyChars: number;
  segmentCoverage: number;
  charCoverage: number;
  expectedSegmentCount?: number;
  unmatchedExpectedSegmentCount?: number;
  proxyTokenEstimate?: number;
  matchedProxyTokenEstimate?: number;
  unexplainedProxyTokenEstimate?: number;
  tokenCoverage?: number;
  byCategory?: CoverageByCategory[];

  // ── 细化覆盖率拆分 ────────────────────────────────────────────────────────
  // attribution-only + evidence-backed + suspect 三者合计 = charCoverage 的分子
  //
  // attributionCoverage：proxy segment 已被 attribution 识别类别（含 evidence-backed），
  //   归因有效但不一定有 expected 对应。计算方式：has attribution && category != "unknown"
  attributionCoverage?: number;
  // evidenceBackedCoverage：matched 或 approximate_match（有 rawHash/normalizedHash/
  //   toolUseId/ruleId 锚点）的 proxy chars / proxyChars。suspect_match 不计入。
  evidenceBackedCoverage?: number;
  // attributionOnlyGap：attributionCoverage - evidenceBackedCoverage，即"归因知道但
  //   expected 未覆盖"的字符比例（系统规则未实现导致的 gap）
  attributionOnlyGap?: number;
  // alignedTextDrift：evidence-backed matched 中 |expectedChars - proxyChars| 之和 / proxyChars，
  //   衡量已匹配内容的文本漂移程度
  alignedTextDrift?: number;
}

export interface AgentCapabilityMatrix {
  agentKind: AgentKind;
  hasProxyGroundTruth: boolean;
  hasStructuredLocalLog: boolean;
  hasToolUseIds: boolean;
  hasUsageTokens: boolean;
  hasCacheBreakdown: boolean;
  hasMemoryFiles: boolean;
  hasCompactionEvents: boolean;
  hasHooks: boolean;
  hasSubagents: boolean;
  supportedSections: SegmentSection[];
  notes?: string[];
}

export interface ReconciliationReport {
  schemaVersion: "context-ledger.report.v1";
  id: string;
  agentKind: AgentKind;
  sessionId: string;
  queryId: string;
  snapshot: ProxyQuerySnapshot;
  proxyAttributions: ProxySegmentAttribution[];
  alignments: AlignmentRef[];
  findings: ReconciliationFinding[];
  coverage: CoverageSummary;
  generatedAt: string;
  agentId?: string;
  subagentId?: string;
  parentAgentId?: string;
  fixtureName?: string;
  expected?: ExpectedQueryContext;
  capability?: AgentCapabilityMatrix;
  metadata?: Record<string, unknown>;
}
