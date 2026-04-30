// Proxy Attribution View
// 三列独立 HTML，专注于 proxy → parser → attribution 的完整链路。
// 不展示 expected / mutation / reconciliation。
//
// 列定义：
//   左  Raw Context     — 原始 proxy 请求体，按 section 分组，折叠展示 rawText
//   中  Parser Segments — parseClaudeProxyRequest 产出的每个 segment
//   右  Attribution     — inferClaudeProxyAttributions 产出，含 category override / ruleId / notes
//
// 三列通过 segment id 对齐（pseg-* 作为锚点），点击行互相高亮。

import type { ContextSegment, ProxySegmentAttribution } from "../types";

// ── 颜色 / badge 映射 ─────────────────────────────────────────────────────────

const CATEGORY_COLOR: Record<string, string> = {
  billing_noise:        "#6b7280",  // gray
  system_prompt:        "#3b82f6",  // blue
  harness_injection:    "#8b5cf6",  // purple
  tools_schema:         "#f59e0b",  // amber
  tool_use:             "#10b981",  // green
  tool_result:          "#059669",  // emerald
  user_message:         "#0ea5e9",  // sky
  assistant_text:       "#64748b",  // slate
  local_command_history:"#d97706",  // orange
  prior_session_history:"#a78bfa",  // violet
  unknown:              "#ef4444",  // red
};

function categoryColor(cat: string): string {
  return CATEGORY_COLOR[cat] ?? "#94a3b8";
}

function badge(text: string, color: string, title?: string): string {
  const t = title ? ` title="${esc(title)}"` : "";
  return `<span class="badge"${t} style="background:${color}20;color:${color};border:1px solid ${color}40">${esc(text)}</span>`;
}

function confidenceBadge(conf: string): string {
  const colors: Record<string, string> = { exact: "#10b981", estimated: "#f59e0b", inferred: "#94a3b8", unknown: "#ef4444" };
  return badge(conf, colors[conf] ?? "#94a3b8");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

// ── 数据准备 ─────────────────────────────────────────────────────────────────

interface SegmentRow {
  seg: ContextSegment;
  attr: ProxySegmentAttribution | undefined;
}

function buildRows(
  segments: ContextSegment[],
  attributions: ProxySegmentAttribution[],
): SegmentRow[] {
  const attrById = new Map<string, ProxySegmentAttribution>();
  for (const a of attributions) {
    for (const id of a.proxySegmentIds) attrById.set(id, a);
  }
  return segments.map((seg) => ({ seg, attr: attrById.get(seg.id) }));
}

// ── 左列：Raw Context ─────────────────────────────────────────────────────────

function renderRawCell(row: SegmentRow): string {
  const { seg } = row;
  const ref = seg.sourceRefs[0];
  const jsonPath = ref?.kind === "proxy" ? (ref.proxy.jsonPath ?? "?") : "?";
  const charRange = ref?.kind === "proxy" ? ref.proxy.charRange : undefined;
  const rangeStr = charRange ? `[${charRange.start}…${charRange.end})` : "";
  const rawText = seg.rawText ?? "";
  const preview = truncate(rawText.replace(/\n/g, "↵"), 120);

  const hasText = rawText.length > 0;
  const detailId = `raw-detail-${seg.id.replace(/[^a-zA-Z0-9-_]/g, "_")}`;

  return `
    <div class="raw-cell">
      <div class="path-line">
        <code class="path">${esc(jsonPath)}</code>
        ${rangeStr ? `<span class="range">${esc(rangeStr)}</span>` : ""}
        <span class="chars">${seg.charCount ?? 0}c</span>
        ${seg.cacheHint && seg.cacheHint !== "none" ? badge(seg.cacheHint, "#f59e0b") : ""}
      </div>
      ${hasText ? `
        <details id="${detailId}">
          <summary class="raw-preview">${esc(preview)}</summary>
          <pre class="raw-full">${esc(rawText.slice(0, 2000))}${rawText.length > 2000 ? "\n…(truncated)" : ""}</pre>
        </details>
      ` : `<span class="no-text">—</span>`}
    </div>`;
}

// ── 中列：Parser Segments ─────────────────────────────────────────────────────

function renderParserCell(row: SegmentRow): string {
  const { seg } = row;
  const color = categoryColor(seg.category);
  const meta = seg.metadata as Record<string, unknown> | undefined;
  const sectionHeader = typeof meta?.["sectionHeader"] === "string" ? meta["sectionHeader"] : null;

  return `
    <div class="parser-cell">
      <div class="seg-id"><code>${esc(seg.id)}</code></div>
      <div class="seg-meta">
        ${badge(seg.section, "#6b7280")}
        ${badge(seg.category, color)}
        ${seg.lifecycle ? badge(seg.lifecycle, "#94a3b8") : ""}
        ${seg.flags?.includes("large_segment") ? badge("large", "#ef4444") : ""}
        ${seg.flags?.includes("known_noise") ? badge("noise", "#6b7280") : ""}
      </div>
      ${sectionHeader ? `<div class="section-header">§ ${esc(sectionHeader)}</div>` : ""}
      ${seg.toolUseId ? `<div class="tool-id"><code>${esc(seg.toolUseId)}</code></div>` : ""}
    </div>`;
}

// ── 右列：Attribution ─────────────────────────────────────────────────────────

function renderAttrCell(row: SegmentRow): string {
  const { attr, seg } = row;
  if (!attr) {
    return `<div class="attr-cell attr-missing"><span class="no-attr">— no attribution —</span></div>`;
  }

  const color = categoryColor(attr.category);
  // parser の保守 category（system_prompt / user_message / assistant_text）は
  // attribution が変えることが設計上想定された占位値なので "override" とは呼ばない。
  // wire schema で確定した category（tool_use / tool_result / tools_schema）を
  // attribution が変えた場合のみ本当の override として表示する。
  const PARSER_AUTHORITATIVE = new Set(["tool_use", "tool_result", "tools_schema"]);
  const categoryMismatch =
    attr.category !== seg.category && PARSER_AUTHORITATIVE.has(seg.category);

  return `
    <div class="attr-cell ${categoryMismatch ? "category-override" : ""}">
      <div class="attr-category">
        ${badge(attr.category, color)}
        ${categoryMismatch ? `<span class="override-hint" title="parser: ${esc(seg.category)}">← override</span>` : ""}
      </div>
      <div class="attr-meta">
        <code class="mechanism">${esc(attr.mechanism)}</code>
        ${confidenceBadge(attr.confidence)}
      </div>
      ${attr.ruleId ? `<div class="rule-id"><code>${esc(attr.ruleId)}</code></div>` : ""}
      ${attr.notes?.length ? `
        <details class="attr-notes">
          <summary>${attr.notes.length} note${attr.notes.length > 1 ? "s" : ""}</summary>
          <ul>${attr.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
        </details>` : ""}
    </div>`;
}

// ── メイン HTML レンダー ───────────────────────────────────────────────────────

export interface ProxyAttributionViewInput {
  snapshotId: string;
  queryId: string;
  sessionId: string;
  timestamp: string;
  segments: ContextSegment[];
  attributions: ProxySegmentAttribution[];
  proxySourceRef?: string;
}

export function renderProxyAttributionView(input: ProxyAttributionViewInput): string {
  const { snapshotId, queryId, sessionId, timestamp, segments, attributions, proxySourceRef } = input;
  const rows = buildRows(segments, attributions);

  // section ごとにグループ化して視認性を上げる
  const sectionOrder: ContextSegment["section"][] = ["system", "tools", "messages", "metadata", "unknown"];
  const grouped = new Map<string, SegmentRow[]>();
  for (const s of sectionOrder) grouped.set(s, []);
  for (const row of rows) {
    const key = row.seg.section;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(row);
  }

  const sectionBlocks = [...grouped.entries()]
    .filter(([, r]) => r.length > 0)
    .map(([section, sectionRows]) => {
      const totalChars = sectionRows.reduce((s, r) => s + (r.seg.charCount ?? 0), 0);
      const rowHtml = sectionRows.map((row) => {
        const segId = row.seg.id.replace(/[^a-zA-Z0-9-_]/g, "_");
        return `
          <tr class="seg-row" id="row-${segId}" data-segid="${esc(row.seg.id)}"
              onclick="highlightRow('${esc(row.seg.id)}')">
            <td class="col-raw">${renderRawCell(row)}</td>
            <td class="col-parser">${renderParserCell(row)}</td>
            <td class="col-attr">${renderAttrCell(row)}</td>
          </tr>`;
      }).join("");

      return `
        <tr class="section-header-row">
          <td colspan="3">
            <div class="section-banner">
              <span class="section-name">${esc(section)}</span>
              <span class="section-stats">${sectionRows.length} segments · ${totalChars.toLocaleString()} chars</span>
            </div>
          </td>
        </tr>
        ${rowHtml}`;
    }).join("");

  // summary stats
  const totalSegs = segments.length;
  const attrMap = new Map<string, ProxySegmentAttribution>();
  for (const a of attributions) for (const id of a.proxySegmentIds) attrMap.set(id, a);

  const categoryCounts = new Map<string, number>();
  for (const a of attributions) {
    categoryCounts.set(a.category, (categoryCounts.get(a.category) ?? 0) + 1);
  }
  const ruledCount = attributions.filter((a) => a.ruleId).length;
  // override = attribution が wire schema 確定 category を変えた件数（保守占位の変更は除く）
  const PARSER_AUTHORITATIVE_SET = new Set(["tool_use", "tool_result", "tools_schema"]);
  const overrideCount = segments.filter((seg) => {
    const a = attrMap.get(seg.id);
    return a && a.category !== seg.category && PARSER_AUTHORITATIVE_SET.has(seg.category);
  }).length;

  const summaryBadges = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, cnt]) => badge(`${cat} ×${cnt}`, categoryColor(cat)))
    .join(" ");

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Proxy Attribution View · ${esc(queryId.slice(-12))}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: ui-monospace, 'Cascadia Code', monospace; font-size: 12px;
       background: #0f172a; color: #e2e8f0; }

/* ── header ── */
.view-header { padding: 16px 20px; border-bottom: 1px solid #1e293b;
               background: #1e293b; }
.view-title { font-size: 14px; font-weight: 600; color: #f1f5f9; }
.view-meta { margin-top: 6px; color: #94a3b8; font-size: 11px; }
.view-meta span { margin-right: 16px; }
.summary-row { margin-top: 10px; display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
.stat { color: #94a3b8; }
.stat b { color: #e2e8f0; }

/* ── table layout ── */
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
col.col-raw    { width: 33%; }
col.col-parser { width: 27%; }
col.col-attr   { width: 40%; }

/* ── section banner ── */
.section-header-row td { padding: 0; }
.section-banner { padding: 6px 12px; background: #1e293b;
                  border-top: 2px solid #334155; display: flex; gap: 12px; align-items: center; }
.section-name { font-weight: 700; color: #7dd3fc; font-size: 11px; text-transform: uppercase;
                letter-spacing: 0.08em; }
.section-stats { color: #64748b; font-size: 11px; }

/* ── segment rows ── */
.seg-row td { padding: 8px 12px; vertical-align: top; border-bottom: 1px solid #1e293b; }
.seg-row:hover td { background: #1e293b80; }
.seg-row.highlighted td { background: #1e3a5f; outline: 1px solid #3b82f6; }

/* ── raw cell ── */
.path-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.path { color: #7dd3fc; font-size: 10px; }
.range { color: #475569; font-size: 10px; }
.chars { color: #475569; font-size: 10px; }
.raw-preview { cursor: pointer; color: #94a3b8; font-size: 11px; list-style: none;
               white-space: pre-wrap; word-break: break-all; }
.raw-preview::-webkit-details-marker { display: none; }
details[open] .raw-preview { color: #e2e8f0; }
.raw-full { margin-top: 6px; padding: 8px; background: #0f172a; border-radius: 4px;
            font-size: 10px; white-space: pre-wrap; word-break: break-all;
            color: #cbd5e1; max-height: 300px; overflow-y: auto; border: 1px solid #1e293b; }
.no-text { color: #475569; }

/* ── parser cell ── */
.seg-id code { color: #a78bfa; font-size: 10px; display: block; margin-bottom: 4px; }
.seg-meta { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
.section-header { color: #fbbf24; font-size: 11px; margin-top: 2px; }
.tool-id code { color: #34d399; font-size: 10px; }

/* ── attribution cell ── */
.attr-category { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.override-hint { color: #f59e0b; font-size: 10px; font-style: italic; }
.category-override { border-left: 3px solid #f59e0b; padding-left: 6px !important; }
.attr-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
.mechanism { color: #94a3b8; font-size: 10px; }
.rule-id code { color: #34d399; font-size: 10px; display: block; margin-top: 2px; }
.attr-notes summary { cursor: pointer; color: #94a3b8; font-size: 10px; margin-top: 4px; }
.attr-notes ul { margin-top: 4px; padding-left: 12px; }
.attr-notes li { color: #94a3b8; font-size: 10px; margin-bottom: 2px; }
.attr-missing { color: #475569; }
.no-attr { font-size: 11px; }

/* ── badge ── */
.badge { display: inline-block; padding: 1px 6px; border-radius: 3px;
         font-size: 10px; font-weight: 500; white-space: nowrap; }

/* ── column headers ── */
.col-headers th { padding: 8px 12px; background: #0f172a; color: #64748b;
                  font-size: 11px; text-align: left; font-weight: 600;
                  border-bottom: 2px solid #1e293b; position: sticky; top: 0; z-index: 10; }
</style>
</head>
<body>

<div class="view-header">
  <div class="view-title">Proxy Attribution View</div>
  <div class="view-meta">
    <span>queryId: <b>${esc(queryId)}</b></span>
    <span>session: <b>${esc(sessionId.slice(0, 8))}…</b></span>
    <span>${esc(timestamp)}</span>
    ${proxySourceRef ? `<span>${esc(proxySourceRef)}</span>` : ""}
  </div>
  <div class="summary-row">
    <span class="stat"><b>${totalSegs}</b> segments</span>
    <span class="stat"><b>${ruledCount}</b> with ruleId</span>
    <span class="stat"><b>${overrideCount}</b> category overrides</span>
    <span style="flex:1">${summaryBadges}</span>
  </div>
</div>

<table>
  <colgroup>
    <col class="col-raw">
    <col class="col-parser">
    <col class="col-attr">
  </colgroup>
  <thead>
    <tr class="col-headers">
      <th>Raw Context</th>
      <th>Parser Segments</th>
      <th>Attribution</th>
    </tr>
  </thead>
  <tbody>
    ${sectionBlocks}
  </tbody>
</table>

<script>
function highlightRow(segId) {
  document.querySelectorAll('.seg-row.highlighted').forEach(el => el.classList.remove('highlighted'));
  const escaped = segId.replace(/[^a-zA-Z0-9-_]/g, '_');
  const row = document.getElementById('row-' + escaped);
  if (row) {
    row.classList.add('highlighted');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
// URL hash → highlight on load
window.addEventListener('load', () => {
  const hash = location.hash.slice(1);
  if (hash) highlightRow(hash);
});
</script>
</body>
</html>`;
}
