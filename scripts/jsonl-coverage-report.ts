#!/usr/bin/env node
// jsonl-coverage-report.ts
//
// 用法：
//   npx tsx scripts/jsonl-coverage-report.ts [--out path/to/report.html]
//
// 输出：静态 HTML 报告，包含：
//   1. JSONL event type 分布图（实际出现次数）
//   2. Sourcemap 全量 type 列表 + 哪些我们还没见过（盲区）
//   3. Proxy dump 请求统计 + 能覆盖哪些 event
//   4. 贪心选出最少 session 覆盖最多 type 的推荐列表

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanAllJsonl } from "../server/src/mutation/coverage/scan-jsonl";
import { scanProxyTraffic } from "../server/src/mutation/coverage/scan-proxy";
import { selectCoveringSessions } from "../server/src/mutation/coverage/select-sessions";
import { SOURCEMAP_TYPES, SSE_EVENT_TYPES } from "../server/src/mutation/coverage/sourcemap-types";

// ── CLI args ──────────────────────────────────────────────────────────────────
const outArg = process.argv.indexOf("--out");
const outPath =
  outArg !== -1 && process.argv[outArg + 1]
    ? process.argv[outArg + 1]
    : join(import.meta.dirname ?? __dirname, "jsonl-coverage-report.html");

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("Scanning JSONL files…");
const jsonlResult = await scanAllJsonl();

console.log("Scanning proxy traffic…");
const proxyResult = await scanProxyTraffic();

console.log("Computing coverage…");

// Build full key universe: sourcemap keys + any extra keys seen live
const sourcemapKeys = new Set(SOURCEMAP_TYPES.map((t) => t.key));
const liveKeys = new Set(jsonlResult.globalTypeCounts.keys());
const allKnownKeys = [
  ...SOURCEMAP_TYPES.map((t) => t.key),
  ...[...liveKeys].filter((k) => !sourcemapKeys.has(k)),
];

// Coverage gaps: keys in sourcemap but count=0 in live scans
const missingKeys = SOURCEMAP_TYPES.filter(
  (t) => !jsonlResult.globalTypeCounts.has(t.key),
).map((t) => t.key);

// Greedy session selection (max 8 sessions)
const selection = selectCoveringSessions(jsonlResult.sessions, allKnownKeys, 8);

// Proxy SSE event coverage
const proxySseTypes = proxyResult.allSseEventTypes;
const missingSseTypes = SSE_EVENT_TYPES.filter((t) => !proxySseTypes.has(t));

// Recent proxy files (last 10)
const recentProxyFiles = proxyResult.files.slice(-10).reverse();

// ── HTML generation ───────────────────────────────────────────────────────────
const NOW = new Date().toISOString();

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badge(text: string, color: string): string {
  return `<span class="badge" style="background:${color}">${esc(text)}</span>`;
}

// Distribution bar chart data (top 50 by count)
const topTypes = [...jsonlResult.globalTypeCounts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 50);
const maxCount = topTypes[0]?.[1] ?? 1;

function distRow(key: string, count: number): string {
  const pct = (count / maxCount) * 100;
  const smEntry = SOURCEMAP_TYPES.find((t) => t.key === key);
  const catColor: Record<string, string> = {
    transcript: "#4f9cf9",
    meta: "#a78bfa",
    runtime: "#34d399",
    system_sub: "#f59e0b",
    attachment_sub: "#f87171",
  };
  const color = catColor[smEntry?.category ?? ""] ?? "#94a3b8";
  return `
    <tr>
      <td class="key-cell"><code>${esc(smEntry?.label ?? key)}</code></td>
      <td class="cat-cell">${smEntry ? `<span class="cat-dot" style="background:${color}"></span>${esc(smEntry.category)}` : '<span style="color:#94a3b8">unknown</span>'}</td>
      <td class="bar-cell">
        <div class="bar-wrap"><div class="bar" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>
      </td>
      <td class="count-cell">${count.toLocaleString()}</td>
    </tr>`;
}

// Type coverage table
function coverageRow(entry: (typeof SOURCEMAP_TYPES)[0]): string {
  const count = jsonlResult.globalTypeCounts.get(entry.key) ?? 0;
  const seen = count > 0;
  const catColor: Record<string, string> = {
    transcript: "#4f9cf9",
    meta: "#a78bfa",
    runtime: "#34d399",
    system_sub: "#f59e0b",
    attachment_sub: "#f87171",
  };
  const color = catColor[entry.category] ?? "#94a3b8";
  const srcBadge =
    entry.source === "sourcemap"
      ? badge("sourcemap-only", "#64748b")
      : entry.source === "both"
        ? badge("both", "#22c55e")
        : badge("live-only", "#f59e0b");
  const unionBadge = entry.inLogsUnion ? badge("logs.ts", "#6366f1") : "";
  const example = jsonlResult.examples.get(entry.key);
  const exHtml = example
    ? `<pre class="example-pre">${esc(example)}</pre>`
    : '<span class="dimmed">no example</span>';
  return `
    <tr class="${seen ? "" : "unseen-row"}">
      <td><span class="status-dot" style="background:${seen ? "#22c55e" : "#ef4444"}"></span></td>
      <td><code>${esc(entry.label)}</code></td>
      <td><span class="cat-dot" style="background:${color}"></span>${esc(entry.category)}</td>
      <td>${srcBadge} ${unionBadge}</td>
      <td>${seen ? count.toLocaleString() : '<span class="dimmed">—</span>'}</td>
      <td class="desc-cell">${esc(entry.description ?? "")}</td>
      <td class="example-cell">${exHtml}</td>
    </tr>`;
}

// Session coverage table
function sessionRow(s: (typeof selection.selectedSessions)[0], rank: number): string {
  const date = new Date(s.modifiedAt).toISOString().slice(0, 19).replace("T", " ");
  const kb = (s.sizeBytes / 1024).toFixed(1);
  const allKeys = [...s.typesPresent, ...s.subTypesPresent];
  const badges = allKeys
    .slice(0, 12)
    .map((k) => {
      const sm = SOURCEMAP_TYPES.find((t) => t.key === k);
      return `<code class="type-chip">${esc(sm?.label ?? k)}</code>`;
    })
    .join(" ");
  const more = allKeys.length > 12 ? `<span class="dimmed"> +${allKeys.length - 12} more</span>` : "";
  return `
    <tr>
      <td style="text-align:center;font-weight:bold">#${rank}</td>
      <td><code class="session-id">${esc(s.sessionId)}</code></td>
      <td class="dimmed">${esc(date)}</td>
      <td class="dimmed">${kb} KB</td>
      <td style="text-align:center">${allKeys.length}</td>
      <td>${badges}${more}</td>
    </tr>`;
}

// Proxy files table
function proxyFileRow(f: (typeof recentProxyFiles)[0]): string {
  const name = f.filePath.split("/").pop() ?? f.filePath;
  const sseList = [...f.sseEventTypes].sort().map((t) => `<code class="type-chip">${esc(t)}</code>`).join(" ");
  return `
    <tr>
      <td><code class="dimmed">${esc(name)}</code></td>
      <td style="text-align:right">${f.responseCount.toLocaleString()}</td>
      <td style="text-align:right">${f.sseEventCount.toLocaleString()}</td>
      <td>${sseList || '<span class="dimmed">—</span>'}</td>
    </tr>`;
}

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JSONL Coverage Report — ${NOW.slice(0, 10)}</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2d3148;
    --text: #e2e8f0;
    --dimmed: #64748b;
    --accent: #4f9cf9;
    color-scheme: dark;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.5; padding: 24px; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 16px; font-weight: 600; margin: 32px 0 12px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h3 { font-size: 14px; font-weight: 600; margin: 20px 0 8px; color: #94a3b8; }
  .meta { color: var(--dimmed); font-size: 12px; margin-bottom: 24px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px,1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; }
  .stat-card .val { font-size: 28px; font-weight: 700; color: var(--accent); }
  .stat-card .lbl { font-size: 11px; color: var(--dimmed); margin-top: 2px; text-transform: uppercase; letter-spacing: .05em; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: var(--surface); color: var(--dimmed); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
  td { padding: 7px 10px; border-bottom: 1px solid #1e2133; vertical-align: top; }
  tr:hover td { background: #171a26; }
  .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 24px; }
  .unseen-row td { opacity: .7; }
  .unseen-row:hover td { opacity: 1; }
  code { font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 12px; background: #1e2235; padding: 1px 5px; border-radius: 3px; }
  .session-id { font-size: 11px; color: var(--dimmed); }
  .type-chip { background: #252a3d; color: #a5b4fc; font-size: 11px; padding: 1px 5px; border-radius: 3px; display: inline-block; margin: 1px 2px; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 10px; color: white; display: inline-block; }
  .cat-dot, .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; flex-shrink: 0; }
  .bar-wrap { background: #1e2235; border-radius: 4px; height: 14px; overflow: hidden; min-width: 80px; }
  .bar { height: 100%; border-radius: 4px; transition: width .3s; }
  .bar-cell { min-width: 120px; }
  .count-cell { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dimmed { color: var(--dimmed); }
  .key-cell { white-space: nowrap; }
  .cat-cell { white-space: nowrap; }
  .desc-cell { color: #94a3b8; font-size: 12px; max-width: 260px; }
  .example-cell { max-width: 340px; }
  .example-pre { font-size: 10px; max-height: 100px; overflow: auto; background: #12141f; padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; }
  .legend { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
  .legend-item { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dimmed); }
  .coverage-bar-wrap { background: #1e2235; border-radius: 6px; height: 18px; overflow: hidden; max-width: 400px; margin: 8px 0 20px; }
  .coverage-bar { height: 100%; background: linear-gradient(90deg, #22c55e, #4f9cf9); border-radius: 6px; display: flex; align-items: center; padding-left: 8px; font-size: 11px; font-weight: 600; color: white; }
  .section-desc { color: var(--dimmed); font-size: 12px; margin: -6px 0 12px; }
  .proxy-legend { font-size: 12px; color: var(--dimmed); margin-bottom: 12px; }
  .gap-list { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 16px; }
  .gap-chip { background: #2a1515; border: 1px solid #7f1d1d; color: #fca5a5; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-family: monospace; }
</style>
</head>
<body>

<h1>JSONL Event Coverage Report</h1>
<div class="meta">Generated: ${NOW} &nbsp;·&nbsp; ${jsonlResult.allFiles.length} JSONL files scanned &nbsp;·&nbsp; ${jsonlResult.sessions.length} sessions</div>

<!-- ── Stats ─────────────────────────────────────────────────────────────────── -->
<div class="stats-grid">
  <div class="stat-card"><div class="val">${jsonlResult.globalTypeCounts.size}</div><div class="lbl">Live type keys</div></div>
  <div class="stat-card"><div class="val">${SOURCEMAP_TYPES.length}</div><div class="lbl">Sourcemap types</div></div>
  <div class="stat-card"><div class="val">${missingKeys.length}</div><div class="lbl">Unseen types (gap)</div></div>
  <div class="stat-card"><div class="val">${proxyResult.files.length}</div><div class="lbl">Proxy dump files</div></div>
  <div class="stat-card"><div class="val">${proxyResult.totalSseEvents.toLocaleString()}</div><div class="lbl">SSE events captured</div></div>
  <div class="stat-card"><div class="val">${selection.selectedSessions.length}</div><div class="lbl">Sessions selected</div></div>
</div>

<!-- ── Section 1: Distribution ───────────────────────────────────────────────── -->
<h2>§1 · JSONL Event Type Distribution</h2>
<p class="section-desc">All event type keys observed across ${jsonlResult.allFiles.length} local JSONL files, sorted by frequency.</p>
<div class="legend">
  ${[["#4f9cf9","transcript"],["#a78bfa","meta"],["#34d399","runtime"],["#f59e0b","system_sub"],["#f87171","attachment_sub"]].map(([c,l]) => `<div class="legend-item"><span class="cat-dot" style="background:${c}"></span>${l}</div>`).join("")}
</div>
<div class="table-wrap">
<table>
  <thead><tr><th>Key</th><th>Category</th><th>Distribution</th><th>Count</th></tr></thead>
  <tbody>
  ${topTypes.map(([k, c]) => distRow(k, c)).join("")}
  </tbody>
</table>
</div>

<!-- ── Section 2: Sourcemap Coverage ────────────────────────────────────────── -->
<h2>§2 · Sourcemap Type Coverage</h2>
<p class="section-desc">All types defined in sourcemap <code>logs.ts</code> or observed in live scans. Red rows = never seen locally (blind spots).</p>

${
  missingKeys.length > 0
    ? `<h3>Missing types (${missingKeys.length} blind spots)</h3>
<div class="gap-list">
${missingKeys.map((k) => {
  const sm = SOURCEMAP_TYPES.find((t) => t.key === k);
  return `<span class="gap-chip">${esc(sm?.label ?? k)}</span>`;
}).join("")}
</div>`
    : `<p style="color:#22c55e;margin-bottom:16px">All sourcemap types observed locally!</p>`
}

<div class="table-wrap">
<table>
  <thead><tr><th>✓</th><th>Key</th><th>Category</th><th>Source</th><th>Count</th><th>Description</th><th>Example</th></tr></thead>
  <tbody>
  ${SOURCEMAP_TYPES.map(coverageRow).join("")}
  </tbody>
</table>
</div>

<!-- ── Section 3: Proxy Coverage ────────────────────────────────────────────── -->
<h2>§3 · Proxy Dump Coverage</h2>
<p class="section-desc">Which JSONL event types can be cross-referenced or reconstructed from proxy requests. Proxy captures the actual API call — SSE events correspond to model turns (<code>assistant</code>) with tool use / text content.</p>

<div class="proxy-legend">
  <strong>Proxy → JSONL mapping:</strong>
  proxy <code>sse_event/message_start</code> → JSONL <code>assistant</code> turn start &nbsp;|&nbsp;
  proxy <code>sse_event/content_block_delta</code> → assistant text/thinking content &nbsp;|&nbsp;
  proxy <code>response kind=response</code> → one full assistant turn (token counts, model, stop_reason) &nbsp;|&nbsp;
  proxy <code>request</code> → preceding <code>user</code> message + prior context
</div>

<h3>SSE Event Types Captured by Proxy</h3>
<div class="legend">
  ${SSE_EVENT_TYPES.map((t) => {
    const seen = proxySseTypes.has(t);
    return `<div class="legend-item"><span class="status-dot" style="background:${seen ? "#22c55e" : "#ef4444"}"></span><code>${esc(t)}</code></div>`;
  }).join("")}
</div>
${missingSseTypes.length > 0 ? `<p class="dimmed">Not yet captured: ${missingSseTypes.map((t) => `<code>${esc(t)}</code>`).join(", ")}</p>` : '<p style="color:#22c55e">All SSE event types captured!</p>'}

<h3>Recent Proxy Files (last ${recentProxyFiles.length})</h3>
<div class="table-wrap">
<table>
  <thead><tr><th>File</th><th>Responses</th><th>SSE Events</th><th>SSE Types</th></tr></thead>
  <tbody>
  ${recentProxyFiles.map(proxyFileRow).join("")}
  </tbody>
</table>
</div>

<h3>JSONL Types Coverable by Proxy Dump</h3>
<div class="gap-list">
  ${["user","assistant","system::subtype::api_error"].map((k) => {
    const sm = SOURCEMAP_TYPES.find((t) => t.key === k);
    return `<span class="gap-chip" style="background:#0f2a1a;border-color:#166534;color:#86efac">${esc(sm?.label ?? k)}</span>`;
  }).join("")}
</div>
<p class="dimmed">Meta types (ai-title, last-prompt, permission-mode, etc.) are written by the client after the turn and cannot be recovered from proxy alone.</p>

<!-- ── Section 4: Recommended Sessions ──────────────────────────────────────── -->
<h2>§4 · Greedy Session Selection</h2>
<p class="section-desc">Minimum sessions needed to cover the maximum number of event-type keys. Selection stops at 8 sessions.</p>

<div class="coverage-bar-wrap">
  <div class="coverage-bar" style="width:${selection.coveragePercent.toFixed(1)}%">
    ${selection.coveragePercent.toFixed(1)}% (${selection.coveredKeys.size} / ${allKnownKeys.length} keys)
  </div>
</div>

${selection.uncoveredKeys.length > 0 ? `
<h3>Still uncovered after selection (${selection.uncoveredKeys.length})</h3>
<div class="gap-list">
${selection.uncoveredKeys.map((k) => {
  const sm = SOURCEMAP_TYPES.find((t) => t.key === k);
  return `<span class="gap-chip">${esc(sm?.label ?? k)}</span>`;
}).join("")}
</div>` : `<p style="color:#22c55e;margin-bottom:12px">All known keys covered by the selected sessions!</p>`}

<div class="table-wrap">
<table>
  <thead><tr><th>#</th><th>Session ID</th><th>Modified</th><th>Size</th><th>Keys</th><th>Types Present</th></tr></thead>
  <tbody>
  ${selection.selectedSessions.map((s, i) => sessionRow(s, i + 1)).join("")}
  </tbody>
</table>
</div>

<div class="meta" style="margin-top:32px">Report generated by <code>scripts/jsonl-coverage-report.ts</code></div>
</body>
</html>`;

writeFileSync(outPath, html, "utf8");
console.log(`\nReport written to: ${outPath}`);
console.log(`Sessions scanned: ${jsonlResult.sessions.length}`);
console.log(`Type keys (live): ${jsonlResult.globalTypeCounts.size}`);
console.log(`Sourcemap types: ${SOURCEMAP_TYPES.length}`);
console.log(`Missing (blind spots): ${missingKeys.length}`);
console.log(`Coverage (greedy ${selection.selectedSessions.length} sessions): ${selection.coveragePercent.toFixed(1)}%`);
