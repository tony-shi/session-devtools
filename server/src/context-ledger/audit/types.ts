// Audit Runner 类型定义
// 不修改 context-ledger/types.ts；仅在此处扩展 audit 专属类型

import type { AgentKind } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Verdict
// ─────────────────────────────────────────────────────────────────────────────

export type AuditVerdict =
  | "ok"           // 无显著变化，各指标在阈值内
  | "improvement"  // evidenceBackedCoverage 上升 / unknownProxyChars 下降
  | "regression"   // falseReliableMatchCount>0 / evidenceBackedCoverage 明显下降
  | "needs_review" // 新 query / drift 暴露 / prefixIncomplete / proxy_without_jsonl
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
  // 原始字符数指标
  proxyChars: number;
  attributedProxyChars: number;
  evidenceBackedProxyChars: number;
  attributionOnlyProxyChars: number;
  unknownProxyChars: number;
  suspectMatchChars: number;
  alignedAuditedChars: number;
  alignedTextDriftChars: number;
  // 计数指标
  falseReliableMatchCount: number;
  prefixIncompleteCount: number;
  sourceTextUnavailableCount: number;
  // 覆盖率比例 (0..1)
  attributionCoverage: number;
  evidenceBackedCoverage: number;
  attributionOnlyRatio: number;
  alignedTextDriftRatio: number;
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

// run.json 顶层结构
export interface AuditRunRecord {
  runId: string;
  createdAt: string;
  baselineRunId?: string;
  mode: "fixtures" | "all-local" | "since-last";
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
