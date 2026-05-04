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

// P3-2：ComparisonGrade 取代 MatchKind，描述对账"复现确信"的层级
//   exact      → wire-bytes / canonical / tool_use_id 命中（M1/M2/M3）
//   normalized → normalized_hash 命中（M2 fallback）
//   template   → rule_id 命中且 materialization=exact_text（contentPattern 字面）
//   regex      → rule_id 命中且 materialization=normalized_text/shape（regex pattern）
//   presence   → 仅靠 category/role 等非内容锚点对齐（M4 / harness_rule）
//   none       → 未对齐 / unmatched
export type ComparisonGrade =
  | "exact"
  | "normalized"
  | "template"
  | "regex"
  | "presence"
  | "none";

export type Confidence = "exact" | "estimated" | "inferred" | "unknown";

// P3-2：从 P2-6 拆分 confidence 的两个独立维度，仅作用于 ProxySegmentAttribution
// classificationConfidence：这段属于该 category/rule 的识别确信（regex 命中即可达 exact）
// materializationConfidence：能否原样复现该 segment 的内容（regex 命中通常封顶 estimated）
export type ClassificationConfidence = Confidence;
export type MaterializationConfidence = Confidence;

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
  | "attribution_only"         // P1-3 修正：attribution 已识别但无 expected segment（U1-U5 缺口），与 presence 桶分离
  | "manual_fixture";

// P3-2：FindingType 与 char-diff 的 DiffKind 合并为单一枚举。
//   matched / approximate_match / suspect_match：匹配质量（替代 matched_exact / matched_char_diff / suspect_match）
//   expected_only / proxy_only：单边未匹配（替代 unmatched_expected_segment / unmatched_proxy_segment）
//   attribution_only：proxy 已识别 category 但 expected 缺段（U1-U5 缺口）
//   server_side_attribution：billing_noise 等 server-side overhead（替代 known_noise）
export type FindingType =
  | "matched"
  | "approximate_match"
  // 无强证据（无 rawHash/normalizedHash/toolUseId/ruleId）时的 category+role heuristic 匹配，
  // 置信度低，不计入 wireExact / canonicalExact / template 桶（落入 unexplainedChars）
  | "suspect_match"
  | "expected_only"
  | "proxy_only"
  | "attribution_only"
  | "token_mismatch"
  | "order_mismatch"
  | "lifecycle_mismatch"
  | "api_error_retry"
  | "server_side_attribution"
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
  /** canonicalJson(parsedBody) 的 hash，用作 request-level canonical exact 的 proxy 事实口径。 */
  canonicalRequestHash?: string;
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
    outputConfig?: unknown;
    thinking?: unknown;
    metadata?: unknown;
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
  // P3-2：confidence 拆分为 classification + materialization 两个独立维度
  classificationConfidence: ClassificationConfidence;
  materializationConfidence: MaterializationConfidence;
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
  // P3-2：comparisonGrade 取代 matchKind，按 basis 推导（见 ComparisonGrade 注释）
  comparisonGrade: ComparisonGrade;
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
  // basis=harness_rule（presence rule 正向预留路径，目前未触发；与 attributionOnlyChars 严格互斥）
  presenceChars: number;
  // billing_noise / known server-side overhead，basis=server_side_attribution
  serverSideChars: number;
  // basis=attribution_only：attribution 已识别但 expected 缺段（U1-U5 缺口）
  attributionOnlyChars: number;
  // 无归因也无 expected（unknown / suspect_match）
  unexplainedChars: number;
  // P3-3：suspect_match（category+role heuristic，无内容锚点）字符数和 alignment 数
  // reconcile 层权威计算，scorecard 不再从 char-diff 读
  suspectMatchChars: number;
  suspectMatchCount: number;
  // P3-3：evidence-backed matched 中 |expectedChars - proxyChars| 之和（绝对字符数）
  // alignedTextDrift = alignedTextDriftChars / evidenceBackedProxyCharsForDrift
  alignedTextDriftChars: number;

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
  /** P3-1：request-level 对账最强档位；缺少 TargetRequest 时为 undefined。 */
  requestLevelExact?: RequestLevelExactLevel;
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

export type TargetMaterialization =
  | "exact"
  | "placeholder"
  | "shape"
  | "unavailable";

export interface TargetSourceMapEntry {
  jsonPath: string;
  segmentIds: string[];
  sourceRefs: SourceRef[];
  category?: SegmentCategory;
  role?: SegmentRole;
  ruleIds?: string[];
  materialization: TargetMaterialization;
}

export type SegmentSourceMap = Record<string, TargetSourceMapEntry>;

export interface TargetSegment {
  id: string;
  jsonPath: string;
  section: SegmentSection;
  category: SegmentCategory;
  role?: SegmentRole;
  text?: string;
  placeholder?: string;
  rawHash?: string;
  charCount?: number;
  toolUseId?: string;
  toolName?: string;
  sourceSegmentIds: string[];
  materialization: TargetMaterialization;
}

export interface TargetMessage {
  role: "user" | "assistant";
  jsonPath: string;
  content: TargetSegment[];
  sourceSegmentIds: string[];
}

export interface TargetRequest {
  request: {
    model?: string;
    max_tokens?: number;
    stream?: boolean;
    context_management?: unknown;
    output_config?: unknown;
    thinking?: unknown;
    metadata?: unknown;
  };
  system: TargetSegment[];
  tools: TargetSegment[];
  messages: TargetMessage[];
  sourceMap: SegmentSourceMap;
  rulesApplied: AppliedRule[];
  unmaterializedRules: string[];
  canonicalJson: string;
  canonicalHash: string;
  metadata?: Record<string, unknown>;
}

// HarnessRuntimeSnapshot：harness 非 proxy 运行态快照。
// 作为 rule materializer 和 target-request-builder 的非 proxy 输入，
// 与 ProxyQuerySnapshot 严格隔离——所有字段均来自 JSONL/本地配置/进程环境，
// 不得从 proxy raw text 反写。
//
// 字段保守原则：
//   - 能从 JSONL 直接推断的字段列为第一版（V1）
//   - 仍需从 cli.js / local settings / env 派生的字段标注 TODO
//   - 未知值统一用 undefined 或字面量 "unknown"，不得默认填充业务值
export interface HarnessRuntimeSnapshot {
  // 快照来源。第一版来自 JSONL 解析，后续可叠加 local_env / derived 来源。
  source: "jsonl" | "local_env" | "derived" | "unknown";

  // ── V1：从 JSONL 直接推断的字段 ─────────────────────────────────────────────

  // 从 assistant mutation 的 message.model 字段推断（最后一条有值的 assistant mutation）。
  // 与 ProxyQuerySnapshot.request.model 独立——两者一致可互验，不一致时以此为准。
  inferredModel?: string;

  // JSONL 文件路径，供 audit 溯源使用。
  jsonlFile?: string;

  // JSONL sessionId（从记录头部提取）。
  sessionId?: string;

  // permission-mode mutation 中记录的权限模式（如 "default" / "bypassPermissions"）。
  // 若 JSONL 无 permission-mode 行则为 undefined。
  permissionMode?: string;

  // assistant mutation 中最早出现的时间戳，近似代表 harness 启动时间。
  firstTimestamp?: string;

  // 推断的 Claude Code 版本（目前无法从 JSONL 直接读取，预留字段）。
  // TODO: 从 cli.js 路径解析 / 本地环境变量获取。
  claudeCodeVersion?: string;

  // ── 待后续派生的字段（第一版均为 undefined）────────────────────────────────

  // harness 启动入口（cli.js 路径等）。TODO: 从进程环境派生。
  entrypoint?: string;

  // 工作目录。TODO: 从 JSONL worktree-state 行 / 环境变量获取。
  cwd?: string;

  // 用户类型（external / ant）。TODO: 从 settings 或 env 推断。
  // 未知时显式为 "unknown"，不得默认 "external"。
  userType?: "external" | "ant" | "unknown";

  // 输出风格配置。TODO: 从 settings 读取。
  outputStyleConfig?: "default" | "custom" | "unknown";

  // 已启用的工具名列表。TODO: 从 JSONL attachment.skill_listing / cli.js 读取。
  enabledToolNames?: string[];

  // MCP 工具名列表。TODO: 从 local settings 读取。
  mcpToolNames?: string[];

  // auto memory 是否启用。TODO: 从 settings 读取。
  autoMemoryEnabled?: boolean;

  // auto memory 路径。TODO: 从 settings 读取。
  autoMemoryPath?: string;

  // harness settings 对象（来自 ~/.claude/settings.json 等）。TODO: 从本地读取。
  settings?: Record<string, unknown>;

  // feature flags（如 isAutoMemoryEnabled）。TODO: 从 harness runtime 推断。
  // 值为 boolean 时已确认；"unknown" 表示无法判断。
  featureFlags?: Record<string, boolean | "unknown">;
}

// PreConditionResult：RulePreCondition evaluator 的返回值。
//   "pass"    — 条件明确成立，可激活 rule
//   "fail"    — 条件明确不成立，跳过 rule
//   "unknown" — 缺少足够 runtime 信息，无法判断
//              → evaluator 必须保守 skip，不得默认 pass
export type PreConditionResult = "pass" | "fail" | "unknown";

export type RequestLevelExactLevel =
  | "raw"
  | "canonical"
  | "structural"
  | "segment-only"
  | "none";

export interface RequestLevelExact {
  rawExact: boolean;
  canonicalExact: boolean;
  structuralExact: boolean;
  segmentOnly: boolean;
  level: RequestLevelExactLevel;
  reasons: string[];
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
  targetRequest?: TargetRequest;
  requestLevelExact?: RequestLevelExact;
  capability?: AgentCapabilityMatrix;
  metadata?: Record<string, unknown>;
}
