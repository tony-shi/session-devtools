// render-char-diff-html.ts — Gate 3.5 Alignment Precision Audit
//
// Renders a CharDiffReport as a self-contained HTML page for manual inspection.
// No external dependencies; pure string generation.

import type { CharDiffReport, CharDiffSummary, SegmentDiffEntry, SegmentText } from "./char-diff";

const KIND_COLORS: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  matched_exact:      { bg: "#f0fdf4", border: "#86efac", text: "#166534", badge: "#22c55e" },
  matched_char_diff:  { bg: "#fffbeb", border: "#fcd34d", text: "#92400e", badge: "#f59e0b" },
  expected_only:      { bg: "#eff6ff", border: "#93c5fd", text: "#1e40af", badge: "#3b82f6" },
  proxy_only:         { bg: "#fef2f2", border: "#fca5a5", text: "#991b1b", badge: "#ef4444" },
  attribution_only:   { bg: "#fdf4ff", border: "#d8b4fe", text: "#6b21a8", badge: "#a855f7" },
  known_noise:        { bg: "#f9fafb", border: "#d1d5db", text: "#6b7280", badge: "#9ca3af" },
};

const KIND_LABELS: Record<string, string> = {
  matched_exact:     "matched exact",
  matched_char_diff: "matched (char diff)",
  expected_only:     "expected only",
  proxy_only:        "proxy only (unattributed)",
  attribution_only:  "server-side attribution",
  known_noise:       "known non-user-semantic",
};

export function renderCharDiffHtml(report: CharDiffReport): string {
  const title = `Context Char Diff — ${report.queryId}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: ui-monospace, "Cascadia Code", "Fira Code", monospace; font-size: 13px; background: #f8fafc; color: #1e293b; }
.page { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
.meta { color: #64748b; font-size: 11px; margin-bottom: 20px; }
.summary-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin-bottom: 24px; }
.stat-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 14px; }
.stat-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.stat-value { font-size: 20px; font-weight: 700; color: #0f172a; }
.stat-sub { font-size: 10px; color: #94a3b8; margin-top: 2px; }
.legend { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.legend-item { display: flex; align-items: center; gap: 5px; font-size: 11px; }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.section-header { font-size: 12px; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.08em; margin: 20px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
.entry { border-radius: 6px; border: 1px solid; padding: 10px 12px; margin-bottom: 8px; }
.entry-header { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 6px; }
.badge { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px; color: #fff; white-space: nowrap; flex-shrink: 0; }
.entry-label { font-weight: 600; font-size: 13px; flex: 1; word-break: break-all; }
.entry-category { font-size: 10px; color: #64748b; margin-left: auto; white-space: nowrap; padding-left: 8px; }
.ranges { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 6px; }
.range-block { font-size: 11px; }
.range-label { color: #64748b; margin-right: 4px; }
.range-value { font-family: ui-monospace, monospace; background: #f1f5f9; padding: 1px 5px; border-radius: 3px; }
.char-delta { font-size: 11px; margin-bottom: 6px; }
.char-delta.positive { color: #0369a1; }
.char-delta.negative { color: #b91c1c; }
.char-delta.zero { color: #64748b; }
.notes { list-style: none; }
.notes li { font-size: 11px; color: #475569; padding: 1px 0; }
.notes li::before { content: "› "; color: #94a3b8; }
.ids { font-size: 10px; color: #94a3b8; margin-top: 4px; word-break: break-all; }
.bar-wrap { background: #e2e8f0; border-radius: 4px; height: 8px; overflow: hidden; margin: 12px 0 4px; }
.bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
.bar-label { font-size: 10px; color: #64748b; text-align: right; }
/* expandable text */
.expand-row { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.expand-col { flex: 1; min-width: 240px; }
.expand-toggle { font-size: 11px; color: #3b82f6; cursor: pointer; user-select: none; padding: 2px 0; display: flex; align-items: center; gap: 4px; }
.expand-toggle:hover { color: #1d4ed8; }
.expand-toggle .arrow { font-size: 9px; transition: transform 0.15s; display: inline-block; }
.expand-toggle.open .arrow { transform: rotate(90deg); }
.expand-col-label { font-size: 10px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }
.expand-body { display: none; margin-top: 4px; }
.expand-body.open { display: block; }
.expand-text { white-space: pre-wrap; word-break: break-all; font-size: 11px; line-height: 1.5; background: #0f172a; color: #e2e8f0; padding: 10px 12px; border-radius: 5px; max-height: 400px; overflow-y: auto; }
.expand-no-text { font-size: 11px; color: #94a3b8; font-style: italic; padding: 6px 0; }
</style>
</head>
<body>
<div class="page">
  <h1>${esc(title)}</h1>
  <div class="meta">session: ${esc(report.sessionId)} · generated: ${esc(report.generatedAt)} · expected flat: ${report.expectedFlatChars.toLocaleString()} chars · proxy flat: ${report.proxyFlatChars.toLocaleString()} chars</div>

  ${renderSummaryCards(report.summary)}
  ${renderCoverageBar(report.summary)}
  ${renderLegend()}
  ${renderEntries(report.entries)}
</div>
<script>
document.addEventListener('click', function(e) {
  const toggle = e.target.closest('.expand-toggle');
  if (!toggle) return;
  const col = toggle.closest('.expand-col');
  if (!col) return;
  const body = col.querySelector('.expand-body');
  if (!body) return;
  const isOpen = body.classList.toggle('open');
  toggle.classList.toggle('open', isOpen);
});
</script>
</body>
</html>`;
}

function renderSummaryCards(s: CharDiffSummary): string {
  const cards = [
    { label: "Proxy Chars", value: s.totalProxyChars.toLocaleString(), sub: "denominator (proxy ground truth)" },
    { label: "Expected Chars", value: s.totalExpectedChars.toLocaleString(), sub: "reconstructed from JSONL/rules" },
    // evidenceBackedCoverage：内容锚点覆盖比例（不含纯归因）
    { label: "Evidence-Backed", value: `${(s.evidenceBackedCoverage * 100).toFixed(1)}%`, sub: `of proxy chars (matched_exact + char_diff)` },
    // attributionCoverage：server-side attribution 覆盖比例（含 evidence-backed）
    { label: "Attribution Cov.", value: `${(s.attributionCoverage * 100).toFixed(1)}%`, sub: `incl. server-side attribution` },
    // attributionOnlyGap：归因知晓但无内容锚点的 gap
    { label: "Attribution Gap", value: `${(s.attributionOnlyGap * 100).toFixed(1)}%`, sub: `attribution - evidence-backed` },
    // unexplainedProxyChars：unattributed proxy（proxy_only + suspect_match），不含 attribution_only/known_noise
    { label: "Unattributed", value: s.unexplainedProxyChars.toLocaleString(), sub: `${pct(s.unexplainedProxyChars, s.totalProxyChars)}% of proxy (proxy_only + suspect)` },
    { label: "Suspect Match", value: s.suspectMatch, sub: `${s.suspectMatchChars.toLocaleString()} chars (no content anchor)` },
    // alignedTextDrift：已对齐段的字符漂移，=0 仅表示 aligned 无漂移，不代表 proxy==expected
    { label: "Aligned Drift", value: `${(s.alignedTextDrift * 100).toFixed(2)}%`, sub: `of proxy chars (aligned segments only)` },
    { label: "Total Entries", value: s.totalEntries, sub: "" },
    { label: "Matched Exact", value: s.matchedExact, sub: `${pct(s.matchedExact, s.totalEntries)}%` },
    { label: "Known Non-User-Semantic", value: s.knownNoise, sub: "server-side billing/infra (not unexplained)" },
  ];
  return `<div class="summary-grid">${cards.map((c) => `
    <div class="stat-card">
      <div class="stat-label">${esc(c.label)}</div>
      <div class="stat-value">${esc(String(c.value))}</div>
      ${c.sub ? `<div class="stat-sub">${esc(c.sub)}</div>` : ""}
    </div>`).join("")}
  </div>`;
}

function renderCoverageBar(s: CharDiffSummary): string {
  // 三段堆叠：evidence-backed（绿）/ attribution-only gap（紫）/ unattributed（红）
  const evidencePct = s.evidenceBackedCoverage * 100;
  const attrGapPct = s.attributionOnlyGap * 100;
  const unattributedPct = s.totalProxyChars > 0
    ? (s.unexplainedProxyChars / s.totalProxyChars) * 100
    : 0;

  return `
  <div>
    <div class="section-header">Proxy Char Coverage</div>
    <div style="font-size:11px;color:#64748b;margin-bottom:4px;">
      分母 = proxy chars (${s.totalProxyChars.toLocaleString()})；
      char diff = 0 仅表示 aligned 段无漂移，不代表 proxy == expected
    </div>
    <div class="bar-wrap" style="height:12px;position:relative;">
      <div class="bar-fill" style="width:${evidencePct.toFixed(2)}%;background:#22c55e;position:absolute;left:0;top:0;height:100%;"></div>
      <div class="bar-fill" style="width:${attrGapPct.toFixed(2)}%;background:#a855f7;position:absolute;left:${evidencePct.toFixed(2)}%;top:0;height:100%;"></div>
      <div class="bar-fill" style="width:${unattributedPct.toFixed(2)}%;background:#ef4444;position:absolute;left:${(evidencePct + attrGapPct).toFixed(2)}%;top:0;height:100%;"></div>
    </div>
    <div class="bar-label" style="display:flex;gap:16px;flex-wrap:wrap;margin-top:4px;">
      <span style="color:#22c55e">■ evidence-backed ${evidencePct.toFixed(1)}%</span>
      <span style="color:#a855f7">■ attribution-only gap ${attrGapPct.toFixed(1)}%</span>
      <span style="color:#ef4444">■ unattributed ${unattributedPct.toFixed(1)}% (${s.unexplainedProxyChars.toLocaleString()} chars)</span>
    </div>
  </div>`;
}

function renderLegend(): string {
  return `<div class="legend">${Object.entries(KIND_COLORS).map(([kind, c]) => `
    <div class="legend-item">
      <div class="legend-dot" style="background:${c.badge}"></div>
      <span>${esc(KIND_LABELS[kind] ?? kind)}</span>
    </div>`).join("")}
  </div>`;
}

function renderEntries(entries: SegmentDiffEntry[]): string {
  if (entries.length === 0) return `<div class="section-header">No entries</div>`;

  // Group by kind for readability
  const groups: Record<string, SegmentDiffEntry[]> = {};
  for (const e of entries) {
    (groups[e.kind] ??= []).push(e);
  }

  const kindOrder: string[] = [
    "matched_char_diff",
    "proxy_only",
    "expected_only",
    "attribution_only",
    "matched_exact",
    "known_noise",
  ];

  const sections: string[] = [];
  for (const kind of kindOrder) {
    const group = groups[kind];
    if (!group || group.length === 0) continue;
    const label = KIND_LABELS[kind] ?? kind;
    sections.push(`
    <div class="section-header">${esc(label)} (${group.length})</div>
    ${group.map((e) => renderEntry(e)).join("\n")}`);
  }

  // Any remaining kinds not in kindOrder
  for (const [kind, group] of Object.entries(groups)) {
    if (kindOrder.includes(kind)) continue;
    sections.push(`
    <div class="section-header">${esc(kind)} (${group.length})</div>
    ${group.map((e) => renderEntry(e)).join("\n")}`);
  }

  return sections.join("\n");
}

function renderEntry(e: SegmentDiffEntry): string {
  const c = KIND_COLORS[e.kind] ?? KIND_COLORS["known_noise"];
  const badgeLabel = KIND_LABELS[e.kind] ?? e.kind;

  const rangesHtml = renderRanges(e);
  const deltaHtml = renderCharDelta(e);
  const notesHtml = e.notes.length > 0
    ? `<ul class="notes">${e.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
    : "";
  const idsHtml = renderIds(e);
  const expandHtml = renderExpandable(e);

  return `<div class="entry" style="background:${c.bg};border-color:${c.border}">
  <div class="entry-header">
    <span class="badge" style="background:${c.badge}">${esc(badgeLabel)}</span>
    <span class="entry-label" style="color:${c.text}">${esc(e.label)}</span>
    <span class="entry-category">${esc(e.category)}</span>
  </div>
  ${rangesHtml}
  ${deltaHtml}
  ${notesHtml}
  ${idsHtml}
  ${expandHtml}
</div>`;
}

function renderExpandable(e: SegmentDiffEntry): string {
  const hasSomething = (e.expectedTexts?.length ?? 0) > 0 || (e.proxyTexts?.length ?? 0) > 0;
  if (!hasSomething) return "";

  const cols: string[] = [];

  if (e.expectedTexts && e.expectedTexts.length > 0) {
    cols.push(renderExpandCol("expected", e.expectedTexts));
  }
  if (e.proxyTexts && e.proxyTexts.length > 0) {
    cols.push(renderExpandCol("proxy", e.proxyTexts));
  }

  return `<div class="expand-row">${cols.join("")}</div>`;
}

function renderExpandCol(side: string, texts: SegmentText[]): string {
  const totalChars = texts.reduce((s, t) => s + t.chars, 0);
  const hasAnyText = texts.some((t) => t.text !== undefined);

  const bodyContent = texts.map((t) => {
    if (t.text !== undefined) {
      return `<pre class="expand-text">${esc(t.text)}</pre>`;
    }
    return `<div class="expand-no-text">${esc(t.label)} — ${t.chars.toLocaleString()} chars (no inline text)</div>`;
  }).join("");

  const hint = hasAnyText ? `${totalChars.toLocaleString()} chars` : `${totalChars.toLocaleString()} chars · no text`;

  return `<div class="expand-col">
  <div class="expand-col-label">${esc(side)}</div>
  <div class="expand-toggle"><span class="arrow">▶</span> show ${esc(hint)}</div>
  <div class="expand-body">${bodyContent}</div>
</div>`;
}

function renderRanges(e: SegmentDiffEntry): string {
  const parts: string[] = [];
  if (e.expectedRange) {
    parts.push(`<span class="range-block"><span class="range-label">expected:</span><span class="range-value">[${e.expectedRange.start}…${e.expectedRange.end}) ${e.expectedRange.chars.toLocaleString()} chars</span></span>`);
  }
  if (e.proxyRange) {
    parts.push(`<span class="range-block"><span class="range-label">proxy:</span><span class="range-value">[${e.proxyRange.start}…${e.proxyRange.end}) ${e.proxyRange.chars.toLocaleString()} chars</span></span>`);
  }
  if (parts.length === 0) return "";
  return `<div class="ranges">${parts.join("")}</div>`;
}

function renderCharDelta(e: SegmentDiffEntry): string {
  if (e.charDelta === undefined) return "";
  const sign = e.charDelta > 0 ? "+" : "";
  const cls = e.charDelta > 0 ? "positive" : e.charDelta < 0 ? "negative" : "zero";
  const pctStr = e.charDeltaPct !== undefined ? ` (${(e.charDeltaPct * 100).toFixed(1)}%)` : "";
  return `<div class="char-delta ${cls}">charDelta: ${sign}${e.charDelta.toLocaleString()}${pctStr}</div>`;
}

function renderIds(e: SegmentDiffEntry): string {
  const parts: string[] = [];
  if (e.alignmentId) parts.push(`align:${e.alignmentId}`);
  if (e.expectedSegmentIds.length > 0) parts.push(`eseg:[${e.expectedSegmentIds.join(",")}]`);
  if (e.proxySegmentIds.length > 0) parts.push(`pseg:[${e.proxySegmentIds.join(",")}]`);
  if (e.findingIds.length > 0) parts.push(`findings:[${e.findingIds.join(",")}]`);
  if (parts.length === 0) return "";
  return `<div class="ids">${esc(parts.join(" · "))}</div>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(n: number, total: number): string {
  if (total === 0) return "0";
  return ((n / total) * 100).toFixed(0);
}
