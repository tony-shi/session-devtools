// SegmentOrigin：每个 AST 节点都恰好有一个 origin，回答"这段 segment 是什么 / 从哪里来"。
//
// 设计要点：
//   - origin 是 discriminated union（单值，非组合），保证模型简单可推理。
//   - "rule 解释外壳 + jsonl 解释变量值" 这种组合性通过两个机制承担：
//       1. 树深度：外壳 vs 内容拆成父子节点。
//       2. RuleOrigin.dynamicFields[].evidence：rule 命中后，每个动态字段单独标注值的出处。
//   - Evidence 是轻量 hint，不是另一层 origin —— 它没有 confidence、不会递归，只回答
//     "这一段 char range 的值从哪儿来"。
//   - 不再使用 "wire_schema" 这种伪 mechanism：wire 结构由 jsonl 推导的就是 JsonlOrigin，
//     由 rule 描述的就是 RuleOrigin，无内容解释的就是 StructuralOrigin。

import type { Confidence } from "../../types";
import type { DynamicField as RuleDynamicField } from "./types";

// ─── DynamicField + Evidence ─────────────────────────────────────────────────

/**
 * Evidence：一个 char range 的值出处。
 *
 * 不是 Origin —— Evidence 只解释"值"，不解释"形态"。形态由所在节点的 origin 决定。
 * 因此 Evidence 没有 confidence、没有 dynamicFields、不递归。
 */
export type Evidence =
  | { kind: "jsonl"; jsonlLineIdx: number; sourceCallId?: number; sourceTurnId?: number; eventKind?: string }
  | { kind: "runtime"; key: string }                              // cwd / shell / model / git.branch / ...
  | { kind: "file"; path: string; section?: string }              // CLAUDE.md 等仓库内文件
  | { kind: "memory"; memoryFile: string; memoryName?: string }   // ~/.claude/memory/*.md
  | { kind: "unknown" };

/**
 * DynamicField：rule 命中后，regex 命名捕获组对应的动态字段。
 *
 * 复用 rule-evaluator 的 DynamicField 形状（保持兼容），额外允许带 evidence。
 * Evidence 在 rule-evaluator 阶段为空；后续 jsonl-linker / evidence-attacher
 * 可基于字段名 + 内容做反向追溯填入。
 */
export interface DynamicFieldWithEvidence extends RuleDynamicField {
  evidence?: Evidence;
}

// ─── SegmentOrigin discriminated union ──────────────────────────────────────

/**
 * RuleOrigin：节点形态由先验规则解释。
 *
 * 例子：
 *   - <system-reminder>...</system-reminder> 块（外壳由 rule 解释）
 *   - 系统 prompt 的 identity / doing-tasks / actions 等静态段
 *   - environment section（含 cwd/gitBranch 动态字段，evidence=runtime）
 */
export interface RuleOrigin {
  kind: "rule";
  ruleId: string;
  matchMode: "exact" | "regex" | "prefix";
  confidence: Confidence;
  dynamicFields?: DynamicFieldWithEvidence[];
}

/**
 * JsonlOrigin：节点形态 + 内容由一条 JSONL 事件直接产生。
 *
 * 用于 tool_use / tool_result（by id 精确匹配）以及 user_input / assistant_text
 * （由 jsonl-linker 用 message 内容 + 位置匹配）。
 *
 * confidence:
 *   - "definitive"  — id 精确匹配（tool_use_id）或内容 byte-equal
 *   - "estimated"   — 仅内容相似（截断 / 规范化后相等）
 *   - "inferred"    — 仅按位置 + 角色推断
 */
export interface JsonlOrigin {
  kind: "jsonl";
  eventKind: JsonlEventKind;
  jsonlLineIdx: number;
  sourceCallId?: number;
  sourceTurnId?: number;
  toolUseId?: string;
  confidence: Confidence;
}

export type JsonlEventKind =
  | "user_input"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "system_local_command"
  | "stop_hook"
  | "away_summary"
  | "attachment"
  | "unknown";

/**
 * StructuralOrigin：节点的结构身份已知，但内容没有被规则或 jsonl 解释。
 *
 * 两种 reason:
 *   - "container_node"   — 非叶子节点。父节点不直接归因；解释在其叶子。
 *   - "no_rule_matched"  — 叶子节点，槽位已知（slotId 有效），但无 rule 命中且无 jsonl 匹配。
 */
export interface StructuralOrigin {
  kind: "structural";
  slotId: string;
  reason: "container_node" | "no_rule_matched";
}

/**
 * UnknownOrigin：完全不识别 —— 既不在 template 已知 slot 范围内，又无 rule / jsonl 命中。
 *
 * 用于 matcher 产出的 unknown fallback 节点（system.block.unknown 等）。
 */
export interface UnknownOrigin {
  kind: "unknown";
  reason: string;
}

export type SegmentOrigin = RuleOrigin | JsonlOrigin | StructuralOrigin | UnknownOrigin;

// ─── Factory helpers ─────────────────────────────────────────────────────────

export function originContainer(slotId: string): StructuralOrigin {
  return { kind: "structural", slotId, reason: "container_node" };
}

export function originStructural(slotId: string): StructuralOrigin {
  return { kind: "structural", slotId, reason: "no_rule_matched" };
}

export function originUnknown(reason: string): UnknownOrigin {
  return { kind: "unknown", reason };
}
