// Proxy Attribution View
// 四列 HTML，proxy → parser → attribution → expected（reconciliation 结果）完整链路。
//
// 列定义：
//   col-1 Raw Original  — reqBody 原始明文，直接从 JSON 取，不经过 parser
//   col-2 Parser        — parseClaudeProxyRequest 产出的 segment（id/category/metadata）
//   col-3 Attribution   — inferClaudeProxyAttributions 产出（category/mechanism/ruleId/notes）
//   col-4 Expected      — reconciliation 结果：matched expected segment / attribution_only / expected_only
//
// 四列通过 segment id 对齐，点击行互相高亮。
// col-4 需要传入 reconciliationReport；不传时退化为三列视图。

import { CONTEXT_LEDGER_RULE_BY_ID } from "../rules/rule-registry";
import type { ContextLedgerRule } from "../rules/rule-registry";
import type {
  AlignmentRef,
  ContextSegment,
  ProxySegmentAttribution,
  ReconciliationReport,
} from "../types";
import type { AttributionCoverage } from "../parser/attribution";

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

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
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

// 对齐状态：一个 proxy segment 对应的 reconciliation 结果
interface AlignmentState {
  // P3-2：known_noise → server_side_attribution
  kind: "matched" | "attribution_only" | "server_side_attribution" | "unknown";
  alignment: AlignmentRef | undefined;
  // 对应的 expected segments（matched 时存在）
  expectedSegs: ContextSegment[];
  // alignment basis / confidence / comparisonGrade
  basis?: AlignmentRef["basis"];
  confidence?: AlignmentRef["confidence"];
  comparisonGrade?: AlignmentRef["comparisonGrade"];
  note?: string;
}

// 构建 proxy segment id → AlignmentState 的索引
function buildAlignmentIndex(
  report: ReconciliationReport,
): Map<string, AlignmentState> {
  const idx = new Map<string, AlignmentState>();
  const expectedById = new Map<string, ContextSegment>(
    (report.expected?.segments ?? []).map((s) => [s.id, s]),
  );

  for (const align of report.alignments) {
    // 判断 kind
    let kind: AlignmentState["kind"] = "matched";
    if (align.expectedSegmentIds.length === 0) {
      // 无 expected 对应：看 note 判断是 attribution_only 还是 server_side_attribution
      if (align.note?.startsWith("billing_noise")) {
        kind = "server_side_attribution";
      } else {
        kind = "attribution_only";
      }
    }

    const expectedSegs = align.expectedSegmentIds
      .map((id) => expectedById.get(id))
      .filter(Boolean) as ContextSegment[];

    const state: AlignmentState = {
      kind,
      alignment: align,
      expectedSegs,
      basis: align.basis,
      confidence: align.confidence,
      comparisonGrade: align.comparisonGrade,
      note: align.note,
    };

    for (const proxyId of align.proxySegmentIds) {
      idx.set(proxyId, state);
    }
  }

  return idx;
}

// 未被任何 alignment 覆盖的 expected segments（expected_only）
function buildExpectedOnlyList(report: ReconciliationReport): ContextSegment[] {
  const coveredExpectedIds = new Set<string>();
  for (const align of report.alignments) {
    for (const id of align.expectedSegmentIds) coveredExpectedIds.add(id);
  }
  return (report.expected?.segments ?? []).filter((s) => !coveredExpectedIds.has(s.id));
}

interface SegmentRow {
  seg: ContextSegment;
  attr: ProxySegmentAttribution | undefined;
  alignState: AlignmentState | undefined;
}

function buildRows(
  segments: ContextSegment[],
  attributions: ProxySegmentAttribution[],
  alignmentIndex: Map<string, AlignmentState> | undefined,
): SegmentRow[] {
  const attrById = new Map<string, ProxySegmentAttribution>();
  for (const a of attributions) {
    for (const id of a.proxySegmentIds) attrById.set(id, a);
  }
  return segments.map((seg) => ({
    seg,
    attr: attrById.get(seg.id),
    alignState: alignmentIndex?.get(seg.id),
  }));
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
            ? `<div class="rule-precond">if: <code>${esc(JSON.stringify(rule.reconstruction.preCondition))}</code></div>`
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
        <span class="conf-pair">cls=${confidenceBadge(attr.classificationConfidence)}/mat=${confidenceBadge(attr.materializationConfidence)}</span>
      </div>
      ${ruleDetail}
      ${attr.notes?.length ? `
        <details class="attr-notes">
          <summary>${attr.notes.length} note${attr.notes.length > 1 ? "s" : ""}</summary>
          <ul>${attr.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
        </details>` : ""}
    </div>`;
}

// ── 第四列：Expected（reconciliation 结果）──────────────────────────────────

// alignment kind → 颜色 / badge 文案
const ALIGN_KIND_STYLE: Record<string, { color: string; label: string }> = {
  matched:                 { color: "#10b981", label: "matched" },
  attribution_only:        { color: "#8b5cf6", label: "attribution only" },
  server_side_attribution: { color: "#6b7280", label: "server-side attribution" },
  unknown:                 { color: "#ef4444", label: "no alignment" },
};

function renderExpectedCell(row: SegmentRow): string {
  const { alignState } = row;

  if (!alignState) {
    // reconciliationReport 未传，或此 proxy segment 没有对应的 alignment
    return `<div class="expected-cell expected-missing"><span class="no-expected">— no reconciliation —</span></div>`;
  }

  const style = ALIGN_KIND_STYLE[alignState.kind] ?? ALIGN_KIND_STYLE["unknown"];
  const kindBadge = badge(style.label, style.color);

  // alignment basis / confidence / comparisonGrade badges
  const basisBadge = alignState.basis ? badge(alignState.basis, "#334155") : "";
  const confBadge = alignState.confidence ? confidenceBadge(alignState.confidence) : "";
  const gradeBadge = alignState.comparisonGrade ? badge(alignState.comparisonGrade, "#475569") : "";

  // attribution_only / server_side_attribution：无 expected segments
  if (alignState.expectedSegs.length === 0) {
    const noteHtml = alignState.note
      ? `<div class="expected-note">${esc(truncate(alignState.note, 120))}</div>`
      : "";
    return `
      <div class="expected-cell">
        <div class="expected-kind">${kindBadge}</div>
        <div class="expected-meta">${basisBadge}${confBadge}</div>
        ${noteHtml}
      </div>`;
  }

  // matched：展示 expected segments 的信息
  const esegHtml = alignState.expectedSegs.map((eseg) => {
    const color = categoryColor(eseg.category);
    const charInfo = eseg.charCount !== undefined
      ? `<span class="expected-chars">${eseg.charCount.toLocaleString()}c</span>`
      : "";
    const textPreview = eseg.contentRef?.kind === "inline" && eseg.contentRef.text
      ? `<div class="expected-preview">${esc(truncate(eseg.contentRef.text, 120))}</div>`
      : eseg.metadata?.preview
        ? `<div class="expected-preview">${esc(truncate(String(eseg.metadata.preview), 120))}</div>`
        : "";
    return `
      <div class="expected-seg">
        <div class="expected-seg-meta">
          ${badge(eseg.category, color)}
          ${charInfo}
          <code class="expected-seg-id">${esc(eseg.id)}</code>
        </div>
        ${textPreview}
      </div>`;
  }).join("");

  // charDelta：expected chars - proxy chars
  const proxyChars = row.seg.charCount ?? 0;
  const expectedChars = alignState.expectedSegs.reduce((s, e) => s + (e.charCount ?? 0), 0);
  const delta = expectedChars - proxyChars;
  const deltaHtml = Math.abs(delta) > 0
    ? `<div class="expected-delta ${delta > 0 ? "delta-pos" : "delta-neg"}">${delta > 0 ? "+" : ""}${delta.toLocaleString()} chars</div>`
    : "";

  return `
    <div class="expected-cell">
      <div class="expected-kind">${kindBadge}</div>
      <div class="expected-meta">${basisBadge}${confBadge}${gradeBadge}</div>
      ${esegHtml}
      ${deltaHtml}
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
  /** 可选。传入后启用第四列 Expected（reconciliation 结果）。 */
  reconciliationReport?: ReconciliationReport;
  /** 新 AST parser attribution 覆盖率摘要；用于把 parser-view 的结果并入 proxy-view 页头。 */
  parserCoverage?: AttributionCoverage;
  /** 相对于当前 HTML 文件的 parser-view 链接。 */
  parserViewHref?: string;
}

export function renderProxyAttributionView(input: ProxyAttributionViewInput): string {
  const {
    queryId, sessionId, timestamp, segments, attributions, reqBody, proxySourceRef,
    reconciliationReport, parserCoverage, parserViewHref,
  } = input;

  // 第四列需要的索引
  const alignmentIndex = reconciliationReport
    ? buildAlignmentIndex(reconciliationReport)
    : undefined;
  const expectedOnlySegs = reconciliationReport
    ? buildExpectedOnlyList(reconciliationReport)
    : [];
  const hasExpectedCol = !!reconciliationReport;
  const colCount = hasExpectedCol ? 4 : 3;

  const rows = buildRows(segments, attributions, alignmentIndex);

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
            ${hasExpectedCol ? `<td class="col-expected">${renderExpectedCell(row)}</td>` : ""}
          </tr>`;
      }).join("");

      return `
        <tr class="section-header-row">
          <td colspan="${colCount}">
            <div class="section-banner">
              <span class="section-name">${esc(section)}</span>
              <span class="section-stats">${sectionRows.length} segments · ${totalChars.toLocaleString()} chars</span>
            </div>
          </td>
        </tr>
        ${rowHtml}`;
    }).join("");

  // expected_only 行：没有对应 proxy segment 的 expected segments，追加到表尾
  const expectedOnlyBlock = expectedOnlySegs.length > 0 && hasExpectedCol ? `
    <tr class="section-header-row">
      <td colspan="${colCount}">
        <div class="section-banner">
          <span class="section-name" style="color:#3b82f6">expected only</span>
          <span class="section-stats">${expectedOnlySegs.length} segments · no proxy counterpart</span>
        </div>
      </td>
    </tr>
    ${expectedOnlySegs.map((eseg) => {
      const color = categoryColor(eseg.category);
      const textPreview = eseg.contentRef?.kind === "inline" && eseg.contentRef.text
        ? `<pre class="raw-orig-text">${esc(truncate(eseg.contentRef.text, 400))}</pre>`
        : eseg.metadata?.preview
          ? `<div class="expected-preview">${esc(truncate(String(eseg.metadata.preview), 120))}</div>`
          : "";
      return `
        <tr class="seg-row expected-only-row">
          <td class="col-raw-orig"><div class="expected-only-cell">${textPreview}</div></td>
          <td class="col-parser">
            <div class="parser-cell">
              <div class="seg-id"><code>${esc(eseg.id)}</code></div>
              <div class="seg-meta">
                ${badge(eseg.section, "#6b7280")}
                ${badge(eseg.category, color)}
              </div>
              <div class="range-hint">${(eseg.charCount ?? 0).toLocaleString()}c</div>
            </div>
          </td>
          <td class="col-attr"><div class="attr-cell attr-missing"><span class="no-attr">— proxy側に対応なし —</span></div></td>
          <td class="col-expected">
            <div class="expected-cell">
              ${badge("expected only", "#3b82f6")}
              <div class="expected-note" style="color:#3b82f6;margin-top:4px">
                expected segment has no proxy counterpart
              </div>
            </div>
          </td>
        </tr>`;
    }).join("")}` : "";

  // summary stats
  const categoryCounts = new Map<string, number>();
  for (const a of attributions) {
    categoryCounts.set(a.category, (categoryCounts.get(a.category) ?? 0) + 1);
  }
  const ruledCount = attributions.filter((a) => a.ruleId).length;

  const summaryBadges = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, cnt]) => badge(`${cat} ×${cnt}`, categoryColor(cat)))
    .join(" ");

  // reconciliation summary stats（第四列存在时）
  const reconSummary = hasExpectedCol && reconciliationReport ? (() => {
    const matched = reconciliationReport.alignments.filter(
      (a) => a.expectedSegmentIds.length > 0,
    ).length;
    const attrOnly = reconciliationReport.alignments.filter(
      (a) => a.expectedSegmentIds.length === 0 && !a.note?.startsWith("billing_noise"),
    ).length;
    const serverSide = reconciliationReport.alignments.filter(
      (a) => a.note?.startsWith("billing_noise"),
    ).length;
    return `<span class="stat" style="margin-left:12px;padding-left:12px;border-left:1px solid #334155">
      reconcile: <b>${matched}</b> matched · <b>${attrOnly}</b> attr-only · <b>${serverSide}</b> server-side · <b>${expectedOnlySegs.length}</b> expected-only
    </span>`;
  })() : "";

  const parserSummary = parserCoverage ? `
    <div class="parser-summary">
      <span class="parser-summary-title">AST parser attribution</span>
      <span class="stat"><b>${parserCoverage.totalNodes}</b> nodes</span>
      <span class="stat">recognition <b>${formatPercent(parserCoverage.recognitionRatio)}</b></span>
      <span class="stat">evidence <b>${formatPercent(parserCoverage.evidenceBackedRatio)}</b></span>
      <span class="stat">rule_gap <b>${formatPercent(parserCoverage.totalChars > 0 ? parserCoverage.ruleGap.chars / parserCoverage.totalChars : 0)}</b></span>
      ${parserViewHref ? `<a class="parser-link" href="${esc(parserViewHref)}">open parser view</a>` : ""}
    </div>
  ` : "";

  // 列宽：4列模式下收窄，优先 Raw 和 Expected 内容
  const colWidthStyle = hasExpectedCol
    ? `col.col-raw-orig { width: 28%; } col.col-parser { width: 16%; } col.col-attr { width: 28%; } col.col-expected { width: 28%; }`
    : `col.col-raw-orig { width: 38%; } col.col-parser { width: 22%; } col.col-attr { width: 40%; }`;

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
.parser-summary {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  padding: 8px 10px;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 6px;
}
.parser-summary-title { color: #f59e0b; font-weight: 700; }
.parser-link {
  color: #7dd3fc;
  text-decoration: none;
  border-bottom: 1px dashed #7dd3fc;
}
.parser-link:hover { color: #bae6fd; border-bottom-color: #bae6fd; }

/* ── table layout ── */
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
${colWidthStyle}

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
.expected-only-row td { background: #0c1a30; }
.expected-only-row:hover td { background: #0e2040; }

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

/* ── col-4: expected（reconciliation）── */
.expected-cell { }
.expected-missing { color: #475569; }
.no-expected { font-size: 11px; }
.expected-kind { margin-bottom: 4px; }
.expected-meta { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 4px; }
.expected-seg { border: 1px solid #1e293b; border-radius: 3px; padding: 4px 6px;
                margin-bottom: 4px; background: #0a1628; }
.expected-seg-meta { display: flex; gap: 4px; align-items: center; flex-wrap: wrap; margin-bottom: 2px; }
.expected-seg-id { color: #a78bfa; font-size: 9px; }
.expected-chars { color: #475569; font-size: 10px; }
.expected-preview { font-size: 10px; color: #94a3b8; white-space: pre-wrap; word-break: break-all;
                    max-height: 100px; overflow-y: auto; margin-top: 2px;
                    border-top: 1px solid #1e293b; padding-top: 2px; }
.expected-note { color: #64748b; font-size: 10px; margin-top: 2px; }
.expected-delta { font-size: 10px; margin-top: 4px; font-weight: 600; }
.delta-pos { color: #3b82f6; }
.delta-neg { color: #ef4444; }
.expected-only-cell { }

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
    ${reconSummary}
  </div>
  ${parserSummary}
</div>

<table>
  <colgroup>
    <col class="col-raw-orig">
    <col class="col-parser">
    <col class="col-attr">
    ${hasExpectedCol ? `<col class="col-expected">` : ""}
  </colgroup>
  <thead>
    <tr class="col-headers">
      <th>Raw（reqBody 原文）</th>
      <th>Parser Segments</th>
      <th>Attribution</th>
      ${hasExpectedCol ? `<th>Expected（reconciliation）</th>` : ""}
    </tr>
  </thead>
  <tbody>
    ${sectionBlocks}
    ${expectedOnlyBlock}
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
