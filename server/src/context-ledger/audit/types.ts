// Audit Runner 类型定义
// 不修改 context-ledger/types.ts；仅在此处扩展 audit 专属类型

import type { AgentKind } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Verdict
// ─────────────────────────────────────────────────────────────────────────────

export type AuditVerdict =
  | "ok"           // 无显著变化，各指标在阈值内
  | "improvement"  // wireExact + template 上升 / unexplainedCoverage 下降
  | "regression"   // falseReliableMatchCount>0 / wireExact + template 明显下降
  | "needs_review" // 新 query / drift 暴露 / prefixIncomplete / proxy_without_jsonl /
                   // pendingRuleCoverage>30% / regexOverreachRisk>60%
  | "unchanged"    // 与 baseline 完全一致
  | "skipped"      // proxy_without_jsonl 或缺少必要输入
  | "failed";      // pipeline 抛出异常

// verdict 变化分类（对比 baseline run）
export type ChangeClass =
  | "new"      // 本次 run 新增，baseline 里没有
  | "removed"  // baseline 有，本次 run 没有
  | "improved"
  | "regressed"
  | "needs_review"
  | "unchanged"
  | "skipped"
  | "failed";

// ─────────────────────────────────────────────────────────────────────────────
// Scorecard
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryScorecard {
  queryKey: string;
  queryKeyHash: string;
  // 基础计数
  proxyChars: number;
  suspectMatchChars: number;
  alignedTextDriftChars: number;
  falseReliableMatchCount: number;
  prefixIncompleteCount: number;
  sourceTextUnavailableCount: number;
  // 正交分桶覆盖率（直接来自 CoverageSummary，相加 ≈ 1.0）
  wireExactCoverage: number;
  canonicalExactCoverage: number;
  templateCoverage: number;
  regexCoverage: number;
  presenceCoverage: number;
  serverSideCoverage: number;
  attributionOnlyCoverage: number;
  unexplainedCoverage: number;
  // 治理指标
  regexOverreachRisk: number;
  pendingRuleCoverage?: number;   // attribution 命中但 rule.verifiedFor===null 的字符 / proxyChars
  alignedTextDrift: number;
  // 元数据
  verdict: AuditVerdict;
  reasons: string[];
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scorecard Delta（当前 vs baseline）
// ─────────────────────────────────────────────────────────────────────────────

export interface ScorecardDelta {
  queryKey: string;
  queryKeyHash: string;
  current: QueryScorecard;
  previous?: QueryScorecard;
  verdict: AuditVerdict;
  changeClass: ChangeClass;
  reasons: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// QueryKey — proxy-first 索引 key
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryKey {
  agentKind: AgentKind;
  sessionId: string;
  queryId: string;  // proxy queryId（timestamp-based）
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery 结果
// ─────────────────────────────────────────────────────────────────────────────

// proxy record（从 traffic.jsonl 解析的一条 request entry）
export interface DiscoveredProxyRecord {
  queryKey: QueryKey;
  queryKeyHash: string;
  proxySourceFile: string;
  trafficLine: number;
  timestamp: string;
  sessionId: string;
  agentKind: AgentKind;
  raw: Record<string, unknown>;  // 原始 traffic record（含 reqBody）
}

// jsonl session 候选（发现了 JSONL 但可能没有对应 proxy）
export interface DiscoveredJsonlSession {
  sessionId: string;
  jsonlFile: string;
  agentKind: AgentKind;
  candidateQueryCount: number;  // JSONL 里可识别的 query 数量
}

// discovery 汇总
export interface DiscoveryResult {
  discoveredProxyQueries: DiscoveredProxyRecord[];
  proxyWithoutJsonl: DiscoveredProxyRecord[];
  matchedProxyJsonl: Array<{ proxy: DiscoveredProxyRecord; jsonlFile: string }>;
  jsonlOnlySessions: DiscoveredJsonlSession[];
  jsonlOnlyCandidateQueries: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-query Pipeline 结果
// ─────────────────────────────────────────────────────────────────────────────

export type PipelineStatus = "success" | "skipped" | "failed";

export interface PipelineResult {
  queryKey: QueryKey;
  queryKeyHash: string;
  status: PipelineStatus;
  skipReason?: string;
  error?: string;
  proxySourceRef: string;
  jsonlSourceRef?: string;
  timestamp: string;
  queryKind?: string;
  // 产出路径（相对于 runDir）
  reportPath?: string;
  scorecardPath?: string;
  charDiffJsonPath?: string;
  charDiffHtmlPath?: string;
  proxyAttributionViewPath?: string;
  errorPath?: string;
  // scorecard（成功时有）
  scorecard?: QueryScorecard;
  delta?: ScorecardDelta;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run Artifact
// ─────────────────────────────────────────────────────────────────────────────

/** T0/E0 控制变量 flags，记录本次 run 启用了哪些对照开关 */
export interface AuditControlFlags {
  /** --no-r9：禁用 attribution 反写 system/tools expected segments */
  noR9?: boolean;
  /** --verified-only：verifiedFor===null 的 rule 不进入 evidenceBacked */
  verifiedOnly?: boolean;
  /** --proxy-only：proxy_without_jsonl 走 attribution-only 路径（不 skip） */
  proxyOnly?: boolean;
}

/** T0 fixture 来源矩阵（fixture 模式下输出） */
export interface FixtureMatrixEntry {
  fixtureName: string;
  source: string;  // "ant-native" | "external" | "synthetic" | "unknown"
  queryId: string;
  // P0-2 后用正交桶替代旧 evidenceBackedCoverage：
  //   wireExactCoverage  — basis=raw_hash / tool_use_id（精确锚点匹配）
  //   templateCoverage   — basis=rule_id + materialization=exact_text（contentPattern 正向重建命中）
  // 两者之和约等于"严格 exact"覆盖率；不含 regex/presence/attributionOnly。
  wireExactCoverage?: number;
  templateCoverage?: number;
  verdict?: string;
}

/** T0 rule registry 验证摘要（来自 rule-registry 的静态统计，不依赖 CLI binary） */
export interface RuleRegistrySummary {
  supportedVersion: string;
  totalRules: number;
  verifiedRules: number;
  unverifiedRules: number;
  /** 注意：与本地 CLI binary 对账结果需单独运行 verify-rules-against-cli.ts */
  lastCliVerificationNote?: string;
}

// run.json 顶层结构
export interface AuditRunRecord {
  runId: string;
  createdAt: string;
  baselineRunId?: string;
  mode: "fixtures" | "all-local" | "since-last";
  /** T0 控制变量开关（默认均为 false/不存在即关闭） */
  controlFlags?: AuditControlFlags;
  /** T0 fixture 来源矩阵（仅 fixtures 模式下有值） */
  fixtureMatrix?: FixtureMatrixEntry[];
  /** T0 rule registry 验证摘要 */
  ruleRegistrySummary?: RuleRegistrySummary;
  // discovery 计数
  discoveredProxyQueries: number;
  matchedProxyJsonlQueries: number;
  proxyWithoutJsonlQueries: number;
  jsonlOnlySessions: number;
  jsonlOnlyCandidateQueries: number;
  // query 对比（vs baseline）
  previousQueries: number;
  currentQueries: number;
  newQueries: number;
  removedQueries: number;
  commonQueries: number;
  // verdict 统计
  improvedQueries: number;
  regressedQueries: number;
  needsReviewQueries: number;
  unchangedQueries: number;
  skippedQueries: number;
  failedQueries: number;
}

/** AuditIndexEntry 里内嵌的覆盖率摘要（用于 report-generator 直接渲染，避免二次读文件） */
export interface ScorecardV2Summary {
  wireExactCoverage: number;
  canonicalExactCoverage: number;
  templateCoverage: number;
  regexCoverage: number;
  presenceCoverage: number;
  serverSideCoverage: number;
  attributionOnlyCoverage: number;
  unexplainedCoverage: number;
  regexOverreachRisk: number;
  pendingRuleCoverage?: number;
  proxyChars: number;
}

// index.json 的单条 entry
export interface AuditIndexEntry {
  queryKey: QueryKey;
  queryKeyHash: string;
  agentKind: AgentKind;
  sessionId: string;
  queryId: string;
  timestamp: string;
  proxySourceRef: string;
  jsonlSourceRef?: string;
  verdict: AuditVerdict;
  changeClass: ChangeClass;
  reasons: string[];
  // query 类型标注：main_session / session_title_side_query / side_query / unknown
  queryKind?: string;
  // E0-5 v2 分桶摘要（有 scorecard 时有值）
  v2?: ScorecardV2Summary;
  reportPath?: string;
  scorecardPath?: string;
  charDiffHtmlPath?: string;
  charDiffJsonPath?: string;
  proxyAttributionViewPath?: string;
  errorPath?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline 指针
// ─────────────────────────────────────────────────────────────────────────────

export interface BaselinePointer {
  runId: string;
  pointedAt: string;  // ISO 时间戳，人工标记时间
  note?: string;
}

// latest.json 结构
export interface LatestPointer {
  runId: string;
  createdAt: string;
}
