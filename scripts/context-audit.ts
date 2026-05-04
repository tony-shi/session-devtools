#!/usr/bin/env bun
// context-audit.ts — Context Audit Runner CLI
//
// 用法：
//   bun run context:audit                    # 扫描本地所有 proxy records
//   bun run context:audit --fixtures         # 用 test fixtures 快速跑通调测 loop
//   bun run context:audit --since-last       # 只处理上次 run 以来的新 proxy records
//   bun run context:audit --baseline <runId> # 对比指定 baseline 而非 latest
//   bun run context:audit --fixtures --no-update-latest
//                                      # 并行 worker 场景：写 run 产物，但不更新 latest 指针
//   bun run context:audit:mark-baseline <runId>
//   bun run context:audit clear              # 清除所有 audit 产物（不删 proxy/jsonl 原始数据）
//   bun run context:audit clear --keep <N>   # 保留最近 N 个 run，清除其余

import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { makeRunId, runDir, AUDIT_HOME, RUNS_DIR, LATEST_JSON, BASELINE_JSON, latestJsonPath, baselineJsonPath } from "../server/src/context-ledger/audit/paths";
import { discoverFixtures, discoverLocal } from "../server/src/context-ledger/audit/discovery";
import { runPipelineWithData } from "../server/src/context-ledger/audit/pipeline";
import { CONTEXT_LEDGER_RULES, SUPPORTED_CLAUDE_CODE_VERSION } from "../server/src/context-ledger/rule-registry";
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
import type { AuditRunRecord, FixtureMatrixEntry } from "../server/src/context-ledger/audit/types";

// ─────────────────────────────────────────────────────────────────────────────
// 参数解析
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const shouldUpdateLatest = !args.includes("--no-update-latest");

// clear 子命令：清除 audit 产物，不删除 proxy/jsonl 原始数据
if (args[0] === "clear") {
  const keepIdx = args.indexOf("--keep");
  const keepN = keepIdx !== -1 ? parseInt(args[keepIdx + 1] ?? "0", 10) : 0;

  if (!existsSync(RUNS_DIR)) {
    console.log("没有 audit 产物（runs/ 目录不存在），无需清理。");
    process.exit(0);
  }

  const allRuns = readdirSync(RUNS_DIR)
    .filter((name) => existsSync(join(RUNS_DIR, name, "run.json")))
    .sort();

  if (allRuns.length === 0) {
    console.log("runs/ 为空，无需清理。");
    process.exit(0);
  }

  const keep = Math.max(0, keepN);
  const toDelete = keep > 0 ? allRuns.slice(0, allRuns.length - keep) : allRuns;
  const toKeep = keep > 0 ? allRuns.slice(allRuns.length - keep) : [];

  if (toDelete.length === 0) {
    console.log(`已有 ${allRuns.length} 个 run，--keep ${keep} 无需删除任何内容。`);
    process.exit(0);
  }

  console.log(`将删除 ${toDelete.length} 个 run（保留 ${toKeep.length} 个）：`);
  for (const r of toDelete) console.log(`  - ${r}`);
  if (toKeep.length > 0) {
    console.log(`保留：`);
    for (const r of toKeep) console.log(`  + ${r}`);
  }

  for (const r of toDelete) {
    rmSync(join(RUNS_DIR, r), { recursive: true, force: true });
  }

  const pointerFiles = [
    LATEST_JSON, BASELINE_JSON,
    ...["fixtures", "all-local", "since-last"].flatMap((m) => [
      latestJsonPath(m as "fixtures" | "all-local" | "since-last"),
      baselineJsonPath(m as "fixtures" | "all-local" | "since-last"),
    ]),
  ];
  for (const pf of pointerFiles) {
    if (!existsSync(pf)) continue;
    try {
      const p = JSON.parse(readFileSync(pf, "utf-8")) as { runId: string };
      if (toDelete.includes(p.runId)) {
        rmSync(pf, { force: true });
        console.log(`已清除 ${pf.replace(AUDIT_HOME + "/", "")}（指向的 run 已删除）`);
      }
    } catch { rmSync(pf, { force: true }); }
  }

  console.log(`✓ 清理完成（${toDelete.length} 个 run 已删除）`);
  process.exit(0);
}

// mark-baseline 子命令
if (args[0] === "mark-baseline") {
  const runId = args[1];
  if (!runId) {
    console.error("用法：bun run context:audit:mark-baseline <runId>");
    process.exit(1);
  }
  const runJsonFile = join(runDir(runId), "run.json");
  if (!existsSync(runJsonFile)) {
    console.error(`runId 不存在：${runId}`);
    process.exit(1);
  }
  let markMode: "fixtures" | "all-local" | "since-last" = "all-local";
  try {
    const r = JSON.parse(readFileSync(runJsonFile, "utf-8")) as { mode?: string };
    if (r.mode === "fixtures" || r.mode === "all-local" || r.mode === "since-last") {
      markMode = r.mode;
    }
  } catch { /* ignore */ }
  markBaseline(runId, markMode);
  console.log(`已标记 baseline → ${runId} (mode: ${markMode})`);
  console.log(`baseline.${markMode}.json：${baselineJsonPath(markMode)}`);
  process.exit(0);
}

const mode: AuditRunRecord["mode"] = args.includes("--fixtures")
  ? "fixtures"
  : args.includes("--since-last")
  ? "since-last"
  : "all-local";

// --session：只处理指定 session（聚焦调试用）
const sessionIdx = args.indexOf("--session");
const sessionFilter = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined;

// --baseline / --compare-run 指定对比 run
let baselineRunId: string | undefined;
const baselineIdx = args.indexOf("--baseline") !== -1 ? args.indexOf("--baseline") : args.indexOf("--compare-run");
if (baselineIdx !== -1 && args[baselineIdx + 1]) {
  baselineRunId = args[baselineIdx + 1];
} else {
  const latestForBoundary = mode === "since-last"
    ? readBaselineRunId(mode) ?? readLatestRunId("all-local") ?? readLatestRunId(mode)
    : readBaselineRunId(mode) ?? readLatestRunId(mode);
  baselineRunId = latestForBoundary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\nContext Audit Runner`);
console.log(`mode: ${mode}`);
console.log(`baseline: ${baselineRunId ?? "(none)"}`);
if (sessionFilter) console.log(`[filter] --session ${sessionFilter}`);
console.log(`Discovering...`);

let discovery: ReturnType<typeof discoverFixtures>;

if (mode === "fixtures") {
  discovery = discoverFixtures();
} else {
  let sinceTs: string | undefined;
  if (mode === "since-last" && baselineRunId) {
    const runJsonFile = join(runDir(baselineRunId), "run.json");
    if (existsSync(runJsonFile)) {
      try {
        const r = JSON.parse(readFileSync(runJsonFile, "utf-8")) as AuditRunRecord;
        sinceTs = r.createdAt;
      } catch { /* ignore */ }
    }
  }
  discovery = await discoverLocal({ sinceTs, sessionFilter });
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

const baseline = loadBaselineIndex(baselineRunId);

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

const allResults = [];
let successCount = 0;
let failedCount = 0;
let skippedCount = 0;

// proxy_without_jsonl → skip（没有 JSONL 无法做 rule 驱动对账）
for (const proxy of discovery.proxyWithoutJsonl) {
  const { result } = runPipelineWithData({ proxy, jsonlFile: null });
  const written = writeQueryArtifacts(runId, result, undefined);
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

// rule registry 静态摘要
const verifiedRules = CONTEXT_LEDGER_RULES.filter((r) => r.verifiedFor === SUPPORTED_CLAUDE_CODE_VERSION).length;
const ruleRegistrySummary = {
  supportedVersion: SUPPORTED_CLAUDE_CODE_VERSION,
  totalRules: CONTEXT_LEDGER_RULES.length,
  verifiedRules,
  unverifiedRules: CONTEXT_LEDGER_RULES.length - verifiedRules,
  lastCliVerificationNote: "2026-05-02：exact_text rules 40，1 unique / 5 multi / 34 missing（见 scripts/verify-rules-against-cli.ts）",
};

// fixture matrix（fixture 模式下输出来源分布）
let fixtureMatrix: FixtureMatrixEntry[] | undefined;
if (mode === "fixtures") {
  const scorecardByHash = new Map(indexEntries.map((e) => [e.queryKeyHash, e]));
  fixtureMatrix = discovery.discoveredProxyQueries.map((proxy) => {
    const raw = proxy.raw;
    const entry = scorecardByHash.get(proxy.queryKeyHash);
    return {
      fixtureName: (raw["_fixtureName"] as string | undefined) ?? proxy.queryKey.sessionId,
      source: (raw["_fixtureSource"] as string | undefined) ?? "unknown",
      queryId: proxy.queryKey.queryId,
      wireExactCoverage: entry?.v2?.wireExactCoverage,
      templateCoverage: entry?.v2?.templateCoverage,
      verdict: entry?.verdict,
    };
  });
}

const run = writeRunJson(runId, {
  mode,
  baselineRunId,
  fixtureMatrix,
  ruleRegistrySummary,
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
if (shouldUpdateLatest) {
  updateLatestPointer(runId, mode);
} else {
  console.log(`latest pointer: skipped (--no-update-latest)`);
}

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
