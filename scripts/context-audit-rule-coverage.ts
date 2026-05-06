#!/usr/bin/env bun
// context-audit-rule-coverage.ts — Rule Coverage 旁路分析
//
// 用法：
//   bun run context:audit:fixtures:rule-coverage
//
// 逻辑：
//   1. 用 fixture 模式跑完整 pipeline，收集每个 fixture 命中的所有 ruleId
//   2. 与 CONTEXT_LEDGER_RULES 全集做差集，输出：
//      - 每条 rule 被哪些 fixture 命中（coverage matrix）
//      - 从未被任何 fixture 命中的 rule（dead rules）
//      - 覆盖率汇总
//
// 不修改任何 context-ledger 核心代码，不写 audit 产物（run/index/scorecard）。

import { discoverFixtures, VALID_FIXTURE_NAMES } from "../server/src/context-ledger/audit/discovery";
import { runPipelineWithData } from "../server/src/context-ledger/audit/pipeline";
import {
  CONTEXT_LEDGER_RULES,
  SUPPORTED_CLAUDE_CODE_VERSION,
  isRuleVerified,
} from "../server/src/context-ledger/rules/rule-registry";
import type { ContextLedgerRule } from "../server/src/context-ledger/rules/rule-registry";

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

interface RuleHit {
  ruleId: string;
  fixtures: string[];   // 命中此 rule 的 fixture 名列表
  hitCount: number;     // 跨所有 fixture 的总命中次数（attribution 数量）
}

interface RuleCoverageReport {
  supportedVersion: string;
  totalRules: number;
  hitRules: number;
  neverHitRules: number;
  hitRate: number;
  // 明细
  hits: RuleHit[];
  neverHit: Array<{ ruleId: string; verified: boolean; description: string }>;
  // fixture 视角：每个 fixture 命中了多少条不同的 rule
  fixtureRuleCount: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 主逻辑
// ─────────────────────────────────────────────────────────────────────────────

const discovery = discoverFixtures();

if (discovery.matchedProxyJsonl.length === 0 && discovery.proxyWithoutJsonl.length === 0) {
  console.error("没有发现任何 fixture。检查 server/test/fixtures/context-reconstruction/ 是否存在。");
  process.exit(1);
}

// ruleId → { 命中的 fixture 名集合, 总命中次数 }
const ruleHitMap = new Map<string, { fixtureNames: Set<string>; count: number }>();
// fixture 名 → 命中的 ruleId 集合
const fixtureRuleMap = new Map<string, Set<string>>();

// 初始化 fixtureRuleMap
for (const name of VALID_FIXTURE_NAMES) {
  fixtureRuleMap.set(name, new Set());
}

console.log(`\nRule Coverage Analysis (fixture mode)`);
console.log(`supported version: ${SUPPORTED_CLAUDE_CODE_VERSION}`);
console.log(`total rules: ${CONTEXT_LEDGER_RULES.length}`);
console.log(`fixtures: ${VALID_FIXTURE_NAMES.join(", ")}`);
console.log(`\nRunning pipelines...`);

// proxy_without_jsonl fixtures（如 side-query-session-title）走 --proxy-only 路径
for (const proxy of discovery.proxyWithoutJsonl) {
  const fixtureName = (proxy.raw["_fixtureName"] as string | undefined) ?? proxy.queryKey.sessionId;
  process.stdout.write(`  ${fixtureName} (proxy-only) `);

  const { result, data } = runPipelineWithData({ proxy, jsonlFile: null, proxyOnly: true });

  if (result.status !== "success" || !data) {
    process.stdout.write(`✗ ${result.status}\n`);
    continue;
  }

  process.stdout.write(`✓ (${data.attributions.length} attributions)\n`);

  if (!fixtureRuleMap.has(fixtureName)) fixtureRuleMap.set(fixtureName, new Set());
  for (const attr of data.attributions) {
    if (!attr.ruleId) continue;
    const key = attr.ruleId;
    if (!ruleHitMap.has(key)) ruleHitMap.set(key, { fixtureNames: new Set(), count: 0 });
    ruleHitMap.get(key)!.fixtureNames.add(fixtureName);
    ruleHitMap.get(key)!.count++;
    fixtureRuleMap.get(fixtureName)!.add(key);
  }
}

// matched proxy+jsonl fixtures
for (const { proxy, jsonlFile } of discovery.matchedProxyJsonl) {
  const fixtureName = (proxy.raw["_fixtureName"] as string | undefined) ?? proxy.queryKey.sessionId;
  process.stdout.write(`  ${fixtureName} `);

  const { result, data } = runPipelineWithData({ proxy, jsonlFile });

  if (result.status !== "success" || !data) {
    process.stdout.write(`✗ ${result.status}\n`);
    continue;
  }

  process.stdout.write(`✓ (${data.attributions.length} attributions)\n`);

  if (!fixtureRuleMap.has(fixtureName)) fixtureRuleMap.set(fixtureName, new Set());
  for (const attr of data.attributions) {
    if (!attr.ruleId) continue;
    const key = attr.ruleId;
    if (!ruleHitMap.has(key)) ruleHitMap.set(key, { fixtureNames: new Set(), count: 0 });
    ruleHitMap.get(key)!.fixtureNames.add(fixtureName);
    ruleHitMap.get(key)!.count++;
    fixtureRuleMap.get(fixtureName)!.add(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 构建报告
// ─────────────────────────────────────────────────────────────────────────────

const allRuleIds = new Set(CONTEXT_LEDGER_RULES.map((r) => r.ruleId));
const hitRuleIds = new Set(ruleHitMap.keys());
const neverHitRuleIds = [...allRuleIds].filter((id) => !hitRuleIds.has(id));

const hits: RuleHit[] = [...hitRuleIds]
  .map((ruleId) => {
    const h = ruleHitMap.get(ruleId)!;
    return { ruleId, fixtures: [...h.fixtureNames].sort(), hitCount: h.count };
  })
  .sort((a, b) => b.hitCount - a.hitCount);

const neverHit = neverHitRuleIds.map((ruleId) => {
  const rule = CONTEXT_LEDGER_RULES.find((r) => r.ruleId === ruleId)!;
  return {
    ruleId,
    verified: isRuleVerified(rule),
    description: rule.description,
  };
});

const fixtureRuleCount: Record<string, number> = {};
for (const [name, ruleIds] of fixtureRuleMap) {
  fixtureRuleCount[name] = ruleIds.size;
}

const report: RuleCoverageReport = {
  supportedVersion: SUPPORTED_CLAUDE_CODE_VERSION,
  totalRules: CONTEXT_LEDGER_RULES.length,
  hitRules: hitRuleIds.size,
  neverHitRules: neverHitRuleIds.length,
  hitRate: hitRuleIds.size / CONTEXT_LEDGER_RULES.length,
  hits,
  neverHit,
  fixtureRuleCount,
};

// ─────────────────────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(70)}`);
console.log(`Rule Coverage Summary`);
console.log(`${"─".repeat(70)}`);
console.log(`total rules    : ${report.totalRules}`);
console.log(`hit by fixtures: ${report.hitRules}  (${(report.hitRate * 100).toFixed(1)}%)`);
console.log(`never hit      : ${report.neverHitRules}`);

console.log(`\nFixture → distinct rules hit:`);
for (const [name, count] of Object.entries(report.fixtureRuleCount).sort()) {
  console.log(`  ${name.padEnd(35)} ${count}`);
}

// coverage matrix
console.log(`\n${"─".repeat(70)}`);
console.log(`Coverage Matrix (rule → fixtures)`);
console.log(`${"─".repeat(70)}`);
// 按 rule 在 CONTEXT_LEDGER_RULES 里的顺序输出，方便对照 registry
for (const rule of CONTEXT_LEDGER_RULES) {
  const h = ruleHitMap.get(rule.ruleId);
  const verified = isRuleVerified(rule) ? "V" : "?";
  if (h) {
    const fixtureStr = h.fixtureNames.size <= 4
      ? [...h.fixtureNames].sort().join(", ")
      : `${[...h.fixtureNames].sort().slice(0, 3).join(", ")} +${h.fixtureNames.size - 3}`;
    console.log(`  [${verified}] ${rule.ruleId.padEnd(55)} ✓ [${fixtureStr}]`);
  } else {
    // 从未命中：区分 verified vs 待校对
    const tag = isRuleVerified(rule) ? "DEAD" : "DEAD/unverified";
    console.log(`  [${verified}] ${rule.ruleId.padEnd(55)} ✗  ${tag}`);
  }
}

// 未命中汇总
if (report.neverHit.length > 0) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`Never-Hit Rules (fixture coverage gap)`);
  console.log(`${"─".repeat(70)}`);
  for (const { ruleId, verified, description } of report.neverHit) {
    const tag = verified ? "[verified]  " : "[unverified]";
    console.log(`  ${tag} ${ruleId}`);
    console.log(`             ${description}`);
  }
  console.log(`\n⚠  以上 ${report.neverHit.length} 条 rule 无 fixture 驱动——可能是逻辑推测或 fixture 缺失。`);
} else {
  console.log(`\n✓ 所有 rule 均至少被一个 fixture 命中。`);
}
