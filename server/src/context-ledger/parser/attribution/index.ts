// parser/attribution：AST attribution 子系统对外出口。
//
// 内部分层：
//   types.ts          全部公共类型（RuleHit / RuleMatchEvidence / SegmentAttribution / ...）
//   rule-evaluator.ts 单 rule 在单 node 上的命中判定（事实层）
//                     —— 命名刻意区别于 parser/matcher.ts（结构切割）
//   evidence.ts       RuleHit + node + rule → 字符级证据（证据层）
//   resolver.ts       RuleHit / wire fallback / rule_gap → SegmentAttribution（语义层）
//   coverage.ts       SegmentAttribution[] → AttributionCoverage（统计层）
//
// 外部只通过本文件 import：
//   import { attributeSnapshot, computeCoverage } from ".../parser/attribution"
//   import type { SegmentAttribution, ... } from ".../parser/attribution"

import { getContextRulesForSlotId } from "../../rules/context-rule-registry";
import type { ParsedQuerySnapshot, SegmentNode } from "../types";
import { isUnknownSlotId } from "../types";
import { findFirstRuleHit } from "./rule-evaluator";
import { resolveFromHit, ruleGap, wireFallback } from "./resolver";
import type { SegmentAttribution } from "./types";

export { computeCoverage } from "./coverage";
export type {
  AttributionCoverage,
  CharRange,
  DynamicField,
  DynamicFieldSource,
  EvidenceMode,
  MaterializationEvidence,
  MaterializationKind,
  RuleHit,
  RuleHitMode,
  RuleMatchEvidence,
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
 *   1. 按 slotId 取候选 rules → findFirstRuleHit 得 RuleHit
 *   2. 命中：resolveFromHit
 *   3. 未命中：wireFallback（tool_use/tool_result/tools.builtin.*）
 *   4. 仍未命中：ruleGap（unknown slot 或显式无 rule）
 */
export function attributeSnapshot(snapshot: ParsedQuerySnapshot): SegmentAttribution[] {
  const out: SegmentAttribution[] = [];

  for (const node of flattenNodes(snapshot.roots)) {
    const rules = getContextRulesForSlotId(node.slotType);
    const hit = findFirstRuleHit(node, rules, snapshot.queryKind);

    if (hit) {
      out.push(resolveFromHit(node, hit));
      continue;
    }

    const fallback = wireFallback(node);
    if (fallback) {
      out.push(fallback);
      continue;
    }

    if (isUnknownSlotId(node.slotType)) {
      out.push(ruleGap(node, node.unknownMeta?.reason ?? "unknown slot"));
      continue;
    }

    out.push(ruleGap(node, `no context rule matched slot ${node.slotType}`));
  }

  return out;
}
