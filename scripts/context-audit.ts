#!/usr/bin/env bun
// context-audit.ts — Context Audit Runner CLI
//
// 用法：
//   bun run context:audit                    # 扫描本地所有 proxy records
//   bun run context:audit --fixtures         # 用 test fixtures 快速跑通调测 loop
//   bun run context:audit --all-local        # 明确指定扫描全量本地数据
//   bun run context:audit --since-last       # 只处理上次 run 以来的新 proxy records
//   bun run context:audit --baseline <runId> # 对比指定 baseline 而非 latest
//   bun run context:audit:mark-baseline <runId>

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { makeRunId, runDir, AUDIT_HOME, BASELINE_JSON } from "../server/src/context-ledger/audit/paths";
import { discoverFixtures, discoverLocal } from "../server/src/context-ledger/audit/discovery";
import { runPipelineWithData } from "../server/src/context-ledger/audit/pipeline";
import {
  ensureAuditDirs,
  loadBaselineIndex,
  writeQueryArtifacts,
  writeIndex,
  writeRunJson,
  updateLatestPointer,
  readLatestRunId,
  readBaselineRunId,
  markBaseline,
} from "../server/src/context-ledger/audit/artifact-writer";
import { writeAuditRunMd, writeIndexHtml } from "../server/src/context-ledger/audit/report-generator";
import type { AuditRunRecord } from "../server/src/context-ledger/audit/types";

// ─────────────────────────────────────────────────────────────────────────────
// 参数解析
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

// mark-baseline 子命令
if (args[0] === "mark-baseline") {
  const runId = args[1];
  if (!runId) {
    console.error("用法：bun run context:audit:mark-baseline <runId>");
    process.exit(1);
  }
  if (!existsSync(runDir(runId))) {
    console.error(`runId 不存在：${runId}`);
    process.exit(1);
  }
  markBaseline(runId);
  console.log(`已标记 baseline → ${runId}`);
  console.log(`baseline.json：${BASELINE_JSON}`);
  process.exit(0);
}

const mode: AuditRunRecord["mode"] = args.includes("--fixtures")
  ? "fixtures"
  : args.includes("--since-last")
  ? "since-last"
  : "all-local";

// --baseline 指定对比 run
let baselineRunId: string | undefined;
const baselineIdx = args.indexOf("--baseline");
if (baselineIdx !== -1 && args[baselineIdx + 1]) {
  baselineRunId = args[baselineIdx + 1];
} else {
  // 默认：先找 baseline.json，再找 latest run（fixture 模式同样支持 delta 比较）
  baselineRunId = readBaselineRunId() ?? readLatestRunId();
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nContext Audit Runner`);
console.log(`mode: ${mode}`);
console.log(`baseline: ${baselineRunId ?? "(none)"}`);
console.log(`Discovering...`);

let discovery: ReturnType<typeof discoverFixtures>;

if (mode === "fixtures") {
  discovery = discoverFixtures();
} else {
  let sinceTs: string | undefined;
  if (mode === "since-last" && baselineRunId) {
    // 读取 baseline run.json 的 createdAt 作为起点
    const runJsonFile = join(runDir(baselineRunId), "run.json");
    if (existsSync(runJsonFile)) {
      try {
        const r = JSON.parse(readFileSync(runJsonFile, "utf-8")) as AuditRunRecord;
        sinceTs = r.createdAt;
      } catch { /* ignore */ }
    }
  }
  discovery = await discoverLocal({ sinceTs });
}

console.log(`  proxy discovered: ${discovery.discoveredProxyQueries.length}`);
console.log(`  proxy+jsonl matched: ${discovery.matchedProxyJsonl.length}`);
console.log(`  proxy without jsonl: ${discovery.proxyWithoutJsonl.length}`);
console.log(`  jsonl-only sessions: ${discovery.jsonlOnlySessions.length}`);
console.log(`  jsonl-only candidate queries: ${discovery.jsonlOnlyCandidateQueries}`);

if (discovery.matchedProxyJsonl.length === 0 && discovery.proxyWithoutJsonl.length === 0) {
  console.log(`\n没有发现任何 proxy records。`);
  if (mode === "fixtures") {
    console.log(`检查 fixture 目录是否存在：server/test/fixtures/context-reconstruction/`);
  } else {
    console.log(`检查 proxy 是否正在运行：bun run proxy:status`);
  }
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// 初始化 run
// ─────────────────────────────────────────────────────────────────────────────

const runId = makeRunId();
ensureAuditDirs(runId);

console.log(`\nrun: ${runId}`);
console.log(`output: ${runDir(runId)}`);
console.log(`\nRunning pipeline...`);

// 加载 baseline index（用于 delta 比较）
const baseline = loadBaselineIndex(baselineRunId);

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline（proxy+jsonl matched）
// ─────────────────────────────────────────────────────────────────────────────

const allResults = [];
let successCount = 0;
let failedCount = 0;
let skippedCount = 0;

// proxy_without_jsonl → 直接生成 skipped result
for (const proxy of discovery.proxyWithoutJsonl) {
  const { result } = runPipelineWithData({ proxy, jsonlFile: null });
  const written = writeQueryArtifacts(runId, result);
  allResults.push(written);
  skippedCount++;
}

// proxy+jsonl matched → 完整 pipeline
const total = discovery.matchedProxyJsonl.length;
for (let i = 0; i < total; i++) {
  const { proxy, jsonlFile } = discovery.matchedProxyJsonl[i];
  const label = `${proxy.queryKey.sessionId.slice(0, 8)}…/${proxy.queryKey.queryId.slice(0, 20)}`;
  process.stdout.write(`  [${i + 1}/${total}] ${label} `);

  const { result, data } = runPipelineWithData({ proxy, jsonlFile });
  const written = writeQueryArtifacts(runId, result, data);
  allResults.push(written);

  if (result.status === "success") {
    process.stdout.write(`✓\n`);
    successCount++;
  } else if (result.status === "failed") {
    process.stdout.write(`✗ ${result.error?.slice(0, 60) ?? "unknown error"}\n`);
    failedCount++;
  } else {
    process.stdout.write(`~ skipped (${result.skipReason ?? "?"})\n`);
    skippedCount++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact 写入
// ─────────────────────────────────────────────────────────────────────────────

const indexEntries = writeIndex(runId, allResults, baseline);

const run = writeRunJson(runId, {
  mode,
  baselineRunId,
  discoveredProxyQueries: discovery.discoveredProxyQueries.length,
  matchedProxyJsonlQueries: discovery.matchedProxyJsonl.length,
  proxyWithoutJsonlQueries: discovery.proxyWithoutJsonl.length,
  jsonlOnlySessions: discovery.jsonlOnlySessions.length,
  jsonlOnlyCandidateQueries: discovery.jsonlOnlyCandidateQueries,
  baselineEntries: baseline?.entries ?? [],
  currentEntries: indexEntries,
});

writeAuditRunMd(runId, run, indexEntries);
writeIndexHtml(runId, run, indexEntries);
updateLatestPointer(runId);

// ─────────────────────────────────────────────────────────────────────────────
// stdout summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`
Context Audit Run
run: ${runId}
baseline: ${baselineRunId ?? "(none)"}

Discovery
proxy discovered: ${run.discoveredProxyQueries}
proxy+jsonl matched: ${run.matchedProxyJsonlQueries}
proxy without jsonl: ${run.proxyWithoutJsonlQueries}
jsonl-only sessions: ${run.jsonlOnlySessions}
jsonl-only candidate queries: ${run.jsonlOnlyCandidateQueries}

Queries
previous: ${run.previousQueries}
current: ${run.currentQueries}
new: ${run.newQueries}
removed: ${run.removedQueries}
common: ${run.commonQueries}
skipped: ${run.skippedQueries}
failed: ${run.failedQueries}

Verdicts
improved: ${run.improvedQueries}
regressed: ${run.regressedQueries}
needs_review: ${run.needsReviewQueries}
unchanged: ${run.unchangedQueries}

Open:
  ${runDir(runId)}/index.html
  ${runDir(runId)}/audit-run.md
`);
