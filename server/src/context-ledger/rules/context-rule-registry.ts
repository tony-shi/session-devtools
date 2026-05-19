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
import type { VersionPredicate } from "../version";
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
   * appliesTo：cc_version 版本谓词。缺省 = 所有版本都进入候选集。
   * 从对应 ContextLedgerRule.appliesTo 透传过来。
   */
  appliesTo?: VersionPredicate;
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
  "claude-code.system-prompt-tone-style.external.v0": ["system.main-prompt.section.tone-style"],
  "claude-code.system-prompt-tone-style.external.v1": ["system.main-prompt.section.tone-style"],
  "claude-code.system-prompt-text-output-section.v1": ["system.main-prompt.section.text-output"],
  "claude-code.system-prompt-session-guidance.v1": ["system.main-prompt.section.session-guidance"],
  "claude-code.system-prompt-environment.v1": ["system.main-prompt.section.environment"],
  "claude-code.system-prompt-auto-memory.v1": ["system.main-prompt.section.auto-memory"],
  "claude-code.system-prompt-context-management.v1": ["system.main-prompt.section.context-management"],
  "claude-code.system-prompt-gitstatus.v1": ["system.main-prompt.section.context"],

  "claude-code.messages.user-context.v1": ["messages.inline.system-reminder"],
  "claude-code.messages.skill-listing.v1": ["messages.inline.system-reminder"],
  "claude-code.messages.system-reminder.v1": ["messages.inline.system-reminder"],
  "claude-code.messages.local-command.v1": ["messages.inline.local-command"],
  "claude-code.messages.file-attachment.v1": ["messages.inline.system-reminder"],
  "claude-code.messages.tool-result.smoosh.v1": ["messages.tool_result"],
  "claude-code.messages.image.v1": ["messages.block.image"],
  "claude-code.messages.image-placeholder.v1": ["messages.inline.image-placeholder"],
  // away-summary 同时覆盖：
  //   - main session 末尾追加 → splitInlineTags 切出 messages.inline.free-text
  //   - side query 独立形态 → 整块停在 messages.text（side-query 模板下不 expand 子段）
  // 规则 pattern 以固定句首 "The user stepped away and is coming back." 锚定，
  // 不会误吃用户散文。
  "claude-code.messages.away-summary.v1": ["messages.inline.free-text", "messages.text"],

  // SmooshContent v2 rule 簇：tool_result.content 尾部 smoosh 切出的 SR 子段。
  // 当前 ast-builder 还未切 tool_result 尾部（阶段 2.2 完成后），但 rule 先就位。
  // 同时绑定 messages.inline.system-reminder 让 messages.text 路径下出现这些 SR
  // 时也能被识别（兼容历史 user-turn 中独立 SR sibling 的极少数 case）。
  "claude-code.smoosh.task-reminder.v2": ["messages.inline.system-reminder"],
  "claude-code.smoosh.queued-command.v2": ["messages.inline.system-reminder"],
  "claude-code.smoosh.file-modified.v1": ["messages.inline.system-reminder"],
  "claude-code.smoosh.plan-mode-strict.v1": ["messages.inline.system-reminder"],
  "claude-code.smoosh.plan-mode-reminder.v1": ["messages.inline.system-reminder"],
  "claude-code.smoosh.plan-mode-exited.v1": ["messages.inline.system-reminder"],

  "claude-code.side-query.session-title.v1": ["side-query.system"],
};

function normalizeMatchMode(mode: RuleMatchMode): ContextRuleMatchMode {
  if (mode === "exact" || mode === "prefix" || mode === "regex") return mode;
  return "prefix";
}

function copyAttributionRule(rule: ContextLedgerRule, slotId: string): ContextRule | null {
  const attr = rule.attribution;
  if (!attr) return null;
  // PR4 起 materialization 从 reconstruction 块提升到 ContextLedgerRule 顶层。
  const materialization = rule.materialization;
  return {
    ruleId: rule.ruleId,
    slotId,
    verifiedFor: rule.verifiedFor,
    queryScope: rule.queryScope,
    ...(rule.appliesTo ? { appliesTo: rule.appliesTo } : {}),
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

// PR 2 删除：STRUCTURAL_FALLBACK_RULES（空 prefix 规则伪装"slot 已识别"）。
// 新模型里 node.origin 在 ast-builder 出口就是 structural/no_rule_matched 默认值，
// 不需要假装命中一条空规则来"降一档"。fallbackRule helper 也一并不再使用。
//
// 影响：原本走 fallback 规则的节点（known slot 但无内容规则）现在 SegmentAttribution
// 投影会输出 mechanism="rule_gap" 而非 mechanism="slot_anchor_pattern"；audit 覆盖率
// 统计中 ruleGap 桶会包含这些节点。这是诚实的表达 —— 之前的"假证据"被去掉了。

const COPIED_CONTEXT_RULES: ContextRule[] = CONTEXT_LEDGER_RULES.flatMap((rule) =>
  slotIdsForLedgerRule(rule)
    .map((slotId) => copyAttributionRule(rule, slotId))
    .filter((r): r is ContextRule => r !== null),
);

export const CONTEXT_RULES: ContextRule[] = [
  ...COPIED_CONTEXT_RULES,
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
