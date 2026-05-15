// parser/audit/forward：正向归因覆盖度统计。
//
// 心智模型：proxy 是 ground truth；以 SegmentNode AST 的叶子集合为统计单位，
//   按 coverageStateOf(origin) 分到三桶：
//     full    — rule / jsonl origin 且 fullyCovered=true（解释充分）
//     partial — rule / jsonl origin 但 fullyCovered=false（动态注入未覆盖 / 内容近似）
//     none    — structural / unknown origin（无 rule 无 jsonl）
//
// 设计原则（严格 v1）：
//   - 主轴是 coverage 三态，次轴是细分（origin.kind / partial reason / none kind）。
//   - 不引入 confidence / mechanism / 阈值；只有计数和 segmentId 列表。
//   - 输出可直接喂给前端 filter + badge，无需进一步派生。

import type { ParsedQuerySnapshot, SegmentNode } from "../types";
import { coverageStateOf, type CoverageState } from "../attribution/origin";

// ─── 输出类型 ────────────────────────────────────────────────────────────────

export interface ForwardAudit {
  totals: {
    leafCount: number;
    full: number;
    partial: number;
    none: number;
  };
  full: {
    segmentIds: string[];
    /** 按 origin.kind 拆分：哪些是 rule 解释的，哪些是 jsonl 解释的。 */
    byOrigin: {
      rule: string[];
      jsonl: string[];
    };
  };
  partial: {
    segmentIds: string[];
    /** 按 partial 原因聚合（reason → segmentIds）。这是规则改进的 todo 队列。 */
    byReason: Record<PartialReason, string[]>;
  };
  none: {
    segmentIds: string[];
    byKind: {
      /** template 切到了 slot 但无 rule、无 jsonl。 */
      structural_no_rule: string[];
      /** template 也未识别（system.block.unknown 等 fallback）。 */
      unknown: string[];
    };
  };
}

/**
 * Partial reason 枚举。命名约定 "<origin.kind>.<sub>.<detail>"：
 *
 *   rule.regex.partial_match       — regex 只命中 rawText 子串
 *   rule.prefix.anchor_only        — prefix 锚点命中但未解释整段
 *   jsonl.user_input.inferred      — 仅按 turn 回退、未做内容核对
 *   jsonl.assistant_text.substring — jsonl 文本包含 node（estimated）
 *   jsonl.attachment.fingerprint   — SR 子段 attachment 仅匹配片段
 */
export type PartialReason =
  | "rule.regex.partial_match"
  | "rule.prefix.anchor_only"
  | "jsonl.user_input.inferred"
  | "jsonl.assistant_text.substring"
  | "jsonl.attachment.fingerprint"
  | "rule.unknown"
  | "jsonl.unknown";

// ─── 实现 ────────────────────────────────────────────────────────────────────

function isLeaf(node: SegmentNode): boolean {
  return node.children.length === 0;
}

function partialReason(node: SegmentNode): PartialReason {
  const origin = node.origin;
  if (origin.kind === "rule") {
    if (origin.matchMode === "regex") return "rule.regex.partial_match";
    if (origin.matchMode === "prefix") return "rule.prefix.anchor_only";
    return "rule.unknown";
  }
  if (origin.kind === "jsonl") {
    if (origin.eventKind === "user_input") return "jsonl.user_input.inferred";
    if (origin.eventKind === "assistant_text") return "jsonl.assistant_text.substring";
    if (origin.eventKind === "attachment") return "jsonl.attachment.fingerprint";
    return "jsonl.unknown";
  }
  // structural / unknown 不会进 partial 桶。
  return "rule.unknown";
}

function emptyByReason(): Record<PartialReason, string[]> {
  return {
    "rule.regex.partial_match": [],
    "rule.prefix.anchor_only": [],
    "jsonl.user_input.inferred": [],
    "jsonl.assistant_text.substring": [],
    "jsonl.attachment.fingerprint": [],
    "rule.unknown": [],
    "jsonl.unknown": [],
  };
}

/**
 * computeForwardAudit：单次遍历 snapshot.index，对所有叶子节点做覆盖度桶计数。
 *
 * 复杂度：O(n)，n = node 总数。
 */
export function computeForwardAudit(snapshot: ParsedQuerySnapshot): ForwardAudit {
  const audit: ForwardAudit = {
    totals: { leafCount: 0, full: 0, partial: 0, none: 0 },
    full: { segmentIds: [], byOrigin: { rule: [], jsonl: [] } },
    partial: { segmentIds: [], byReason: emptyByReason() },
    none: { segmentIds: [], byKind: { structural_no_rule: [], unknown: [] } },
  };

  for (const node of Object.values(snapshot.index)) {
    if (!isLeaf(node)) continue;
    audit.totals.leafCount += 1;

    const state: CoverageState = coverageStateOf(node.origin);
    if (state === "full") {
      audit.totals.full += 1;
      audit.full.segmentIds.push(node.id);
      if (node.origin.kind === "rule") {
        audit.full.byOrigin.rule.push(node.id);
      } else if (node.origin.kind === "jsonl") {
        audit.full.byOrigin.jsonl.push(node.id);
      }
      continue;
    }
    if (state === "partial") {
      audit.totals.partial += 1;
      audit.partial.segmentIds.push(node.id);
      audit.partial.byReason[partialReason(node)].push(node.id);
      continue;
    }
    // none
    audit.totals.none += 1;
    audit.none.segmentIds.push(node.id);
    if (node.origin.kind === "unknown") {
      audit.none.byKind.unknown.push(node.id);
    } else {
      // structural（leaf 且 no_rule_matched）
      audit.none.byKind.structural_no_rule.push(node.id);
    }
  }

  return audit;
}
