export type * from "./types";
export {
  parseQuery,
  attributeSnapshot,
  computeCoverage as computeParserAttributionCoverage,
} from "./parser";
export type {
  ParsedQuerySnapshot,
  SegmentNode,
  SegmentAttribution,
  AttributionCoverage,
} from "./parser";
export {
  CONTEXT_LEDGER_RULES,
  CONTEXT_LEDGER_RULE_BY_ID,
  CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
  CLAUDE_CODE_SYSTEM_PROMPT_DYNAMIC_SECTION_RULE,  // 过渡期别名，指向 environment rule
  CLAUDE_CODE_BILLING_NOISE_RULE,
  CLAUDE_CODE_INTRO_STANDARD_RULE,
  CLAUDE_CODE_INTRO_OUTPUT_STYLE_RULE,
  CLAUDE_CODE_SYSTEM_SECTION_RULE,
  CLAUDE_CODE_DOING_TASKS_RULE,
  CLAUDE_CODE_ACTIONS_SECTION_RULE,
  CLAUDE_CODE_USING_YOUR_TOOLS_RULE,
  CLAUDE_CODE_OUTPUT_EFFICIENCY_EXTERNAL_RULE,
  CLAUDE_CODE_TONE_STYLE_EXTERNAL_RULE,
  CLAUDE_CODE_TEXT_OUTPUT_SECTION_RULE,
  CLAUDE_CODE_SESSION_GUIDANCE_RULE,
  CLAUDE_CODE_ENVIRONMENT_SECTION_RULE,
  CLAUDE_CODE_AUTO_MEMORY_SECTION_RULE,
  getContextLedgerRule,
  // 过渡期兼容别名
  ATTRIBUTION_RULES,
  ATTRIBUTION_RULE_BY_ID,
  getAttributionRule,
} from "./rules/rule-registry";
export type {
  ContextLedgerRule,
  RuleMatchMode,
  RuleStability,
  RuleMaterialization,
  RuleComparePolicy,
  RuleLocationConstraint,
  RulePreCondition,
  // 过渡期兼容别名
  AttributionRule,
} from "./rules/rule-registry";
export {
  CONTEXT_RULES,
  CONTEXT_RULE_BY_ID,
  getContextRulesForSlotId,
} from "./rules/context-rule-registry";
export type {
  ContextRule,
  ContextRuleMatchMode,
} from "./rules/context-rule-registry";
