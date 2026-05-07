// parser-view：把单 query 的 ParsedQuerySnapshot 渲染为 standalone HTML
// 设计：完整 <!DOCTYPE html>，内联 CSS，无外部依赖（可以直接双击打开）。
// 排版思路：三个折叠块（System / Tools / Messages），每个 segment 一行，
// inline children 在父行下方缩进展示。
//
// P1-1：parser-view 展示每个 AST node 的归因结果。parser 只输出最终
// SegmentAttribution；notes 等展示派生信息由 view 层按需渲染。

import type { CachePolicy, ParsedQuerySnapshot, SegmentNode } from "../parser/types";
import { isUnknownSlotId } from "../parser/types";
import type {
  AttributionCoverage,
  AttributionMatchMode,
  CharCoverage,
  DynamicField,
  SegmentAttribution,
} from "../parser/attribution";

// ─────────────────────────────────────────────────────────────────────────────
// 颜色规则（slotType → badge color）
// 与 phase1 prompt 对齐
// ─────────────────────────────────────────────────────────────────────────────

function slotColor(slotType: string): string {
  // unknown fallback → 醒目红色，让 audit 一眼发现 gap
  if (isUnknownSlotId(slotType)) return "#ef4444";
  if (slotType === "system.billing" || slotType === "system.identity") return "#6b7280";
  if (slotType.startsWith("system.main-prompt.section.")) return "#3b82f6";
  if (slotType.startsWith("system.")) return "#1d4ed8";
  if (slotType.startsWith("tools.")) return "#f59e0b";
  if (slotType === "messages.tool_use") return "#10b981";
  if (slotType === "messages.tool_result") return "#059669";
  if (slotType === "messages.text" || slotType === "messages.inline.free-text") return "#0ea5e9";
  if (slotType === "messages.inline.system-reminder") return "#8b5cf6";
  if (slotType === "messages.inline.local-command") return "#d97706";
  if (slotType.startsWith("side-query.")) return "#64748b";
  return "#ef4444";
}

const CATEGORY_COLOR: Record<string, string> = {
  billing_noise: "#6b7280",
  system_prompt: "#3b82f6",
  harness_injection: "#8b5cf6",
  memory_injection: "#a855f7",
  tools_schema: "#f59e0b",
  tool_use: "#10b981",
  tool_result: "#059669",
  user_message: "#0ea5e9",
  assistant_text: "#64748b",
  local_command_history: "#d97706",
  attachment: "#ec4899",
  unknown: "#ef4444",
};

function categoryColor(category: string): string {
  return CATEGORY_COLOR[category] ?? "#94a3b8";
}

function confidenceColor(confidence: string): string {
  if (confidence === "definitive") return "#10b981";
  if (confidence === "estimated") return "#3b82f6";
  if (confidence === "inferred") return "#f59e0b";
  return "#ef4444";
}

// matchMode → badge 颜色：与 evidence "强弱" 一致。
const MATCH_MODE_COLOR: Record<string, string> = {
  exact: "#10b981",         // 字符串等值，最强
  regex: "#3b82f6",         // 模板 + 动态字段
  prefix: "#f59e0b",        // 锚点识别，文本不解释
  rule_gap: "#ef4444",
};

function matchModeColor(mode: string): string {
  return MATCH_MODE_COLOR[mode] ?? "#94a3b8";
}

// dynamicField.source → badge 颜色：来源越"可控"越绿。
const SOURCE_COLOR: Record<string, string> = {
  env: "#10b981",
  memory: "#3b82f6",
  runtime: "#f97316",
  user: "#a855f7",
  unknown: "#94a3b8",
};

function sourceColor(source: string): string {
  return SOURCE_COLOR[source] ?? "#94a3b8";
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML 转义
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatCharRatio(chars: number, total: number): string {
  if (total <= 0) return "0%";
  return formatPercent(chars / total);
}

// ─────────────────────────────────────────────────────────────────────────────
// section 分组
// ─────────────────────────────────────────────────────────────────────────────

interface Group {
  title: string;
  roots: SegmentNode[];  // 该 section 的顶层节点
}

// 把 snapshot.roots 按 slotType 前缀分进三个 section。
// 注意：分组只看顶层节点（roots），渲染时递归展开 children。
function groupRoots(roots: SegmentNode[]): { system: Group; tools: Group; messages: Group } {
  const system: SegmentNode[] = [];
  const tools: SegmentNode[] = [];
  const messages: SegmentNode[] = [];

  for (const node of roots) {
    const sid = node.slotType;
    if (sid.startsWith("system.") || sid === "side-query.system") {
      system.push(node);
    } else if (sid.startsWith("tools.")) {
      tools.push(node);
    } else if (sid.startsWith("messages.") || sid === "side-query.user") {
      messages.push(node);
    } else {
      messages.push(node);
    }
  }

  return {
    system: { title: "System", roots: system },
    tools: { title: "Tools", roots: tools },
    messages: { title: "Messages", roots: messages },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// evidence 渲染
// ─────────────────────────────────────────────────────────────────────────────

// 单行展示的字符桶摘要（matchMode + literal/dynamic/unmatched 比例）。
function renderCoverageSummary(matchMode: AttributionMatchMode, coverage: CharCoverage): string {
  const modeBadge = `<span class="evd-mode" style="background:${matchModeColor(matchMode)}">${esc(matchMode)}</span>`;

  // rule_gap：只展示"未识别"提示，不渲染 char 桶。
  if (matchMode === "rule_gap") {
    return `<span class="evd">${modeBadge}<span class="evd-gap">${coverage.rawChars} chars unmatched</span></span>`;
  }

  const total = coverage.rawChars;
  const literalPct = formatCharRatio(coverage.literalChars, total);
  const dynamicPct = formatCharRatio(coverage.dynamicChars, total);
  const unmatchedPct = formatCharRatio(coverage.unmatchedChars, total);

  // 微型分桶条：literal / dynamic / unmatched。
  const widthFor = (chars: number): string => {
    if (total <= 0) return "0%";
    return `${Math.max(0, (chars / total) * 100)}%`;
  };
  const microBar = `
    <span class="evd-bar" title="literal ${literalPct} · dynamic ${dynamicPct} · unmatched ${unmatchedPct}">
      <span style="width:${widthFor(coverage.literalChars)};background:#0ea5e9"></span>
      <span style="width:${widthFor(coverage.dynamicChars)};background:#f97316"></span>
      <span style="width:${widthFor(coverage.unmatchedChars)};background:#fecaca"></span>
    </span>
  `;

  // 不展示比例为 0 的桶，让眼睛聚焦到非零值。
  const tagsRaw: Array<[string, number, string]> = [
    ["L", coverage.literalChars, "#0ea5e9"],
    ["D", coverage.dynamicChars, "#f97316"],
    ["U", coverage.unmatchedChars, "#94a3b8"],
  ];
  const tags = tagsRaw
    .filter(([, c]) => c > 0)
    .map(([label, chars, color]) =>
      `<span class="evd-tag" style="color:${color}" title="${label === "L" ? "literal" : label === "D" ? "dynamic" : "unmatched"} chars">${label} ${chars}</span>`,
    )
    .join("");

  return `<span class="evd">${modeBadge}${microBar}${tags}</span>`;
}

function renderReconstructableBadge(reconstructable: boolean): string {
  const label = reconstructable ? "reconstructable" : "not-reconstructable";
  const color = reconstructable ? "#10b981" : "#f59e0b";
  return `<span class="mat-badge" style="background:${color}" title="can reconstruct bytes: ${reconstructable ? "yes" : "no"}">${esc(label)}</span>`;
}

function renderDynamicFieldsTable(fields: DynamicField[] | undefined): string {
  if (!fields || fields.length === 0) return "";
  const rows = fields
    .map((f) => `
      <tr>
        <td class="df-name">${esc(f.name)}</td>
        <td class="df-source"><span class="df-src-badge" style="background:${sourceColor(f.source)}">${esc(f.source)}</span></td>
        <td class="df-range">[${f.charStart}, ${f.charEnd}) · ${f.charCount}c</td>
        <td class="df-value"><code>${esc(f.valuePreview)}</code></td>
      </tr>
    `)
    .join("");

  return `
    <details class="df-block">
      <summary>capture fields (${fields.length})</summary>
      <table class="df-table">
        <thead><tr><th>name</th><th>source</th><th>range</th><th>value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>
  `;
}

// 单行渲染的 attribution cell：badge 集合 + evidence 摘要。
function renderAttributionCell(attr: SegmentAttribution | undefined): string {
  if (!attr) return `<span class="no-attr">—</span>`;
  const category = attr.category;
  const categoryBadge = `<span class="attr-badge" style="background:${categoryColor(category)}">${esc(category)}</span>`;
  const matBadge = renderReconstructableBadge(attr.reconstructable);
  const conf = attr.confidence;
  const confBadge = `<span class="conf" style="color:${confidenceColor(conf)}">${esc(conf)}</span>`;
  const rule = attr.ruleId ? `<code class="rule-id" title="${esc(attr.ruleId)}">${esc(attr.ruleId)}</code>` : "";
  const evd = renderCoverageSummary(attr.matchMode, attr.charCoverage);

  return `${categoryBadge}${matBadge}${confBadge}${rule}${evd}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 单行渲染
// ─────────────────────────────────────────────────────────────────────────────

// renderNode 递归渲染一个 SegmentNode 及其 children。
// children 在 HTML 里紧跟父行，CSS .inline 控制缩进。
// depth 用于判断是否需要 .inline 样式（depth > 0 即为子节点）。
function renderNode(
  node: SegmentNode,
  attrByNodeId: Map<string, SegmentAttribution>,
  depth = 0,
): string {
  return renderRow(node, attrByNodeId, depth) +
    node.children.map((c) => renderNode(c, attrByNodeId, depth + 1)).join("");
}

function renderCachePolicyBadge(policy: CachePolicy | undefined): string {
  if (!policy) return `<span class="cache-none">—</span>`;
  const ttlColor = policy.ttl === "1h" ? "#0ea5e9" : "#64748b";
  const scopeColor = policy.scope === "global" ? "#8b5cf6" : "#475569";
  return [
    `<span class="cache-ttl" style="color:${ttlColor}" title="cache TTL">${esc(policy.ttl)}</span>`,
    `<span class="cache-scope" style="color:${scopeColor}" title="cache scope">${esc(policy.scope)}</span>`,
  ].join(" ");
}

function renderRow(
  seg: SegmentNode,
  attrByNodeId: Map<string, SegmentAttribution>,
  depth = 0,
): string {
  const isInline = depth > 0;
  const attr = attrByNodeId.get(seg.id);
  const isRuleGap = attr?.matchMode === "rule_gap" || attr?.mechanism === "rule_gap";
  const color = slotColor(seg.slotType);
  const warn = seg.charCount > 10000 ? '<span class="warn" title="charCount &gt; 10000">⚠</span>' : "";
  const hashPrefix = seg.rawHash.length > 19 ? seg.rawHash.slice(0, 19) : seg.rawHash;

  // unknown fallback 节点加小标签，方便 audit 一眼发现 gap
  const isUnknown = isUnknownSlotId(seg.slotType);
  const isResidual = seg.slotType === "messages.inline.free-text";
  const kindBadge = isUnknown
    ? `<span class="kind-badge unknown" title="${esc(seg.unknownMeta?.reason ?? "unknown slot")}">[unknown]</span>`
    : isResidual
      ? `<span class="kind-badge residual">[residual]</span>`
      : "";

  // 展开区：rawText + 动态字段表
  const dynamicHtml = renderDynamicFieldsTable(attr?.dynamicFields);
  const rawTextHtml = `
    <div class="raw-expand" hidden>
      ${dynamicHtml}
      <pre class="raw-pre">${esc(seg.rawText)}</pre>
    </div>
  `;

  return `
    <div class="row${isInline ? " inline" : ""}${isUnknown ? " unknown" : isResidual ? " residual" : ""}${isRuleGap ? " rule-gap" : ""}">
      <span class="col-id">${esc(seg.id)}</span>
      <span class="col-slot"><span class="badge" style="background:${color}">${esc(seg.slotType)}</span>${kindBadge}</span>
      <span class="col-path">${esc(seg.jsonPath)}</span>
      <span class="col-count">
        <button class="chars-btn" onclick="var p=this.closest('.row').nextElementSibling;p.hidden=!p.hidden;this.classList.toggle('open')"
          title="点击展开/折叠原文与动态字段">${seg.charCount.toLocaleString()}${warn}</button>
      </span>
      <span class="col-hash">${esc(hashPrefix)}</span>
      <span class="col-cache">${renderCachePolicyBadge(seg.cachePolicy)}</span>
      <span class="col-attr">${renderAttributionCell(attr)}</span>
    </div>
    ${rawTextHtml}
  `;
}

// 计算一棵节点树的所有节点数（含子孙）
function countNodes(nodes: SegmentNode[]): number {
  return nodes.reduce((s, n) => s + 1 + countNodes(n.children), 0);
}

function renderGroup(g: Group, attrByNodeId: Map<string, SegmentAttribution>): string {
  const total = countNodes(g.roots);
  if (total === 0) {
    return `
      <details open>
        <summary>${esc(g.title)} <span class="muted">(empty)</span></summary>
      </details>
    `;
  }

  const rows = g.roots.map((n) => renderNode(n, attrByNodeId)).join("");
  return `
    <details open>
      <summary>${esc(g.title)} <span class="muted">(${total})</span></summary>
      <div class="rows">
        <div class="row header">
          <span class="col-id">id</span>
          <span class="col-slot">slot</span>
          <span class="col-path">jsonPath</span>
          <span class="col-count">chars</span>
          <span class="col-hash">hash</span>
          <span class="col-cache">cache</span>
          <span class="col-attr">attribution · evidence</span>
        </div>
        ${rows}
      </div>
    </details>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// 顶层 render
// ─────────────────────────────────────────────────────────────────────────────

function renderCoverageBar(coverage: AttributionCoverage | undefined): string {
  if (!coverage) return "";
  const total = coverage.totalChars || 1;
  // 桶顺序：从证据最强（exact）到最弱（rule_gap）。
  const parts = [
    { label: "exact", color: "#10b981", chars: coverage.exactChars,
      hint: "exact matchMode 命中或 wire_schema 精确路径，可逐字节重建" },
    { label: "template", color: "#0ea5e9", chars: coverage.templateLiteralChars,
      hint: "regex 命中后非占位符的静态文本（含 exact_text rule 的整段）" },
    { label: "dynamic", color: "#f97316", chars: coverage.dynamicCapturedChars,
      hint: "regex 命名捕获组覆盖的动态字段字符" },
    { label: "recognized", color: "#a855f7", chars: coverage.recognizedUnexplainedChars,
      hint: "prefix 或不可重建 exact 仅识别 slot/rule，文本未解释" },
    { label: "rule_gap", color: "#ef4444", chars: coverage.ruleGapChars,
      hint: "完全无 rule 命中" },
  ];

  return `
    <section class="coverage-panel">
      <div class="coverage-bar">
        ${parts.map((part) => {
          const width = Math.max(0, (part.chars / total) * 100);
          return `<span style="width:${width}%;background:${part.color}" title="${esc(part.label)} ${formatPercent(part.chars / total)} · ${esc(part.hint)}"></span>`;
        }).join("")}
      </div>
      <div class="coverage-meta">
        ${parts.map((part) => `<span title="${esc(part.hint)}"><b style="color:${part.color}">${esc(part.label)}</b> ${formatPercent(part.chars / total)} · ${part.chars.toLocaleString()}c</span>`).join("")}
      </div>
      <div class="coverage-ratios">
        <span class="coverage-ratio" title="(totalChars - ruleGapChars) / totalChars">识别率 <b>${formatPercent(coverage.recognitionRatio)}</b></span>
        <span class="coverage-ratio" title="(exact + template + dynamic) / totalChars">证据覆盖 <b>${formatPercent(coverage.evidenceBackedRatio)}</b></span>
        <span class="coverage-ratio" title="exact / totalChars — 可字节重建占比">字节重建 <b>${formatPercent(coverage.byteReconstructableRatio)}</b></span>
      </div>
    </section>
  `;
}

export function renderParserView(
  snapshot: ParsedQuerySnapshot,
  attributions?: SegmentAttribution[],
  coverage?: AttributionCoverage,
): string {
  const groups = groupRoots(snapshot.roots);
  const totalChars = Object.values(snapshot.index).reduce((s, x) => s + x.charCount, 0);
  const totalNodes = Object.keys(snapshot.index).length;
  const attrByNodeId = new Map((attributions ?? []).map((attr) => [attr.nodeId, attr]));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Parser View — ${esc(snapshot.proxyFile)}</title>
<style>
  body {
    margin: 0;
    padding: 16px 24px;
    background: #f8fafc;
    color: #1f2937;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
  }
  header {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 16px;
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: center;
  }
  header .meta { display: flex; gap: 8px; align-items: center; }
  header .label {
    font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;
  }
  header .value { font-weight: 600; color: #0f172a; }
  header .qk-pill {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 12px;
    background: #1e293b;
    color: #f8fafc;
    font-weight: 600;
    font-size: 12px;
  }
  details {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    margin-bottom: 12px;
    overflow: hidden;
  }
  details > summary {
    padding: 10px 16px;
    cursor: pointer;
    font-weight: 600;
    font-size: 14px;
    border-bottom: 1px solid #e2e8f0;
    background: #f1f5f9;
    user-select: none;
  }
  details > summary .muted { color: #64748b; font-weight: 400; }
  .rows { padding: 4px 0; }
  .row {
    display: grid;
    grid-template-columns: 200px 220px 1fr 100px 140px 80px 460px;
    gap: 12px;
    padding: 6px 16px;
    align-items: center;
    border-bottom: 1px solid #f1f5f9;
  }
  .row:last-child { border-bottom: none; }
  .row.header {
    font-size: 11px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: #f8fafc;
  }
  .row.inline {
    padding-left: 40px;       /* 缩进 24px (相对 row padding 16px) */
    font-size: 12px;
    background: #fafbfc;
  }
  .col-id {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: #475569;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .col-slot { display: flex; align-items: center; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    color: #fff;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    font-weight: 600;
  }
  .col-path {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: #64748b;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .col-count {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: #334155;
  }
  .col-hash {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: #94a3b8;
    font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .col-cache {
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .cache-none { color: #cbd5e1; }
  .cache-ttl, .cache-scope { white-space: nowrap; }
  .col-attr {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    flex-wrap: wrap;
  }
  .attr-badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
  }
  .mat-badge {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 4px;
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
  }
  .conf {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
  }
  .rule-id {
    color: #64748b;
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
    display: inline-block;
  }
  .attr-note {
    color: #94a3b8;
    font-size: 10px;
    white-space: nowrap;
    border-bottom: 1px dotted #cbd5e1;
    cursor: help;
  }
  .no-attr { color: #94a3b8; }
  /* evidence summary */
  .evd {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-wrap: nowrap;
  }
  .evd-mode {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    color: #fff;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10px;
    font-weight: 700;
    white-space: nowrap;
  }
  .evd-bar {
    display: inline-flex;
    width: 90px;
    height: 8px;
    border-radius: 999px;
    background: #e2e8f0;
    overflow: hidden;
  }
  .evd-bar > span { display: block; height: 100%; }
  .evd-tag {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
  }
  .evd-gap {
    color: #ef4444;
    font-size: 10px;
    font-weight: 600;
  }
  .warn {
    color: #ef4444;
    margin-left: 6px;
  }
  /* chars 展开按钮 */
  .chars-btn {
    all: unset;
    cursor: pointer;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: #334155;
    border-bottom: 1px dashed #94a3b8;
    padding-bottom: 1px;
    user-select: none;
  }
  .chars-btn:hover { color: #0ea5e9; border-bottom-color: #0ea5e9; }
  .chars-btn.open { color: #0ea5e9; border-bottom-style: solid; }
  /* 展开区 */
  .raw-expand {
    padding: 6px 16px 10px 16px;
    border-bottom: 1px solid #f1f5f9;
  }
  .raw-expand[hidden] { display: none; }
  .raw-expand:last-child { border-bottom: none; }
  .raw-pre {
    margin: 0;
    padding: 10px 14px;
    background: #0f172a;
    color: #e2e8f0;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 11.5px;
    line-height: 1.6;
    border-radius: 6px;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 400px;
    overflow-y: auto;
  }
  .row.inline + .raw-expand { padding-left: 40px; }
  /* dynamic fields */
  .df-block {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 6px;
    margin-bottom: 8px;
    padding: 0 12px;
  }
  .df-block > summary {
    padding: 6px 0;
    cursor: pointer;
    font-size: 11.5px;
    font-weight: 600;
    color: #475569;
    background: transparent;
    border-bottom: none;
  }
  .df-table {
    border-collapse: collapse;
    width: 100%;
    margin: 6px 0 8px 0;
    font-size: 11.5px;
  }
  .df-table th, .df-table td {
    text-align: left;
    padding: 4px 6px;
    border-bottom: 1px solid #e2e8f0;
    vertical-align: top;
  }
  .df-table th { color: #64748b; font-weight: 600; }
  .df-name { font-family: ui-monospace, monospace; color: #1d4ed8; white-space: nowrap; }
  .df-source .df-src-badge {
    display: inline-block; padding: 1px 6px; border-radius: 3px;
    color: #fff; font-size: 10px; font-weight: 700;
  }
  .df-range { font-family: ui-monospace, monospace; color: #64748b; white-space: nowrap; }
  .df-value code {
    font-family: ui-monospace, monospace; font-size: 11px;
    background: #0f172a; color: #e2e8f0; padding: 1px 6px; border-radius: 3px;
    word-break: break-all;
  }
  /* unknown / residual / rule_gap 行高亮 */
  .row.unknown { background: #fff1f2; }
  .row.residual { background: #fffbeb; }
  .row.rule-gap { background: #fff1f2; }
  .row.rule-gap .col-id { color: #dc2626; }
  /* nodeKind 小标签 */
  .kind-badge {
    display: inline-block;
    margin-left: 6px;
    font-size: 10px;
    font-weight: 600;
    padding: 1px 5px;
    border-radius: 3px;
    vertical-align: middle;
  }
  .kind-badge.unknown { background: #fecaca; color: #991b1b; }
  .kind-badge.residual { background: #fef3c7; color: #92400e; }
  /* coverage panel */
  .coverage-panel {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 10px 16px;
    margin-bottom: 16px;
  }
  .coverage-bar {
    display: flex;
    height: 10px;
    overflow: hidden;
    border-radius: 999px;
    background: #e2e8f0;
  }
  .coverage-bar span { display: block; min-width: 1px; }
  .coverage-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-top: 8px;
    color: #64748b;
    font-size: 12px;
  }
  .coverage-ratios {
    display: flex;
    flex-wrap: wrap;
    gap: 18px;
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px dashed #e2e8f0;
    color: #475569;
    font-size: 12px;
  }
  .coverage-ratio b { color: #0f172a; margin-left: 4px; }
</style>
</head>
<body>
  <header>
    <div class="meta"><span class="label">queryKind</span><span class="qk-pill">${esc(snapshot.queryKind)}</span></div>
    <div class="meta"><span class="label">proxyFile</span><span class="value">${esc(snapshot.proxyFile)}</span></div>
    <div class="meta"><span class="label">segments</span><span class="value">${totalNodes}</span></div>
    <div class="meta"><span class="label">totalChars</span><span class="value">${totalChars.toLocaleString()}</span></div>
    <div class="meta"><span class="label">ts</span><span class="value">${esc(snapshot.ts)}</span></div>
  </header>

  ${renderCoverageBar(coverage)}

  ${renderGroup(groups.system, attrByNodeId)}
  ${renderGroup(groups.tools, attrByNodeId)}
  ${renderGroup(groups.messages, attrByNodeId)}
</body>
</html>`;
}
