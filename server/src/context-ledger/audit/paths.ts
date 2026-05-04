// audit artifact 路径管理
// 默认产物写到 ~/.api-dashboard/context-audit/。
// 并行 worktree 跑 fixture/audit 时，可用 CONTEXT_AUDIT_HOME 指向同一个隔离目录：
//   CONTEXT_AUDIT_HOME=$PWD/.audit/reconstruct bun run context:audit:fixtures --no-update-latest
// 这样各 run 目录仍共享 baseline，但不会污染用户主 dashboard 的 audit 指针。

import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { QueryKey } from "./types";

export const AUDIT_HOME =
  process.env.CONTEXT_AUDIT_HOME ?? join(homedir(), ".api-dashboard", "context-audit");
export const RUNS_DIR = join(AUDIT_HOME, "runs");
// 全局 fallback（兼容旧文件，E0-2 后不再写这两个路径）
export const LATEST_JSON = join(AUDIT_HOME, "latest.json");
export const BASELINE_JSON = join(AUDIT_HOME, "baseline.json");

// E0-2：按 mode 分域的指针文件，避免 fixture run 与 all-local run 互相比较
export type AuditMode = "fixtures" | "all-local" | "since-last";

export function latestJsonPath(mode: AuditMode): string {
  return join(AUDIT_HOME, `latest.${mode}.json`);
}

export function baselineJsonPath(mode: AuditMode): string {
  return join(AUDIT_HOME, `baseline.${mode}.json`);
}

// runId 格式：2026-04-29T11-10-00.000Z__d4e5f6
export function makeRunId(): string {
  const ts = new Date().toISOString().replace(/:/g, "-");
  const hash = createHash("sha256")
    .update(ts + Math.random().toString())
    .digest("hex")
    .slice(0, 6);
  return `${ts}__${hash}`;
}

export function runDir(runId: string): string {
  return join(RUNS_DIR, runId);
}

// queryKeyHash：对 agentKind/sessionId/queryId 做短 hash，用于文件名
export function queryKeyHash(key: QueryKey): string {
  const raw = `${key.agentKind}/${key.sessionId}/${key.queryId}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// per-query artifact 路径（相对于 runDir）
export function reportPath(hash: string): string {
  return join("reports", `${hash}.report.json`);
}
export function scorecardPath(hash: string): string {
  return join("scorecards", `${hash}.scorecard.json`);
}
export function charDiffJsonPath(hash: string): string {
  return join("diffs", `${hash}.char-diff.json`);
}
export function charDiffHtmlPath(hash: string): string {
  return join("diffs", `${hash}.char-diff.html`);
}
export function errorPath(hash: string): string {
  return join("logs", `${hash}.error.json`);
}
export function proxyAttributionViewPath(hash: string): string {
  return join("diffs", `${hash}.proxy-attribution.html`);
}
export function reconcileFusionHtmlPath(hash: string): string {
  return join("diffs", `${hash}.reconcile-fusion.html`);
}
