// parser/attribution：AST attribution 子系统对外出口。
//
// 当前分层：
//   types.ts           最终公共产物类型（SegmentAttribution / CharCoverage / AttributionCoverage）
//   rule-evaluator.ts  单 rule 在单 node 上执行 pattern，直接产出字符桶和动态字段
//   resolver.ts        RuleEvaluation / wire fallback / rule_gap → SegmentAttribution
//   coverage.ts        SegmentAttribution[] → AttributionCoverage

import { getContextRulesForSlotId } from "../../rules/context-rule-registry";
import type { ParsedQuerySnapshot, SegmentNode } from "../types";
import { isUnknownSlotId } from "../types";
import { findFirstRuleEvaluation } from "./rule-evaluator";
import { resolveFromEvaluation, ruleGap, wireFallback } from "./resolver";
import type { SegmentAttribution } from "./types";

export { computeCoverage } from "./coverage";
export type {
  AttributionCoverage,
  AttributionMatchMode,
  CharCoverage,
  CharRange,
  DynamicField,
  DynamicFieldSource,
  SegmentAttribution,
} from "./types";

function flattenNodes(roots: SegmentNode[]): SegmentNode[] {
  const out: SegmentNode[] = [];
  function visit(node: SegmentNode): void {
    out.push(node);
    for (const child of node.children) visit(child);
  }
  for (const root of roots) visit(root);
  return out;
}

/**
 * attributeSnapshot：对 ParsedQuerySnapshot 的每个节点产生一条 SegmentAttribution。
 *
 * 流程：
 *   1. 按 slotId 取候选 rules → findFirstRuleEvaluation
 *   2. 命中：resolveFromEvaluation
 *   3. 未命中：wireFallback（tool_use/tool_result/tools.builtin.*）
 *   4. 仍未命中：ruleGap（unknown slot 或显式无 rule）
 */
export function attributeSnapshot(snapshot: ParsedQuerySnapshot): SegmentAttribution[] {
  const out: SegmentAttribution[] = [];

  for (const node of flattenNodes(snapshot.roots)) {
    const rules = getContextRulesForSlotId(node.slotType);
    const evaluation = findFirstRuleEvaluation(node, rules, snapshot.queryKind);

    if (evaluation) {
      out.push(resolveFromEvaluation(node, evaluation));
      continue;
    }

    const fallback = wireFallback(node);
    if (fallback) {
      out.push(fallback);
      continue;
    }

    if (isUnknownSlotId(node.slotType)) {
      out.push(ruleGap(node));
      continue;
    }

    out.push(ruleGap(node));
  }

  return out;
}
