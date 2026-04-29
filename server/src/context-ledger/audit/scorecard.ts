// Scorecard 计算：从 ReconciliationReport + CharDiffReport 提取量化指标
// 参考：docs/context-reconstruction-correction.md 的指标定义

import type { ReconciliationReport } from "../types";
import type { CharDiffReport } from "../debug/char-diff";
import type { AuditVerdict, QueryScorecard } from "./types";
import { queryKeyHash } from "./paths";
import type { QueryKey } from "./types";

// verdict 判断阈值（本地常量，不需要配置 UI）
const THRESHOLDS = {
  // evidenceBackedCoverage 下降超过此值视为 regression
  evidenceBackedDropRegression: 0.05,
  // unknownProxyChars 上升超过此值视为 regression（绝对字符数）
  unknownCharsRiseRegression: 500,
  // evidenceBackedCoverage 上升超过此值视为 improvement
  evidenceBackedRiseImprovement: 0.02,
  // unknownProxyChars 下降超过此值视为 improvement
  unknownCharsDropImprovement: 200,
  // attributionOnlyProxyChars 下降超过此值视为 improvement（相对 proxyChars 的比例）
  attrOnlyDropImprovementRatio: 0.03,
  // suspectMatchChars 上升超过此值视为 regression（相对 proxyChars 的比例）
  suspectRiseRegressionRatio: 0.05,
  // 新 query 的 evidenceBackedCoverage 低于此值 → needs_review
  newQueryLowEvidenceCoverage: 0.5,
  // evidenceBackedCoverage 上升但 drift 也上升时的 drift 阈值
  driftRiseNeedsReview: 0.05,
};

export function computeScorecard(
  queryKey: QueryKey,
  report: ReconciliationReport,
  diff: CharDiffReport,
): QueryScorecard {
  const { coverage } = report;

  const proxyChars = coverage.proxyChars;
  const evidenceBackedProxyChars = Math.round((coverage.evidenceBackedCoverage ?? 0) * proxyChars);
  const attributionOnlyProxyChars = Math.round(
    (coverage.attributionOnlyGap ?? 0) * proxyChars,
  );
  const attributedProxyChars = Math.round((coverage.attributionCoverage ?? 0) * proxyChars);
  const unknownProxyChars = coverage.unexplainedProxyChars;

  // suspect match chars 从 char diff summary 取
  const suspectMatchChars = diff.summary.suspectMatchChars;

  // alignedAuditedChars = evidence-backed matched chars（matched_exact + matched_char_diff）
  const alignedAuditedChars =
    diff.summary.totalProxyChars > 0
      ? Math.round(diff.summary.evidenceBackedCoverage * diff.summary.totalProxyChars)
      : evidenceBackedProxyChars;

  // alignedTextDriftChars = evidence-backed matched 中的字符漂移绝对值之和
  const alignedTextDriftChars = diff.summary.totalCharDriftAbsolute;

  // falseReliableMatchCount：suspect_match finding 数（heuristic 无锚点匹配）
  const falseReliableMatchCount = diff.summary.suspectMatch;

  // prefixIncompleteCount：report 的 expected metadata 中 prefixIncomplete 标记
  const prefixIncompleteCount =
    report.expected?.metadata?.prefixIncomplete ? 1 : 0;

  // sourceTextUnavailableCount：diff 中 expected_only 且无文本内容的条目
  const sourceTextUnavailableCount = diff.entries.filter(
    (e) => e.kind === "expected_only" && !e.expectedTexts?.some((t) => t.text),
  ).length;

  // 覆盖率比例
  const attributionCoverage = coverage.attributionCoverage ?? 0;
  const evidenceBackedCoverage = coverage.evidenceBackedCoverage ?? 0;
  const attributionOnlyRatio = coverage.attributionOnlyGap ?? 0;
  const alignedTextDriftRatio = coverage.alignedTextDrift ?? 0;

  const hash = queryKeyHash(queryKey);

  // 初始 verdict（无 baseline 对比，单次 run 的基础判断）
  const { verdict, reasons } = classifySingleRunVerdict({
    evidenceBackedCoverage,
    unknownProxyChars,
    falseReliableMatchCount,
    prefixIncompleteCount,
    sourceTextUnavailableCount,
    suspectMatchChars,
    proxyChars,
    alignedTextDriftRatio,
  });

  return {
    queryKey: `${queryKey.agentKind}/${queryKey.sessionId}/${queryKey.queryId}`,
    queryKeyHash: hash,
    proxyChars,
    attributedProxyChars,
    evidenceBackedProxyChars,
    attributionOnlyProxyChars,
    unknownProxyChars,
    suspectMatchChars,
    alignedAuditedChars,
    alignedTextDriftChars,
    falseReliableMatchCount,
    prefixIncompleteCount,
    sourceTextUnavailableCount,
    attributionCoverage,
    evidenceBackedCoverage,
    attributionOnlyRatio,
    alignedTextDriftRatio,
    verdict,
    reasons,
    generatedAt: new Date().toISOString(),
  };
}

// 无 baseline 时的单次 run verdict（新 query 或首次 run）
function classifySingleRunVerdict(m: {
  evidenceBackedCoverage: number;
  unknownProxyChars: number;
  falseReliableMatchCount: number;
  prefixIncompleteCount: number;
  sourceTextUnavailableCount: number;
  suspectMatchChars: number;
  proxyChars: number;
  alignedTextDriftRatio: number;
}): { verdict: AuditVerdict; reasons: string[] } {
  const reasons: string[] = [];

  if (m.falseReliableMatchCount > 0) {
    reasons.push(`suspect_match x${m.falseReliableMatchCount}`);
  }
  if (m.prefixIncompleteCount > 0) {
    reasons.push("prefix_incomplete");
  }
  if (m.sourceTextUnavailableCount > 0) {
    reasons.push(`source_text_unavailable x${m.sourceTextUnavailableCount}`);
  }
  if (m.evidenceBackedCoverage < THRESHOLDS.newQueryLowEvidenceCoverage) {
    reasons.push(
      `low_evidence_backed_coverage (${(m.evidenceBackedCoverage * 100).toFixed(1)}%)`,
    );
  }

  const needsReview =
    m.evidenceBackedCoverage < THRESHOLDS.newQueryLowEvidenceCoverage ||
    m.prefixIncompleteCount > 0 ||
    m.sourceTextUnavailableCount > 0;

  return {
    verdict: needsReview ? "needs_review" : "ok",
    reasons,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Delta 分类（current vs previous baseline）
// ─────────────────────────────────────────────────────────────────────────────

export function classifyDelta(
  current: QueryScorecard,
  previous: QueryScorecard | undefined,
  isNew: boolean,
): { verdict: AuditVerdict; reasons: string[] } {
  if (isNew || !previous) {
    // 新 query：直接按指标判断，不信任 current.verdict（可能是旧 run 写入的值）
    const reasons: string[] = [];
    if (isNew) reasons.push("new_query");
    if (current.prefixIncompleteCount > 0) reasons.push("prefix_incomplete");
    if (current.sourceTextUnavailableCount > 0)
      reasons.push(`source_text_unavailable x${current.sourceTextUnavailableCount}`);
    if (current.evidenceBackedCoverage < THRESHOLDS.newQueryLowEvidenceCoverage) {
      reasons.push(`low_evidence_backed_coverage (${(current.evidenceBackedCoverage * 100).toFixed(1)}%)`);
    }
    // 新 query 默认 needs_review；高覆盖率且无异常时仍是 needs_review（保守）
    return { verdict: "needs_review", reasons };
  }

  const reasons: string[] = [];

  const ebDelta = current.evidenceBackedCoverage - previous.evidenceBackedCoverage;
  const unknownDelta = current.unknownProxyChars - previous.unknownProxyChars;
  const attrOnlyDelta =
    (current.attributionOnlyProxyChars - previous.attributionOnlyProxyChars) /
    Math.max(current.proxyChars, 1);
  const suspectDelta =
    (current.suspectMatchChars - previous.suspectMatchChars) /
    Math.max(current.proxyChars, 1);
  const driftDelta = current.alignedTextDriftRatio - previous.alignedTextDriftRatio;

  // regression 条件（任意一个触发即 regression）
  const isRegression =
    current.falseReliableMatchCount > 0 ||
    ebDelta < -THRESHOLDS.evidenceBackedDropRegression ||
    unknownDelta > THRESHOLDS.unknownCharsRiseRegression ||
    attrOnlyDelta > 0.05 ||
    suspectDelta > THRESHOLDS.suspectRiseRegressionRatio;

  // improvement 条件（任意一个满足，且无 regression）
  const isImprovement =
    !isRegression &&
    (ebDelta > THRESHOLDS.evidenceBackedRiseImprovement ||
      unknownDelta < -THRESHOLDS.unknownCharsDropImprovement ||
      attrOnlyDelta < -THRESHOLDS.attrOnlyDropImprovementRatio);

  // needs_review（上升但有 drift 暴露 / 已知标记）
  const isNeedsReview =
    current.prefixIncompleteCount > 0 ||
    current.sourceTextUnavailableCount > 0 ||
    (ebDelta > 0 && driftDelta > THRESHOLDS.driftRiseNeedsReview);

  if (isRegression) {
    if (current.falseReliableMatchCount > 0)
      reasons.push(`suspect_match x${current.falseReliableMatchCount}`);
    if (ebDelta < -THRESHOLDS.evidenceBackedDropRegression)
      reasons.push(`evidence_backed_drop ${(ebDelta * 100).toFixed(1)}%`);
    if (unknownDelta > THRESHOLDS.unknownCharsRiseRegression)
      reasons.push(`unknown_chars_rise +${unknownDelta}`);
    if (attrOnlyDelta > 0.05)
      reasons.push(`attribution_only_rise ${(attrOnlyDelta * 100).toFixed(1)}%`);
    if (suspectDelta > THRESHOLDS.suspectRiseRegressionRatio)
      reasons.push(`suspect_chars_rise ${(suspectDelta * 100).toFixed(1)}%`);
    return { verdict: "regression", reasons };
  }

  if (isNeedsReview) {
    if (current.prefixIncompleteCount > 0) reasons.push("prefix_incomplete");
    if (current.sourceTextUnavailableCount > 0)
      reasons.push(`source_text_unavailable x${current.sourceTextUnavailableCount}`);
    if (ebDelta > 0 && driftDelta > THRESHOLDS.driftRiseNeedsReview)
      reasons.push(`drift_rise ${(driftDelta * 100).toFixed(1)}%`);
    return { verdict: "needs_review", reasons };
  }

  if (isImprovement) {
    if (ebDelta > THRESHOLDS.evidenceBackedRiseImprovement)
      reasons.push(`evidence_backed_rise +${(ebDelta * 100).toFixed(1)}%`);
    if (unknownDelta < -THRESHOLDS.unknownCharsDropImprovement)
      reasons.push(`unknown_chars_drop ${unknownDelta}`);
    if (attrOnlyDelta < -THRESHOLDS.attrOnlyDropImprovementRatio)
      reasons.push(`attribution_only_drop ${(attrOnlyDelta * 100).toFixed(1)}%`);
    return { verdict: "improvement", reasons };
  }

  // 完全相同
  if (
    current.evidenceBackedCoverage === previous.evidenceBackedCoverage &&
    current.unknownProxyChars === previous.unknownProxyChars &&
    current.suspectMatchChars === previous.suspectMatchChars
  ) {
    return { verdict: "unchanged", reasons: [] };
  }

  return { verdict: "ok", reasons: [] };
}
