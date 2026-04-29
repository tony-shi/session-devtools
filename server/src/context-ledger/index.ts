export type * from "./types";
export { buildMockReconciliationReport, MOCK_RECONCILIATION_REPORT } from "./report";
export { inferClaudeProxyAttributions, buildAttributionBreakdown } from "./proxy-attribution";
export type { AttributionBreakdown } from "./proxy-attribution";
export { parseClaudeJsonlMutations, pairToolUseAndResult } from "./jsonl-mutation-parser";
export type {
  ParseJsonlOptions,
  JsonlMutationParseResult,
  UnknownJsonlLine,
  ToolUsePairingResult,
} from "./jsonl-mutation-parser";
export {
  reconstructExpectedClaudeContext,
  UNIMPLEMENTED_RULES,
} from "./expected-context-reconstructor";
export type {
  HarnessRuleConfig,
  QueryBoundary,
  ReconstructInput,
  UnimplementedRuleId,
} from "./expected-context-reconstructor";
export { reconcileClaudeContext } from "./reconciliation-engine";
export type { ReconcileInput } from "./reconciliation-engine";
export {
  CONTEXT_LEDGER_RULES,
  CONTEXT_LEDGER_RULE_BY_ID,
  CLAUDE_CODE_SYSTEM_PROMPT_IDENTITY_RULE,
  getContextLedgerRule,
  // 过渡期兼容别名
  ATTRIBUTION_RULES,
  ATTRIBUTION_RULE_BY_ID,
  getAttributionRule,
} from "./rule-registry";
export type {
  ContextLedgerRule,
  RuleMatchMode,
  RuleStability,
  RuleMaterialization,
  RuleComparePolicy,
  RuleLocationConstraint,
  // 过渡期兼容别名
  AttributionRule,
} from "./rule-registry";
