// Scorecard 计算：从 ReconciliationReport + CharDiffReport 提取量化指标
// 参考：docs/context-reconstruction-correction.md 的指标定义

import type { ReconciliationReport, ProxySegmentAttribution } from "../types";
import type { CharDiffReport } from "../debug/char-diff";
import type { AuditVerdict, QueryScorecard } from "./types";
import { queryKeyHash } from "./paths";
import type { QueryKey } from "./types";
import { getContextLedgerRule, SUPPORTED_CLAUDE_CODE_VERSION } from "../rule-registry";

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
  // E0-4 治理阈值
  pendingRuleCoverageNeedsReview: 0.30,  // pendingRuleCoverage > 30%
  regexOverreachRiskNeedsReview: 0.60,   // regexOverreachRisk > 60%
};

// ─────────────────────────────────────────────────────────────────────────────
// E0-3：v2 分桶推导
// ─────────────────────────────────────────────────────────────────────────────

interface V2Buckets {
  // E0-3 v2 覆盖率分桶（字符数）
  wireExactChars: number;         // basis=raw_hash（P0-3 前与 canonicalExact 合并）
  canonicalExactChars: number;    // basis=normalized_hash
  templateChars: number;          // basis=rule_id + materialization=exact_text（contentPattern 字面量）
  regexChars: number;             // basis=rule_id + materialization=shape/normalized_text（regex/shape）
  presenceChars: number;          // basis=harness_rule + category≠billing_noise（presence rule，预留路径）
  serverSideChars: number;        // basis=harness_rule + category=billing_noise（known_noise）
  pendingRuleChars: number;       // attribution 命中但 rule.verifiedFor===null 的字符
  pendingRuleMatchedChars: number; // pendingRule 中同时被 reconcile 匹配的字符（交叉）
}

function computeV2Buckets(
  report: ReconciliationReport,
  attributions: ProxySegmentAttribution[],
): V2Buckets {
  const buckets: V2Buckets = {
    wireExactChars: 0,
    canonicalExactChars: 0,
    templateChars: 0,
    regexChars: 0,
    presenceChars: 0,
    serverSideChars: 0,
    pendingRuleChars: 0,
    pendingRuleMatchedChars: 0,
  };

  const proxySegs = report.snapshot.segments;
  const attrBySegId = new Map(attributions.map((a) => [a.proxySegmentIds[0], a]));

  // 为每个 proxy segment 建立 basis 索引（取最强的一条 alignment）
  // basis 优先级：raw_hash > normalized_hash > rule_id > harness_rule > category
  const BASIS_RANK: Record<string, number> = {
    raw_hash: 6,
    normalized_hash: 5,
    tool_use_id: 4,
    rule_id: 3,
    harness_rule: 2,
    category: 1,
    order: 0,
    timestamp: 0,
  };
  const proxyBasis = new Map<string, { basis: string; ruleId?: string }>();

  for (const align of report.alignments) {
    const rank = BASIS_RANK[align.basis] ?? 0;
    for (const pid of align.proxySegmentIds) {
      const cur = proxyBasis.get(pid);
      const curRank = cur ? (BASIS_RANK[cur.basis] ?? 0) : -1;
      if (rank > curRank) {
        // 从 alignment note 解析 ruleId（格式：`ruleId match: <ruleId> (mat)`）
        const ruleId = align.note?.match(/^ruleId match: ([^\s]+)/)?.[1];
        proxyBasis.set(pid, { basis: align.basis, ruleId });
      }
    }
  }

  // 按桶统计
  for (const pseg of proxySegs) {
    const chars = pseg.charCount ?? 0;
    if (chars === 0) continue;

    const match = proxyBasis.get(pseg.id);
    const effectiveCategory = attrBySegId.get(pseg.id)?.category ?? pseg.category;

    if (match) {
      switch (match.basis) {
        case "raw_hash":
          // P0-3 前：raw_hash 是真实 wire-exact（P0-1 后 R9 不再 proxy copy，所以此处不再虚高）
          // P0-3 完成后将进一步区分 raw bytes hash vs canonical hash
          buckets.wireExactChars += chars;
          break;
        case "normalized_hash":
          buckets.canonicalExactChars += chars;
          break;
        case "tool_use_id":
          // tool_use_id 匹配的 tool_result：归入 wireExact（tool_use_id 是确定性锚点）
          buckets.wireExactChars += chars;
          break;
        case "rule_id": {
          const rule = match.ruleId ? getContextLedgerRule(match.ruleId) : undefined;
          const mat = rule?.reconstruction?.materialization;
          if (mat === "exact_text") {
            // exact_text rule：contentPattern 字面量匹配，归入 template
            buckets.templateChars += chars;
          } else {
            // shape / normalized_text / presence / unavailable → regex 桶
            // （P0-1 修复后 shape 会降为 presence_only；当前先统一归 regex）
            buckets.regexChars += chars;
          }
          break;
        }
        case "harness_rule":
          if (effectiveCategory === "billing_noise") {
            buckets.serverSideChars += chars;
          } else {
            // presence rule（当前无此路径，预留）
            buckets.presenceChars += chars;
          }
          break;
        default:
          break;
      }
    }

    // pendingRuleCoverage：attribution 命中且 rule.verifiedFor===null 的字符
    const attr = attrBySegId.get(pseg.id);
    if (attr?.ruleId) {
      const rule = getContextLedgerRule(attr.ruleId);
      if (rule && rule.verifiedFor !== SUPPORTED_CLAUDE_CODE_VERSION) {
        buckets.pendingRuleChars += chars;
        // 若同时被 reconcile 匹配，则也计入 pendingRuleMatchedChars
        if (match && match.basis !== "category") {
          buckets.pendingRuleMatchedChars += chars;
        }
      }
    }
  }

  return buckets;
}

export function computeScorecard(
  queryKey: QueryKey,
  report: ReconciliationReport,
  diff: CharDiffReport,
  attributions?: ProxySegmentAttribution[],
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

  // P3-3 双源问题：alignedAuditedChars 从 char-diff summary 取（diff.summary.evidenceBackedCoverage），
  // 而 evidenceBackedProxyChars 从 reconciliation report 取（coverage.evidenceBackedCoverage）。
  // 两者口径不同时会产生不一致——修复见 P3-3：reconciliation 为权威，char-diff 仅做渲染层。
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

  // ── E0-3 v2 分桶 ──────────────────────────────────────────────────────────
  const v2 = attributions
    ? computeV2Buckets(report, attributions)
    : null;

  const safeRatio = (chars: number) => proxyChars > 0 ? chars / proxyChars : 0;

  // v2 覆盖率比例（无 attributions 时为 undefined，向后兼容）
  const wireExactCoverage = v2 ? safeRatio(v2.wireExactChars) : undefined;
  const canonicalExactCoverage = v2 ? safeRatio(v2.canonicalExactChars) : undefined;
  const templateCoverage = v2 ? safeRatio(v2.templateChars) : undefined;
  const regexCoverage = v2 ? safeRatio(v2.regexChars) : undefined;
  const presenceCoverage = v2 ? safeRatio(v2.presenceChars) : undefined;
  const serverSideAttributionChars = v2 ? v2.serverSideChars : undefined;
  const pendingRuleCoverage = v2 ? safeRatio(v2.pendingRuleChars) : undefined;
  // regexOverreachRisk = (regex + shape) / proxyChars（>60% 触发 needs_review）
  const regexOverreachRisk = v2 ? safeRatio(v2.regexChars) : undefined;

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
    pendingRuleCoverage,
    regexOverreachRisk,
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
    // E0-3 v2 分桶（有 attributions 时有值，否则 undefined）
    wireExactCoverage,
    canonicalExactCoverage,
    templateCoverage,
    regexCoverage,
    presenceCoverage,
    serverSideAttributionChars,
    pendingRuleCoverage,
    regexOverreachRisk,
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
  pendingRuleCoverage?: number;
  regexOverreachRisk?: number;
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
  // E0-4 治理阈值
  if (m.pendingRuleCoverage !== undefined && m.pendingRuleCoverage > THRESHOLDS.pendingRuleCoverageNeedsReview) {
    reasons.push(`pending_rule_coverage (${(m.pendingRuleCoverage * 100).toFixed(1)}%)`);
  }
  if (m.regexOverreachRisk !== undefined && m.regexOverreachRisk > THRESHOLDS.regexOverreachRiskNeedsReview) {
    reasons.push(`regex_overreach_risk (${(m.regexOverreachRisk * 100).toFixed(1)}%)`);
  }

  const needsReview =
    m.evidenceBackedCoverage < THRESHOLDS.newQueryLowEvidenceCoverage ||
    m.prefixIncompleteCount > 0 ||
    m.sourceTextUnavailableCount > 0 ||
    (m.pendingRuleCoverage !== undefined && m.pendingRuleCoverage > THRESHOLDS.pendingRuleCoverageNeedsReview) ||
    (m.regexOverreachRisk !== undefined && m.regexOverreachRisk > THRESHOLDS.regexOverreachRiskNeedsReview);

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
    const reasons: string[] = [];
    if (isNew) reasons.push("new_query");
    if (current.prefixIncompleteCount > 0) reasons.push("prefix_incomplete");
    if (current.sourceTextUnavailableCount > 0)
      reasons.push(`source_text_unavailable x${current.sourceTextUnavailableCount}`);
    if (current.evidenceBackedCoverage < THRESHOLDS.newQueryLowEvidenceCoverage) {
      reasons.push(`low_evidence_backed_coverage (${(current.evidenceBackedCoverage * 100).toFixed(1)}%)`);
    }
    // E0-4：新 query 也检查治理阈值
    if (current.pendingRuleCoverage !== undefined && current.pendingRuleCoverage > THRESHOLDS.pendingRuleCoverageNeedsReview) {
      reasons.push(`pending_rule_coverage (${(current.pendingRuleCoverage * 100).toFixed(1)}%)`);
    }
    if (current.regexOverreachRisk !== undefined && current.regexOverreachRisk > THRESHOLDS.regexOverreachRiskNeedsReview) {
      reasons.push(`regex_overreach_risk (${(current.regexOverreachRisk * 100).toFixed(1)}%)`);
    }
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

  // E0-4：suspectMatchChars > 0 阻止 verdict 升为 ok/improvement
  const hasSuspect = current.falseReliableMatchCount > 0;

  // regression 条件
  const isRegression =
    hasSuspect ||
    ebDelta < -THRESHOLDS.evidenceBackedDropRegression ||
    unknownDelta > THRESHOLDS.unknownCharsRiseRegression ||
    attrOnlyDelta > 0.05 ||
    suspectDelta > THRESHOLDS.suspectRiseRegressionRatio;

  // improvement 条件（无 regression，且无 suspect）
  const isImprovement =
    !isRegression &&
    !hasSuspect &&
    (ebDelta > THRESHOLDS.evidenceBackedRiseImprovement ||
      unknownDelta < -THRESHOLDS.unknownCharsDropImprovement ||
      attrOnlyDelta < -THRESHOLDS.attrOnlyDropImprovementRatio);

  // needs_review 条件（E0-4 新增治理阈值触发）
  const isNeedsReview =
    current.prefixIncompleteCount > 0 ||
    current.sourceTextUnavailableCount > 0 ||
    (ebDelta > 0 && driftDelta > THRESHOLDS.driftRiseNeedsReview) ||
    (current.pendingRuleCoverage !== undefined && current.pendingRuleCoverage > THRESHOLDS.pendingRuleCoverageNeedsReview) ||
    (current.regexOverreachRisk !== undefined && current.regexOverreachRisk > THRESHOLDS.regexOverreachRiskNeedsReview);

  if (isRegression) {
    if (hasSuspect)
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
    if (current.pendingRuleCoverage !== undefined && current.pendingRuleCoverage > THRESHOLDS.pendingRuleCoverageNeedsReview)
      reasons.push(`pending_rule_coverage (${(current.pendingRuleCoverage * 100).toFixed(1)}%)`);
    if (current.regexOverreachRisk !== undefined && current.regexOverreachRisk > THRESHOLDS.regexOverreachRiskNeedsReview)
      reasons.push(`regex_overreach_risk (${(current.regexOverreachRisk * 100).toFixed(1)}%)`);
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

  if (
    current.evidenceBackedCoverage === previous.evidenceBackedCoverage &&
    current.unknownProxyChars === previous.unknownProxyChars &&
    current.suspectMatchChars === previous.suspectMatchChars
  ) {
    return { verdict: "unchanged", reasons: [] };
  }

  return { verdict: "ok", reasons: [] };
}
