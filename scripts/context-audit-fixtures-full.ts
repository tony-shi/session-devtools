#!/usr/bin/env bun
// context-audit-fixtures-full.ts — Fixture 全量覆盖检查
//
// 用法：
//   bun run context:audit:fixtures:full
//
// 串行执行三个阶段，全部完成后退出：
//
//   阶段 1  Fixture Audit（同 bun run context:audit:fixtures）
//           对每个 fixture 跑完整 pipeline，输出 reconciliation scorecard，
//           写入 audit run 产物（run.json / index.json / index.html / audit-run.md）。
//
//   阶段 2  Rule Coverage（同 bun run context:audit:fixtures:rule-coverage）
//           统计 CONTEXT_LEDGER_RULES 全集中，哪些 rule 被至少一个 fixture 的
//           attribution 命中，哪些从未命中（业务层覆盖率）。
//
//   阶段 3  Code Coverage（bun test --coverage）
//           用 bun test runner 跑 fixture-pipeline-coverage.test.ts，
//           收集 server/src/context-ledger/ 下所有模块的行/函数覆盖率。
//
// 退出码：
//   0  三个阶段全部成功
//   1  任意阶段失败

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

function banner(title: string) {
  const bar = "─".repeat(70);
  console.log(`\n${bar}`);
  console.log(`  ${title}`);
  console.log(`${bar}`);
}

function run(label: string, cmd: string, args: string[]): boolean {
  banner(label);
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✗ ${label} 失败（exit ${result.status ?? "signal"}）`);
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 阶段 1：Fixture Audit
// ─────────────────────────────────────────────────────────────────────────────

const ok1 = run(
  "阶段 1 / 3  Fixture Audit",
  "bun",
  ["run", "scripts/context-audit.ts", "--fixtures"],
);
if (!ok1) process.exit(1);

// ─────────────────────────────────────────────────────────────────────────────
// 阶段 2：Rule Coverage
// ─────────────────────────────────────────────────────────────────────────────

const ok2 = run(
  "阶段 2 / 3  Rule Coverage（业务层：哪些 rule 没有 fixture 命中）",
  "bun",
  ["run", "scripts/context-audit-rule-coverage.ts"],
);
if (!ok2) process.exit(1);

// ─────────────────────────────────────────────────────────────────────────────
// 阶段 3：Code Coverage
// ─────────────────────────────────────────────────────────────────────────────

const ok3 = run(
  "阶段 3 / 3  Code Coverage（代码层：server/src/context-ledger/ 行/函数覆盖率）",
  "bun",
  [
    "test",
    "server/src/context-ledger/audit/fixture-pipeline-coverage.test.ts",
    "--coverage",
    "--coverage-reporter", "text",
    "--coverage-include", "server/src/context-ledger",
  ],
);
if (!ok3) process.exit(1);

// ─────────────────────────────────────────────────────────────────────────────
// 完成
// ─────────────────────────────────────────────────────────────────────────────

banner("全部完成");
console.log(`  阶段 1  Fixture Audit      ✓`);
console.log(`  阶段 2  Rule Coverage      ✓`);
console.log(`  阶段 3  Code Coverage      ✓`);
console.log();
