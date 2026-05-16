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

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiV2 } from "./api";
import { FisheyeStrip } from "./fisheye-strip";
import type { FisheyeStatus } from "./fisheye-strip";
import type {
  AttributionTreeResult,
  SerializedNode,
  SegmentOrigin,
  AuditEnvelope,
} from "./attribution-tree-types";
import { coverageStateOf } from "./attribution-tree-types";
import { SegmentedToggle } from "./shared/SegmentedToggle";
import { CodeBlock } from "./shared/CodeBlock";

// ─── 类型与配色 ─────────────────────────────────────────────────────────────

// NOTE: 这些类型 / 颜色 / 工具函数 / 子组件原本是 module-private 的；现在导出供
// 旁路的 AttributionTreeLensPanel 复用。本 AttributionTreePanel 的行为完全不变。

export type SectionId = "system" | "tools" | "messages" | "other";

export interface SectionMeta {
  label: string;
  barBg: string;
  barText: string;
  rowBg: string;
  marker: string;
  textColor: string;
}

export const SECTION_META: Record<SectionId, SectionMeta> = {
  system:   { label: "System",   barBg: "#bfdbfe", barText: "#1e3a8a", rowBg: "#eff6ff", marker: "#3b82f6", textColor: "#1e40af" },
  tools:    { label: "Tools",    barBg: "#3b82f6", barText: "#fff",    rowBg: "#eff6ff", marker: "#2563eb", textColor: "#1e40af" },
  messages: { label: "Messages", barBg: "#a78bfa", barText: "#fff",    rowBg: "#f5f3ff", marker: "#8b5cf6", textColor: "#5b21b6" },
  other:    { label: "Other",    barBg: "#d1d5db", barText: "#374151", rowBg: "#fafafa", marker: "#9ca3af", textColor: "#374151" },
};

// Leaf 颜色：解析清楚的（rule / jsonl / structural）使用所属 section 的色调；
// unknown 统一用「加重一号」的灰，与可解释段落明显区分。
const UNKNOWN_FILL = "#9ca3af";

export function leafFill(leaf: { origin: SegmentOrigin; rootSlotType: string }): string {
  if (leaf.origin.kind === "unknown") return UNKNOWN_FILL;
  return SECTION_META[sectionOf(leaf.rootSlotType)].barBg;
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

export function sectionOf(slotType: string): SectionId {
  if (slotType.startsWith("system.") || slotType === "side-query.system") return "system";
  if (slotType.startsWith("tools.")) return "tools";
  if (slotType.startsWith("messages.") || slotType === "side-query.user") return "messages";
  return "other";
}

export function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

export function shortSlot(slotType: string): string {
  return slotType
    .replace("system.main-prompt.section.", "sys.")
    .replace("system.main-prompt-block", "sys.main")
    .replace("messages.", "msg.")
    .replace("tools.builtin.", "tool.");
}

export function originLabel(origin: SegmentOrigin): string {
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

export interface LeafLite {
  nodeId: string;
  slotType: string;
  rootSlotType: string;
  charCount: number;
  preview: string;
  origin: SegmentOrigin;
  rawText?: string;
  messageRole?: "user" | "assistant" | "system";
  // Cache 视角需要：节点缓存策略。来自 SerializedNode.cachePolicy（可选）。
  cachePolicy?: { ttl: "5m" | "1h"; scope: "org" | "global" };
}

export function flattenLeaves(result: AttributionTreeResult): LeafLite[] {
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
        ...(node.cachePolicy && { cachePolicy: node.cachePolicy }),
      });
      return;
    }
    for (const c of node.children) visit(c, rootSlot);
  }
  for (const root of result.snapshot.roots) visit(root, root.slotType);
  return out;
}

export interface SectionStat {
  id: SectionId;
  totalChars: number;
  leafCount: number;
  leaves: LeafLite[];
  byRole?: { user: number; assistant: number; system: number };
  toolCount?: number;
}

export function computeSectionStats(leaves: LeafLite[]): SectionStat[] {
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
  filter = "all", filteredStats = null, filterColor = null,
}: {
  stats: SectionStat[];
  totalChars: number;
  selectedSection: SectionId | null;
  onSelect: (s: SectionId) => void;
  filter?: "all" | "partial" | "none";
  filteredStats?: SectionStat[] | null;
  filterColor?: string | null;
}) {
  const [hoveredId, setHoveredId] = useState<SectionId | null>(null);
  if (totalChars === 0) return null;
  const hasSelection = selectedSection !== null;
  const filterActive = filter !== "all" && filteredStats !== null;
  return (
    <div
      style={{ display: "flex", gap: 4, height: BAR_HEIGHT }}
      onMouseLeave={() => setHoveredId(null)}
    >
      {stats.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = s.totalChars / totalChars;
        const isSel = selectedSection === s.id;
        const isHov = hoveredId === s.id;
        // 三档强度
        let intensity: 0 | 1 | 2 | 3 = 1;
        if (hasSelection) {
          if (isSel) intensity = 3;
          else if (isHov) intensity = 2;
          else intensity = 0;
        } else if (hoveredId !== null) {
          intensity = isHov ? 2 : 1;
        }
        let opacity = intensity === 0 ? 0.18 : 1;
        const fontWeight = intensity >= 2 ? 800 : 700;
        // filter 命中数（按 section）。无命中且未选中 → 进一步降饱和。
        const hitCount = filterActive
          ? (filteredStats!.find((fs) => fs.id === s.id)?.leafCount ?? 0)
          : null;
        if (filterActive && hitCount === 0 && !isSel) opacity = Math.min(opacity, 0.25);
        const outline = isSel ? "2px solid #1f2937" : (intensity === 2 ? "2px solid rgba(31,41,55,0.45)" : "none");
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            onMouseEnter={() => setHoveredId(s.id)}
            title={`${meta.label} · ${fmtK(s.totalChars)} chars (${(pct * 100).toFixed(1)}%)`}
            style={{
              flex: pct, minWidth: 64,
              background: meta.barBg,
              opacity,
              border: "none",
              outline, outlineOffset: -2,
              borderRadius: 6,
              padding: "8px 14px",
              cursor: "pointer",
              textAlign: "left",
              color: meta.barText,
              display: "flex", alignItems: "center",
              overflow: "hidden",
              transition: "opacity 0.15s, outline-color 0.15s",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {meta.label}
              </div>
              {/* 角标只画在 ≥5% 宽度的块里，避免撑破窄块的 minWidth；窄块的"无命中"信号交给 opacity 灰化即可。
                  纯数字 + 彩色方块，不重复显示 filter 名（顶部 AuditBadge 已激活态，用户知道当前 filter 是什么）。*/}
              {filterActive && filterColor && hitCount !== null && pct >= 0.05 && (
                <span
                  title={`${hitCount} leaf${hitCount === 1 ? "" : "s"} match ${filter}`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    fontSize: 10, fontWeight: 700,
                    padding: "1px 5px", borderRadius: 3,
                    background: "rgba(255,255,255,0.7)",
                    color: "#1f2937",
                    whiteSpace: "nowrap", flexShrink: 0,
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: 1, background: filterColor }} />
                  {hitCount}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── 二级 strip：leaves（消费 fisheye-strip 模块） ────────────────────────────
//
// 简化后只剩一条 strip + 顶部 toggle：
//   - 名称放置完全由 FisheyeStrip 内部按段宽决定（放得下就 inside，否则 hidden），
//     不再用上下 callout 巷道兜底（避免上下波动）。
//   - hover / select 反馈走 FisheyeStrip 内部三档强度（颜色/字重），不再外挂顶部 readout 行。

/** Leaf item — 适配 FisheyeStrip 接口（id + size），保留原 leaf 引用便于回调取数据 */
interface LeafItem {
  id: string;
  size: number;
  leaf: LeafLite;
}

type LayoutMode = "proportional" | "equal";

/** 过载阈值：最窄段 < 此像素值时认为「太密」，提示用户改用 table */
const OVERLOAD_MIN_BAR_PX = 1.5;

export function LeafStrip({
  leaves, selectedId, onSelect, getColor,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional override — Lens panel passes lens-based color; default uses
   *  leafFill (section-based). */
  getColor?: (leaf: LeafLite) => string;
}) {
  const { t } = useTranslation();
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("proportional");
  const [stripStatus, setStripStatus] = useState<FisheyeStatus | null>(null);
  const isOverloaded = (stripStatus?.minBarPx ?? Infinity) < OVERLOAD_MIN_BAR_PX;

  // 业务层把 leaves 转为 FisheyeItem
  // 等宽模式：所有 size 设为 1（模块仍按线性 size 分配空间 → 每段等宽）
  const items: LeafItem[] = useMemo(
    () => leaves.map((l) => ({
      id: l.nodeId,
      size: layoutMode === "equal" ? 1 : Math.max(l.charCount, 0.001),
      leaf: l,
    })),
    [leaves, layoutMode],
  );

  if (leaves.length === 0) return null;

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", gap: 4,
        minWidth: 0, maxWidth: "100%", overflowX: "hidden",
        // 过载时整条 bar 吸顶，让用户滚 table 时仍能看见分布索引
        position: isOverloaded ? "sticky" : "static",
        top: isOverloaded ? 0 : "auto",
        zIndex: isOverloaded ? 5 : "auto",
        background: isOverloaded ? "#fff" : "transparent",
        paddingTop: isOverloaded ? 6 : 0,
        paddingBottom: isOverloaded ? 6 : 0,
        boxShadow: isOverloaded ? "0 2px 4px -2px rgba(17,24,39,0.06)" : "none",
      }}
    >
      {/* 内联布局切换（右对齐） */}
      <SegmentedToggle<"proportional" | "equal">
        value={layoutMode}
        onChange={setLayoutMode}
        options={[
          { id: "proportional", label: t("attribution.layoutProportional"), title: t("attribution.layoutProportionalTitle") },
          { id: "equal",        label: t("attribution.layoutEqual"),        title: t("attribution.layoutEqualTitle") },
        ]}
      />

      {/* Strip — getLabel 返回 shortSlot；模块按段宽决定 inside / 隐藏。
          minCount=5 让 attribution leaves 天然开启鱼眼。 */}
      <FisheyeStrip<LeafItem>
        items={items}
        getColor={(it) => getColor ? getColor(it.leaf) : leafFill(it.leaf)}
        getLabel={(it) => shortSlot(it.leaf.slotType)}
        getTitle={(it) => `${shortSlot(it.leaf.slotType)} · ${fmtK(it.leaf.charCount)} chars · ${originLabel(it.leaf.origin)}`}
        height={SUB_BAR_HEIGHT}
        background="transparent"
        autoConfig={{ minCount: 5, clickableThresholdPx: 16 }}
        selectedId={selectedId}
        onSelect={(it) => onSelect(it.id)}
        onStatusChange={setStripStatus}
      />
    </div>
  );
}

// ─── 极简 table（无边框，行 hover） ─────────────────────────────────────────

function SectionTable({
  stats, totalChars, selectedSection, onSelect,
  filter = "all", filteredStats = null, filterColor = null,
}: {
  stats: SectionStat[];
  totalChars: number;
  selectedSection: SectionId | null;
  onSelect: (s: SectionId) => void;
  filter?: "all" | "partial" | "none";
  filteredStats?: SectionStat[] | null;
  filterColor?: string | null;
}) {
  const filterActive = filter !== "all" && filteredStats !== null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {stats.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = totalChars > 0 ? (s.totalChars / totalChars) * 100 : 0;
        const isSel = selectedSection === s.id;
        const hitCount = filterActive
          ? (filteredStats!.find((fs) => fs.id === s.id)?.leafCount ?? 0)
          : null;
        const rowOpacity = filterActive && hitCount === 0 && !isSel ? 0.45 : 1;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              display: "flex", alignItems: "center", gap: 14,
              padding: "8px 8px",
              background: isSel ? meta.rowBg : "transparent",
              border: "none", borderRadius: 4,
              opacity: rowOpacity,
              cursor: "pointer", textAlign: "left",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => { if (!isSel) e.currentTarget.style.background = "#f9fafb"; }}
            onMouseLeave={(e) => { if (!isSel) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.marker, flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: meta.textColor, minWidth: 90 }}>{meta.label}</span>
            <span style={{ fontSize: 11, color: "#374151", minWidth: 60 }}>{fmtK(s.totalChars)}</span>
            <span style={{ fontSize: 11, color: "#9ca3af", minWidth: 44 }}>{pct.toFixed(1)}%</span>
            <span style={{ fontSize: 10, color: "#9ca3af", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {subStatDescription(s)}
              {filterActive && hitCount !== null && filterColor && (
                <span
                  style={{
                    marginLeft: 10,
                    fontSize: 10, fontWeight: 600,
                    padding: "1px 6px", borderRadius: 3,
                    background: `${filterColor}26`,
                    color: hitCount > 0 ? "#1f2937" : "#9ca3af",
                  }}
                >
                  {hitCount} {filter}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function LeafTable({
  leaves, selectedId, onSelect, getColor,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional override — Lens panel passes lens-based color; default uses
   *  leafFill (section-based). */
  getColor?: (leaf: LeafLite) => string;
}) {
  const total = leaves.reduce((s, l) => s + l.charCount, 0);
  // 选中后只显示该 leaf 行，其他兄弟不再列出（避免与 SelectedDetail 重复信息）
  const visibleLeaves = selectedId ? leaves.filter((l) => l.nodeId === selectedId) : leaves;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {visibleLeaves.map((l) => {
        const pct = total > 0 ? (l.charCount / total) * 100 : 0;
        const isSel = selectedId === l.nodeId;
        const fill = getColor ? getColor(l) : leafFill(l);
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
              transition: "background 0.1s",
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

export function SelectedDetail({ leaf, onLinkSource }: {
  leaf: LeafLite;
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
}) {
  // Back-link: when this leaf's payload was emitted by a previous LLM call
  // (tool_use / tool_result / assistant_text linked via jsonl), expose a
  // pill that opens that source call in the linked panel. Only visible when
  // the parent provides onLinkSource — panel-mode renders skip this to avoid
  // recursive panel stacking.
  const sourceCallId = leaf.origin.kind === "jsonl" ? leaf.origin.sourceCallId : undefined;
  const sourceTurnId = leaf.origin.kind === "jsonl" ? leaf.origin.sourceTurnId : undefined;
  const canLinkSource = onLinkSource && sourceCallId !== undefined;

  // 扁平展示：无 card 外框、无重复的 slot 名（hover readout / 当前行已显示）
  // 仅保留 origin 元信息 + raw 内容
  return (
    <div style={{
      paddingTop: 6,
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      {/* origin 元信息（单行，紧凑）*/}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        fontSize: 10, color: "#374151",
        padding: "2px 2px",
      }}>
        <span style={{
          fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
          color: "#4b5563",
        }}>{leaf.origin.kind}</span>
        <span style={{ color: "#6b7280" }}>{originLabel(leaf.origin)}</span>
        {canLinkSource && (
          <button
            type="button"
            onClick={() => onLinkSource!(sourceCallId!, sourceTurnId)}
            title={`在右侧打开 call #${sourceCallId} 所在 turn 的 call 事件列表（聚焦到该 call）`}
            style={{
              fontSize: 10, fontWeight: 700,
              color: "#4338ca", background: "#eef2ff",
              border: "1px solid #c7d2fe", borderRadius: 4,
              padding: "1px 6px", cursor: "pointer",
            }}
          >
            → 在 Turn 中查看 call #{sourceCallId}
          </button>
        )}
        {(leaf.origin.kind === "rule" || leaf.origin.kind === "jsonl") && (
          <span style={{ marginLeft: "auto", fontSize: 9, color: "#9ca3af" }}>
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
      <CodeBlock variant="preview" maxHeight={240}>{leaf.rawText ?? leaf.preview}</CodeBlock>
    </div>
  );
}

// ─── 顶层 Panel ─────────────────────────────────────────────────────────────

// ─── AuditBadge (PR6) ────────────────────────────────────────────────────────
//
// 紧凑徽章，紧贴 SectionBar 之上。展示三桶计数 + jsonl missing 数。
// 点击 partial / none 切换 filter，把 leaf 列表过滤到对应 segmentId 集合。
// 点击 missing 暂只显示文本（无 drawer）；后续可扩展为列表视图。

type AuditFilter = "all" | "partial" | "none";

function AuditBadge({
  audit, filter, onFilter,
}: {
  audit: AuditEnvelope;
  filter: AuditFilter;
  onFilter: (f: AuditFilter) => void;
}) {
  const { full, partial, none } = audit.forward.totals;
  const missing = audit.reverse.missing.length;

  function Pill({
    label, value, active, color, onClick, title,
  }: {
    label: string; value: number; active: boolean; color: string;
    onClick?: () => void; title?: string;
  }) {
    const clickable = onClick !== undefined;
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        disabled={!clickable}
        style={{
          display: "inline-flex", alignItems: "baseline", gap: 6,
          padding: "3px 8px", borderRadius: 4,
          border: active ? `1px solid ${color}` : "1px solid transparent",
          background: active ? `${color}1a` : "transparent",
          color: "#374151", fontSize: 11,
          cursor: clickable ? "pointer" : "default",
          transition: "background 0.1s, border-color 0.1s",
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 1, background: color, alignSelf: "center" }} />
        <span style={{ fontWeight: 600, color: "#1f2937" }}>{value}</span>
        <span style={{ color: "#6b7280" }}>{label}</span>
      </button>
    );
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      fontSize: 11, color: "#6b7280",
      padding: "2px 0",
    }}>
      <span style={{ fontWeight: 600, color: "#4b5563", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: 10 }}>
        Audit
      </span>
      <Pill label="full"    value={full}    active={false}                 color="#10b981" title="叶子覆盖完整（rule 或 jsonl）" />
      <Pill label="partial" value={partial} active={filter === "partial"}  color="#f59e0b"
            onClick={() => onFilter(filter === "partial" ? "all" : "partial")}
            title="rule/jsonl 命中但 fullyCovered=false（动态注入未覆盖）" />
      <Pill label="none"    value={none}    active={filter === "none"}     color="#9ca3af"
            onClick={() => onFilter(filter === "none" ? "all" : "none")}
            title="structural（slot 已知但无规则）或 unknown（template 未识别）" />
      <span style={{ color: "#d1d5db" }}>|</span>
      <Pill label="missing jsonl" value={missing} active={false} color="#ef4444"
            title="jsonl 中存在但 proxy 中无对应 segment 的原子单元（tool_use / tool_result / user / assistant / attachment）。当前已按 call 时间截断，不含未来 turn 的事件。" />
      {/*
        TODO(audit-missing-belongs-on-turn-view):
        missing jsonl 的语义是"jsonl event 是否被任何 call 引用"，本质属于 session/turn
        视角 —— 一条 jsonl event 属于某个 turn，不属于 call。call 视图当前展示的是
        "截至本 call 时刻 proxy 漏掉的事件"（已经修过 reverse audit 的截断），
        够用但不是终态。终态应该在 turn 视图按 jsonl event 行级展示，标记"被哪些 call
        引用 / 全程无引用 / 只在部分窗口引用"，把诊断粒度下沉到 event。
        现阶段先用本 call 视图凑合，等需要诊断具体哪条 jsonl event 丢了再做 turn 视图。
      */}
      <span
        title="TODO: missing jsonl 更适合放在 turn 视图（按 jsonl event 行展示）。call 视图是 last-call 视角的近似。详见源码 TODO(audit-missing-belongs-on-turn-view)。"
        style={{
          fontSize: 10, color: "#a16207",
          padding: "1px 6px", borderRadius: 3,
          background: "#fef3c7", border: "1px dashed #fcd34d",
          cursor: "help",
          userSelect: "none",
        }}
      >
        TODO: 应移至 turn 视图
      </span>
    </div>
  );
}

export function AttributionTreePanel({
  sessionId, callId, onLinkSource,
}: {
  sessionId: string;
  callId: number;
  /** 反向 link：点击 jsonl origin 带 sourceCallId 的 leaf 时调用。
   *  parent 决定要不要展示 link 按钮（main 模式提供，panel 模式留空避免嵌套）。*/
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
}) {
  const [result, setResult] = useState<AttributionTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedSection, setSelectedSection] = useState<SectionId | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [auditFilter, setAuditFilter] = useState<AuditFilter>("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setSelectedSection(null); setSelectedNodeId(null);
    apiV2.attributionTree(sessionId, callId)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, callId]);

  const allLeaves = useMemo(() => result ? flattenLeaves(result) : [], [result]);

  // 根据 audit filter 过滤叶子（不重算 stats —— 顶部 bar 仍按全集呈现）。
  const leaves = useMemo(() => {
    if (auditFilter === "all" || !result?.audit) return allLeaves;
    return allLeaves.filter((l) => coverageStateOf(l.origin) === auditFilter);
  }, [allLeaves, auditFilter, result?.audit]);

  const stats = useMemo(() => computeSectionStats(allLeaves), [allLeaves]);
  const totalChars = useMemo(() => allLeaves.reduce((s, l) => s + l.charCount, 0), [allLeaves]);

  // filter 启用时按 section 算"命中数"，给 SectionBar / SectionTable 显示角标 + 灰化。
  // 顶部 bar 形状仍按全集分布，避免点击 filter 后整个布局跳动。
  const filteredStats = useMemo(
    () => auditFilter === "all" ? null : computeSectionStats(leaves),
    [leaves, auditFilter],
  );
  const filterColor = auditFilter === "partial" ? "#f59e0b" : auditFilter === "none" ? "#9ca3af" : null;

  const selectedStat = useMemo(() => {
    if (!selectedSection) return null;
    const stat = stats.find((s) => s.id === selectedSection);
    if (!stat) return null;
    // 应用 audit filter：drill-in 后只显示符合 filter 的叶子（顶部 bar 仍按全集）。
    if (auditFilter === "all") return stat;
    const filteredLeaves = stat.leaves.filter((l) => coverageStateOf(l.origin) === auditFilter);
    return { ...stat, leaves: filteredLeaves };
  }, [selectedSection, stats, auditFilter]);
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
      {/* Layer 0: AuditBadge — 紧凑三桶 + missing 数 */}
      {result.audit && (
        <AuditBadge audit={result.audit} filter={auditFilter} onFilter={setAuditFilter} />
      )}

      {/* Layer 1: 顶部 stacked bar */}
      <SectionBar
        stats={stats}
        totalChars={totalChars}
        selectedSection={selectedSection}
        onSelect={(s) => {
          setSelectedSection((cur) => (cur === s ? null : s));
          setSelectedNodeId(null);
        }}
        filter={auditFilter}
        filteredStats={filteredStats}
        filterColor={filterColor}
      />

      {selectedStat === null ? (
        // 默认：极简 section table
        <SectionTable
          stats={stats}
          totalChars={totalChars}
          selectedSection={null}
          onSelect={(s) => setSelectedSection(s)}
          filter={auditFilter}
          filteredStats={filteredStats}
          filterColor={filterColor}
        />
      ) : (
        <>
          {/* drill-in：去掉 header 行（back / size / pct / counts 上方 SectionBar 已有） */}

          {/* Layer 2: leaf strip */}
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

          {/* Layer 3: leaf detail（扁平展示） */}
          {selectedLeaf && sectionOf(selectedLeaf.rootSlotType) === selectedStat.id && (
            <SelectedDetail leaf={selectedLeaf} onLinkSource={onLinkSource} />
          )}
        </>
      )}
    </div>
  );
}
