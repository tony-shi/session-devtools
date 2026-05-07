// parser/attribution/rule-evaluator：单 ContextRule 在单 AST node 上的命中判定。
//
// 命名取 "evaluator" 而非 "matcher"——后者已被 parser/matcher.ts（结构切割）占用，
// 把"评估一条 rule 是否命中"和"切片"两件事在文件名层面就分清。
//
// 模块职责（事实层，不解释来源）：
//   - 对单条 rule 做 pattern match，遵守 rule.queryScope。
//   - 命中时回填 nodeId/slotId/ruleId 与命中区间，便于 evidence/resolver 直接消费。
//   - 不算 confidence、不做 wire_schema fallback、不写 unknown/rule_gap——那是 resolver 的职责。
//   - 不读 rule.materialization / verifiedFor / confidenceOverride。
//
// 接口刻意保持很窄：
//   evaluateRuleForNode(node, rule, queryKind)：单 rule 是否命中
//   findFirstRuleHit(node, rules, queryKind)：候选集里取首个命中（registry 顺序即优先级）

import type { ContextRule } from "../../rules/context-rule-registry";
import type { SegmentNode } from "../types";
import type { CharRange, RuleHit, RuleHitMode } from "./types";

// ContextRule.attribution.matchMode 已被归一化（structural→prefix）成下面四种。
function modeOf(rule: ContextRule): RuleHitMode {
  return rule.attribution.matchMode as RuleHitMode;
}

function buildGroupIndices(
  groupIndices: Record<string, [number, number] | undefined> | null | undefined,
): Record<string, CharRange | undefined> | undefined {
  if (!groupIndices) return undefined;
  const out: Record<string, CharRange | undefined> = {};
  for (const [name, range] of Object.entries(groupIndices)) {
    out[name] = range ? { start: range[0], end: range[1] } : undefined;
  }
  return out;
}

/**
 * evaluateRuleForNode：判定一条 rule 是否命中 node。
 *
 * 命中语义：
 *   exact      text === pattern；matchedRange = [0, text.length)
 *   regex      `new RegExp(pattern, "sd").exec(text)` 命中；matchedRange = m.indices[0]
 *   contains   text.includes(pattern)；matchedRange = [idx, idx+pattern.length)
 *   prefix     text.trimStart().startsWith(pattern)；matchedRange = [trimmedStart, trimmedStart+pattern.length)
 *
 * 不命中或 queryScope 不符返回 null。
 */
export function evaluateRuleForNode(
  node: SegmentNode,
  rule: ContextRule,
  queryKind: string,
): RuleHit | null {
  if (rule.queryScope && rule.queryScope !== "any" && queryKind !== rule.queryScope) {
    return null;
  }

  const { pattern, matchMode } = rule.attribution;
  if (pattern === null) return null;

  const text = node.rawText;
  const mode = modeOf(rule);

  if (matchMode === "regex") {
    // d flag 开启 indices，用于命名捕获组偏移与 matchedRange 计算。
    const m = new RegExp(pattern, "sd").exec(text);
    if (!m) return null;
    const overall = m.indices?.[0];
    const start = overall?.[0] ?? m.index ?? 0;
    const end = overall?.[1] ?? start + m[0].length;
    return {
      nodeId: node.id,
      slotId: node.slotType,
      ruleId: rule.ruleId,
      mode,
      matchedRange: { start, end },
      matchedChars: Math.max(0, end - start),
      groups: (m.groups ?? {}) as Record<string, string | undefined>,
      groupIndices: buildGroupIndices(m.indices?.groups as Record<string, [number, number] | undefined> | undefined),
    };
  }

  if (matchMode === "exact") {
    if (text !== pattern) return null;
    return {
      nodeId: node.id,
      slotId: node.slotType,
      ruleId: rule.ruleId,
      mode,
      matchedRange: { start: 0, end: text.length },
      matchedChars: text.length,
    };
  }

  if (matchMode === "contains") {
    if (!text.includes(pattern)) return null;
    const idx = text.indexOf(pattern);
    return {
      nodeId: node.id,
      slotId: node.slotType,
      ruleId: rule.ruleId,
      mode,
      matchedRange: { start: idx, end: idx + pattern.length },
      matchedChars: pattern.length,
    };
  }

  // prefix（含 ContextRule 把 structural 归一化的结构兜底规则）。
  // 空 pattern 是结构兜底，命中即视作"slot 锚点存在但无可解释内容"。
  if (!text.trimStart().startsWith(pattern)) return null;
  const trimmedLeading = text.length - text.trimStart().length;
  return {
    nodeId: node.id,
    slotId: node.slotType,
    ruleId: rule.ruleId,
    mode,
    matchedRange: { start: trimmedLeading, end: trimmedLeading + pattern.length },
    matchedChars: pattern.length,
  };
}

/**
 * findFirstRuleHit：在候选 rule 集里取首个命中。
 *
 * candidate 顺序由 rule registry 控制（实体 rule 在前，结构兜底在后），
 * 这里不重排，保持 registry 的优先级语义。
 */
export function findFirstRuleHit(
  node: SegmentNode,
  rules: ContextRule[],
  queryKind: string,
): RuleHit | null {
  for (const rule of rules) {
    const hit = evaluateRuleForNode(node, rule, queryKind);
    if (hit) return hit;
  }
  return null;
}
