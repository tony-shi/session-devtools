// audit-run.md 和 index.html 生成器

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "./paths";
import type { AuditIndexEntry, AuditRunRecord } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// audit-run.md
// ─────────────────────────────────────────────────────────────────────────────

export function writeAuditRunMd(runId: string, run: AuditRunRecord, entries: AuditIndexEntry[]): void {
  const regressions = entries
    .filter((e) => e.changeClass === "regressed")
    .sort((a, b) => {
      // 按 suspectMatchChars + unknownProxyChars 降序（越大越需要优先看）
      return 0;  // 简化：保持 index 顺序
    });
  const needsReview = entries.filter((e) => e.changeClass === "needs_review");
  const proxyWithoutJsonl = entries.filter((e) => e.reasons.includes("proxy_without_jsonl"));
  const newQueries = entries.filter((e) => e.changeClass === "new");

  const lines: string[] = [
    `# Context Audit Run`,
    ``,
    `- **runId**: \`${run.runId}\``,
    `- **createdAt**: ${run.createdAt}`,
    `- **baselineRunId**: ${run.baselineRunId ?? "(none — first run)"}`,
    `- **mode**: ${run.mode}`,
    ``,
    `## Discovery Summary`,
    ``,
    `| 指标 | 数量 |`,
    `|------|------|`,
    `| discoveredProxyQueries | ${run.discoveredProxyQueries} |`,
    `| matchedProxyJsonlQueries | ${run.matchedProxyJsonlQueries} |`,
    `| proxyWithoutJsonlQueries | ${run.proxyWithoutJsonlQueries} |`,
    `| jsonlOnlySessions | ${run.jsonlOnlySessions} |`,
    `| jsonlOnlyCandidateQueries | ${run.jsonlOnlyCandidateQueries} |`,
    ``,
    `## Delta Summary`,
    ``,
    `| 对比项 | 数量 |`,
    `|--------|------|`,
    `| previousQueries | ${run.previousQueries} |`,
    `| currentQueries | ${run.currentQueries} |`,
    `| newQueries | ${run.newQueries} |`,
    `| removedQueries | ${run.removedQueries} |`,
    `| commonQueries | ${run.commonQueries} |`,
    ``,
    `## Verdict Summary`,
    ``,
    `| Verdict | 数量 |`,
    `|---------|------|`,
    `| improved | ${run.improvedQueries} |`,
    `| regressed | ${run.regressedQueries} |`,
    `| needs_review | ${run.needsReviewQueries} |`,
    `| unchanged | ${run.unchangedQueries} |`,
    `| skipped | ${run.skippedQueries} |`,
    `| failed | ${run.failedQueries} |`,
    ``,
  ];

  // Top regressions
  if (regressions.length > 0) {
    lines.push(`## Top Regressions`, ``);
    lines.push(`| queryKey | reason | char diff |`);
    lines.push(`|---------|--------|-----------|`);
    for (const e of regressions.slice(0, 10)) {
      const reasons = e.reasons.join(", ");
      const diffLink = e.charDiffHtmlPath ? `[diff](${e.charDiffHtmlPath})` : "-";
      lines.push(`| ${e.queryKey.sessionId}/${e.queryKey.queryId} | ${reasons} | ${diffLink} |`);
    }
    lines.push(``);
  }

  // Top needs review
  if (needsReview.length > 0) {
    lines.push(`## Top Needs Review`, ``);
    lines.push(`| queryKey | reason | report | char diff |`);
    lines.push(`|---------|--------|--------|-----------|`);
    for (const e of needsReview.slice(0, 10)) {
      const reasons = e.reasons.join(", ");
      const reportLink = e.reportPath ? `[report](${e.reportPath})` : "-";
      const diffLink = e.charDiffHtmlPath ? `[diff](${e.charDiffHtmlPath})` : "-";
      lines.push(`| ${e.queryKey.sessionId}/${e.queryKey.queryId} | ${reasons} | ${reportLink} | ${diffLink} |`);
    }
    lines.push(``);
  }

  // New queries
  if (newQueries.length > 0) {
    lines.push(`## New Proxy Queries (${newQueries.length})`, ``);
    for (const e of newQueries.slice(0, 5)) {
      lines.push(`- \`${e.queryKey.sessionId}/${e.queryKey.queryId}\` — ${e.verdict}`);
    }
    if (newQueries.length > 5) lines.push(`- ...and ${newQueries.length - 5} more`);
    lines.push(``);
  }

  // Proxy without JSONL
  if (proxyWithoutJsonl.length > 0) {
    lines.push(`## Proxy Without JSONL (${proxyWithoutJsonl.length})`, ``);
    for (const e of proxyWithoutJsonl.slice(0, 5)) {
      lines.push(`- \`${e.proxySourceRef}\` sessionId=${e.sessionId}`);
    }
    lines.push(``);
  }

  // Proxy coverage note
  lines.push(`## Proxy Coverage Note`, ``);
  lines.push(
    `本次 audit 以 proxy-first 口径进行。proxy 记录是 ground truth，`
    + `只有同时找到 proxy 和 JSONL 的 query 才进入完整 reconciliation 流程。`,
  );
  lines.push(``);
  lines.push(
    `JSONL-only 会话（共 ${run.jsonlOnlySessions} 个，约 ${run.jsonlOnlyCandidateQueries} 条候选 query）`
    + `不代表失败，只表示对应的 API 请求没有经过本地 proxy 记录，无法做 proxy ground truth 对账。`,
  );
  lines.push(``);
  if (run.proxyWithoutJsonlQueries > 0) {
    lines.push(
      `proxy_without_jsonl（${run.proxyWithoutJsonlQueries} 条）`
      + `表示 proxy 记录了请求，但找不到对应 JSONL session，`
      + `可能原因：代理安装后 Claude Code 尚未写入 session，或 session 在另一目录。`,
    );
    lines.push(``);
  }

  // Next actions
  lines.push(`## Next Action Suggestions`, ``);
  if (run.regressedQueries > 0) {
    lines.push(`- **Regression detected**: 检查 proxy-attribution / reconciliation-engine 的 M4 heuristic 是否引入了新的 suspect_match。`);
    lines.push(`- 参考路径：\`server/src/context-ledger/proxy-attribution.ts\` / \`reconciliation-engine.ts\``);
  }
  if (run.needsReviewQueries > 0) {
    lines.push(`- **Needs review**: 检查 expected-context-reconstructor 的 U1-U5 未实现规则是否影响了 evidenceBackedCoverage。`);
  }
  lines.push(`- **No automatic code modification**: 本 audit 仅生成报告，不自动修改 parser/reconstructor/reconciliation 核心代码。`);
  lines.push(``);

  writeFileSync(join(runDir(runId), "audit-run.md"), lines.join("\n"), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// index.html（自包含静态页面）
// ─────────────────────────────────────────────────────────────────────────────

export function writeIndexHtml(runId: string, run: AuditRunRecord, entries: AuditIndexEntry[]): void {
  const regressions = entries.filter((e) => e.changeClass === "regressed");
  const needsReview = entries.filter((e) => e.changeClass === "needs_review");
  const newEntries = entries.filter((e) => e.changeClass === "new");
  const proxyWithoutJsonl = entries.filter((e) => e.reasons.includes("proxy_without_jsonl"));
  const failed = entries.filter((e) => e.changeClass === "failed");
  const skipped = entries.filter((e) => e.changeClass === "skipped");

  const verdictColor = (v: string): string => {
    if (v === "regressed" || v === "regression") return "#ef4444";
    if (v === "improved" || v === "improvement") return "#22c55e";
    if (v === "needs_review") return "#f59e0b";
    if (v === "failed") return "#dc2626";
    if (v === "skipped") return "#9ca3af";
    if (v === "new") return "#3b82f6";
    return "#6b7280";
  };

  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // queryKind → badge 样式
  const queryKindBadge = (qk: string | undefined): string => {
    if (!qk) return `<span style="color:#475569">?</span>`;
    if (qk === "main_session") {
      return `<span style="background:#1e3a5f;color:#7dd3fc;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600">main</span>`;
    }
    if (qk === "session_title_side_query") {
      // session-title 是 Claude Code 标准内置逻辑（initReplBridge.ts count=1/3 触发）
      return `<span style="background:#1c1917;color:#a78bfa;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600" title="generateSessionTitle() — Claude Code 内置，会话首消息后自动触发（count=1/3）">title</span>`;
    }
    if (qk === "side_query") {
      return `<span style="background:#1c1917;color:#94a3b8;padding:1px 6px;border-radius:3px;font-size:10px">side</span>`;
    }
    return `<span style="color:#475569;font-size:10px">${esc(qk)}</span>`;
  };

  const renderRow = (e: AuditIndexEntry): string => {
    const color = verdictColor(e.changeClass);
    const verdict = `<span style="color:${color};font-weight:600">${esc(e.verdict)}</span>`;
    const reportLink = e.reportPath ? `<a href="${esc(e.reportPath)}">report</a>` : "";
    const diffLink = e.charDiffHtmlPath ? `<a href="${esc(e.charDiffHtmlPath)}">diff</a>` : "";
    const scLink = e.scorecardPath ? `<a href="${esc(e.scorecardPath)}">sc</a>` : "";
    const attrLink = e.proxyAttributionViewPath
      ? `<a href="${esc(e.proxyAttributionViewPath)}" title="proxy → parser → attribution 三列视图" style="color:#8b5cf6">attr</a>`
      : "";
    const reasons = esc(e.reasons.join(", "));
    return `<tr>
      <td>${verdict}</td>
      <td style="color:${verdictColor(e.changeClass)}">${esc(e.changeClass)}</td>
      <td>${queryKindBadge(e.queryKind)}</td>
      <td><code>${esc(e.sessionId.slice(0, 8))}…/${esc(e.queryId.slice(0, 20))}</code></td>
      <td>${reasons}</td>
      <td>${reportLink} ${scLink} ${diffLink} ${attrLink}</td>
    </tr>`;
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Context Audit — ${esc(runId)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: ui-monospace, monospace; font-size: 13px; background: #f8fafc; color: #1e293b; padding: 24px; }
h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
h2 { font-size: 15px; font-weight: 600; margin: 20px 0 8px; }
.meta { color: #64748b; margin-bottom: 20px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; }
.card-value { font-size: 22px; font-weight: 700; }
.card-label { color: #64748b; font-size: 11px; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0; }
th { background: #f1f5f9; padding: 8px 10px; text-align: left; font-size: 11px; color: #64748b; }
td { padding: 7px 10px; border-top: 1px solid #f1f5f9; vertical-align: top; }
td a { color: #3b82f6; text-decoration: none; }
td a:hover { text-decoration: underline; }
.note { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 6px; padding: 10px 14px; margin: 12px 0; color: #92400e; }
</style>
</head>
<body>
<h1>Context Audit Run</h1>
<div class="meta">
  <div>runId: <code>${esc(runId)}</code></div>
  <div>createdAt: ${esc(run.createdAt)}</div>
  <div>baseline: ${run.baselineRunId ? `<code>${esc(run.baselineRunId)}</code>` : "(none)"}</div>
  <div>mode: ${esc(run.mode)}</div>
</div>

<h2>Run Summary</h2>
<div class="grid">
  <div class="card"><div class="card-value">${run.discoveredProxyQueries}</div><div class="card-label">proxy discovered</div></div>
  <div class="card"><div class="card-value">${run.matchedProxyJsonlQueries}</div><div class="card-label">proxy+jsonl matched</div></div>
  <div class="card"><div class="card-value">${run.proxyWithoutJsonlQueries}</div><div class="card-label">proxy without jsonl</div></div>
  <div class="card"><div class="card-value">${run.jsonlOnlySessions}</div><div class="card-label">jsonl-only sessions</div></div>
  <div class="card"><div class="card-value" style="color:#ef4444">${run.regressedQueries}</div><div class="card-label">regressed</div></div>
  <div class="card"><div class="card-value" style="color:#22c55e">${run.improvedQueries}</div><div class="card-label">improved</div></div>
  <div class="card"><div class="card-value" style="color:#f59e0b">${run.needsReviewQueries}</div><div class="card-label">needs_review</div></div>
  <div class="card"><div class="card-value">${run.unchangedQueries}</div><div class="card-label">unchanged</div></div>
  <div class="card"><div class="card-value">${run.skippedQueries}</div><div class="card-label">skipped</div></div>
  <div class="card"><div class="card-value" style="color:#dc2626">${run.failedQueries}</div><div class="card-label">failed</div></div>
</div>

<h2>Query Delta</h2>
<div class="grid">
  <div class="card"><div class="card-value">${run.previousQueries}</div><div class="card-label">previous</div></div>
  <div class="card"><div class="card-value">${run.currentQueries}</div><div class="card-label">current</div></div>
  <div class="card"><div class="card-value" style="color:#3b82f6">${run.newQueries}</div><div class="card-label">new</div></div>
  <div class="card"><div class="card-value">${run.removedQueries}</div><div class="card-label">removed</div></div>
  <div class="card"><div class="card-value">${run.commonQueries}</div><div class="card-label">common</div></div>
</div>

${regressions.length > 0 ? `
<h2>Top Regressions (${regressions.length})</h2>
<table>
<tr><th>verdict</th><th>changeClass</th><th>type</th><th>session/query</th><th>reasons</th><th>links <span style="color:#8b5cf6;font-weight:400">(attr=三列视图)</span></th></tr>
${regressions.map(renderRow).join("\n")}
</table>` : ""}

${needsReview.length > 0 ? `
<h2>Needs Review (${needsReview.length})</h2>
<table>
<tr><th>verdict</th><th>changeClass</th><th>type</th><th>session/query</th><th>reasons</th><th>links</th></tr>
${needsReview.map(renderRow).join("\n")}
</table>` : ""}

${newEntries.length > 0 ? `
<h2>New Proxy Queries (${newEntries.length})</h2>
<table>
<tr><th>verdict</th><th>changeClass</th><th>type</th><th>session/query</th><th>reasons</th><th>links</th></tr>
${newEntries.map(renderRow).join("\n")}
</table>` : ""}

${proxyWithoutJsonl.length > 0 ? `
<h2>Proxy Without JSONL (${proxyWithoutJsonl.length})</h2>
<div class="note">proxy 找不到对应 JSONL session，不影响整体 run 成功。可能原因：代理重启、网络绕过代理、历史会话缺失。</div>
<table>
<tr><th>sessionId</th><th>timestamp</th><th>proxySourceRef</th></tr>
${proxyWithoutJsonl.map((e) => `<tr><td><code>${esc(e.sessionId)}</code></td><td>${esc(e.timestamp)}</td><td><code>${esc(e.proxySourceRef)}</code></td></tr>`).join("\n")}
</table>` : ""}

${failed.length > 0 ? `
<h2>Failed Queries (${failed.length})</h2>
<table>
<tr><th>verdict</th><th>changeClass</th><th>type</th><th>session/query</th><th>reasons</th><th>links</th></tr>
${failed.map(renderRow).join("\n")}
</table>` : ""}

<h2>All Queries (${entries.length})</h2>
<table>
<tr><th>verdict</th><th>changeClass</th><th>type</th><th>session/query</th><th>reasons</th><th>links</th></tr>
${entries.map(renderRow).join("\n")}
</table>

</body>
</html>`;

  writeFileSync(join(runDir(runId), "index.html"), html, "utf-8");
}
