// ContextRule Registry
//
// 这是新 parser AST attribution 使用的平行规则表，不替换旧 rule-registry.ts。
// 设计边界：
//   - 旧 ContextLedgerRule 继续驱动 proxy/attribution、reconstruction、reconciliation。
//   - 这里把旧 rule 的 attribution 最小子集投影成 ContextRule，并显式绑定 slotId。
//   - template 只描述结构，不承载 rule 内容；slotId → ContextRule[] 的索引在本文件维护。
//
// 注意：ContextRule 是阶段性复制层。后续当 AST attribution 稳定后，可以逐步把它
// 扩展成权威规则表，再评估是否回收旧 registry。

import type { Confidence, SegmentCategory } from "../types";
import {
  CONTEXT_LEDGER_RULES,
  SUPPORTED_CLAUDE_CODE_VERSION,
} from "./rule-registry";
import type {
  ContextLedgerRule,
  RuleMatchMode,
} from "./rule-registry";

export type ContextRuleMatchMode = "exact" | "prefix" | "regex";

/**
 * ContextRuleMaterialization：rule 在 expected 侧的可重建语义。
 * 与旧 ContextLedgerRule.reconstruction.materialization 同义；
 * AST attribution 用它驱动 reconstructable 布尔值，区分
 *   exact_text       contentPattern 字面，可逐字节重建
 *   normalized_text  静态模板 + 动态字段可解释，但字节级不保证
 *   shape            只能复现结构/轮廓
 *   presence         只能确认存在，内容不可预测
 *   unavailable      不提供任何可重建证据
 */
export type ContextRuleMaterialization =
  | "exact_text"
  | "normalized_text"
  | "shape"
  | "presence"
  | "unavailable";

export interface ContextRule {
  ruleId: string;
  /** 该 rule 绑定的精确 slotId；tools.builtin 作为动态工具 slot 的前缀槽。 */
  slotId: string;
  /** 已校对版本；null 表示命中后 confidence 必须降级为 inferred。 */
  verifiedFor: string | null;
  /** 适用 query 类型；省略等同于 any。 */
  queryScope?: "main_session" | "side_query" | "any";
  /**
   * P1-1：声明该 rule 命中后能给出的 materialization 证据。
   *   - 来自旧 ContextLedgerRule.reconstruction.materialization
   *   - 结构兜底 rule（STRUCTURAL_FALLBACK_RULES）默认 "presence"
   * 缺失时 attribution 会按 matchMode 给出保守兜底。
   */
  materialization?: ContextRuleMaterialization;
  attribution: {
    pattern: string | null;
    matchMode: ContextRuleMatchMode;
    mechanism: string;
    category: SegmentCategory;
    captureGroups?: Record<string, string>;
    notesTemplate?: Array<{
      format: string;
      requireGroup?: string;
      absentGroup?: string;
    }>;
    confidenceOverride?: Confidence;
  };
}

// 旧 ruleId → 新 AST slotId 的显式绑定。
// WHY：旧 RuleLocationConstraint 只有 section/orderHint 等弱约束；新链路必须由 slotId
// 决定候选 rule 集合，避免回到全表扫描。
const SLOT_BINDINGS: Record<string, string[]> = {
  "claude-code.billing-noise.v1": ["system.billing"],
  "claude-code.system-prompt-identity.v1": ["system.identity"],

  "claude-code.system-prompt-intro.standard.v1": ["system.main-prompt.section.prelude"],
  "claude-code.system-prompt-intro.output-style.v1": ["system.main-prompt.section.prelude"],
  "claude-code.system-prompt-system-section.v1": ["system.main-prompt.section.system"],
  "claude-code.system-prompt-doing-tasks.v1": ["system.main-prompt.section.doing-tasks"],
  "claude-code.system-prompt-actions-section.v1": ["system.main-prompt.section.actions"],
  "claude-code.system-prompt-using-your-tools.v1": ["system.main-prompt.section.using-tools"],
  "claude-code.system-prompt-output-efficiency.external.v1": ["system.main-prompt.section.output-efficiency"],
  "claude-code.system-prompt-tone-style.external.v1": ["system.main-prompt.section.tone-style"],
  "claude-code.system-prompt-text-output-section.v1": ["system.main-prompt.section.text-output"],
  "claude-code.system-prompt-session-guidance.v1": ["system.main-prompt.section.session-guidance"],
  "claude-code.system-prompt-environment.v1": ["system.main-prompt.section.environment"],
  "claude-code.system-prompt-auto-memory.v1": ["system.main-prompt.section.auto-memory"],
  "claude-code.system-prompt-context-management.v1": [
    "system.main-prompt.section.context-management",
    "system.main-prompt.section.context",
  ],

  "claude-code.messages.user-context.v1": ["messages.inline.system-reminder"],
  "claude-code.messages.system-reminder.v1": ["messages.inline.system-reminder"],
  "claude-code.messages.local-command.v1": ["messages.inline.local-command"],
  "claude-code.messages.file-attachment.v1": ["messages.inline.system-reminder"],
  "claude-code.messages.tool-result.smoosh.v1": ["messages.tool_result"],

  "claude-code.side-query.session-title.v1": ["side-query.system"],
};

function normalizeMatchMode(mode: RuleMatchMode): ContextRuleMatchMode {
  if (mode === "exact" || mode === "prefix" || mode === "regex") return mode;
  return "prefix";
}

function copyAttributionRule(rule: ContextLedgerRule, slotId: string): ContextRule | null {
  const attr = rule.attribution;
  if (!attr) return null;
  // P1-1：把旧 rule.reconstruction.materialization 投影到 ContextRule，
  //       让 AST attribution 能直接读出"该 rule 命中后能给出什么 materialization 证据"。
  //       legacy 的 "unavailable" 在 ContextRule 里同样表达为 "unavailable"。
  const materialization = rule.reconstruction?.materialization;
  return {
    ruleId: rule.ruleId,
    slotId,
    verifiedFor: rule.verifiedFor,
    queryScope: rule.queryScope,
    ...(materialization ? { materialization } : {}),
    attribution: {
      pattern: attr.pattern,
      matchMode: normalizeMatchMode(attr.matchMode),
      mechanism: attr.mechanism,
      category: attr.category,
      ...(attr.captureGroups ? { captureGroups: attr.captureGroups } : {}),
      ...(attr.notesTemplate ? { notesTemplate: attr.notesTemplate } : {}),
      ...(attr.confidenceOverride ? { confidenceOverride: attr.confidenceOverride } : {}),
    },
  };
}

function slotIdsForLedgerRule(rule: ContextLedgerRule): string[] {
  const explicit = SLOT_BINDINGS[rule.ruleId];
  if (explicit) return explicit;
  if (rule.attribution?.category === "tools_schema") return ["tools.builtin"];
  return [];
}

function fallbackRule(params: {
  ruleId: string;
  slotId: string;
  category: SegmentCategory;
  mechanism?: string;
}): ContextRule {
  return {
    ruleId: params.ruleId,
    slotId: params.slotId,
    verifiedFor: null,
    // 结构兜底 rule 不声称可重建文本：只确认"slot 锚点存在"。
    materialization: "presence",
    attribution: {
      // 空 prefix 是显式的"结构存在即命中"兜底规则；它必须排在 copy 规则之后。
      pattern: "",
      matchMode: "prefix",
      mechanism: params.mechanism ?? "slot_anchor_pattern",
      category: params.category,
    },
  };
}

// AST attribution 的结构兜底规则。
// 这些 rule 不声称可重建文本，只把 known slot 从 rule_gap 降为 inferred 识别，
// 让 audit 页面区分"结构已知但内容规则待补"和"完全未知结构"。
const STRUCTURAL_FALLBACK_RULES: ContextRule[] = [
  fallbackRule({
    ruleId: "context.slot.system-main-prompt.container.v1",
    slotId: "system.main-prompt-block",
    category: "system_prompt",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-prelude.fallback.v1",
    slotId: "system.main-prompt.section.prelude",
    category: "system_prompt",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-system.fallback.v1",
    slotId: "system.main-prompt.section.system",
    category: "system_prompt",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-doing-tasks.fallback.v1",
    slotId: "system.main-prompt.section.doing-tasks",
    category: "system_prompt",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-actions.fallback.v1",
    slotId: "system.main-prompt.section.actions",
    category: "system_prompt",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-using-tools.fallback.v1",
    slotId: "system.main-prompt.section.using-tools",
    category: "system_prompt",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-tone-style.fallback.v1",
    slotId: "system.main-prompt.section.tone-style",
    category: "system_prompt",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-text-output.fallback.v1",
    slotId: "system.main-prompt.section.text-output",
    category: "system_prompt",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-output-efficiency.fallback.v1",
    slotId: "system.main-prompt.section.output-efficiency",
    category: "system_prompt",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-session-guidance.fallback.v1",
    slotId: "system.main-prompt.section.session-guidance",
    category: "harness_injection",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-environment.fallback.v1",
    slotId: "system.main-prompt.section.environment",
    category: "harness_injection",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-auto-memory.fallback.v1",
    slotId: "system.main-prompt.section.auto-memory",
    category: "memory_injection",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-context-management.fallback.v1",
    slotId: "system.main-prompt.section.context-management",
    category: "harness_injection",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-context-tail.fallback.v1",
    slotId: "system.main-prompt.section.context",
    category: "harness_injection",
  }),
  fallbackRule({
    ruleId: "context.slot.system-section-language.fallback.v1",
    slotId: "system.main-prompt.section.language",
    category: "harness_injection",
  }),
  fallbackRule({
    ruleId: "context.slot.messages-text.fallback.v1",
    slotId: "messages.text",
    category: "user_message",
    mechanism: "wire_schema",
  }),
  fallbackRule({
    ruleId: "context.slot.messages-inline-free-text.fallback.v1",
    slotId: "messages.inline.free-text",
    category: "user_message",
    mechanism: "wire_schema",
  }),
  fallbackRule({
    ruleId: "context.slot.side-query-system.fallback.v1",
    slotId: "side-query.system",
    category: "system_prompt",
  }),
  fallbackRule({
    ruleId: "context.slot.side-query-user.fallback.v1",
    slotId: "side-query.user",
    category: "user_message",
    mechanism: "wire_schema",
  }),
];

const COPIED_CONTEXT_RULES: ContextRule[] = CONTEXT_LEDGER_RULES.flatMap((rule) =>
  slotIdsForLedgerRule(rule)
    .map((slotId) => copyAttributionRule(rule, slotId))
    .filter((r): r is ContextRule => r !== null),
);

export const CONTEXT_RULES: ContextRule[] = [
  ...COPIED_CONTEXT_RULES,
  ...STRUCTURAL_FALLBACK_RULES,
];

export const CONTEXT_RULE_BY_ID: ReadonlyMap<string, ContextRule> = new Map(
  CONTEXT_RULES.map((rule) => [rule.ruleId, rule]),
);

const CONTEXT_RULES_BY_SLOT_ID: ReadonlyMap<string, ContextRule[]> = (() => {
  const bySlot = new Map<string, ContextRule[]>();
  for (const rule of CONTEXT_RULES) {
    const existing = bySlot.get(rule.slotId) ?? [];
    existing.push(rule);
    bySlot.set(rule.slotId, existing);
  }
  return bySlot;
})();

export function getContextRulesForSlotId(slotId: string): ContextRule[] {
  if (slotId.startsWith("tools.builtin.")) {
    return CONTEXT_RULES_BY_SLOT_ID.get("tools.builtin") ?? [];
  }
  return CONTEXT_RULES_BY_SLOT_ID.get(slotId) ?? [];
}

export { SUPPORTED_CLAUDE_CODE_VERSION };
