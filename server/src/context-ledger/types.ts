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
  | "server_side_attribution"  // P0-2：billing_noise / known server-side overhead
  | "manual_fixture";

export type FindingType =
  | "matched"
  | "approximate_match"
  // 无强证据（无 rawHash/normalizedHash/toolUseId/ruleId）时的 category+role heuristic 匹配，
  // 置信度低，不计入 wireExact / canonicalExact / template 桶（落入 unexplainedChars）
  | "suspect_match"
  | "unmatched_proxy_segment"
  | "unmatched_expected_segment"
  | "token_mismatch"
  | "order_mismatch"
  | "lifecycle_mismatch"
  | "merge_alignment"
  | "one_to_many_alignment"
  | "api_error_retry"
  | "known_noise"
  // P1-1：regex rule 捕获组字符占比 > 60%，说明 pattern 过宽，大部分内容是动态字段
  | "regex_too_loose";

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
  /** JSON.stringify(parsedBody) 的 hash（旧口径，用于向后兼容） */
  rawRequestHash: string;
  /** P0-3：proxy 落盘的原始 UTF-8 字节的 sha256（真实 wire bytes hash）。
   *  P0-3 完成前可能为 undefined；完成后 wireExactCoverage 将使用此字段。 */
  rawRequestBytesHash?: string;
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

// P1-1：单个捕获组的命中区间与来源
export interface RuleMatchCapture {
  name: string;                      // captureGroup 名称（来自 rule.attribution.captureGroups）
  valuePreview: string;              // 实际捕获值（最多 120 字符）
  charStart: number;                 // 在 rawText 里的起始位置（含）
  charEnd: number;                   // 在 rawText 里的结束位置（不含）
  source: "env" | "memory" | "runtime" | "unknown";  // 动态字段来源推断
}

// P1-1：结构化 rule 命中证据（替代 notes: string[]）
export interface RuleMatchEvidence {
  ruleId: string;
  mode: "exact" | "template" | "regex" | "presence";
  // 字符统计
  literalChars: number;              // 非占位符的静态文本字符数
  placeholderChars: number;          // 所有 captureGroup 的字符数之和
  placeholderRatio: number;          // placeholderChars / (literalChars + placeholderChars)
  // 各捕获组详情
  captures: RuleMatchCapture[];
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
  /** P1-1：结构化 rule 命中证据（regex/template 命中时有值） */
  evidence?: RuleMatchEvidence;
  /** 兼容旧口径，P1-1 后 evidence 为权威；notes 仅在 evidence 不覆盖的场景下保留 */
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

// P0-2：覆盖率正交分桶，每个 proxy char 落在且仅落在一个桶。
// 正交性：wireExact + canonical + template + regex + presence + serverSide + attrOnly + unexplained = proxyChars
export interface CoverageSummary {
  // 基础计数
  proxySegmentCount: number;
  matchedProxySegmentCount: number;
  unmatchedProxySegmentCount: number;
  proxyChars: number;
  expectedSegmentCount?: number;
  unmatchedExpectedSegmentCount?: number;
  byCategory?: CoverageByCategory[];

  // 正交分桶（字符数，相加 = proxyChars）
  // basis=raw_hash / tool_use_id 精确匹配（P0-3 完成前与 canonicalExact 合并于此桶）
  wireExactChars: number;
  // basis=normalized_hash（规范化后相等）
  canonicalExactChars: number;
  // basis=rule_id + materialization=exact_text（contentPattern 字面匹配，正向重建后 rawHash 命中）
  templateChars: number;
  // basis=rule_id + materialization=shape/normalized_text（无可复现文本，presence_only 对齐）
  regexChars: number;
  // basis=harness_rule + category≠billing_noise（presence rule，当前路径预留）
  presenceChars: number;
  // billing_noise / known server-side overhead，basis=server_side_attribution
  serverSideChars: number;
  // 有归因但无 expected segment（U1-U5 缺口）
  attributionOnlyChars: number;
  // 无归因也无 expected（unknown / suspect_match）
  unexplainedChars: number;

  // 覆盖率比例（对应桶的 chars / proxyChars）
  wireExactCoverage: number;
  canonicalExactCoverage: number;
  templateCoverage: number;
  regexCoverage: number;
  presenceCoverage: number;
  serverSideCoverage: number;
  attributionOnlyCoverage: number;
  unexplainedCoverage: number;

  // 治理指标
  regexOverreachRisk: number;      // regexChars / proxyChars（>0.6 → needs_review）
  placeholderRatio?: number;       // P1-1：所有 template/regex rule 命中字符中，captureGroup 字符占比

  // 总对齐文本漂移（evidence-backed matched 中 |expectedChars - proxyChars| 之和 / proxyChars）
  alignedTextDrift: number;
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
