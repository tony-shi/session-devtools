// parser-view：把单 query 的 ParsedQuerySnapshot 渲染为 standalone HTML
// 设计：完整 <!DOCTYPE html>，内联 CSS，无外部依赖（可以直接双击打开）。
// 排版思路：三个折叠块（System / Tools / Messages），每个 segment 一行，
// inline children 在父行下方缩进展示。

import type { ParsedQuerySnapshot, SegmentNode } from "../parser/types";
import { UNKNOWN_SLOT } from "../parser/types";

// ─────────────────────────────────────────────────────────────────────────────
// 颜色规则（slotId → badge color）
// 与 phase1 prompt 对齐
// ─────────────────────────────────────────────────────────────────────────────

function slotColor(slotId: string): string {
  // unknown / residual → 醒目红色，让 audit 一眼发现 gap
  if (Object.values(UNKNOWN_SLOT).includes(slotId as never)) return "#ef4444";
  if (slotId === "system.billing" || slotId === "system.identity") return "#6b7280";
  if (slotId.startsWith("system.section.")) return "#3b82f6";
  if (slotId.startsWith("system.")) return "#1d4ed8";
  if (slotId.startsWith("tools.")) return "#f59e0b";
  if (slotId === "messages.tool_use") return "#10b981";
  if (slotId === "messages.tool_result") return "#059669";
  if (slotId === "messages.text" || slotId === "messages.inline.free-text") return "#0ea5e9";
  if (slotId === "messages.inline.system-reminder") return "#8b5cf6";
  if (slotId === "messages.inline.local-command") return "#d97706";
  if (slotId.startsWith("side-query.")) return "#64748b";
  return "#ef4444";
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

// ─────────────────────────────────────────────────────────────────────────────
// section 分组
// ─────────────────────────────────────────────────────────────────────────────

interface Group {
  title: string;
  roots: SegmentNode[];  // 该 section 的顶层节点
}

// 把 snapshot.roots 按 slotId 前缀分进三个 section。
// 注意：分组只看顶层节点（roots），渲染时递归展开 children。
function groupRoots(roots: SegmentNode[]): { system: Group; tools: Group; messages: Group } {
  const system: SegmentNode[] = [];
  const tools: SegmentNode[] = [];
  const messages: SegmentNode[] = [];

  for (const node of roots) {
    const sid = node.slotId;
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
// 单行渲染
// ─────────────────────────────────────────────────────────────────────────────

// renderNode 递归渲染一个 SegmentNode 及其 children。
// children 在 HTML 里紧跟父行，CSS .inline 控制缩进。
// depth 用于判断是否需要 .inline 样式（depth > 0 即为子节点）。
function renderNode(node: SegmentNode, depth = 0): string {
  return renderRow(node, depth) + node.children.map((c) => renderNode(c, depth + 1)).join("");
}

function renderRow(seg: SegmentNode, depth = 0): string {
  const isInline = depth > 0;
  const color = slotColor(seg.slotId);
  const warn = seg.charCount > 10000 ? '<span class="warn" title="charCount &gt; 10000">⚠</span>' : "";
  const hashPrefix = seg.rawHash.length > 19 ? seg.rawHash.slice(0, 19) : seg.rawHash;

  // unknown / residual 节点加小标签，方便 audit 一眼发现 gap
  const kindBadge = seg.nodeKind === "unknown"
    ? `<span class="kind-badge unknown" title="${esc(seg.metadata?.reason ?? "unknown slot")}">[unknown]</span>`
    : seg.nodeKind === "residual"
      ? `<span class="kind-badge residual">[residual]</span>`
      : "";

  // rawText 展开区
  const rawTextHtml = `<div class="raw-expand" hidden><pre class="raw-pre">${esc(seg.rawText)}</pre></div>`;

  return `
    <div class="row${isInline ? " inline" : ""}${seg.nodeKind !== "known" ? " " + seg.nodeKind : ""}">
      <span class="col-id">${esc(seg.id)}</span>
      <span class="col-slot"><span class="badge" style="background:${color}">${esc(seg.slotId)}</span>${kindBadge}</span>
      <span class="col-path">${esc(seg.jsonPath)}</span>
      <span class="col-count">
        <button class="chars-btn" onclick="var p=this.closest('.row').nextElementSibling;p.hidden=!p.hidden;this.classList.toggle('open')"
          title="点击展开/折叠原文">${seg.charCount.toLocaleString()}${warn}</button>
      </span>
      <span class="col-hash">${esc(hashPrefix)}</span>
    </div>
    ${rawTextHtml}
  `;
}

// 计算一棵节点树的所有节点数（含子孙）
function countNodes(nodes: SegmentNode[]): number {
  return nodes.reduce((s, n) => s + 1 + countNodes(n.children), 0);
}

function renderGroup(g: Group): string {
  const total = countNodes(g.roots);
  if (total === 0) {
    return `
      <details open>
        <summary>${esc(g.title)} <span class="muted">(empty)</span></summary>
      </details>
    `;
  }

  const rows = g.roots.map((n) => renderNode(n)).join("");
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
        </div>
        ${rows}
      </div>
    </details>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// 顶层 render
// ─────────────────────────────────────────────────────────────────────────────

export function renderParserView(snapshot: ParsedQuerySnapshot): string {
  const groups = groupRoots(snapshot.roots);
  const totalChars = Object.values(snapshot.index).reduce((s, x) => s + x.charCount, 0);
  const totalNodes = Object.keys(snapshot.index).length;

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
    grid-template-columns: 220px 240px 1fr 100px 200px;
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
  /* 展开状态：数字变蓝表示已打开 */
  .chars-btn.open { color: #0ea5e9; border-bottom-style: solid; }
  /* 展开区 */
  .raw-expand {
    padding: 0 16px 10px 16px;
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
  /* inline 行的展开区也缩进对齐 */
  .row.inline + .raw-expand { padding-left: 40px; }
  /* unknown / residual 行高亮背景 */
  .row.unknown { background: #fff1f2; }
  .row.residual { background: #fffbeb; }
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

  ${renderGroup(groups.system)}
  ${renderGroup(groups.tools)}
  ${renderGroup(groups.messages)}
</body>
</html>`;
}
