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
      // 按 suspectMatchChars + unexplainedChars 降序（越大越需要优先看）
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

  // T0 rule registry summary section
  if (run.ruleRegistrySummary) {
    const rs = run.ruleRegistrySummary;
    lines.push(`## Rule Registry Summary`, ``);
    lines.push(`| 字段 | 值 |`);
    lines.push(`|------|-----|`);
    lines.push(`| supportedVersion | \`${rs.supportedVersion}\` |`);
    lines.push(`| totalRules | ${rs.totalRules} |`);
    lines.push(`| verifiedRules | ${rs.verifiedRules} |`);
    lines.push(`| unverifiedRules | ${rs.unverifiedRules} |`);
    const unverifiedPct = rs.totalRules > 0 ? ((rs.unverifiedRules / rs.totalRules) * 100).toFixed(1) : "0.0";
    lines.push(``);
    if (rs.unverifiedRules > rs.totalRules * 0.3) {
      lines.push(`> ⚠️  未验证 rule 占比 ${unverifiedPct}%（>30%）→ 当前覆盖率数字不可信，建议运行 \`npm run scripts/verify-rules-against-cli.ts\` 更新 verifiedFor。`);
    } else {
      lines.push(`> ✓ 未验证 rule 占比 ${unverifiedPct}%`);
    }
    if (rs.lastCliVerificationNote) {
      lines.push(`> 最近 CLI 对账：${rs.lastCliVerificationNote}`);
    }
    lines.push(``);
  }

  // T0 fixture matrix section（fixture 模式下输出）
  if (run.fixtureMatrix && run.fixtureMatrix.length > 0) {
    lines.push(`## Fixture Source Matrix`, ``);
    lines.push(`| fixture | 来源 | queryId | verdict |`);
    lines.push(`|---------|------|---------|---------|`);
    for (const m of run.fixtureMatrix) {
      const sourceTag = m.source === "ant-native"
        ? "🏠 ant-native（Anthropic 内部）"
        : m.source === "external"
        ? "🌐 external（公开 CLI）"
        : m.source === "synthetic"
        ? "🔧 synthetic（手写）"
        : `❓ ${m.source}`;
      lines.push(`| ${m.fixtureName} | ${sourceTag} | ${m.queryId.slice(0, 20)} | ${m.verdict ?? "-"} |`);
    }
    const antNative = run.fixtureMatrix.filter((m) => m.source === "ant-native").length;
    const external = run.fixtureMatrix.filter((m) => m.source === "external").length;
    lines.push(``);
    lines.push(`> ant-native: ${antNative}  external: ${external}  total: ${run.fixtureMatrix.length}`);
    if (external === 0) {
      lines.push(`> ⚠️  **无 external CLI fixture**：所有 fixture 来自 Anthropic 内部环境，`
        + `无法验证 rule 对公开 Claude Code 的适用性。建议录制至少 2 份 external fixture（P3-5）。`);
    }
    lines.push(``);
  }

  // 覆盖率正交分桶 section
  const entriesWithV2 = entries.filter((e) => e.v2);
  if (entriesWithV2.length > 0) {
    lines.push(`## Coverage 正交分桶`, ``);
    lines.push(`> wire = basis=raw_hash/tool_use_id  tmpl = basis=rule_id+exact_text  regex = basis=rule_id+shape`);
    lines.push(`> ruleMat = template+presence（rule 正向 materialize 总覆盖）  pending = attribution 命中但 rule.verifiedFor===null 的字符占比`);
    lines.push(`> scalarFB = proxy scalar fallback 字段数  unmtRule = unmaterialized rule 数`);
    lines.push(``);
    lines.push(`| query | proxyChars | req | wire | tmpl | ruleMat | attrOnly | unexplained | pending | scalarFB | unmtRule |`);
    lines.push(`|-------|-----------|-----|------|------|---------|---------|------------|---------|----------|----------|`);
    for (const e of entriesWithV2) {
      const v = e.v2!;
      const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
      const pendingFlag = (v.pendingRuleCoverage ?? 0) > 0.3 ? "⚠️ " : "";
      const ruleMatFlag = (v.ruleMaterializedCoverage ?? 0) > 0.5 ? "✓ " : "";
      lines.push(
        `| ${e.sessionId.slice(0, 8)}…/${e.queryId.slice(0, 16)}`
        + ` | ${v.proxyChars}`
        + ` | ${v.requestLevelExact ?? "-"}`
        + ` | ${pct(v.wireExactCoverage)}`
        + ` | ${pct(v.templateCoverage)}`
        + ` | ${ruleMatFlag}${v.ruleMaterializedCoverage !== undefined ? pct(v.ruleMaterializedCoverage) : "-"}`
        + ` | ${pct(v.attributionOnlyCoverage)}`
        + ` | ${pct(v.unexplainedCoverage)}`
        + ` | ${pendingFlag}${v.pendingRuleCoverage !== undefined ? pct(v.pendingRuleCoverage) : "-"}`
        + ` | ${v.proxyScalarFallbackCount ?? "-"}`
        + ` | ${v.unmaterializedRuleCount ?? "-"}`
        + ` |`,
      );
    }
    lines.push(``);
  }

  // 覆盖率口径说明
  lines.push(`## 覆盖率口径说明`, ``);
  if (run.ruleRegistrySummary) {
    const rs = run.ruleRegistrySummary;
    lines.push(`| rule registry | 值 |`);
    lines.push(`|--------------|-----|`);
    lines.push(`| 支持版本 | \`${rs.supportedVersion}\` |`);
    lines.push(`| 总规则数 | ${rs.totalRules} |`);
    lines.push(`| 已验证 | ${rs.verifiedRules} |`);
    lines.push(`| 未验证 | ${rs.unverifiedRules} |`);
    if (rs.unverifiedRules > 0) {
      lines.push(``);
      lines.push(`> ⚠️ ${rs.unverifiedRules} 条规则 verifiedFor=null，template/regex 覆盖率可能包含未经 CLI 验证的 rule`);
    }
    if (rs.lastCliVerificationNote) {
      lines.push(`> CLI 对账备注：${rs.lastCliVerificationNote}`);
    }
    lines.push(``);
  }
  lines.push(`覆盖率桶含义（按可信度降序）：`);
  lines.push(`- **wireExact**：raw_hash 精确匹配，最可信`);
  lines.push(`- **template**：rule contentPattern 正向重建命中（exact_text materialization）`);
  lines.push(`- **regex**：normalized_text/shape rule 的 ruleId 对齐`);
  lines.push(`- **presence**：仅验证段存在（hash policy 失败降级，或 shape/presence rule）`);
  lines.push(`- **attrOnly**：有归因无 expected（rule 未物化）`);
  lines.push(`- **unexplained**：无归因无 expected`);
  lines.push(``);

  // Next actions
  lines.push(`## Next Action Suggestions`, ``);
  if (run.regressedQueries > 0) {
    lines.push(`- **Regression detected**: 检查 proxy-attribution / reconciliation-engine 的 M4 heuristic 是否引入了新的 suspect_match。`);
    lines.push(`- 参考路径：\`server/src/context-ledger/proxy/attribution.ts\` / \`reconciliation/engine.ts\``);
  }
  if (run.needsReviewQueries > 0) {
    lines.push(`- **Needs review**: 检查 expected-context-reconstructor 的 U1-U5 未实现规则是否压低了 wireExactCoverage + templateCoverage（push 到 attributionOnlyCoverage / unexplainedCoverage）。`);
  }
  lines.push(`- **No automatic code modification**: 本 audit 仅生成报告，不自动修改 parser/reconstructor/reconciliation 核心代码。`);
  lines.push(``);

  writeFileSync(join(runDir(runId), "audit-run.md"), lines.join("\n"), "utf-8");
}

// ─────────────────────────────────────────────────────────────────────────────
// index.html（自包含静态页面）
// ─────────────────────────────────────────────────────────────────────────────

export function writeIndexHtml(runId: string, run: AuditRunRecord, entries: AuditIndexEntry[]): void {
  // 按 LLM 请求时间倒序（最近的在最前）
  const sorted = [...entries].sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));

  const regressions = sorted.filter((e) => e.changeClass === "regressed");
  const needsReview = sorted.filter((e) => e.changeClass === "needs_review");
  const newEntries = sorted.filter((e) => e.changeClass === "new");
  const proxyWithoutJsonl = sorted.filter((e) => e.reasons.includes("proxy_without_jsonl"));
  const failed = sorted.filter((e) => e.changeClass === "failed");
  const skipped = sorted.filter((e) => e.changeClass === "skipped");

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

  // E0-5：v2 分桶 mini-bar（wireExact + template + ruleMat + pending + unmtRule）
  const v2MiniBar = (v: import("./types").ScorecardV2Summary | undefined): string => {
    if (!v) return `<span style="color:#94a3b8">-</span>`;
    const pct = (n: number) => (n * 100).toFixed(0);
    const wire = v.wireExactCoverage;
    const tmpl = v.templateCoverage;
    const pend = v.pendingRuleCoverage ?? 0;
    const risk = v.regexOverreachRisk;
    const ruleMatPct = v.ruleMaterializedCoverage !== undefined ? pct(v.ruleMaterializedCoverage) : "-";
    const pendFlag = pend > 0.3 ? `<span style="color:#f59e0b" title="pending ${pct(pend)}%">⚠</span>` : "";
    const riskFlag = risk > 0.6 ? `<span style="color:#ef4444" title="regex risk ${pct(risk)}%">⚠</span>` : "";
    const fbStr = v.proxyScalarFallbackCount !== undefined ? ` fb:${v.proxyScalarFallbackCount}` : "";
    const unmtStr = v.unmaterializedRuleCount !== undefined ? ` unmt:${v.unmaterializedRuleCount}` : "";
    return `<span title="wire:${pct(wire)}% tmpl:${pct(tmpl)}% ruleMat:${ruleMatPct}% attrOnly:${pct(v.attributionOnlyCoverage)}% unexplained:${pct(v.unexplainedCoverage)}%${fbStr}${unmtStr}">`
      + `<span style="color:#22c55e">${pct(wire)}%</span>`
      + `<span style="color:#94a3b8">+${pct(tmpl)}%</span>`
      + `<span style="color:#a78bfa" title="rule materialized (template+presence)"> mat:${ruleMatPct}%</span>`
      + `${pendFlag}${riskFlag}`
      + `</span>`;
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
    const fusionLink = e.reconcileFusionHtmlPath
      ? `<a href="${esc(e.reconcileFusionHtmlPath)}" title="融合视图：coverage 分桶 + 四视角对比" style="color:#10b981;font-weight:600">fusion</a>`
      : "";
    const parserLink = e.parserViewPath
      ? `<a href="${esc(e.parserViewPath)}" title="parser-view：新 parser 切分结果" style="color:#f59e0b;font-weight:600">parser</a>`
      : "";
    // reconstruct2 第一阶段产物：纯 JSONL → MutationView 静态页面
    const mutationLink = e.mutationViewPath
      ? `<a href="${esc(e.mutationViewPath)}" title="mutation-view：JSONL line ledger / frames / dropped" style="color:#0ea5e9;font-weight:600">mutation</a>`
      : "";
    const reasons = esc(e.reasons.join(", "));
    return `<tr>
      <td>${verdict}</td>
      <td style="color:${verdictColor(e.changeClass)}">${esc(e.changeClass)}</td>
      <td>${queryKindBadge(e.queryKind)}</td>
      <td><code>${esc(e.sessionId.slice(0, 8))}…/${esc(e.queryId.slice(0, 20))}</code></td>
      <td>${v2MiniBar(e.v2)}</td>
      <td>${reasons}</td>
      <td>${reportLink} ${scLink} ${diffLink} ${attrLink} ${fusionLink} ${parserLink} ${mutationLink}</td>
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
<tr><th>verdict</th><th>changeClass</th><th>type</th><th>session/query</th><th>coverage (wire/legacy)</th><th>reasons</th><th>links <span style="color:#8b5cf6;font-weight:400">(attr=三列视图)</span> <span style="color:#10b981;font-weight:400">(fusion=融合视图)</span> <span style="color:#f59e0b;font-weight:400">(parser=新切分)</span> <span style="color:#0ea5e9;font-weight:400">(mutation=JSONL视图)</span></th></tr>
${regressions.map(renderRow).join("\n")}
</table>` : ""}

${needsReview.length > 0 ? `
<h2>Needs Review (${needsReview.length})</h2>
<table>
<tr><th>verdict</th><th>changeClass</th><th>type</th><th>session/query</th><th>coverage</th><th>reasons</th><th>links <span style="color:#f59e0b;font-weight:400">(parser=新切分)</span> <span style="color:#0ea5e9;font-weight:400">(mutation=JSONL视图)</span></th></tr>
${needsReview.map(renderRow).join("\n")}
</table>` : ""}

${newEntries.length > 0 ? `
<h2>New Proxy Queries (${newEntries.length})</h2>
<table>
<tr><th>verdict</th><th>changeClass</th><th>type</th><th>session/query</th><th>coverage</th><th>reasons</th><th>links <span style="color:#f59e0b;font-weight:400">(parser=新切分)</span> <span style="color:#0ea5e9;font-weight:400">(mutation=JSONL视图)</span></th></tr>
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
<tr><th>verdict</th><th>changeClass</th><th>type</th><th>session/query</th><th>coverage</th><th>reasons</th><th>links <span style="color:#f59e0b;font-weight:400">(parser=新切分)</span> <span style="color:#0ea5e9;font-weight:400">(mutation=JSONL视图)</span></th></tr>
${failed.map(renderRow).join("\n")}
</table>` : ""}

<h2>All Queries (${sorted.length})</h2>
<table>
<tr><th>verdict</th><th>changeClass</th><th>type</th><th>session/query</th><th>coverage</th><th>reasons</th><th>links <span style="color:#f59e0b;font-weight:400">(parser=新切分)</span> <span style="color:#0ea5e9;font-weight:400">(mutation=JSONL视图)</span></th></tr>
${sorted.map(renderRow).join("\n")}
</table>

</body>
</html>`;

  writeFileSync(join(runDir(runId), "index.html"), html, "utf-8");
}
