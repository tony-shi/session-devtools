// parser/attribution：AST attribution 子系统对外出口。
//
// 当前分层：
//   types.ts           最终公共产物类型（SegmentAttribution / CharCoverage / AttributionCoverage）
//   rule-evaluator.ts  单 rule 在单 node 上执行 pattern，直接产出字符桶和动态字段
//   resolver.ts        RuleEvaluation / wire fallback / rule_gap → SegmentAttribution
//   coverage.ts        SegmentAttribution[] → AttributionCoverage

import { getContextRulesForSlotId } from "../../rules/context-rule-registry";
import type { ParsedQuerySnapshot, SegmentNode } from "../types";
import { findFirstRuleEvaluation } from "./rule-evaluator";
import { resolveFromEvaluation, wireFallback, projectStructuralOriginAsAttribution } from "./resolver";
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
 * attributeSnapshot：对 ParsedQuerySnapshot 的每个叶子节点尝试归因。
 *
 * 双重输出：
 *   - 权威：在 node.origin 上原地写入归因结果（RuleOrigin / 不写则保留 PR 1 默认）
 *   - 兼容：返回 SegmentAttribution[]，供尚未迁移到 origin 的 audit / parser-view 使用
 *
 * Container 节点跳过（PR 1 已经填了 origin=structural/container_node）。
 *
 * 流程（仅作用于叶子）：
 *   1. 按 slotId 取候选 rules → findFirstRuleEvaluation（含 cc_version 过滤 appliesTo）
 *   2. 命中：resolveFromEvaluation（写 RuleOrigin + 投影 SegmentAttribution）
 *   3. 未命中：wireFallback（tool_use/tool_result/tools.builtin.* → 合成 wire RuleOrigin）
 *   4. 仍未命中：不动 origin（保留 PR 1 的 structural/unknown 默认），projection 输出 rule_gap
 *
 * snapshot.attributionContext 失败状态（billing-noise 未命中 system[0]）：跳过所有 rule
 * 评估，但仍保留 wire fallback（tool_use/tool_result/wire schema 不依赖 cc_version）。
 * 叶子保持 structural 默认，让上层 UI/audit 可识别"归因失败"信号。
 */
export function attributeSnapshot(snapshot: ParsedQuerySnapshot): SegmentAttribution[] {
  const out: SegmentAttribution[] = [];
  const ctxOk = snapshot.attributionContext.ok;
  const ccVersion = ctxOk ? snapshot.attributionContext.ctx.ccVersion : undefined;

  for (const node of flattenNodes(snapshot.roots)) {
    // container 节点：默认 origin 是 structural/container_node，不参与 rule 命中。
    // 例外：wire-schema 节点（tool_use/tool_result/tools.builtin.*）即便有 children
    // 也应保留 wire origin —— 它们的协议含义来自 wire schema，children 是 wire 之下的
    // 内容切分（如 tool_result 尾部 smoosh 段），不影响父节点的协议归因。
    // 注意：container 节点只**原地**写 origin，不向 SegmentAttribution[] 输出条目，
    // 保留"叶子数 = attrs 数"的现有不变量。
    if (node.children.length > 0) {
      wireFallback(node); // 副作用：写 node.origin = wire origin（仅当 slotType 命中）
      continue;
    }

    if (ctxOk) {
      const rules = getContextRulesForSlotId(node.slotType);
      const evaluation = findFirstRuleEvaluation(node, rules, snapshot.queryKind, ccVersion);

      if (evaluation) {
        out.push(resolveFromEvaluation(node, evaluation, ccVersion));
        continue;
      }
    }
    // ctx 失败时直接跳过 rule 评估，进入 wire fallback / rule_gap 分支。

    const fallback = wireFallback(node);
    if (fallback) {
      out.push(fallback);
      continue;
    }

    // 没有 rule 命中、也不是 wire fallback：节点 origin 保留 PR 1 默认值。
    // 投影一条 rule_gap SegmentAttribution 让 audit/view 知道这里有缺口。
    out.push(projectStructuralOriginAsAttribution(node));
  }

  return out;
}
