// rule-corpus/generator.ts
//
// corpus Rule[] → 运行时双表示:
//   ① ContextLedgerRule[]  (老链路:rule-registry.ts 的 CONTEXT_LEDGER_RULES 消费)
//   ② ContextRule[] + SLOT_BINDINGS  (新 AST attribution 路径消费)
//
// Phase 1 阶段:空 corpus → 空数组,生成器是"恒等(对老 registry 而言不可观察)"。
// Phase 2 起:每迁一条规则进 corpus,同时从 rule-registry.ts 的 CONTEXT_LEDGER_RULES
//   数组里剔除该常量,生成器接管,合并入口产出与原数组逐字段相等。
//
// 设计原则:
//   - 生成器**只做翻译**,不做语义变换。corpus 字段缺省 → 运行时 undefined,不"补默认值"。
//   - 类型在 corpus 端是 zod-inferred(字符串 union 比较宽),在运行时端是窄 TS 枚举;
//     生成器在边界做 cast,by-design 假设 corpus schema 校验已通过。

import type { ContextLedgerRule, RuleMatchMode as LedgerMatchMode } from "../rules/rule-registry";
import type { ContextRule, ContextRuleMatchMode } from "../rules/context-rule-registry";
import type { Confidence, SegmentCategory, RuleMechanism } from "../types";
import type { VersionPredicate } from "../version";
import type { Rule } from "./schema";

// ── corpus Rule → ContextLedgerRule(完整 schema)─────────────────────────────

export function toContextLedgerRule(rule: Rule): ContextLedgerRule {
  return {
    ruleId: rule.ruleId,
    verifiedFor: rule.verifiedFor,
    description: rule.description,
    stability: rule.stability,
    ...(rule.sourcemapRef ? { sourcemapRef: rule.sourcemapRef } : {}),
    ...(rule.queryScope ? { queryScope: rule.queryScope } : {}),
    ...(rule.appliesTo ? { appliesTo: rule.appliesTo as VersionPredicate } : {}),
    ...(rule.materialization ? { materialization: rule.materialization } : {}),
    attribution: {
      pattern: rule.pattern,
      matchMode: rule.attribution.matchMode as LedgerMatchMode,
      mechanism: rule.attribution.mechanism as RuleMechanism,
      category: rule.attribution.category as SegmentCategory,
      ...(rule.attribution.captureGroups
        ? { captureGroups: rule.attribution.captureGroups }
        : {}),
      ...(rule.attribution.notesTemplate
        ? { notesTemplate: rule.attribution.notesTemplate }
        : {}),
      ...(rule.attribution.confidenceOverride
        ? { confidenceOverride: rule.attribution.confidenceOverride as Confidence }
        : {}),
    },
  };
}

// ── corpus Rule → ContextRule(AST 投影)+ SLOT_BINDINGS───────────────────────

// 老 context-rule-registry.ts 的 normalizeMatchMode:把 "contains"/"structural" 等
// 归一到 ContextRule 允许的 "exact"|"prefix"|"regex"。这里保留同一语义。
function normalizeMatchModeForAst(mode: string): ContextRuleMatchMode {
  if (mode === "exact" || mode === "prefix" || mode === "regex") return mode;
  return "prefix";
}

/** slotId 在 corpus 可能是 string 或 string[];归一为数组,取首项作 ContextRule.slotId。 */
function slotIdsOf(rule: Rule): string[] {
  return Array.isArray(rule.slotId) ? rule.slotId : [rule.slotId];
}

export function toContextRule(rule: Rule): ContextRule {
  return {
    ruleId: rule.ruleId,
    // ContextRule 类型单值;多 slot 的 rule 由 SLOT_BINDINGS 提供完整列表(generateSlotBindings)
    slotId: slotIdsOf(rule)[0]!,
    verifiedFor: rule.verifiedFor,
    ...(rule.queryScope ? { queryScope: rule.queryScope } : {}),
    ...(rule.appliesTo ? { appliesTo: rule.appliesTo as VersionPredicate } : {}),
    ...(rule.materialization ? { materialization: rule.materialization } : {}),
    attribution: {
      pattern: rule.pattern,
      matchMode: normalizeMatchModeForAst(rule.attribution.matchMode),
      mechanism: rule.attribution.mechanism,
      category: rule.attribution.category as SegmentCategory,
      ...(rule.attribution.captureGroups
        ? { captureGroups: rule.attribution.captureGroups }
        : {}),
      ...(rule.attribution.notesTemplate
        ? { notesTemplate: rule.attribution.notesTemplate }
        : {}),
      ...(rule.attribution.confidenceOverride
        ? { confidenceOverride: rule.attribution.confidenceOverride as Confidence }
        : {}),
    },
  };
}

// ── 批量生成 ─────────────────────────────────────────────────────────────────

export function generateLedgerRules(corpus: { rules: Rule[] }): ContextLedgerRule[] {
  return corpus.rules.map(toContextLedgerRule);
}

export function generateContextRules(corpus: { rules: Rule[] }): ContextRule[] {
  return corpus.rules.map(toContextRule);
}

/**
 * 从 corpus 产出 SLOT_BINDINGS 片段(ruleId → slotId)。
 * 与 context-rule-registry.ts 的 SLOT_BINDINGS 同形(数组允许 N 个 slot,但 corpus 当前每条 rule 只绑一个 slot)。
 */
export function generateSlotBindings(corpus: { rules: Rule[] }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of corpus.rules) {
    out[r.ruleId] = slotIdsOf(r);
  }
  return out;
}
