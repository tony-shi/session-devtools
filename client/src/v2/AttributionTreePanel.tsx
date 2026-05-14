// AttributionTreePanel：极简钻取风格的归因视图。
//
// 视觉模型（无边框，靠 gap 间隔）：
//   Layer 1  顶部 stacked bar（root sections — system / tools / messages 三段；按字符比例宽度）
//   Layer 2  极简 table（默认状态）— 每段一行：色点 + 名称 + 大小 + % + 段数
//
// 点击 == 选中 == 钻取，不展开下拉。
//   - 点击 top bar 段 / table 行 → 进入对应 section，顶部 bar 仍在（其他段被 dim），
//     下方多出一根二级 bar（= 顶部 bar 等宽，按 section 内 leaves 比例分块），再加一张 leaves table。
//   - 点击 leaf bar / leaf 行 → 高亮该 leaf，并显示叶子详情。
//   - 「← back」回到上一级。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  barBg: string;
  barText: string;
  rowBg: string;
  marker: string;
  textColor: string;
}

const SECTION_META: Record<SectionId, SectionMeta> = {
  system:   { label: "System",   barBg: "#818cf8", barText: "#fff", rowBg: "#eef2ff", marker: "#6366f1", textColor: "#3730a3" },
  tools:    { label: "Tools",    barBg: "#9ca3af", barText: "#fff", rowBg: "#f3f4f6", marker: "#6b7280", textColor: "#374151" },
  messages: { label: "Messages", barBg: "#7c8df6", barText: "#fff", rowBg: "#eff6ff", marker: "#6366f1", textColor: "#1e40af" },
  other:    { label: "Other",    barBg: "#d1d5db", barText: "#fff", rowBg: "#fafafa", marker: "#9ca3af", textColor: "#374151" },
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
  byRole?: { user: number; assistant: number; system: number };
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

function subStatDescription(s: SectionStat): string {
  const bits: string[] = [`${s.leafCount} segments`];
  if (s.toolCount !== undefined) bits.push(`${s.toolCount} tools`);
  if (s.byRole) {
    if (s.byRole.user > 0) bits.push(`${s.byRole.user} user`);
    if (s.byRole.assistant > 0) bits.push(`${s.byRole.assistant} assistant`);
    if (s.byRole.system > 0) bits.push(`${s.byRole.system} system`);
  }
  return bits.join(" · ");
}

// ─── 顶部 stacked bar（无边框 / gap 间隔 / 可点击）─────────────────────────────

const BAR_HEIGHT = 44;
const SUB_BAR_HEIGHT = 36;

function SectionBar({
  stats, totalChars, selectedSection, onSelect,
}: {
  stats: SectionStat[];
  totalChars: number;
  selectedSection: SectionId | null;
  onSelect: (s: SectionId) => void;
}) {
  if (totalChars === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, height: BAR_HEIGHT }}>
      {stats.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = s.totalChars / totalChars;
        const isSel = selectedSection === s.id;
        const dimmed = selectedSection !== null && !isSel;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            title={`${meta.label}: ${fmtK(s.totalChars)} chars (${(pct * 100).toFixed(1)}%)`}
            style={{
              flex: pct, minWidth: 64,
              background: meta.barBg,
              opacity: dimmed ? 0.32 : 1,
              border: "none",
              borderRadius: 6,
              padding: "8px 14px",
              cursor: "pointer",
              textAlign: "left",
              color: meta.barText,
              display: "flex", flexDirection: "column", justifyContent: "center",
              overflow: "hidden",
              transition: "opacity 0.15s",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta.label}</div>
            <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.95, lineHeight: 1.25 }}>~{fmtK(s.totalChars)}</div>
          </button>
        );
      })}
    </div>
  );
}

// ─── 二级 strip：leaves（与顶部 bar 等宽） ────────────────────────────────────
//
// label 自适应放置：inside → above → below → hidden
//   - inside：bar 宽度足够直接显示 label
//   - above：bar 太窄但上方该 x-range 未被占用，label 浮在上方（绝对定位 + 引线点）
//   - below：上方已被占用，挪到下方
//   - hidden：上下都已被同样窄的邻居占满 → 隐藏（仍可 tooltip）
//
// 选中某项时其他项 visibility:hidden（保留位置 / 比例）。

const STRIP_GAP_PX = 2;
const STRIP_FONT_PX = 9;
const STRIP_CHAR_PX = 5.2; // 9px 字体单字符近似宽度（含字距）
const STRIP_LABEL_PAD = 6;
const STRIP_LANE_HEIGHT = 13;
const STRIP_LANE_GAP = 2;

type LabelPlacement =
  | { type: "inside" }
  | { type: "above"; left: number; width: number }
  | { type: "below"; left: number; width: number }
  | { type: "hidden" };

function computePlacements(
  leaves: LeafLite[],
  total: number,
  containerWidth: number,
): LabelPlacement[] {
  const n = leaves.length;
  if (n === 0 || total === 0 || containerWidth <= 0) return new Array(n).fill({ type: "hidden" });
  const totalGap = (n - 1) * STRIP_GAP_PX;
  const available = Math.max(containerWidth - totalGap, 1);

  const placements: LabelPlacement[] = new Array(n);
  const aboveOcc: Array<[number, number]> = [];
  const belowOcc: Array<[number, number]> = [];

  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const l = leaves[i];
    const pct = l.charCount / total;
    const barW = pct * available;
    const label = shortSlot(l.slotType);
    const labelW = Math.min(label.length * STRIP_CHAR_PX + STRIP_LABEL_PAD, 220);

    // 1) 能 inside 就 inside
    if (barW >= labelW + 4) {
      placements[i] = { type: "inside" };
    } else {
      // 2) 尝试 above / below callout
      const center = cursor + barW / 2;
      const left = center - labelW / 2;
      const right = center + labelW / 2;
      const fits = (occ: Array<[number, number]>) =>
        !occ.some(([oL, oR]) => !(right <= oL || left >= oR));

      if (fits(aboveOcc)) {
        placements[i] = { type: "above", left, width: labelW };
        aboveOcc.push([left, right]);
      } else if (fits(belowOcc)) {
        placements[i] = { type: "below", left, width: labelW };
        belowOcc.push([left, right]);
      } else {
        placements[i] = { type: "hidden" };
      }
    }
    cursor += barW + STRIP_GAP_PX;
  }
  return placements;
}

function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function LeafStrip({
  leaves, selectedId, onSelect,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  if (leaves.length === 0) return null;
  const total = leaves.reduce((s, l) => s + l.charCount, 0);
  if (total === 0) return null;

  const placements = computePlacements(leaves, total, width);

  return (
    <div ref={ref} style={{ display: "flex", flexDirection: "column", gap: STRIP_LANE_GAP }}>
      {/* 上方 callout lane（绝对定位）*/}
      <div style={{ position: "relative", height: STRIP_LANE_HEIGHT }}>
        {placements.map((p, i) => {
          if (p.type !== "above") return null;
          const l = leaves[i];
          const isSel = selectedId === l.nodeId;
          const dimmed = selectedId !== null && !isSel;
          return (
            <div
              key={l.nodeId + "-above"}
              style={{
                position: "absolute",
                left: p.left, width: p.width,
                bottom: 0,
                fontSize: STRIP_FONT_PX, lineHeight: 1.25,
                color: isSel ? "#111827" : "#6b7280",
                fontWeight: isSel ? 600 : 400,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                textAlign: "center",
                opacity: dimmed ? 0.32 : 1,
                transition: "opacity 0.15s",
                pointerEvents: "none",
              }}
            >
              {shortSlot(l.slotType)}
            </div>
          );
        })}
      </div>

      {/* Strip — bar 本体 */}
      <div style={{ display: "flex", gap: STRIP_GAP_PX, height: SUB_BAR_HEIGHT }}>
        {leaves.map((l, i) => {
          const pct = l.charCount / total;
          const fill = ORIGIN_FILL[l.origin.kind];
          const isSel = selectedId === l.nodeId;
          const dimmed = selectedId !== null && !isSel;
          const p = placements[i];
          const insideText = p?.type === "inside" ? shortSlot(l.slotType) : "";
          return (
            <button
              key={l.nodeId}
              onClick={() => onSelect(l.nodeId)}
              title={`${shortSlot(l.slotType)} · ${fmtK(l.charCount)} chars · ${originLabel(l.origin)}`}
              style={{
                flex: pct, minWidth: 4,
                background: fill,
                border: "none",
                borderRadius: 4,
                outline: isSel ? "2px solid #374151" : "none",
                outlineOffset: -2,
                cursor: "pointer",
                opacity: dimmed ? 0.32 : 1,
                transition: "opacity 0.15s",
                padding: "0 4px",
                display: "flex", alignItems: "center", justifyContent: "center",
                whiteSpace: "nowrap", overflow: "hidden",
                fontSize: STRIP_FONT_PX, color: "#1f2937", fontWeight: 500,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{insideText}</span>
            </button>
          );
        })}
      </div>

      {/* 下方 callout lane（绝对定位）*/}
      <div style={{ position: "relative", height: STRIP_LANE_HEIGHT }}>
        {placements.map((p, i) => {
          if (p.type !== "below") return null;
          const l = leaves[i];
          const isSel = selectedId === l.nodeId;
          const dimmed = selectedId !== null && !isSel;
          return (
            <div
              key={l.nodeId + "-below"}
              style={{
                position: "absolute",
                left: p.left, width: p.width,
                top: 0,
                fontSize: STRIP_FONT_PX, lineHeight: 1.25,
                color: isSel ? "#111827" : "#6b7280",
                fontWeight: isSel ? 600 : 400,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                textAlign: "center",
                opacity: dimmed ? 0.32 : 1,
                transition: "opacity 0.15s",
                pointerEvents: "none",
              }}
            >
              {shortSlot(l.slotType)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 极简 table（无边框，行 hover） ─────────────────────────────────────────

function SectionTable({
  stats, totalChars, selectedSection, onSelect,
}: {
  stats: SectionStat[];
  totalChars: number;
  selectedSection: SectionId | null;
  onSelect: (s: SectionId) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {stats.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = totalChars > 0 ? (s.totalChars / totalChars) * 100 : 0;
        const isSel = selectedSection === s.id;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              display: "flex", alignItems: "center", gap: 14,
              padding: "8px 8px",
              background: isSel ? meta.rowBg : "transparent",
              border: "none", borderRadius: 4,
              cursor: "pointer", textAlign: "left",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = "#f9fafb"; }}
            onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.marker, flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: meta.textColor, minWidth: 90 }}>{meta.label}</span>
            <span style={{ fontSize: 11, color: "#374151", minWidth: 60 }}>~{fmtK(s.totalChars)}</span>
            <span style={{ fontSize: 11, color: "#9ca3af", minWidth: 44 }}>{pct.toFixed(1)}%</span>
            <span style={{ fontSize: 10, color: "#9ca3af", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {subStatDescription(s)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function LeafTable({
  leaves, selectedId, onSelect,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const total = leaves.reduce((s, l) => s + l.charCount, 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {leaves.map((l) => {
        const pct = total > 0 ? (l.charCount / total) * 100 : 0;
        const isSel = selectedId === l.nodeId;
        const dimmed = selectedId !== null && !isSel;
        const fill = ORIGIN_FILL[l.origin.kind];
        return (
          <button
            key={l.nodeId}
            onClick={() => onSelect(l.nodeId)}
            style={{
              display: "flex", alignItems: "center", gap: 12,
              padding: "6px 8px",
              background: isSel ? "#eef2ff" : "transparent",
              border: "none", borderRadius: 4,
              cursor: "pointer", textAlign: "left",
              opacity: dimmed ? 0.4 : 1,
              transition: "background 0.1s, opacity 0.15s",
            }}
            onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = "#f9fafb"; }}
            onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: fill, flexShrink: 0 }} />
            <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11, color: "#111827", minWidth: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {shortSlot(l.slotType)}
            </span>
            <span style={{ fontSize: 11, color: "#374151", minWidth: 50 }}>{fmtK(l.charCount)}</span>
            <span style={{ fontSize: 10, color: "#9ca3af", minWidth: 40 }}>{pct.toFixed(1)}%</span>
            <span style={{ fontSize: 10, color: "#6b7280", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {l.preview}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── 叶子详情 ───────────────────────────────────────────────────────────────

function SelectedDetail({ leaf }: { leaf: LeafLite }) {
  const fill = ORIGIN_FILL[leaf.origin.kind];
  const border = ORIGIN_BORDER[leaf.origin.kind];
  return (
    <div style={{
      marginTop: 4, padding: 10,
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

  const [selectedSection, setSelectedSection] = useState<SectionId | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setSelectedSection(null); setSelectedNodeId(null);
    apiV2.attributionTree(sessionId, callId)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, callId]);

  const leaves = useMemo(() => result ? flattenLeaves(result) : [], [result]);
  const stats = useMemo(() => computeSectionStats(leaves), [leaves]);
  const totalChars = useMemo(() => leaves.reduce((s, l) => s + l.charCount, 0), [leaves]);

  const selectedStat = useMemo(
    () => selectedSection ? stats.find((s) => s.id === selectedSection) ?? null : null,
    [selectedSection, stats],
  );
  const selectedLeaf = useMemo(
    () => selectedNodeId ? leaves.find((l) => l.nodeId === selectedNodeId) ?? null : null,
    [selectedNodeId, leaves],
  );

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
      {/* Layer 1: 顶部 stacked bar */}
      <SectionBar
        stats={stats}
        totalChars={totalChars}
        selectedSection={selectedSection}
        onSelect={(s) => {
          setSelectedSection((cur) => (cur === s ? null : s));
          setSelectedNodeId(null);
        }}
      />

      {selectedStat === null ? (
        // 默认：极简 section table
        <SectionTable
          stats={stats}
          totalChars={totalChars}
          selectedSection={null}
          onSelect={(s) => setSelectedSection(s)}
        />
      ) : (
        <>
          {/* Section header + back */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "2px 4px" }}>
            <button
              onClick={() => { setSelectedSection(null); setSelectedNodeId(null); }}
              style={{
                fontSize: 11, padding: "3px 10px", borderRadius: 4,
                background: "#fff", border: "1px solid #e5e7eb",
                cursor: "pointer", color: "#374151",
              }}
            >← back</button>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: SECTION_META[selectedStat.id].marker }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: SECTION_META[selectedStat.id].textColor }}>
              {SECTION_META[selectedStat.id].label}
            </span>
            <span style={{ fontSize: 11, color: "#6b7280" }}>~{fmtK(selectedStat.totalChars)}</span>
            <span style={{ fontSize: 11, color: "#9ca3af" }}>
              {totalChars > 0 ? ((selectedStat.totalChars / totalChars) * 100).toFixed(1) : 0}%
            </span>
            <span style={{ fontSize: 11, color: "#9ca3af" }}>· {subStatDescription(selectedStat)}</span>
          </div>

          {/* Layer 2: leaf strip（与顶部 bar 等宽） */}
          <LeafStrip
            leaves={selectedStat.leaves}
            selectedId={selectedNodeId}
            onSelect={(id) => setSelectedNodeId((cur) => (cur === id ? null : id))}
          />

          {/* Layer 2.5: leaf table */}
          <LeafTable
            leaves={selectedStat.leaves}
            selectedId={selectedNodeId}
            onSelect={(id) => setSelectedNodeId((cur) => (cur === id ? null : id))}
          />

          {/* Layer 3: leaf detail */}
          {selectedLeaf && sectionOf(selectedLeaf.rootSlotType) === selectedStat.id && (
            <SelectedDetail leaf={selectedLeaf} />
          )}
        </>
      )}
    </div>
  );
}
