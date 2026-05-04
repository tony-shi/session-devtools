// Artifact Writer
// 把 pipeline 产出写到 AUDIT_HOME/runs/<runId>/ 目录。
// AUDIT_HOME 默认是 ~/.api-dashboard/context-audit/，并行 worktree 可通过
// CONTEXT_AUDIT_HOME 覆盖。每次 run 目录不可变，不覆盖旧 run。

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { CharDiffReport } from "../debug/char-diff";
import type { ReconciliationReport } from "../types";
import {
  AUDIT_HOME,
  RUNS_DIR,
  LATEST_JSON,
  BASELINE_JSON,
  latestJsonPath,
  baselineJsonPath,
  runDir,
  reportPath,
  scorecardPath,
  charDiffJsonPath,
  charDiffHtmlPath,
  proxyAttributionViewPath,
  reconcileFusionHtmlPath,
  errorPath,
} from "./paths";
import type { AuditMode } from "./paths";
import { renderProxyAttributionView } from "./proxy-attribution-view";
import { renderReconcileFusionHtml } from "./render-reconcile-fusion-html";
import type { ProxySegmentAttribution } from "../types";
import type {
  AuditIndexEntry,
  AuditRunRecord,
  AuditVerdict,
  BaselinePointer,
  ChangeClass,
  LatestPointer,
  PipelineResult,
  QueryScorecard,
  ScorecardDelta,
} from "./types";
import { classifyDelta } from "./scorecard";

// AuditVerdict → ChangeClass 映射（两者字面量不同，as 强转会产生错误值）
function verdictToChangeClass(v: AuditVerdict): ChangeClass {
  if (v === "improvement") return "improved";
  if (v === "regression")  return "regressed";
  if (v === "needs_review") return "needs_review";
  if (v === "unchanged")   return "unchanged";
  if (v === "skipped")     return "skipped";
  if (v === "failed")      return "failed";
  return "unchanged";  // "ok" fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// 初始化目录
// ─────────────────────────────────────────────────────────────────────────────

export function ensureAuditDirs(runId: string): string {
  const dir = runDir(runId);
  for (const sub of ["reports", "scorecards", "diffs", "logs"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// 读取 baseline run 的 index.json（用于 delta 计算）
// ─────────────────────────────────────────────────────────────────────────────

export interface BaselineIndex {
  entries: AuditIndexEntry[];
  scorecardByHash: Map<string, QueryScorecard>;
}

export function loadBaselineIndex(baselineRunId: string | undefined): BaselineIndex | null {
  if (!baselineRunId) return null;
  const indexFile = join(runDir(baselineRunId), "index.json");
  if (!existsSync(indexFile)) return null;

  try {
    const entries = JSON.parse(readFileSync(indexFile, "utf-8")) as AuditIndexEntry[];
    const scorecardByHash = new Map<string, QueryScorecard>();

    for (const entry of entries) {
      if (!entry.scorecardPath) continue;
      const scFile = join(runDir(baselineRunId), entry.scorecardPath);
      if (!existsSync(scFile)) continue;
      try {
        const sc = JSON.parse(readFileSync(scFile, "utf-8")) as QueryScorecard;
        scorecardByHash.set(entry.queryKeyHash, sc);
      } catch { /* skip */ }
    }

    return { entries, scorecardByHash };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 写 per-query artifacts
// ─────────────────────────────────────────────────────────────────────────────

export function writeQueryArtifacts(
  runId: string,
  result: PipelineResult,
  data?: {
    report: ReconciliationReport;
    diff: CharDiffReport;
    diffHtml: string;
    attributions?: ProxySegmentAttribution[];
    reqBody?: Record<string, unknown>;
  },
): PipelineResult {
  const dir = runDir(runId);
  const hash = result.queryKeyHash;
  const updated = { ...result };

  if (result.status === "failed" && result.error) {
    const ePath = errorPath(hash);
    const absPath = join(dir, ePath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, JSON.stringify({ error: result.error, queryKey: result.queryKey }, null, 2), "utf-8");
    updated.errorPath = ePath;
  }

  if (result.status === "success" && data && result.scorecard) {
    const rPath = reportPath(hash);
    const sPath = scorecardPath(hash);
    const djPath = charDiffJsonPath(hash);
    const dhPath = charDiffHtmlPath(hash);

    writeFileSync(join(dir, rPath), JSON.stringify(data.report, null, 2), "utf-8");
    writeFileSync(join(dir, sPath), JSON.stringify(result.scorecard, null, 2), "utf-8");
    writeFileSync(join(dir, djPath), JSON.stringify(data.diff, null, 2), "utf-8");
    writeFileSync(join(dir, dhPath), data.diffHtml, "utf-8");

    updated.reportPath = rPath;
    updated.scorecardPath = sPath;
    updated.charDiffJsonPath = djPath;
    updated.charDiffHtmlPath = dhPath;

    // proxy-attribution view（四列 HTML：raw / parser / attribution / expected）
    if (data.attributions) {
      const snap = data.report.snapshot;
      const pavHtml = renderProxyAttributionView({
        snapshotId: snap.id,
        queryId: snap.queryId,
        sessionId: snap.sessionId,
        timestamp: snap.timestamp,
        segments: snap.segments,
        attributions: data.attributions,
        reqBody: data.reqBody ?? {},
        proxySourceRef: result.proxySourceRef,
        reconciliationReport: data.report,
      });
      const pavPath = proxyAttributionViewPath(hash);
      writeFileSync(join(dir, pavPath), pavHtml, "utf-8");
      updated.proxyAttributionViewPath = pavPath;
    }

    // reconcile fusion view（4-col table: raw / attribution / expected / reconcile）
    if (result.scorecard) {
      const snap = data.report.snapshot;
      const fusionHtml = renderReconcileFusionHtml({
        queryId: snap.queryId,
        sessionId: snap.sessionId,
        timestamp: snap.timestamp,
        report: data.report,
        reqBody: data.reqBody ?? {},
        scorecard: result.scorecard,
      });
      const fusionPath = reconcileFusionHtmlPath(hash);
      writeFileSync(join(dir, fusionPath), fusionHtml, "utf-8");
      updated.reconcileFusionHtmlPath = fusionPath;
    }
  }

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// 写 index.json
// ─────────────────────────────────────────────────────────────────────────────

export function writeIndex(
  runId: string,
  results: PipelineResult[],
  baseline: BaselineIndex | null,
): AuditIndexEntry[] {
  const baselineHashes = new Set(baseline?.entries.map((e) => e.queryKeyHash) ?? []);

  const entries: AuditIndexEntry[] = results.map((r) => {
    const isNew = !baselineHashes.has(r.queryKeyHash);
    let delta: ScorecardDelta | undefined;

    if (r.scorecard) {
      const prevScorecard = baseline?.scorecardByHash.get(r.queryKeyHash);
      const { verdict, reasons } = classifyDelta(r.scorecard, prevScorecard, isNew);
      delta = {
        queryKey: r.scorecard.queryKey,
        queryKeyHash: r.queryKeyHash,
        current: r.scorecard,
        previous: prevScorecard,
        verdict,
        changeClass: isNew ? "new" : verdictToChangeClass(verdict),
        reasons,
      };
    }

    // 从 scorecard 提取覆盖率分桶摘要，内嵌到 index entry（report-generator 直接读取）
    const v2 = r.scorecard ? {
      wireExactCoverage: r.scorecard.wireExactCoverage,
      canonicalExactCoverage: r.scorecard.canonicalExactCoverage,
      templateCoverage: r.scorecard.templateCoverage,
      regexCoverage: r.scorecard.regexCoverage,
      presenceCoverage: r.scorecard.presenceCoverage,
      serverSideCoverage: r.scorecard.serverSideCoverage,
      attributionOnlyCoverage: r.scorecard.attributionOnlyCoverage,
      unexplainedCoverage: r.scorecard.unexplainedCoverage,
      regexOverreachRisk: r.scorecard.regexOverreachRisk,
      pendingRuleCoverage: r.scorecard.pendingRuleCoverage,
      ruleMaterializedCoverage: r.scorecard.ruleMaterializedCoverage,
      proxyScalarFallbackCount: r.scorecard.proxyScalarFallbackCount,
      unmaterializedRuleCount: r.scorecard.unmaterializedRuleCount,
      requestLevelExact: r.scorecard.requestLevelExact,
      proxyChars: r.scorecard.proxyChars,
    } : undefined;

    const entry: AuditIndexEntry = {
      queryKey: r.queryKey,
      queryKeyHash: r.queryKeyHash,
      agentKind: r.queryKey.agentKind,
      sessionId: r.queryKey.sessionId,
      queryId: r.queryKey.queryId,
      timestamp: r.timestamp,
      proxySourceRef: r.proxySourceRef,
      jsonlSourceRef: r.jsonlSourceRef,
      verdict: delta?.verdict ?? (r.status === "skipped" ? "skipped" : r.status === "failed" ? "failed" : "ok"),
      // skipped/failed 状态优先于 isNew，避免 proxy_without_jsonl 被误标为 "new"
      changeClass: delta?.changeClass ?? (r.status === "skipped" ? "skipped" : r.status === "failed" ? "failed" : isNew ? "new" : "unchanged"),
      reasons: delta?.reasons ?? (r.skipReason ? [r.skipReason] : r.error ? ["pipeline_error"] : []),
      queryKind: r.queryKind,
      v2,
      reportPath: r.reportPath,
      scorecardPath: r.scorecardPath,
      charDiffHtmlPath: r.charDiffHtmlPath,
      charDiffJsonPath: r.charDiffJsonPath,
      proxyAttributionViewPath: r.proxyAttributionViewPath,
      reconcileFusionHtmlPath: r.reconcileFusionHtmlPath,
      errorPath: r.errorPath,
    };
    return entry;
  });

  writeFileSync(
    join(runDir(runId), "index.json"),
    JSON.stringify(entries, null, 2),
    "utf-8",
  );
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// 写 run.json
// ─────────────────────────────────────────────────────────────────────────────

export function writeRunJson(
  runId: string,
  params: {
    mode: AuditRunRecord["mode"];
    baselineRunId?: string;
    fixtureMatrix?: import("./types").FixtureMatrixEntry[];
    ruleRegistrySummary?: import("./types").RuleRegistrySummary;
    discoveredProxyQueries: number;
    matchedProxyJsonlQueries: number;
    proxyWithoutJsonlQueries: number;
    jsonlOnlySessions: number;
    jsonlOnlyCandidateQueries: number;
    baselineEntries: AuditIndexEntry[];
    currentEntries: AuditIndexEntry[];
  },
): AuditRunRecord {
  const {
    mode, baselineRunId, fixtureMatrix, ruleRegistrySummary,
    discoveredProxyQueries, matchedProxyJsonlQueries,
    proxyWithoutJsonlQueries, jsonlOnlySessions, jsonlOnlyCandidateQueries,
    baselineEntries, currentEntries,
  } = params;

  // 当前 run 的 hash 集合
  const currentHashes = new Set(currentEntries.map((e) => e.queryKeyHash));
  const baselineHashes = new Set(baselineEntries.map((e) => e.queryKeyHash));

  const newQueries = currentEntries.filter((e) => !baselineHashes.has(e.queryKeyHash)).length;
  const removedQueries = baselineEntries.filter((e) => !currentHashes.has(e.queryKeyHash)).length;
  const commonQueries = currentEntries.filter((e) => baselineHashes.has(e.queryKeyHash)).length;

  const record: AuditRunRecord = {
    runId,
    createdAt: new Date().toISOString(),
    baselineRunId,
    mode,
    ...(fixtureMatrix ? { fixtureMatrix } : {}),
    ...(ruleRegistrySummary ? { ruleRegistrySummary } : {}),
    discoveredProxyQueries,
    matchedProxyJsonlQueries,
    proxyWithoutJsonlQueries,
    jsonlOnlySessions,
    jsonlOnlyCandidateQueries,
    previousQueries: baselineEntries.length,
    currentQueries: currentEntries.length,
    newQueries,
    removedQueries,
    commonQueries,
    improvedQueries: currentEntries.filter((e) => e.changeClass === "improved").length,
    regressedQueries: currentEntries.filter((e) => e.changeClass === "regressed").length,
    needsReviewQueries: currentEntries.filter((e) => e.changeClass === "needs_review").length,
    unchangedQueries: currentEntries.filter((e) => e.changeClass === "unchanged").length,
    skippedQueries: currentEntries.filter((e) => e.changeClass === "skipped").length,
    failedQueries: currentEntries.filter((e) => e.changeClass === "failed").length,
  };

  writeFileSync(
    join(runDir(runId), "run.json"),
    JSON.stringify(record, null, 2),
    "utf-8",
  );
  return record;
}

// ─────────────────────────────────────────────────────────────────────────────
// 更新 latest.json / baseline.json
// ─────────────────────────────────────────────────────────────────────────────

// E0-2：mode-aware 指针写入/读取。优先用 latest.<mode>.json，兼容读旧的 latest.json
export function updateLatestPointer(runId: string, mode: AuditMode): void {
  mkdirSync(AUDIT_HOME, { recursive: true });
  const pointer: LatestPointer = { runId, createdAt: new Date().toISOString() };
  const data = JSON.stringify(pointer, null, 2);
  writeFileSync(latestJsonPath(mode), data, "utf-8");
}

export function readLatestRunId(mode: AuditMode): string | undefined {
  // 先读 mode-specific 文件，不存在时 fallback 到全局 latest.json（兼容旧 run）
  const modeFile = latestJsonPath(mode);
  const file = existsSync(modeFile) ? modeFile : existsSync(LATEST_JSON) ? LATEST_JSON : null;
  if (!file) return undefined;
  try {
    const p = JSON.parse(readFileSync(file, "utf-8")) as LatestPointer;
    return p.runId;
  } catch {
    return undefined;
  }
}

export function markBaseline(runId: string, mode: AuditMode, note?: string): void {
  mkdirSync(AUDIT_HOME, { recursive: true });
  const pointer: BaselinePointer = {
    runId,
    pointedAt: new Date().toISOString(),
    note,
  };
  writeFileSync(baselineJsonPath(mode), JSON.stringify(pointer, null, 2), "utf-8");
}

export function readBaselineRunId(mode: AuditMode): string | undefined {
  // 先读 mode-specific 文件，不存在时 fallback 到全局 baseline.json（兼容旧 run）
  const modeFile = baselineJsonPath(mode);
  const file = existsSync(modeFile) ? modeFile : existsSync(BASELINE_JSON) ? BASELINE_JSON : null;
  if (!file) return undefined;
  try {
    const p = JSON.parse(readFileSync(file, "utf-8")) as BaselinePointer;
    return p.runId;
  } catch {
    return undefined;
  }
}
