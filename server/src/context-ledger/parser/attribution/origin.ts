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
  /**
   * 是否完整覆盖叶子节点 rawText。严格 v1：
   *   - exact / structural 全段匹配 → true
   *   - regex 命中整段（matchedChars === rawChars） → true
   *   - 其他（regex 子串命中、prefix 锚点、wire fallback 之外的部分匹配） → false
   *
   * Audit 用这个标志区分 "解释充分" vs "解释不足（动态注入未覆盖）"。
   */
  fullyCovered: boolean;
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
  /**
   * 是否完整覆盖叶子节点 rawText。严格 v1：
   *   - tool_use / tool_result id 精确匹配 → true（wire 原子单元）
   *   - user_input / assistant_text 内容相等（definitive） → true
   *   - 其他（inferred turn 回退、substring 命中、SR 子段 fingerprint 部分匹配） → false
   */
  fullyCovered: boolean;
  /**
   * 当 eventKind.source === "harness_injection" 时携带的双轴子分类。
   *
   *   mechanism — 触发 harness 注入的具体子系统（哪个 Claude Code 模块在合成）
   *   payload   — 注入到 wire 的载荷形态（合成出来的内容是什么）
   *
   * 两轴正交：将来加入新的 harness 注入路径（如 mcp_tool_doc / subagent_handoff）
   * 时，只扩这两个枚举的取值，不动 source 轴 —— authorship/dynamic 这两层语义
   * 已经由 source 表达。
   */
  harness?: HarnessOriginDetail;
}

/** harness 注入路径的子分类。authorship 已由外层 source 表达，这里只描述 how / what。 */
export interface HarnessOriginDetail {
  /**
   * 触发机制：哪个 Claude Code 子系统注入的。
   *
   *   skill_invocation     — assistant.tool_use(Skill) 触发 SkillTool 加载 SKILL.md
   *   compaction_summary   — auto/manual compaction 把 N 轮对话压成 summary 注入下条
   */
  mechanism: "skill_invocation" | "compaction_summary";
  /**
   * 注入载荷：合成出来的内容形态。
   *
   *   skill_md_body         — Skill 文件体（含可选 "Base directory for this skill:" 前缀）
   *   conversation_summary  — "This session is being continued from a previous conversation..." 体
   */
  payload: "skill_md_body" | "conversation_summary";
}

/**
 * JsonlEventKind：结构化对象，描述 JSONL 事件的"来源 × 内容类型"二维分类。
 *
 *   source       — 事件大类（user_input / assistant_text / tool_use / ...）
 *   contentType  — 同一 source 下的 block 子类型（text / image / ...）。省略 = "text"。
 *
 * 设计动机：JSONL 里 user 事件的 message.content[] 可以同时包含 text 和 image
 * block，它们都来自同一条 user 事件。用 (source, contentType) 笛卡尔积表达
 * 比扁平字面量（user_input vs user_image）更准确，也避免给同一来源拆出多个 source 值。
 *
 * 兼容策略：构造方仅设 source、不设 contentType 时，语义等价于 contentType="text"
 * （由 `getContentType()` helper 兜底）。
 */
export type JsonlEventSource =
  | "user_input"
  | "assistant_text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "system_local_command"
  | "stop_hook"
  | "away_summary"
  | "attachment"
  /**
   * harness_injection：Claude Code 合成出来、占用 user 位置但不来自人类的文本。
   *
   * 与 user_input / assistant_text / tool_result 同为 authorship 轴上的一类：
   * **harness-authored**（区别于 human / assistant / tool-protocol）。具体由哪
   * 个子系统、注入的载荷形态，由 JsonlOrigin.harness 子结构的 mechanism × payload
   * 两轴表达。
   *
   * 当前覆盖（mechanism × payload）：
   *
   *   skill_invocation × skill_md_body
   *     —— assistant 发 Skill tool_use → SkillTool 加载 SKILL.md → 拼到下一条
   *     user message 末尾（jsonl 里这条 user event 是 isMeta=true text）。
   *     sourcemap：restored-src/src/tools/SkillTool/SkillTool.ts:1076
   *              + restored-src/src/skills/loadSkillsDir.ts:346
   *              + restored-src/src/utils/plugins/loadPluginCommands.ts:329
   *
   *   compaction_summary × conversation_summary
   *     —— auto/manual compaction 把先前的对话压成 summary 注入到下条 user
   *     message（jsonl 里这条 user event 是 isCompactSummary=true）。
   *     sourcemap：restored-src/src/services/compact/prompt.ts:345 (getCompactUserSummaryMessage)
   *              + restored-src/src/services/compact/compact.ts:614-624
   */
  | "harness_injection"
  | "unknown";

export type JsonlEventContentType = "text" | "image";

export interface JsonlEventKind {
  source: JsonlEventSource;
  contentType?: JsonlEventContentType;
}

/** 返回 kind.contentType，省略时兜底 "text"。 */
export function getContentType(kind: JsonlEventKind): JsonlEventContentType {
  return kind.contentType ?? "text";
}

/** 便捷构造：source-only kind（contentType 缺省 = text）。 */
export function eventKindOf(source: JsonlEventSource, contentType?: JsonlEventContentType): JsonlEventKind {
  return contentType ? { source, contentType } : { source };
}

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

// ─── Coverage 派生 ───────────────────────────────────────────────────────────

/**
 * CoverageState：叶子节点的归因覆盖完整性。Audit 三桶的主轴。
 *
 *   - "full"    rule 或 jsonl origin，且 fullyCovered=true
 *   - "partial" rule 或 jsonl origin，但 fullyCovered=false（动态注入未覆盖 / 内容近似）
 *   - "none"    structural 或 unknown origin（无规则、无 jsonl）
 */
export type CoverageState = "full" | "partial" | "none";

export function coverageStateOf(origin: SegmentOrigin): CoverageState {
  switch (origin.kind) {
    case "rule":
    case "jsonl":
      return origin.fullyCovered ? "full" : "partial";
    case "structural":
    case "unknown":
      return "none";
  }
}
