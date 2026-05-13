// AttributionTreePanel：legacy-style 三层钻取视图。
//
// Layer 1  CompositionBar     顶部连体堆叠条（system / tools / messages 三段，按字符数比例宽度）。
//                              视觉照搬 legacy CallSegmentTree 的 stacked bar：浅紫 / 灰 / 蓝。
// Layer 2  SectionRow         每段一行：色块 + 名称 + 大小 + % + 段数 + 子统计 + expand 按钮。
//                              展开后内嵌 strip + selected 详情。
// Layer 3  SectionStrip       单行 strip：每个叶子一个色块，宽度 ∝ charCount，填色 ∝ origin.kind。
//                              不再带任何 diff 视觉（diff 由 Diff vs Previous tab 承担）。
//
// 设计取向：
//   - 边框 1px、低饱和度配色，向 legacy CallSegmentTree 看齐。
//   - 顶部 stacked bar 用 flex 比例，单个圆角容器内分段，不留缝。

import { useEffect, useMemo, useState } from "react";
import { apiV2 } from "./api";
import type {
  AttributionTreeResult,
  SerializedNode,
  SegmentOrigin,
  OriginKind,
} from "./attribution-tree-types";

// ─── 类型与配色 ─────────────────────────────────────────────────────────────

type SectionId = "system" | "tools" | "messages" | "other";

interface SectionMeta {
  label: string;
  /** stacked bar 块的填色（legacy 调色板） */
  barBg: string;
  /** stacked bar 块文字颜色 */
  barText: string;
  /** SectionRow 容器底色 */
  rowBg: string;
  /** SectionRow 边框颜色 */
  rowBorder: string;
  /** SectionRow 左侧色块 */
  marker: string;
  /** SectionRow 文字主色 */
  textColor: string;
}

const SECTION_META: Record<SectionId, SectionMeta> = {
  system:   { label: "System",   barBg: "#a5b4fc", barText: "#fff", rowBg: "#eef2ff", rowBorder: "#e0e7ff", marker: "#818cf8", textColor: "#3730a3" },
  tools:    { label: "Tools",    barBg: "#9ca3af", barText: "#fff", rowBg: "#f3f4f6", rowBorder: "#e5e7eb", marker: "#6b7280", textColor: "#374151" },
  messages: { label: "Messages", barBg: "#7c8df6", barText: "#fff", rowBg: "#eff6ff", rowBorder: "#dbeafe", marker: "#6366f1", textColor: "#1e40af" },
  other:    { label: "Other",    barBg: "#d1d5db", barText: "#fff", rowBg: "#fafafa", rowBorder: "#f3f4f6", marker: "#9ca3af", textColor: "#374151" },
};

const ORIGIN_FILL: Record<OriginKind, string> = {
  rule:       "#c7d2fe",
  jsonl:      "#bbf7d0",
  structural: "#e5e7eb",
  unknown:    "#fecaca",
};

const ORIGIN_BORDER: Record<OriginKind, string> = {
  rule:       "#a5b4fc",
  jsonl:      "#86efac",
  structural: "#d1d5db",
  unknown:    "#fca5a5",
};

const ORIGIN_LABEL: Record<OriginKind, string> = {
  rule: "rule", jsonl: "jsonl", structural: "structural", unknown: "unknown",
};

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function sectionOf(slotType: string): SectionId {
  if (slotType.startsWith("system.") || slotType === "side-query.system") return "system";
  if (slotType.startsWith("tools.")) return "tools";
  if (slotType.startsWith("messages.") || slotType === "side-query.user") return "messages";
  return "other";
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

function shortSlot(slotType: string): string {
  return slotType
    .replace("system.main-prompt.section.", "sys.")
    .replace("system.main-prompt-block", "sys.main")
    .replace("messages.", "msg.")
    .replace("tools.builtin.", "tool.");
}

function originLabel(origin: SegmentOrigin): string {
  if (origin.kind === "rule") {
    return origin.ruleId.startsWith("wire.") ? `wire · ${origin.ruleId.slice(5)}` : origin.ruleId;
  }
  if (origin.kind === "jsonl") {
    return `${origin.eventKind} @L${origin.jsonlLineIdx}` +
      (origin.sourceCallId !== undefined ? ` · call #${origin.sourceCallId}` : "");
  }
  if (origin.kind === "structural") return `slot · ${origin.reason}`;
  return `unknown · ${origin.reason}`;
}

// ─── 派生数据：current snapshot → leaves（按 section 分组）────────────────────

interface LeafLite {
  nodeId: string;
  slotType: string;
  rootSlotType: string;
  charCount: number;
  preview: string;
  origin: SegmentOrigin;
  rawText?: string;
  /** message role：消息类节点用于子统计（user/assistant/system 段数） */
  messageRole?: "user" | "assistant" | "system";
}

function flattenLeaves(result: AttributionTreeResult): LeafLite[] {
  if (!result.snapshot) return [];
  const out: LeafLite[] = [];
  function visit(node: SerializedNode, rootSlot: string) {
    if (node.children.length === 0) {
      out.push({
        nodeId: node.id,
        slotType: node.slotType,
        rootSlotType: rootSlot,
        charCount: node.charCount,
        preview: node.preview,
        origin: node.origin,
        rawText: node.rawText,
        ...(node.wireMeta?.messageRole && { messageRole: node.wireMeta.messageRole }),
      });
      return;
    }
    for (const c of node.children) visit(c, rootSlot);
  }
  for (const root of result.snapshot.roots) visit(root, root.slotType);
  return out;
}

interface SectionStat {
  id: SectionId;
  totalChars: number;
  leafCount: number;
  leaves: LeafLite[];
  /** 仅 messages 用：按 role 子计数 */
  byRole?: { user: number; assistant: number; system: number };
  /** 仅 tools 用：tool 个数（顶层 root 为 tools.builtin.* 的去重数） */
  toolCount?: number;
}

function computeSectionStats(leaves: LeafLite[]): SectionStat[] {
  const map = new Map<SectionId, LeafLite[]>();
  for (const l of leaves) {
    const id = sectionOf(l.rootSlotType);
    if (!map.has(id)) map.set(id, []);
    map.get(id)!.push(l);
  }
  const order: SectionId[] = ["system", "tools", "messages", "other"];
  const out: SectionStat[] = [];
  for (const id of order) {
    const ls = map.get(id);
    if (!ls || ls.length === 0) continue;
    const stat: SectionStat = {
      id, leaves: ls,
      totalChars: ls.reduce((s, l) => s + l.charCount, 0),
      leafCount: ls.length,
    };
    if (id === "messages") {
      stat.byRole = { user: 0, assistant: 0, system: 0 };
      for (const l of ls) {
        const r = l.messageRole;
        if (r === "user") stat.byRole.user += 1;
        else if (r === "assistant") stat.byRole.assistant += 1;
        else if (r === "system") stat.byRole.system += 1;
      }
    } else if (id === "tools") {
      const tools = new Set<string>();
      for (const l of ls) tools.add(l.rootSlotType);
      stat.toolCount = tools.size;
    }
    out.push(stat);
  }
  return out;
}

// ─── Layer 1: CompositionBar (legacy stacked bar) ────────────────────────────

function CompositionBar({ stats, totalChars }: { stats: SectionStat[]; totalChars: number }) {
  if (totalChars === 0) return null;
  return (
    <div style={{
      display: "flex", overflow: "hidden", borderRadius: 8,
      border: "1px solid #e5e7eb",
    }}>
      {stats.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = s.totalChars / totalChars;
        return (
          <div
            key={s.id}
            title={`${meta.label}: ${fmtK(s.totalChars)} chars (${(pct * 100).toFixed(1)}%)`}
            style={{
              flex: pct,
              minWidth: 64,
              background: meta.barBg,
              color: meta.barText,
              padding: "12px 14px",
              fontSize: 13, fontWeight: 700, lineHeight: 1.3,
              display: "flex", flexDirection: "column", justifyContent: "center",
              overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
            }}
          >
            <div>{meta.label}</div>
            <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.95 }}>~{fmtK(s.totalChars)}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Layer 2: SectionRow ─────────────────────────────────────────────────────

function SectionRow({
  stat, totalChars, expanded, onToggle, children,
}: {
  stat: SectionStat;
  totalChars: number;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  const meta = SECTION_META[stat.id];
  const pct = totalChars > 0 ? Math.round((stat.totalChars / totalChars) * 100) : 0;

  return (
    <div style={{
      background: meta.rowBg,
      border: `1px solid ${meta.rowBorder}`,
      borderRadius: 8,
      overflow: "hidden",
    }}>
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px", cursor: "pointer",
        }}
      >
        <span style={{ width: 10, height: 10, background: meta.marker, borderRadius: 2, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: meta.textColor }}>{meta.label}</span>
        <span style={{ fontSize: 11, color: meta.textColor, opacity: 0.7 }}>~{fmtK(stat.totalChars)}</span>
        <span style={{ fontSize: 11, color: meta.textColor, opacity: 0.7 }}>{pct}%</span>
        <span style={{ fontSize: 11, color: meta.textColor, opacity: 0.7 }}>{stat.leafCount} segments</span>

        {/* 子统计 */}
        {stat.toolCount !== undefined && (
          <span style={chipStyle}>{stat.toolCount} tools</span>
        )}
        {stat.byRole && (
          <>
            {stat.byRole.user > 0 && <span style={chipStyle}>{stat.byRole.user} user</span>}
            {stat.byRole.assistant > 0 && <span style={chipStyle}>{stat.byRole.assistant} assistant</span>}
            {stat.byRole.system > 0 && <span style={chipStyle}>{stat.byRole.system} system</span>}
          </>
        )}

        <span style={{
          marginLeft: "auto", fontSize: 11, color: meta.textColor,
          opacity: 0.85, fontWeight: 500,
        }}>
          {expanded ? "▾ collapse" : "▸ expand"}
        </span>
      </div>

      {expanded && (
        <div style={{ padding: "10px 14px 14px", borderTop: `1px solid ${meta.rowBorder}`, background: "#fff" }}>
          {children}
        </div>
      )}
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  fontSize: 10, color: "#6b7280",
  background: "#fff", border: "1px solid #e5e7eb",
  borderRadius: 4, padding: "1px 6px",
};

// ─── Layer 3: SectionStrip ───────────────────────────────────────────────────

function SectionStrip({
  leaves, selectedId, onSelect, containerWidth = 760,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  containerWidth?: number;
}) {
  if (leaves.length === 0) {
    return <div style={{ fontSize: 10, color: "#9ca3af", fontStyle: "italic" }}>No segments.</div>;
  }
  const totalChars = leaves.reduce((s, l) => s + l.charCount, 0);
  const scale = containerWidth / Math.max(totalChars, 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 1, flexWrap: "nowrap", overflow: "hidden" }}>
        {leaves.map((l) => {
          const width = Math.max(2, Math.min(l.charCount * scale, 240));
          const fill = ORIGIN_FILL[l.origin.kind];
          const border = ORIGIN_BORDER[l.origin.kind];
          const isSelected = selectedId === l.nodeId;
          const tip = `${shortSlot(l.slotType)}\n${fmtK(l.charCount)} chars · ${ORIGIN_LABEL[l.origin.kind]}\n${originLabel(l.origin)}\n\n${l.preview}`;
          return (
            <div
              key={l.nodeId}
              title={tip}
              onClick={() => onSelect(l.nodeId)}
              style={{
                width, height: 18, flexShrink: 0,
                background: fill,
                border: `1px solid ${isSelected ? "#374151" : border}`,
                borderRadius: 2,
                cursor: "pointer",
                boxShadow: isSelected ? "0 0 0 1px #374151" : "none",
              }}
            />
          );
        })}
      </div>
      {/* Legend */}
      <div style={{ display: "flex", gap: 10, fontSize: 9, color: "#9ca3af" }}>
        <LegendChip color={ORIGIN_FILL.rule} border={ORIGIN_BORDER.rule} label="rule" />
        <LegendChip color={ORIGIN_FILL.jsonl} border={ORIGIN_BORDER.jsonl} label="jsonl" />
        <LegendChip color={ORIGIN_FILL.structural} border={ORIGIN_BORDER.structural} label="structural" />
        {leaves.some((l) => l.origin.kind === "unknown") && (
          <LegendChip color={ORIGIN_FILL.unknown} border={ORIGIN_BORDER.unknown} label="unknown" />
        )}
      </div>
    </div>
  );
}

function LegendChip({ color, border, label }: { color: string; border: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
      <span style={{ width: 9, height: 8, background: color, border: `1px solid ${border}`, borderRadius: 1 }} />
      {label}
    </span>
  );
}

// ─── Selected detail ─────────────────────────────────────────────────────────

function SelectedDetail({ leaf }: { leaf: LeafLite }) {
  const fill = ORIGIN_FILL[leaf.origin.kind];
  const border = ORIGIN_BORDER[leaf.origin.kind];
  return (
    <div style={{
      marginTop: 10, padding: 10,
      background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6,
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#111827", fontWeight: 600 }}>
          {shortSlot(leaf.slotType)}
        </span>
        <span style={{ fontSize: 10, color: "#6b7280" }}>{fmtK(leaf.charCount)} chars</span>
      </div>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "3px 8px", background: fill, border: `1px solid ${border}`, borderRadius: 4,
        fontSize: 10, color: "#111827",
      }}>
        <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {leaf.origin.kind}
        </span>
        <span>{originLabel(leaf.origin)}</span>
        {(leaf.origin.kind === "rule" || leaf.origin.kind === "jsonl") && (
          <span style={{ marginLeft: "auto", fontSize: 9, color: "#6b7280" }}>
            confidence · {leaf.origin.confidence}
          </span>
        )}
      </div>
      {leaf.origin.kind === "rule" && leaf.origin.dynamicFields && leaf.origin.dynamicFields.length > 0 && (
        <details style={{ fontSize: 10 }}>
          <summary style={{ cursor: "pointer", color: "#6366f1" }}>
            {leaf.origin.dynamicFields.length} dynamic field{leaf.origin.dynamicFields.length > 1 ? "s" : ""}
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4, paddingLeft: 8 }}>
            {leaf.origin.dynamicFields.map((f, i) => (
              <div key={i} style={{ display: "flex", gap: 6, fontSize: 10 }}>
                <span style={{ fontFamily: "ui-monospace, monospace", color: "#4338ca", minWidth: 100 }}>{f.name}</span>
                <span style={{ color: "#6b7280" }}>{f.source}</span>
                <span style={{ color: "#374151", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {f.valuePreview}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
      <pre style={{
        margin: 0, fontSize: 11, color: "#374151", lineHeight: 1.5,
        whiteSpace: "pre-wrap", wordBreak: "break-word",
        background: "#f9fafb", padding: "6px 10px", borderRadius: 4,
        maxHeight: 240, overflow: "auto",
      }}>{leaf.rawText ?? leaf.preview}</pre>
    </div>
  );
}

// ─── 顶层 Panel ─────────────────────────────────────────────────────────────

export function AttributionTreePanel({
  sessionId, callId,
}: { sessionId: string; callId: number }) {
  const [result, setResult] = useState<AttributionTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 每段独立 expanded 状态（可同时展开多段）
  const [expanded, setExpanded] = useState<Set<SectionId>>(new Set());
  // 当前选中叶子的 nodeId（跨段全局唯一）
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setExpanded(new Set()); setSelectedNodeId(null);
    apiV2.attributionTree(sessionId, callId)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, callId]);

  const leaves = useMemo(() => result ? flattenLeaves(result) : [], [result]);
  const stats = useMemo(() => computeSectionStats(leaves), [leaves]);
  const totalChars = useMemo(() => leaves.reduce((s, l) => s + l.charCount, 0), [leaves]);

  const selectedLeaf = useMemo(
    () => selectedNodeId ? leaves.find((l) => l.nodeId === selectedNodeId) ?? null : null,
    [selectedNodeId, leaves],
  );

  const toggle = (id: SectionId) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  if (loading) {
    return <div style={{ padding: "32px 0", textAlign: "center", fontSize: 11, color: "#9ca3af" }}>Loading attribution tree…</div>;
  }
  if (error) {
    return <div style={{ padding: 16, fontSize: 11, color: "#b91c1c", background: "#fef2f2", borderRadius: 6, border: "1px solid #fecaca" }}>
      Failed to load attribution tree: {error}
    </div>;
  }
  if (!result?.snapshot) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "#9ca3af", background: "#fafafa", borderRadius: 6, border: "1px dashed #e5e7eb" }}>
        {result?.error ?? "Attribution tree unavailable — proxy data may be missing for this call."}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* 顶部 stacked bar */}
      <CompositionBar stats={stats} totalChars={totalChars} />

      {/* 每段一行 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {stats.map((s) => (
          <SectionRow
            key={s.id}
            stat={s}
            totalChars={totalChars}
            expanded={expanded.has(s.id)}
            onToggle={() => toggle(s.id)}
          >
            <SectionStrip
              leaves={s.leaves}
              selectedId={selectedNodeId}
              onSelect={(nodeId) => setSelectedNodeId((cur) => cur === nodeId ? null : nodeId)}
            />
            {selectedLeaf && sectionOf(selectedLeaf.rootSlotType) === s.id && (
              <SelectedDetail leaf={selectedLeaf} />
            )}
          </SectionRow>
        ))}
      </div>
    </div>
  );
}
