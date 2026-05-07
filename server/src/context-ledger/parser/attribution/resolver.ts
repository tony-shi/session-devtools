// parser/attribution/resolver：RuleEvaluation / wire fallback / rule_gap → SegmentAttribution。
//
// 模块职责：
//   - 把 rule-evaluator 的命中结果升级为最终 SegmentAttribution。
//   - 推导单一 confidence 与 reconstructable。
//   - 处理 verifiedFor 降级、wire_schema fallback、rule_gap。
//   - 不渲染 notes；notesTemplate 留给 audit/view 层按 dynamicFields 派生展示。

import type { Confidence } from "../../types";
import { SUPPORTED_CLAUDE_CODE_VERSION } from "../../rules/context-rule-registry";
import type { ContextRule } from "../../rules/context-rule-registry";
import type { SegmentNode } from "../types";
import type { RuleEvaluation } from "./rule-evaluator";
import type {
  AttributionMatchMode,
  CharCoverage,
  CharRange,
  SegmentAttribution,
} from "./types";

function fullRange(node: SegmentNode): CharRange | undefined {
  return node.rawText.length > 0 ? { start: 0, end: node.rawText.length } : undefined;
}

function fullLiteralCoverage(node: SegmentNode): CharCoverage {
  const rawChars = node.rawText.length;
  return {
    rawChars,
    matchedChars: rawChars,
    literalChars: rawChars,
    dynamicChars: 0,
    unmatchedChars: 0,
  };
}

function ruleGapCoverage(node: SegmentNode): CharCoverage {
  const rawChars = node.rawText.length;
  return {
    rawChars,
    matchedChars: 0,
    literalChars: 0,
    dynamicChars: 0,
    unmatchedChars: rawChars,
  };
}

function reconstructableFromRule(rule: ContextRule): boolean {
  return rule.materialization === "exact_text";
}

function deriveConfidence(rule: ContextRule, evaluation: RuleEvaluation): Confidence {
  let confidence: Confidence;

  if (evaluation.matchMode === "exact") {
    confidence = "exact";
  } else if (evaluation.matchMode === "regex") {
    confidence = evaluation.dynamicFields?.length ? "exact" : "estimated";
  } else {
    confidence = "estimated";
  }

  if (rule.attribution.confidenceOverride) {
    confidence = rule.attribution.confidenceOverride;
  }

  // 未校对 rule：confidence 强制降级，避免未验证规则抬高 audit 结论。
  if (rule.verifiedFor !== SUPPORTED_CLAUDE_CODE_VERSION) {
    confidence = "inferred";
  }

  return confidence;
}

// ── rule 命中 ────────────────────────────────────────────────────────────────

export function resolveFromEvaluation(
  node: SegmentNode,
  evaluation: RuleEvaluation,
): SegmentAttribution {
  const { rule } = evaluation;

  return {
    nodeId: node.id,
    slotId: node.slotType,
    category: rule.attribution.category,
    mechanism: rule.attribution.mechanism,
    ruleId: rule.ruleId,
    matchMode: evaluation.matchMode,
    matchedRange: evaluation.matchedRange,
    charCoverage: evaluation.charCoverage,
    ...(evaluation.dynamicFields ? { dynamicFields: evaluation.dynamicFields } : {}),
    reconstructable: reconstructableFromRule(rule),
    confidence: deriveConfidence(rule, evaluation),
  };
}

// ── wire-schema fallback ─────────────────────────────────────────────────────

function wireAttribution(
  node: SegmentNode,
  category: SegmentAttribution["category"],
  matchMode: Exclude<AttributionMatchMode, "regex" | "prefix" | "rule_gap"> = "exact",
): SegmentAttribution {
  return {
    nodeId: node.id,
    slotId: node.slotType,
    category,
    mechanism: "wire_schema",
    matchMode,
    ...(fullRange(node) ? { matchedRange: fullRange(node) } : {}),
    charCoverage: fullLiteralCoverage(node),
    reconstructable: true,
    confidence: "exact",
  };
}

export function wireFallback(node: SegmentNode): SegmentAttribution | null {
  if (node.slotType === "messages.tool_use") {
    return wireAttribution(node, "tool_use");
  }

  if (node.slotType === "messages.tool_result") {
    return wireAttribution(node, "tool_result");
  }

  if (node.slotType.startsWith("tools.builtin.")) {
    return wireAttribution(node, "tools_schema");
  }

  return null;
}

// ── rule_gap ────────────────────────────────────────────────────────────────

export function ruleGap(node: SegmentNode): SegmentAttribution {
  return {
    nodeId: node.id,
    slotId: node.slotType,
    category: "unknown",
    mechanism: "rule_gap",
    matchMode: "rule_gap",
    charCoverage: ruleGapCoverage(node),
    reconstructable: false,
    confidence: "unknown",
  };
}
