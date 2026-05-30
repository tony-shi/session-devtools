// rule-corpus/runtime.ts
//
// 单一加载入口:从 `_generated.ts`(由 scripts/corpus-sync.ts 离线生成,入 git)
// 读 corpus 数据,产出运行时双表示。**完全不 readFileSync**——这是 tsup bundle
// 后(prod/npm publish)corpus 仍能工作的关键(解决 Codex Review P1-1)。
//
// 工作流:
//   - 开发者改 corpus/*.md → 跑 `npm run corpus:sync` 重新生成 _generated.ts
//   - CI 跑 `corpus:check` 校验"重 sync 后 git diff 为空",防漏 sync
//   - build:server 链上挂 corpus:sync,prepack 兜底
//   - runtime 永远 import 自 _generated.ts(dev / prod / bundle 行为同源)

import {
  generateLedgerRules,
  generateContextRules,
  generateSlotBindings,
} from "./generator";
import { GENERATED_RULES } from "./_generated";
import type { Rule } from "./schema";
import type { ContextLedgerRule } from "../rules/rule-registry";
import type { ContextRule } from "../rules/context-rule-registry";

// generated 不带 filePath(运行时用不上、且会让生成产物在不同 checkout 路径产生伪 diff)。
// 这里加 placeholder filePath 仅为满足 Rule 类型契约;下游 generator/evaluator 均不读它。
const CORPUS = {
  rules: GENERATED_RULES.map((r) => ({ ...r, filePath: `_generated:${r.ruleId}` })) as Rule[],
};

export const CORPUS_LEDGER_RULES: ContextLedgerRule[] = generateLedgerRules(CORPUS);
export const CORPUS_CONTEXT_RULES: ContextRule[] = generateContextRules(CORPUS);
export const CORPUS_SLOT_BINDINGS: Record<string, string[]> = generateSlotBindings(CORPUS);

/** 按 ruleId 索引的 ContextLedgerRule(供 rule-registry.ts 在数组里插入对应位置)。 */
export const CORPUS_LEDGER_RULES_BY_ID: Readonly<Record<string, ContextLedgerRule>> =
  Object.fromEntries(CORPUS_LEDGER_RULES.map((r) => [r.ruleId, r]));
