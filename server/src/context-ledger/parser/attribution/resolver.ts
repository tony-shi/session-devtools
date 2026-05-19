// parser/attribution/resolver：RuleEvaluation / wire fallback / rule_gap → SegmentAttribution。
//
// 模块职责：
//   - 把 rule-evaluator 的命中结果升级为最终 SegmentAttribution。
//   - 推导单一 confidence 与 reconstructable。
//   - 处理 verifiedFor 降级、wire_schema fallback、rule_gap。
//   - 不渲染 notes；notesTemplate 留给 audit/view 层按 dynamicFields 派生展示。

import type { Confidence, SegmentCategory } from "../../types";
import { SUPPORTED_CLAUDE_CODE_VERSION } from "../../rules/context-rule-registry";
import type { ContextRule } from "../../rules/context-rule-registry";
import { parseSkillListingBody } from "../../rules/skill-listing-parser";
import type { SegmentNode } from "../types";
import type { RuleEvaluation } from "./rule-evaluator";
import type { RuleOrigin, DynamicFieldWithEvidence } from "./origin";
import type {
  AttributionMatchMode,
  CharCoverage,
  CharRange,
  SegmentAttribution,
  SegmentAttributionPayload,
} from "./types";

// rule-specific 二次解析的 ruleId 白名单 + 派发逻辑
// 命中这些 rule 时，resolver 调用对应 parser、把结构化结果挂到 SegmentAttribution.payload。
// 其他 rule 命中时 payload 缺省，行为不变。
const SKILL_LISTING_RULE_ID = "claude-code.messages.skill-listing.v1";

function buildPayload(
  rule: ContextRule,
  evaluation: RuleEvaluation,
  node: SegmentNode,
): SegmentAttributionPayload | undefined {
  if (rule.ruleId !== SKILL_LISTING_RULE_ID) return undefined;

  // 取 (?<skillsBlock>...) 的捕获值与 segment 内偏移。
  // 缺失任何一个都返回 undefined（rule 命中但 group 缺失，理论不会发生；防御性）。
  const block = evaluation.dynamicFields?.find(f => f.name === "skillsBlock");
  if (!block) return undefined;

  const body = node.rawText.slice(block.charStart, block.charEnd);
  return {
    skillListing: parseSkillListingBody(body, block.charStart),
  };
}

function fullRange(node: SegmentNode): CharRange | undefined {
  return node.rawText.length > 0 ? { start: 0, end: node.rawText.length } : undefined;
}

function fullLiteralCoverage(node: SegmentNode): CharCoverage {
  const rawChars = node.rawText.length;
  return {
    rawChars,
    matchedChars: rawChars,
    staticChars: rawChars,
    dynamicChars: 0,
    unmatchedChars: 0,
  };
}

function ruleGapCoverage(node: SegmentNode): CharCoverage {
  const rawChars = node.rawText.length;
  return {
    rawChars,
    matchedChars: 0,
    staticChars: 0,
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
    confidence = "definitive";
  } else if (evaluation.matchMode === "regex") {
    confidence = evaluation.dynamicFields?.length ? "definitive" : "estimated";
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

/**
 * 把 rule evaluation 投射到节点上：写入 node.origin（RuleOrigin），并产出 backward-compatible
 * 的 SegmentAttribution。两个返回路径表达同一个事实，新模型以 node.origin 为权威，
 * SegmentAttribution[] 仅用于尚未迁移的 audit / parser-view 调用方。
 */
export function resolveFromEvaluation(
  node: SegmentNode,
  evaluation: RuleEvaluation,
): SegmentAttribution {
  const { rule } = evaluation;
  const confidence = deriveConfidence(rule, evaluation);

  // —— 新模型：写入 node.origin —— //
  // fullyCovered：严格 v1。matchedChars 必须等于 rawChars 才算 full；
  // regex 子串、prefix 锚点匹配天然 partial。
  const cov = evaluation.charCoverage;
  const fullyCovered = cov.rawChars > 0 && cov.matchedChars === cov.rawChars;
  const payload = buildPayload(rule, evaluation, node);
  const origin: RuleOrigin = {
    kind: "rule",
    ruleId: rule.ruleId,
    matchMode: evaluation.matchMode,
    confidence,
    fullyCovered,
    ...(evaluation.dynamicFields ? { dynamicFields: evaluation.dynamicFields as DynamicFieldWithEvidence[] } : {}),
    ...(payload ? { payload } : {}),
  };
  node.origin = origin;

  // —— 旧模型投影：保持 audit/parser-view 等调用方可继续工作 —— //
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
    ...(payload ? { payload } : {}),
    reconstructable: reconstructableFromRule(rule),
    confidence,
  };
}

// ── wire-schema fallback ─────────────────────────────────────────────────────
// wire 协议本身就是一种"先验规则"：tool_use / tool_result / tools.builtin.* 的结构
// 由 Anthropic 协议固定，因此在新模型里同样表达为 RuleOrigin（带合成 ruleId "wire.*"）。
// PR 3 的 jsonl-linker 会用真实的 jsonl 事件把这些 origin 升级为 JsonlOrigin。

function wireAttribution(
  node: SegmentNode,
  category: SegmentCategory,
  wireRuleId: string,
): SegmentAttribution {
  // —— 新模型：写合成 wire rule origin —— //
  // wire 协议是原子单元（整段 tool_use / tool_result / tools.builtin schema 由协议解释），fullyCovered=true。
  node.origin = {
    kind: "rule",
    ruleId: wireRuleId,
    matchMode: "exact",
    confidence: "definitive",
    fullyCovered: true,
  };

  // —— 旧模型投影 —— //
  return {
    nodeId: node.id,
    slotId: node.slotType,
    category,
    mechanism: "wire_schema",
    matchMode: "exact",
    ...(fullRange(node) ? { matchedRange: fullRange(node) } : {}),
    charCoverage: fullLiteralCoverage(node),
    reconstructable: true,
    confidence: "definitive",
  };
}

export function wireFallback(node: SegmentNode): SegmentAttribution | null {
  if (node.slotType === "messages.tool_use") {
    return wireAttribution(node, "tool_use", "wire.messages.tool_use");
  }

  if (node.slotType === "messages.tool_result") {
    return wireAttribution(node, "tool_result", "wire.messages.tool_result");
  }

  if (node.slotType === "messages.thinking") {
    // thinking / redacted_thinking 块：wire 协议本身就把 signature 当作原子单元 —— 整段
    // 内容（可能空字符串）由协议唯一定义，等同 tool_use / tool_result 的处理。
    // jsonl-linker 之后可能用 signature 把此 origin 升级为 JsonlOrigin（同样 definitive）。
    return wireAttribution(node, "thinking", "wire.messages.thinking");
  }

  if (node.slotType.startsWith("tools.builtin.")) {
    return wireAttribution(node, "tools_schema", "wire.tools.builtin");
  }

  return null;
}

// ── rule_gap projection ─────────────────────────────────────────────────────
// 不再写 origin —— 节点保留 PR 1 默认值（structural/no_rule_matched 或 unknown）。
// 这里只为 backward compat 输出一条 SegmentAttribution，供旧 audit/view 使用。

export function projectStructuralOriginAsAttribution(node: SegmentNode): SegmentAttribution {
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
