// reconstruct2 / audit / mutation-view-html
//
// 把 MutationView 渲染成自包含静态 HTML，供 audit 主页通过链接跳转打开。
//
// 设计目标（与 docs/draft/context/reconstruct-refine.md 一致）：
//   1. 在没有 proxy 的情况下回答"我们如何理解这份 JSONL"。
//   2. 把 JSONL 行级 disposition、frame 参与关系、过滤/丢弃理由摆在一个地方。
//   3. 与 parser-view 平级——只读、纯静态、无外部依赖、可双击打开。
//
// 三个核心视图（顶部 tab 切换）：
//   - All lines    JSONL 原始顺序逐行 ledger（含 disposition / frames / preview）
//   - Frames       每个 ContextFrame 的入参清单（mutationIds / eventIds / runtimeSnapshot）
//   - Dropped      未进入任何 frame 的行，按 reasonCode 聚合

import type {
  ClaudeJsonlEvent,
  ContextFrame,
  JsonlLineDisposition,
  JsonlLineLedgerEntry,
  MutationView,
} from "../jsonl/event-types";
import type { ContextMutation } from "../../types";

// ─────────────────────────────────────────────────────────────────────────────
// HTML 转义 / 颜色
// ─────────────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DISPOSITION_COLOR: Record<JsonlLineDisposition, string> = {
  included_in_frame: "#10b981",
  parsed_not_materialized: "#0ea5e9",
  runtime_fact_only: "#6366f1",
  filtered_noise: "#94a3b8",
  sidechain_routed: "#a855f7",
  dropped_retry_preempted: "#f59e0b",
  deferred_unimplemented: "#f97316",
  unknown_schema: "#ef4444",
  parse_error: "#dc2626",
};

const QUERY_KIND_COLOR: Record<string, string> = {
  main_session: "#1d4ed8",
  side_query: "#a855f7",
  unknown: "#94a3b8",
};

function dispositionBadge(disposition: JsonlLineDisposition): string {
  const color = DISPOSITION_COLOR[disposition] ?? "#94a3b8";
  return `<span class="disp" style="background:${color}">${esc(disposition)}</span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 渲染辅助
// ─────────────────────────────────────────────────────────────────────────────

interface IndexedView {
  view: MutationView;
  mutationById: Map<string, ContextMutation>;
  eventById: Map<string, ClaudeJsonlEvent>;
  frameById: Map<string, ContextFrame>;
  ledgerByLine: Map<number, JsonlLineLedgerEntry>;
}

function indexView(view: MutationView): IndexedView {
  const mutationById = new Map<string, ContextMutation>();
  for (const m of view.mutations) mutationById.set(m.id, m);
  for (const m of view.sidechainMutations) mutationById.set(m.id, m);
  const eventById = new Map<string, ClaudeJsonlEvent>();
  for (const e of view.events) eventById.set(e.id, e);
  const frameById = new Map<string, ContextFrame>();
  for (const f of view.frames) frameById.set(f.frameId, f);
  const ledgerByLine = new Map<number, JsonlLineLedgerEntry>();
  for (const e of view.lineLedger) ledgerByLine.set(e.line, e);
  return { view, mutationById, eventById, frameById, ledgerByLine };
}

function summarizePreview(s: string | undefined, max = 160): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function renderLedgerRow(entry: JsonlLineLedgerEntry): string {
  const disp = dispositionBadge(entry.disposition);
  const typeCol = entry.type
    ? `${esc(entry.type)}${entry.subtype ? ":" + esc(entry.subtype) : ""}${entry.attachmentType ? "/" + esc(entry.attachmentType) : ""}`
    : "<span class=\"muted\">—</span>";
  const muts = entry.mutationIds.length > 0
    ? entry.mutationIds
        .map((id) => `<code class="mut-ref" data-mut="${esc(id)}" title="${esc(id)}">${esc(id)}</code>`)
        .join(" ")
    : `<span class="muted">—</span>`;
  const frames = entry.frameIds.length > 0
    ? entry.frameIds
        .map((id) => `<a class="frame-ref" href="#frame-${esc(id)}" title="${esc(id)}">${esc(id)}</a>`)
        .join(" ")
    : `<span class="muted">—</span>`;
  const reason = entry.reasonCode
    ? `<code class="reason">${esc(entry.reasonCode)}</code>`
    : "";
  const cat = entry.category
    ? `<span class="cat">${esc(entry.category)}</span>`
    : "";
  const preview = summarizePreview(entry.preview);
  return `
    <tr class="ledger-row" data-disp="${esc(entry.disposition)}">
      <td class="ln">${entry.line}</td>
      <td class="ty">${typeCol}</td>
      <td class="cg">${cat}</td>
      <td class="ds">${disp}</td>
      <td class="rs">${reason}</td>
      <td class="mu">${muts}</td>
      <td class="fr">${frames}</td>
      <td class="pv"><code>${esc(preview)}</code></td>
    </tr>
  `;
}

function renderFrameSection(frame: ContextFrame, idx: IndexedView): string {
  const qkColor = QUERY_KIND_COLOR[frame.queryKind] ?? "#94a3b8";
  const lines = new Set<number>();
  for (const mid of frame.mutationIds) {
    const m = idx.mutationById.get(mid);
    if (m && m.sourceRef.kind === "jsonl" && m.sourceRef.jsonl.line !== undefined) {
      lines.add(m.sourceRef.jsonl.line);
    }
  }
  const callEvent = idx.eventById.get(frame.callEventId);
  const callLine = callEvent?.line;

  const mutationRows = frame.mutationIds.map((mid) => {
    const m = idx.mutationById.get(mid);
    if (!m) return "";
    const line =
      m.sourceRef.kind === "jsonl" && m.sourceRef.jsonl.line !== undefined
        ? m.sourceRef.jsonl.line
        : "?";
    const text = m.contentRef?.text ?? "";
    const preview = summarizePreview(text);
    return `
      <tr>
        <td class="ln">${line}</td>
        <td><code>${esc(mid)}</code></td>
        <td><span class="cat">${esc(m.category)}</span></td>
        <td><code class="muted">${esc(m.type)}</code></td>
        <td class="num">${(m.charDeltaEstimate ?? 0).toLocaleString()}</td>
        <td class="pv"><code>${esc(preview)}</code></td>
      </tr>
    `;
  }).join("");

  const subagentInfo = frame.subagentId
    ? ` <span class="muted">subagent=${esc(frame.subagentId)}</span>`
    : "";

  const runtime = frame.runtimeSnapshot;
  const runtimeKv = [
    ["model", runtime.inferredModel],
    ["permissionMode", runtime.permissionMode],
    ["claudeCodeVersion", runtime.claudeCodeVersion],
    ["userType", runtime.userType],
    ["cwd", runtime.cwd],
  ]
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<span class="rt-kv"><b>${esc(String(k))}</b> ${esc(String(v))}</span>`)
    .join("");

  return `
    <section id="frame-${esc(frame.frameId)}" class="frame">
      <h3>
        <span class="qk-badge" style="background:${qkColor}">${esc(frame.queryKind)}</span>
        <code>${esc(frame.frameId)}</code>
        <span class="muted">queryIndex=${frame.queryIndex}</span>
        <span class="muted">·</span>
        <span class="muted">callLine=${callLine ?? frame.callEventId}</span>
        <span class="muted">·</span>
        <span class="muted">boundary.confidence=${esc(frame.boundary.confidence)}</span>
        ${subagentInfo}
      </h3>
      <div class="frame-meta">
        <div><b>mutations</b> ${frame.mutationIds.length} · <b>events</b> ${frame.eventIds.length} · <b>jsonl lines</b> ${lines.size}</div>
        <div class="rt">${runtimeKv || `<span class="muted">runtime snapshot empty</span>`}</div>
      </div>
      <table class="frame-mut">
        <thead><tr><th>line</th><th>mutationId</th><th>category</th><th>type</th><th>chars</th><th>preview</th></tr></thead>
        <tbody>${mutationRows}</tbody>
      </table>
    </section>
  `;
}

function renderFrames(view: MutationView, idx: IndexedView): string {
  if (view.frames.length === 0) {
    return `<div class="empty">No frames detected — JSONL has no assistant responses.</div>`;
  }
  return view.frames.map((f) => renderFrameSection(f, idx)).join("");
}

function renderDropped(view: MutationView): string {
  const buckets = new Map<string, JsonlLineLedgerEntry[]>();
  for (const entry of view.lineLedger) {
    if (entry.frameIds.length > 0) continue;
    const key = `${entry.disposition}|${entry.reasonCode || "no_reason"}`;
    const arr = buckets.get(key) ?? [];
    arr.push(entry);
    buckets.set(key, arr);
  }
  if (buckets.size === 0) {
    return `<div class="empty">All JSONL lines participated in a frame — nothing was dropped or filtered.</div>`;
  }
  const sortedKeys = [...buckets.keys()].sort();
  return sortedKeys
    .map((key) => {
      const entries = buckets.get(key)!;
      const [disposition, reason] = key.split("|");
      const rows = entries
        .slice(0, 50)
        .map((e) => `
          <tr>
            <td class="ln">${e.line}</td>
            <td>${e.type ? esc(e.type) : "<span class=\"muted\">—</span>"}</td>
            <td><code class="muted">${esc(e.subtype ?? e.attachmentType ?? "")}</code></td>
            <td class="pv"><code>${esc(summarizePreview(e.preview, 200))}</code></td>
          </tr>
        `)
        .join("");
      const more = entries.length > 50 ? `<div class="muted">+${entries.length - 50} more rows…</div>` : "";
      return `
        <section class="drop-bucket">
          <h3>
            ${dispositionBadge(disposition as JsonlLineDisposition)}
            <code class="reason">${esc(reason)}</code>
            <span class="muted">${entries.length} line${entries.length > 1 ? "s" : ""}</span>
          </h3>
          <table class="drop-table">
            <thead><tr><th>line</th><th>type</th><th>subtype/attachmentType</th><th>preview</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          ${more}
        </section>
      `;
    })
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// 顶层 render
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderMutationViewOptions {
  /** 顶部 header 显示的标题（默认 sessionId） */
  title?: string;
  /** 来源 jsonl 文件路径 / 备注 */
  sourceLabel?: string;
}

export function renderMutationViewHtml(
  view: MutationView,
  opts: RenderMutationViewOptions = {},
): string {
  const idx = indexView(view);

  const ledgerRows = view.lineLedger
    .map((entry) => renderLedgerRow(entry))
    .join("");

  const dispositionCounts = new Map<JsonlLineDisposition, number>();
  for (const entry of view.lineLedger) {
    dispositionCounts.set(entry.disposition, (dispositionCounts.get(entry.disposition) ?? 0) + 1);
  }
  const dispositionPills = [...dispositionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([d, c]) => `${dispositionBadge(d)}<span class="pill-count">${c}</span>`)
    .join("");

  const totals = {
    lines: view.lineLedger.length,
    events: view.events.length,
    mutations: view.mutations.length,
    sidechainMutations: view.sidechainMutations.length,
    frames: view.frames.length,
    mainFrames: view.frames.filter((f) => f.queryKind === "main_session").length,
    sideFrames: view.frames.filter((f) => f.queryKind === "side_query").length,
    pendingFrames: view.frames.filter((f) => f.queryKind === "unknown").length,
  };

  const title = esc(opts.title ?? view.sessionId);
  const source = esc(opts.sourceLabel ?? view.jsonlFile);

  const framesHtml = renderFrames(view, idx);
  const droppedHtml = renderDropped(view);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Mutation View — ${title}</title>
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
    margin-bottom: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    align-items: center;
  }
  header .meta { display: flex; gap: 6px; align-items: center; }
  header .label {
    font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;
  }
  header .value { font-weight: 600; color: #0f172a; }
  header .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: #f1f5f9;
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 11px;
  }
  .nav {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }
  .nav button {
    all: unset;
    cursor: pointer;
    padding: 6px 14px;
    border-radius: 6px;
    background: #e2e8f0;
    color: #1e293b;
    font-weight: 600;
    font-size: 12px;
  }
  .nav button.active {
    background: #1d4ed8;
    color: #f8fafc;
  }
  .panel { display: none; }
  .panel.active { display: block; }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 12px;
  }
  th { background: #f1f5f9; padding: 8px 10px; text-align: left; font-size: 11px; color: #64748b; }
  td { padding: 6px 10px; border-top: 1px solid #f1f5f9; vertical-align: top; }
  td.ln { width: 64px; color: #64748b; font-family: ui-monospace, monospace; text-align: right; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; color: #334155; }
  td.ty { font-family: ui-monospace, monospace; font-size: 12px; }
  td.ds, td.rs { white-space: nowrap; }
  td.fr a { color: #1d4ed8; text-decoration: none; font-family: ui-monospace, monospace; font-size: 11px; }
  td.fr a:hover { text-decoration: underline; }
  td.pv code {
    display: block;
    max-height: 5.4em;
    overflow: hidden;
    color: #475569;
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .disp {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 3px;
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    font-family: ui-monospace, monospace;
  }
  .pill-count {
    margin: 0 12px 0 4px;
    color: #475569;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .reason {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: #1e293b;
    background: #f1f5f9;
    padding: 1px 6px;
    border-radius: 3px;
  }
  .cat {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: #475569;
    background: #fff7ed;
    padding: 1px 6px;
    border-radius: 3px;
  }
  .muted { color: #94a3b8; }
  .mut-ref {
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: #4f46e5;
    background: #eef2ff;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .qk-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 3px;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    margin-right: 6px;
  }
  .frame {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    margin-bottom: 12px;
    padding: 12px 16px;
  }
  .frame h3 {
    font-size: 14px;
    margin: 0 0 6px 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .frame-meta { color: #475569; font-size: 12px; margin-bottom: 8px; }
  .frame-meta .rt { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4px; }
  .rt-kv { color: #475569; }
  .rt-kv b { color: #0f172a; margin-right: 4px; }
  .frame-mut { margin: 0; }
  .frame-mut td { font-size: 12px; }
  .drop-bucket { margin-bottom: 12px; }
  .drop-bucket h3 {
    font-size: 13px;
    margin: 0 0 6px 0;
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .drop-table th { background: #fef2f2; }
  .empty {
    background: #fff;
    border: 1px dashed #cbd5e1;
    border-radius: 8px;
    padding: 20px;
    text-align: center;
    color: #64748b;
  }
  .legend {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 8px 12px;
    margin-bottom: 12px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: center;
    font-size: 11px;
    color: #64748b;
  }
  .legend b { color: #0f172a; margin-right: 4px; font-weight: 600; }
</style>
</head>
<body>
  <header>
    <div class="meta"><span class="label">sessionId</span><span class="value">${title}</span></div>
    <div class="meta"><span class="label">source</span><span class="value">${source}</span></div>
    <div class="meta"><span class="label">model</span><span class="value">${esc(view.inferredModel ?? "—")}</span></div>
    <div class="meta">
      <span class="label">totals</span>
      <span class="pill">lines <b>${totals.lines}</b></span>
      <span class="pill">events <b>${totals.events}</b></span>
      <span class="pill">mutations <b>${totals.mutations}</b></span>
      <span class="pill">sidechain <b>${totals.sidechainMutations}</b></span>
      <span class="pill">frames <b>${totals.frames}</b></span>
      <span class="pill">main <b>${totals.mainFrames}</b></span>
      <span class="pill">side <b>${totals.sideFrames}</b></span>
      <span class="pill">pending <b>${totals.pendingFrames}</b></span>
    </div>
  </header>

  <div class="legend"><b>disposition</b>${dispositionPills}</div>

  <div class="nav">
    <button class="tab active" data-tab="lines">All lines (${totals.lines})</button>
    <button class="tab" data-tab="frames">Frames (${totals.frames})</button>
    <button class="tab" data-tab="dropped">Dropped / filtered</button>
  </div>

  <section class="panel active" data-panel="lines">
    <table>
      <thead>
        <tr>
          <th>line</th>
          <th>type</th>
          <th>category</th>
          <th>disposition</th>
          <th>reason</th>
          <th>mutation ids</th>
          <th>frames</th>
          <th>preview</th>
        </tr>
      </thead>
      <tbody>
        ${ledgerRows}
      </tbody>
    </table>
  </section>

  <section class="panel" data-panel="frames">
    ${framesHtml}
  </section>

  <section class="panel" data-panel="dropped">
    ${droppedHtml}
  </section>

<script>
(function () {
  var tabs = document.querySelectorAll('.tab');
  var panels = document.querySelectorAll('.panel');
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      var id = t.getAttribute('data-tab');
      tabs.forEach(function (x) { x.classList.toggle('active', x === t); });
      panels.forEach(function (p) {
        p.classList.toggle('active', p.getAttribute('data-panel') === id);
      });
    });
  });
  // Hash-based deep-link to a frame: switch to Frames tab automatically.
  if (location.hash.indexOf('#frame-') === 0) {
    var framesTab = document.querySelector('.tab[data-tab="frames"]');
    if (framesTab) framesTab.click();
  }
})();
</script>
</body>
</html>`;
}
