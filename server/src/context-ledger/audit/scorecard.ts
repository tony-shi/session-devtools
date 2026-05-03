// Scorecard 计算：从 ReconciliationReport + CharDiffReport 提取量化指标

import type { ReconciliationReport, ProxySegmentAttribution } from "../types";
import type { CharDiffReport } from "../debug/char-diff";
import type { AuditVerdict, QueryScorecard } from "./types";
import { queryKeyHash } from "./paths";
import type { QueryKey } from "./types";
import { getContextLedgerRule, SUPPORTED_CLAUDE_CODE_VERSION } from "../rule-registry";

// verdict 判断阈值
const THRESHOLDS = {
  // unexplainedCoverage 上升超过此值视为 regression
  unexplainedRiseRegression: 0.05,
  unexplainedCharsRiseRegression: 500,
  // wireExact + template 合计上升超过此值视为 improvement
  exactRiseImprovement: 0.02,
  unexplainedCharsDropImprovement: 200,
  attrOnlyDropImprovementRatio: 0.03,
  suspectRiseRegressionRatio: 0.05,
  // 新 query：wireExact + template + canonical 合计低于此值 → needs_review
  newQueryLowExactCoverage: 0.3,
  driftRiseNeedsReview: 0.05,
  // 治理阈值
  pendingRuleCoverageNeedsReview: 0.30,
  regexOverreachRiskNeedsReview: 0.60,
};

// pendingRuleCoverage：attribution 命中但 rule.verifiedFor===null 的字符 / proxyChars
function computePendingRuleCoverage(
  report: ReconciliationReport,
  attributions: ProxySegmentAttribution[],
): number {
  const proxyChars = report.coverage.proxyChars;
  if (proxyChars === 0) return 0;
  const proxySegs = report.snapshot.segments;
  const attrBySegId = new Map(attributions.flatMap((a) =>
    a.proxySegmentIds.map((id) => [id, a]),
  ));
  let pendingChars = 0;
  for (const pseg of proxySegs) {
    const chars = pseg.charCount ?? 0;
    if (chars === 0) continue;
    const attr = attrBySegId.get(pseg.id);
    if (!attr?.ruleId) continue;
    const rule = getContextLedgerRule(attr.ruleId);
    if (rule && rule.verifiedFor !== SUPPORTED_CLAUDE_CODE_VERSION) {
      pendingChars += chars;
    }
  }
  return proxyChars > 0 ? pendingChars / proxyChars : 0;
}

export function computeScorecard(
  queryKey: QueryKey,
  report: ReconciliationReport,
  diff: CharDiffReport,
  attributions?: ProxySegmentAttribution[],
): QueryScorecard {
  const { coverage } = report;
  const proxyChars = coverage.proxyChars;

  // suspect match chars 从 char diff summary 取
  const suspectMatchChars = diff.summary.suspectMatchChars;
  const alignedTextDriftChars = diff.summary.totalCharDriftAbsolute;
  const falseReliableMatchCount = diff.summary.suspectMatch;

  const prefixIncompleteCount = report.expected?.metadata?.prefixIncomplete ? 1 : 0;
  const sourceTextUnavailableCount = diff.entries.filter(
    (e) => e.kind === "expected_only" && !e.expectedTexts?.some((t) => t.text),
  ).length;

  // 正交分桶直接从 coverage 读（P0-2 已在 reconcile 层计算）
  const wireExactCoverage = coverage.wireExactCoverage;
  const canonicalExactCoverage = coverage.canonicalExactCoverage;
  const templateCoverage = coverage.templateCoverage;
  const regexCoverage = coverage.regexCoverage;
  const presenceCoverage = coverage.presenceCoverage;
  const serverSideCoverage = coverage.serverSideCoverage;
  const attributionOnlyCoverage = coverage.attributionOnlyCoverage;
  const unexplainedCoverage = coverage.unexplainedCoverage;
  const regexOverreachRisk = coverage.regexOverreachRisk;
  const alignedTextDrift = coverage.alignedTextDrift;

  // pendingRuleCoverage 需要 attributions（rule 验证状态不在 coverage 里）
  const pendingRuleCoverage = attributions
    ? computePendingRuleCoverage(report, attributions)
    : undefined;

  const hash = queryKeyHash(queryKey);

  const { verdict, reasons } = classifySingleRunVerdict({
    wireExactCoverage,
    templateCoverage,
    canonicalExactCoverage,
    unexplainedCoverage,
    unexplainedChars: coverage.unexplainedChars,
    falseReliableMatchCount,
    prefixIncompleteCount,
    sourceTextUnavailableCount,
    suspectMatchChars,
    proxyChars,
    alignedTextDrift,
    pendingRuleCoverage,
    regexOverreachRisk,
  });

  return {
    queryKey: `${queryKey.agentKind}/${queryKey.sessionId}/${queryKey.queryId}`,
    queryKeyHash: hash,
    proxyChars,
    suspectMatchChars,
    alignedTextDriftChars,
    falseReliableMatchCount,
    prefixIncompleteCount,
    sourceTextUnavailableCount,
    wireExactCoverage,
    canonicalExactCoverage,
    templateCoverage,
    regexCoverage,
    presenceCoverage,
    serverSideCoverage,
    attributionOnlyCoverage,
    unexplainedCoverage,
    regexOverreachRisk,
    pendingRuleCoverage,
    alignedTextDrift,
    verdict,
    reasons,
    generatedAt: new Date().toISOString(),
  };
}

function classifySingleRunVerdict(m: {
  wireExactCoverage: number;
  templateCoverage: number;
  canonicalExactCoverage: number;
  unexplainedCoverage: number;
  unexplainedChars: number;
  falseReliableMatchCount: number;
  prefixIncompleteCount: number;
  sourceTextUnavailableCount: number;
  suspectMatchChars: number;
  proxyChars: number;
  alignedTextDrift: number;
  pendingRuleCoverage?: number;
  regexOverreachRisk: number;
}): { verdict: AuditVerdict; reasons: string[] } {
  const reasons: string[] = [];
  const exactTotal = m.wireExactCoverage + m.canonicalExactCoverage + m.templateCoverage;

  if (m.falseReliableMatchCount > 0) {
    reasons.push(`suspect_match x${m.falseReliableMatchCount}`);
  }
  if (m.prefixIncompleteCount > 0) reasons.push("prefix_incomplete");
  if (m.sourceTextUnavailableCount > 0) {
    reasons.push(`source_text_unavailable x${m.sourceTextUnavailableCount}`);
  }
  if (exactTotal < THRESHOLDS.newQueryLowExactCoverage) {
    reasons.push(`low_exact_coverage (${(exactTotal * 100).toFixed(1)}%)`);
  }
  if (m.pendingRuleCoverage !== undefined && m.pendingRuleCoverage > THRESHOLDS.pendingRuleCoverageNeedsReview) {
    reasons.push(`pending_rule_coverage (${(m.pendingRuleCoverage * 100).toFixed(1)}%)`);
  }
  if (m.regexOverreachRisk > THRESHOLDS.regexOverreachRiskNeedsReview) {
    reasons.push(`regex_overreach_risk (${(m.regexOverreachRisk * 100).toFixed(1)}%)`);
  }

  const needsReview =
    exactTotal < THRESHOLDS.newQueryLowExactCoverage ||
    m.prefixIncompleteCount > 0 ||
    m.sourceTextUnavailableCount > 0 ||
    (m.pendingRuleCoverage !== undefined && m.pendingRuleCoverage > THRESHOLDS.pendingRuleCoverageNeedsReview) ||
    m.regexOverreachRisk > THRESHOLDS.regexOverreachRiskNeedsReview;

  return { verdict: needsReview ? "needs_review" : "ok", reasons };
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
    const reasons: string[] = [];
    if (isNew) reasons.push("new_query");
    if (current.prefixIncompleteCount > 0) reasons.push("prefix_incomplete");
    if (current.sourceTextUnavailableCount > 0) {
      reasons.push(`source_text_unavailable x${current.sourceTextUnavailableCount}`);
    }
    const exactTotal = current.wireExactCoverage + current.canonicalExactCoverage + current.templateCoverage;
    if (exactTotal < THRESHOLDS.newQueryLowExactCoverage) {
      reasons.push(`low_exact_coverage (${(exactTotal * 100).toFixed(1)}%)`);
    }
    if (current.pendingRuleCoverage !== undefined && current.pendingRuleCoverage > THRESHOLDS.pendingRuleCoverageNeedsReview) {
      reasons.push(`pending_rule_coverage (${(current.pendingRuleCoverage * 100).toFixed(1)}%)`);
    }
    if (current.regexOverreachRisk > THRESHOLDS.regexOverreachRiskNeedsReview) {
      reasons.push(`regex_overreach_risk (${(current.regexOverreachRisk * 100).toFixed(1)}%)`);
    }
    return { verdict: "needs_review", reasons };
  }

  const reasons: string[] = [];

  const prevExact = previous.wireExactCoverage + previous.canonicalExactCoverage + previous.templateCoverage;
  const curExact = current.wireExactCoverage + current.canonicalExactCoverage + current.templateCoverage;
  const exactDelta = curExact - prevExact;
  const unexplainedDelta = current.unexplainedCoverage - previous.unexplainedCoverage;
  const unexplainedCharsDelta = Math.round(current.unexplainedCoverage * current.proxyChars)
    - Math.round(previous.unexplainedCoverage * previous.proxyChars);
  const attrOnlyDelta = current.attributionOnlyCoverage - previous.attributionOnlyCoverage;
  const suspectDelta = (current.suspectMatchChars - previous.suspectMatchChars) / Math.max(current.proxyChars, 1);
  const driftDelta = current.alignedTextDrift - previous.alignedTextDrift;

  const hasSuspect = current.falseReliableMatchCount > 0;

  const isRegression =
    hasSuspect ||
    unexplainedDelta > THRESHOLDS.unexplainedRiseRegression ||
    unexplainedCharsDelta > THRESHOLDS.unexplainedCharsRiseRegression ||
    attrOnlyDelta > 0.05 ||
    suspectDelta > THRESHOLDS.suspectRiseRegressionRatio;

  const isImprovement =
    !isRegression && !hasSuspect &&
    (exactDelta > THRESHOLDS.exactRiseImprovement ||
      unexplainedCharsDelta < -THRESHOLDS.unexplainedCharsDropImprovement ||
      attrOnlyDelta < -THRESHOLDS.attrOnlyDropImprovementRatio);

  const isNeedsReview =
    current.prefixIncompleteCount > 0 ||
    current.sourceTextUnavailableCount > 0 ||
    (exactDelta > 0 && driftDelta > THRESHOLDS.driftRiseNeedsReview) ||
    (current.pendingRuleCoverage !== undefined && current.pendingRuleCoverage > THRESHOLDS.pendingRuleCoverageNeedsReview) ||
    current.regexOverreachRisk > THRESHOLDS.regexOverreachRiskNeedsReview;

  if (isRegression) {
    if (hasSuspect) reasons.push(`suspect_match x${current.falseReliableMatchCount}`);
    if (unexplainedDelta > THRESHOLDS.unexplainedRiseRegression)
      reasons.push(`unexplained_rise +${(unexplainedDelta * 100).toFixed(1)}%`);
    if (unexplainedCharsDelta > THRESHOLDS.unexplainedCharsRiseRegression)
      reasons.push(`unexplained_chars_rise +${unexplainedCharsDelta}`);
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
    if (exactDelta > 0 && driftDelta > THRESHOLDS.driftRiseNeedsReview)
      reasons.push(`drift_rise ${(driftDelta * 100).toFixed(1)}%`);
    if (current.pendingRuleCoverage !== undefined && current.pendingRuleCoverage > THRESHOLDS.pendingRuleCoverageNeedsReview)
      reasons.push(`pending_rule_coverage (${(current.pendingRuleCoverage * 100).toFixed(1)}%)`);
    if (current.regexOverreachRisk > THRESHOLDS.regexOverreachRiskNeedsReview)
      reasons.push(`regex_overreach_risk (${(current.regexOverreachRisk * 100).toFixed(1)}%)`);
    return { verdict: "needs_review", reasons };
  }

  if (isImprovement) {
    if (exactDelta > THRESHOLDS.exactRiseImprovement)
      reasons.push(`exact_coverage_rise +${(exactDelta * 100).toFixed(1)}%`);
    if (unexplainedCharsDelta < -THRESHOLDS.unexplainedCharsDropImprovement)
      reasons.push(`unexplained_chars_drop ${unexplainedCharsDelta}`);
    if (attrOnlyDelta < -THRESHOLDS.attrOnlyDropImprovementRatio)
      reasons.push(`attribution_only_drop ${(attrOnlyDelta * 100).toFixed(1)}%`);
    return { verdict: "improvement", reasons };
  }

  if (
    current.wireExactCoverage === previous.wireExactCoverage &&
    current.templateCoverage === previous.templateCoverage &&
    current.unexplainedCoverage === previous.unexplainedCoverage
  ) {
    return { verdict: "unchanged", reasons: [] };
  }

  return { verdict: "ok", reasons: [] };
}
