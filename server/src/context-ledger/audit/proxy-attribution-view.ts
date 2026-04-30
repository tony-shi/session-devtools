// Proxy Attribution View
// 四列 HTML，专注于 proxy → parser → attribution 的完整链路。
// 不展示 expected / mutation / reconciliation。
//
// 列定义：
//   col-1 Raw Original  — reqBody 原始明文，直接从 JSON 取，不经过 parser
//   col-2 Parser        — parseClaudeProxyRequest 产出的 segment（id/category/metadata）
//   col-3 Attribution   — inferClaudeProxyAttributions 产出（category/mechanism/ruleId/notes）
//
// 三列通过 segment id 对齐，点击行互相高亮。

import { CONTEXT_LEDGER_RULE_BY_ID } from "../rule-registry";
import type { ContextLedgerRule } from "../rule-registry";
import type { ContextSegment, ProxySegmentAttribution } from "../types";

// ── 颜色 / badge 映射 ─────────────────────────────────────────────────────────

const CATEGORY_COLOR: Record<string, string> = {
  billing_noise:        "#6b7280",
  system_prompt:        "#3b82f6",
  harness_injection:    "#8b5cf6",
  tools_schema:         "#f59e0b",
  tool_use:             "#10b981",
  tool_result:          "#059669",
  user_message:         "#0ea5e9",
  assistant_text:       "#64748b",
  local_command_history:"#d97706",
  prior_session_history:"#a78bfa",
  unknown:              "#ef4444",
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

// ── reqBody 原文提取 ──────────────────────────────────────────────────────────

function walkPath(path: string, root: unknown): unknown {
  const tokens = path.split(/\.|\[(\d+)\]/).filter((t) => t !== undefined && t !== "");
  let cur: unknown = root;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return undefined;
    const idx = parseInt(tok, 10);
    if (!isNaN(idx)) cur = (cur as unknown[])[idx];
    else cur = (cur as Record<string, unknown>)[tok];
  }
  return cur;
}

// 从 reqBody 取 segment 对应的原始文本。
// 对 system/messages text block → 取 .text 字段，再用 charRange 切片（sub-section 时）
// 对 tools → JSON.stringify
// 对 tool_use / tool_result → 取相关字段文本
function extractRawOriginal(
  seg: ContextSegment,
  reqBody: Record<string, unknown>,
): string | null {
  const ref = seg.sourceRefs[0];
  if (!ref || ref.kind !== "proxy" || !ref.proxy.jsonPath) return null;

  const path = ref.proxy.jsonPath.startsWith("reqBody.")
    ? ref.proxy.jsonPath.slice("reqBody.".length)
    : ref.proxy.jsonPath;

  const value = walkPath(path, reqBody);
  if (value === undefined || value === null) return null;

  // object with .text field（system block / message content block）
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj["text"] === "string") {
      const text = obj["text"] as string;
      const range = ref.proxy.charRange;
      // sub-section: 用 charRange 切片还原该 section 的原始文本
      if (range) return text.slice(range.start, range.end);
      return text;
    }
    return JSON.stringify(obj, null, 2);
  }

  if (typeof value === "string") return value;

  // tools[i]：JSON
  return JSON.stringify(value, null, 2);
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

// ── 第一列：Raw Original（reqBody 原始明文）───────────────────────────────────

function renderRawOriginalCell(row: SegmentRow, reqBody: Record<string, unknown>): string {
  const rawText = extractRawOriginal(row.seg, reqBody) ?? "";
  const ref = row.seg.sourceRefs[0];
  const jsonPath = ref?.kind === "proxy" ? (ref.proxy.jsonPath ?? "?") : "?";
  const charRange = ref?.kind === "proxy" ? ref.proxy.charRange : undefined;
  const rangeStr = charRange ? `[${charRange.start}…${charRange.end})` : "";

  if (!rawText) {
    return `<div class="raw-orig-cell"><div class="path-line"><code class="path">${esc(jsonPath)}</code></div><span class="no-text">—</span></div>`;
  }

  const chars = rawText.length;
  // 直接展示，不折叠——这是"原文列"的核心诉求
  return `
    <div class="raw-orig-cell">
      <div class="path-line">
        <code class="path">${esc(jsonPath)}</code>
        ${rangeStr ? `<span class="range">${esc(rangeStr)}</span>` : ""}
        <span class="chars">${chars.toLocaleString()}c</span>
      </div>
      <pre class="raw-orig-text">${esc(rawText.slice(0, 3000))}${rawText.length > 3000 ? "\n…(truncated)" : ""}</pre>
    </div>`;
}

// ── 第二列：Parser Segments ───────────────────────────────────────────────────

function renderParserCell(row: SegmentRow): string {
  const { seg } = row;
  const color = categoryColor(seg.category);
  const meta = seg.metadata as Record<string, unknown> | undefined;
  const sectionHeader = typeof meta?.["sectionHeader"] === "string" ? meta["sectionHeader"] : null;
  const ref = seg.sourceRefs[0];
  const charRange = ref?.kind === "proxy" ? ref.proxy.charRange : undefined;
  const rangeStr = charRange ? `[${charRange.start}…${charRange.end})` : "";

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
      ${rangeStr ? `<div class="range-hint">${esc(rangeStr)} · ${(seg.charCount ?? 0).toLocaleString()}c</div>` : ""}
      ${seg.toolUseId ? `<div class="tool-id"><code>${esc(seg.toolUseId)}</code></div>` : ""}
      ${seg.cacheHint && seg.cacheHint !== "none" ? badge(seg.cacheHint, "#f59e0b") : ""}
    </div>`;
}

// ── 第三列：Attribution ───────────────────────────────────────────────────────

// stability → badge 颜色
const STABILITY_COLOR: Record<string, string> = {
  static:      "#10b981",  // green
  "semi-static": "#f59e0b",
  dynamic:     "#8b5cf6",  // purple
};

function renderAttrCell(row: SegmentRow): string {
  const { attr, seg } = row;
  if (!attr) {
    return `<div class="attr-cell attr-missing"><span class="no-attr">— no attribution —</span></div>`;
  }

  const color = categoryColor(attr.category);
  const PARSER_AUTHORITATIVE = new Set(["tool_use", "tool_result", "tools_schema"]);
  const categoryMismatch = attr.category !== seg.category && PARSER_AUTHORITATIVE.has(seg.category);

  // 从 rule-registry 取 rule 详情
  const rule: ContextLedgerRule | undefined = attr.ruleId
    ? CONTEXT_LEDGER_RULE_BY_ID.get(attr.ruleId)
    : undefined;

  const ruleDetail = rule
    ? `
      <details class="rule-detail">
        <summary class="rule-summary">
          <code class="rule-id-text">${esc(rule.ruleId)}</code>
        </summary>
        <div class="rule-body">
          <div class="rule-desc">${esc(rule.description)}</div>
          <div class="rule-props">
            ${badge(rule.stability, STABILITY_COLOR[rule.stability] ?? "#94a3b8", "stability")}
            ${rule.attribution?.matchMode ? badge(rule.attribution.matchMode, "#475569", "matchMode") : ""}
            ${rule.reconciliation?.comparePolicy ? badge(rule.reconciliation.comparePolicy, "#334155", "comparePolicy") : ""}
            ${rule.reconstruction?.materialization ? badge(rule.reconstruction.materialization, "#1e3a5f", "materialization") : ""}
          </div>
          ${rule.sourcemapRef ? `<div class="rule-src">src: <code>${esc(rule.sourcemapRef.slice(0, 60))}${rule.sourcemapRef.length > 60 ? "…" : ""}</code></div>` : ""}
          ${rule.reconstruction?.preCondition
            ? `<div class="rule-precond">if: <code>${esc(rule.reconstruction.preCondition)}</code></div>`
            : ""}
        </div>
      </details>`
    : attr.ruleId
      ? `<div class="rule-id"><code>${esc(attr.ruleId)}</code> <span style="color:#ef4444;font-size:9px">not in registry</span></div>`
      : "";

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
      ${ruleDetail}
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
  reqBody: Record<string, unknown>;
  proxySourceRef?: string;
}

export function renderProxyAttributionView(input: ProxyAttributionViewInput): string {
  const { queryId, sessionId, timestamp, segments, attributions, reqBody, proxySourceRef } = input;
  const rows = buildRows(segments, attributions);

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
            <td class="col-raw-orig">${renderRawOriginalCell(row, reqBody)}</td>
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
  const attrMap = new Map<string, ProxySegmentAttribution>();
  for (const a of attributions) for (const id of a.proxySegmentIds) attrMap.set(id, a);
  const categoryCounts = new Map<string, number>();
  for (const a of attributions) {
    categoryCounts.set(a.category, (categoryCounts.get(a.category) ?? 0) + 1);
  }
  const ruledCount = attributions.filter((a) => a.ruleId).length;

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
.view-header { padding: 16px 20px; border-bottom: 1px solid #1e293b; background: #1e293b; }
.view-title { font-size: 14px; font-weight: 600; color: #f1f5f9; }
.view-meta { margin-top: 6px; color: #94a3b8; font-size: 11px; }
.view-meta span { margin-right: 16px; }
.summary-row { margin-top: 10px; display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
.stat { color: #94a3b8; }
.stat b { color: #e2e8f0; }

/* ── table layout：3列 ── */
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
col.col-raw-orig { width: 38%; }
col.col-parser   { width: 22%; }
col.col-attr     { width: 40%; }

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

/* ── col-1: raw original ── */
.raw-orig-cell { }
.path-line { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.path { color: #7dd3fc; font-size: 10px; }
.range { color: #475569; font-size: 10px; }
.chars { color: #475569; font-size: 10px; }
.raw-orig-text {
  font-size: 10px; white-space: pre-wrap; word-break: break-all;
  color: #cbd5e1; max-height: 240px; overflow-y: auto;
  border: 1px solid #1e293b; border-radius: 3px; padding: 6px;
  background: #080f1a;
  line-height: 1.5;
}
.no-text { color: #475569; }

/* ── col-2: parser ── */
.seg-id code { color: #a78bfa; font-size: 10px; display: block; margin-bottom: 4px; }
.seg-meta { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
.section-header { color: #fbbf24; font-size: 11px; margin-top: 2px; }
.range-hint { color: #475569; font-size: 10px; margin-top: 2px; }
.tool-id code { color: #34d399; font-size: 10px; }

/* ── col-3: attribution ── */
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

/* ── rule detail（折叠展开） ── */
.rule-detail { margin-top: 4px; }
.rule-summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 4px; }
.rule-summary::-webkit-details-marker { display: none; }
.rule-id-text { color: #34d399; font-size: 10px; }
details.rule-detail[open] .rule-id-text::before { content: "▾ "; }
details.rule-detail:not([open]) .rule-id-text::before { content: "▸ "; }
.rule-body { margin-top: 4px; padding: 6px 8px; background: #0a1628;
             border-radius: 4px; border: 1px solid #1e3a5f; }
.rule-desc { color: #cbd5e1; font-size: 10px; margin-bottom: 4px; line-height: 1.4; }
.rule-props { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
.rule-src { color: #475569; font-size: 9px; margin-top: 2px; }
.rule-src code { color: #64748b; }
.rule-precond { color: #94a3b8; font-size: 9px; margin-top: 2px; }
.rule-precond code { color: #7dd3fc; }

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
    <span class="stat"><b>${segments.length}</b> segments</span>
    <span class="stat"><b>${ruledCount}</b> with ruleId</span>
    <span style="flex:1">${summaryBadges}</span>
  </div>
</div>

<table>
  <colgroup>
    <col class="col-raw-orig">
    <col class="col-parser">
    <col class="col-attr">
  </colgroup>
  <thead>
    <tr class="col-headers">
      <th>Raw（reqBody 原文）</th>
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
  const row = document.getElementById('row-' + segId.replace(/[^a-zA-Z0-9-_]/g, '_'));
  if (row) {
    row.classList.add('highlighted');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}
window.addEventListener('load', () => {
  const hash = location.hash.slice(1);
  if (hash) highlightRow(hash);
});
</script>
</body>
</html>`;
}
