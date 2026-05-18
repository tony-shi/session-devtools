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
  JsonlEventKindObject,
} from "./attribution-tree-types";
import { coverageStateOf } from "./attribution-tree-types";
import { SegmentedToggle } from "./shared/SegmentedToggle";
import { CodeBlock } from "./shared/CodeBlock";
import { LinkIcon, SegmentView } from "./shared/EventUnitCard";
import { EVENT_PALETTES } from "./shared/eventPalette";
import type { IntervalEventKind } from "./drilldown-types";
import { useAttributionGraph } from "./attribution-graph-context";
import { sectionPalette, UNKNOWN_FILL as PALETTE_UNKNOWN_FILL } from "./lens-palette";

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

// 配色集中在 lens-palette.ts；本处仅 re-export 以保持向后兼容。
export const SECTION_META: Record<SectionId, SectionMeta> = sectionPalette;

// Leaf 颜色：解析清楚的（rule / jsonl / structural）使用所属 section 的色调；
// unknown 统一用「加重一号」的灰，与可解释段落明显区分。
const UNKNOWN_FILL = PALETTE_UNKNOWN_FILL;

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

// Best-effort JSON parse for the "原始 JSON" segment toggle. Returns
// `undefined` when the content isn't valid JSON so the toggle stays
// hidden instead of showing an error.
function tryParseSegmentJson(s: string): unknown {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
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
    const ek: JsonlEventKindObject = typeof origin.eventKind === "string"
      ? { source: origin.eventKind as JsonlEventKindObject["source"] }
      : origin.eventKind;
    const kindStr = ek.contentType && ek.contentType !== "text"
      ? `${ek.source}:${ek.contentType}`
      : ek.source;
    return `${kindStr} @L${origin.jsonlLineIdx}` +
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
  /**
   * Position of this leaf inside the raw LLM request JSON
   * (e.g. `reqBody.system[0]`, `reqBody.messages[0].content[1]`). Carried
   * from `SerializedNode.jsonPath` so the leaf detail can surface where in
   * the wire payload the content came from.
   */
  jsonPath: string;
  messageRole?: "user" | "assistant" | "system";
  /**
   * The wire tool_use_id for `messages.tool_use@N` leaves. Carried into
   * LeafLite so the back-link in `SelectedDetail` can land on the exact
   * `ToolCallRow` in the Turn view (`flashToolUse`) rather than just the
   * enclosing call card. Absent for non-tool_use leaves.
   */
  toolUseId?: string;
  // Cache 视角需要：节点缓存策略。来自 SerializedNode.cachePolicy（可选）。
  cachePolicy?: { ttl: "5m" | "1h"; scope: "org" | "global" };
  // Diff 视角需要：本 leaf 相对前一次 call 的变化状态。由父组件从 diff-tree
  // 按 leafId 合并而来；attribution-tree 自身不带 diff 信息，所以是可选。
  diffKind?: "added" | "removed" | "modified" | "kept";
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
        jsonPath: node.jsonPath,
        ...(node.wireMeta?.messageRole && { messageRole: node.wireMeta.messageRole }),
        ...(node.wireMeta?.toolUseId && { toolUseId: node.wireMeta.toolUseId }),
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
  // 与 Anthropic 实际 cache prefix 顺序 + diff-tree-service 一致，让两边视觉
  // 顺序对齐：tools → system → messages → other。
  const order: SectionId[] = ["tools", "system", "messages", "other"];
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
export interface LeafItem {
  id: string;
  size: number;
  leaf: LeafLite;
}

type LayoutMode = "proportional" | "equal";

/** 过载阈值：最窄段 < 此像素值时认为「太密」，提示用户改用 table */
const OVERLOAD_MIN_BAR_PX = 1.5;

export function LeafStrip({
  leaves, selectedId, onSelect, getColor, getUnderlineColor,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional override — Lens panel passes lens-based color; default uses
   *  leafFill (section-based). */
  getColor?: (leaf: LeafLite) => string;
  /** Optional — return underline color for the leaf bar (Diff lens uses this:
   *  add 绿 / modify 黄). null = no underline. Bar 本身不变。 */
  getUnderlineColor?: (leaf: LeafLite) => string | null;
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
        getUnderlineColor={getUnderlineColor ? (it) => getUnderlineColor(it.leaf) : undefined}
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
  leaves, selectedId, onSelect, getColor, getBadges,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional override — Lens panel passes lens-based color; default uses
   *  leafFill (section-based). */
  getColor?: (leaf: LeafLite) => string;
  /** 每个 leaf 行末尾的额外 badge 列表，按 active lens 维度提供
   *  （Lens panel 用来表达 diff state / cache layer / audit 等附加属性）。 */
  getBadges?: (leaf: LeafLite) => Array<{ key: string; label: string; color: string; bg: string; border: string; title?: string }>;
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
            {getBadges && getBadges(l).map((b) => (
              <span
                key={b.key}
                title={b.title}
                style={{
                  display: "inline-flex", alignItems: "center",
                  padding: "1px 5px", borderRadius: 3,
                  fontSize: 9, fontWeight: 700, letterSpacing: "0.02em",
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  color: b.color, background: b.bg, border: `1px solid ${b.border}`,
                  flexShrink: 0,
                }}
              >
                {b.label}
              </span>
            ))}
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
  // Back-link target: open the Turn view (onLinkSource), then scroll to a
  // landing point that depends on the leaf's underlying event kind:
  //
  //   • tool_use leaf — the "source" is the Call that *emitted* this
  //     tool_use. Landing = the Call card anchor (`#turn-N-call-K`), not
  //     a specific jsonl row. Multiple tool_uses can share the same jsonl
  //     line (assistant message), so a row-level scroll wouldn't pick
  //     this one out anyway.
  //
  //   • other jsonl leaves (tool_result / user_input / harness) — landing
  //     = the IntervalEventRow at `data-jsonl-line="${jsonlLineIdx}"`.
  //
  // jumpTarget prefers `firstSeenInCall` (the graph's "first-prompt" call)
  // over `sourceCallId` (the parser's call ownership) — for tool_result
  // these differ; for tool_use they coincide.
  const { t } = useTranslation();
  const { flashEvent, flashCall, flashToolUse } = useAttributionGraph();
  const sourceTurnId = leaf.origin.kind === "jsonl" ? leaf.origin.sourceTurnId : undefined;
  const sourceCallId = leaf.origin.kind === "jsonl" ? leaf.origin.sourceCallId : undefined;
  const firstSeenInCall = leaf.origin.kind === "jsonl" ? leaf.origin.firstSeenInCall : undefined;
  const jsonlLineIdx = leaf.origin.kind === "jsonl" ? leaf.origin.jsonlLineIdx : undefined;
  // eventKind comes from server as `{ source, contentType }` but older
  // serializations / tests may carry just a string — handle both.
  const isToolUseLeaf = leaf.origin.kind === "jsonl" && (() => {
    const ek = leaf.origin.eventKind;
    if (typeof ek === "string") return ek === "tool_use";
    return ek?.source === "tool_use";
  })();
  const jumpTarget = firstSeenInCall ?? sourceCallId;
  const handleJumpSource = (jumpTarget !== undefined && onLinkSource)
    ? () => {
        onLinkSource(jumpTarget, sourceTurnId);
        // Defer past panel mount so the target node exists in the DOM
        // when we try to scroll to it.
        if (isToolUseLeaf) {
          // Prefer landing on the specific `ToolCallRow` keyed by
          // `data-tool-use-id` (more precise than just the call card).
          // Fall back to `flashCall` when wireMeta didn't carry a
          // toolUseId (e.g. older snapshots, structural rendering).
          if (leaf.toolUseId) {
            requestAnimationFrame(() => flashToolUse(leaf.toolUseId!));
          } else {
            requestAnimationFrame(() => flashCall(jumpTarget));
          }
        } else if (jsonlLineIdx != null) {
          requestAnimationFrame(() => flashEvent(jsonlLineIdx));
        }
      }
    : undefined;

  // Flat detail: top one-line metadata row + content + dynamic fields.
  // Identity bits (color / kindLabel / title / shortId) come from the
  // shared mapper so this stays in sync with Turn/Response renderings.
  const { color, kindLabel, title, shortId } = leafOriginToCardHeader(leaf);
  const requestPath = leaf.jsonPath ? leaf.jsonPath.replace(/^reqBody\./, "") : undefined;
  const confidence =
    leaf.origin.kind === "rule" || leaf.origin.kind === "jsonl"
      ? leaf.origin.confidence
      : undefined;
  // `originSuffix` collects the secondary facts that follow the primary
  // identifier (kindLabel + the call/line coordinate, then confidence,
  // then size). Joined with " · " so the row stays a single inline strip.
  const originSuffixParts: string[] = [kindLabel.toLowerCase()];
  if (leaf.origin.kind === "jsonl") {
    originSuffixParts.push(`L${leaf.origin.jsonlLineIdx + 1}`);
  }
  if (confidence) originSuffixParts.push(confidence);
  originSuffixParts.push(`${leaf.charCount}b`);
  const originSuffix = originSuffixParts.join(" · ");

  // Always attempt to parse — `tryParseSegmentJson` gates on the first
  // non-whitespace char being `{` or `[`, so prose leaves return undefined
  // and stay text-only. This catches both the jsonl wire payloads (where
  // `origin.kind === "jsonl"`) AND rule-origin leaves whose rawText is a
  // JSON schema/blob (tools.* especially — its rawText is a serialized
  // tool definition that previously had no toggle because we only gated
  // on `origin.kind === "jsonl"`).
  const parsedRawJson = tryParseSegmentJson(leaf.rawText ?? leaf.preview);
  const hasJsonContent = parsedRawJson !== undefined;

  const jumpLabel = jumpTarget !== undefined
    ? t("terms.viewSourceCall", { callId: jumpTarget })
    : undefined;
  const jumpTooltip = jumpTarget !== undefined
    ? (isToolUseLeaf
        ? t("terms.jumpToCallCardTooltip", { callId: jumpTarget })
        : t("terms.jumpToCallLineTooltip", { callId: jumpTarget }))
    : undefined;

  return (
    <div style={{ paddingTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Inline metadata strip — replaces the EventUnitCard shell so the
          info reads as a single header line, not a labeled META footer
          duplicated under a card with the same title in its header. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        fontSize: 11, color: "#374151",
        paddingBottom: 6, borderBottom: "1px solid #e5e7eb",
        flexWrap: "wrap",
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: 2,
          background: color, flexShrink: 0,
        }} />
        {requestPath && (
          <>
            <code style={{
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              fontSize: 11, color: "#111827", fontWeight: 600,
            }}>
              {requestPath}
            </code>
            <span style={{ color: "#d1d5db" }}>·</span>
          </>
        )}
        <span style={{
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 11, color: "#1f2937",
        }}>
          {title ?? "—"}
        </span>
        {shortId && (
          <>
            <span style={{ color: "#d1d5db" }}>·</span>
            <span style={{ color: "#6b7280", fontSize: 10 }}>{shortId}</span>
          </>
        )}
        <span style={{ color: "#d1d5db" }}>·</span>
        <span style={{ color: "#6b7280", fontSize: 10 }}>{originSuffix}</span>
        {handleJumpSource && (
          <button
            type="button"
            title={jumpTooltip}
            onClick={(e) => { e.stopPropagation(); handleJumpSource(); }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#4338ca"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "#4f46e5"; }}
            style={{
              marginLeft: "auto",
              display: "inline-flex", alignItems: "center", gap: 5,
              border: "none", background: "#4f46e5", color: "#fff",
              borderRadius: 4, fontSize: 10, fontWeight: 700,
              padding: "3px 9px", cursor: "pointer", lineHeight: 1.3,
              flexShrink: 0, whiteSpace: "nowrap",
              transition: "background 0.12s",
              letterSpacing: "0.02em",
            }}
          >
            <LinkIcon />
            {jumpLabel ?? t("terms.jump", { defaultValue: "跳转" })}
          </button>
        )}
      </div>

      {/* Content — sole focus of the rest of the panel. JSON-parseable
          payloads start in tree mode (toggle to raw available); prose
          stays as a plain block. */}
      <SegmentView
        seg={{
          content: leaf.rawText ?? leaf.preview,
          monospace: leaf.origin.kind === "jsonl" || hasJsonContent,
          rawJson: parsedRawJson,
          defaultRaw: hasJsonContent,
        }}
      />

      {/* Rule origin's dynamic field injection trail — collapsible aside
          below the content. Orthogonal information, not part of the leaf
          identity, so it stays out of the header. */}
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
    </div>
  );
}

// Map a leaf's SegmentOrigin onto EventUnitCard's header slots so that the
// Attribution leaf-detail view reads with the same visual vocabulary as the
// JSONL event rows in Turn cards. The color comes from `EVENT_PALETTES` when
// the origin is a jsonl event (so the dot matches the corresponding
// IntervalEventRow exactly), and from a small rule/structural/unknown
// fallback palette otherwise.
function leafOriginToCardHeader(leaf: LeafLite): {
  color: string;
  kindLabel: string;
  title?: string;
  shortId?: string;
} {
  const o = leaf.origin;
  if (o.kind === "rule") {
    return {
      color: "#3b82f6",
      kindLabel: "Rule",
      title: o.ruleId.startsWith("wire.") ? `wire · ${o.ruleId.slice(5)}` : o.ruleId,
    };
  }
  if (o.kind === "jsonl") {
    const ek: JsonlEventKindObject = typeof o.eventKind === "string"
      ? { source: o.eventKind as JsonlEventKindObject["source"] }
      : o.eventKind;
    const src = ek.source;
    const ct = ek.contentType;
    // Three assistant-side sources (`tool_use` / `assistant_text` /
    // `thinking`) don't correspond to any `IntervalEventKind` — they
    // aren't free-floating jsonl events in the Turn view, they're blocks
    // inside an assistant message. Color them to match the Response tab's
    // `SLOT_META` palette so the same concept reads with the same color
    // wherever it appears.
    const responseSideColor: Record<string, string> = {
      tool_use:       "#f59e0b",  // response.tool_use marker
      assistant_text: "#22c55e",  // response.text marker
      thinking:       "#a78bfa",  // response.thinking marker
    };
    const color = responseSideColor[src]
      ?? EVENT_PALETTES[jsonlSourceToIntervalKind(src)]?.fg
      ?? "#64748b";
    const titleParts: string[] = [src];
    if (ct && ct !== "text") titleParts.push(`:${ct}`);
    return {
      color,
      kindLabel: "JSONL",
      title: titleParts.join(""),
      shortId: o.sourceCallId !== undefined ? `call #${o.sourceCallId}` : undefined,
    };
  }
  if (o.kind === "structural") {
    return { color: "#9ca3af", kindLabel: "Structural", title: o.reason };
  }
  return { color: "#9ca3af", kindLabel: "Unknown", title: o.reason };
}

function jsonlSourceToIntervalKind(source: string): IntervalEventKind {
  switch (source) {
    case "user_input":         return "user:human";
    case "tool_result":        return "user:tool_result";
    case "system_local_command": return "user:command";
    case "attachment":         return "attachment:file";
    case "system_api_error":   return "system:api_error";
    case "stop_hook":          return "system:stop_hook_summary";
    case "away_summary":       return "system:away_summary";
    default:                   return "unknown";
  }
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

// TODO(remove-after-tab-refactor): the AttributionTreePanel *component* (the
// "经典" view that only filters by Audit) has been retired. Call detail now
// always renders AttributionTreeLensPanel, which exposes the full lens
// catalog (来源 / 缓存 / Audit / Diff) — the legacy Audit-only filter is one
// of those lenses.
//
// This file still exports utilities (SECTION_META / computeSectionStats /
// flattenLeaves / shortSlot / fmtK / LeafStrip / LeafTable / SelectedDetail
// / leafFill / originLabel) that AttributionTreeLensPanel imports. Those
// stay. Only the panel function below should be removed once we're sure no
// stray import survives.
export function AttributionTreePanel({
  sessionId, agentFileId, callId, onLinkSource,
}: {
  sessionId: string;
  /** Present iff the panel is rendering a call from a sub-agent — routes
   *  the API call to the sub-agent endpoint variant. Parent (main) sessions
   *  leave this undefined. */
  agentFileId?: string;
  callId: number;
  /** 反向 link：点击 jsonl origin 带 sourceCallId 的 leaf 时调用。
   *  parent 决定要不要展示 link 按钮（main 模式提供，panel 模式留空避免嵌套）。*/
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<AttributionTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedSection, setSelectedSection] = useState<SectionId | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [auditFilter, setAuditFilter] = useState<AuditFilter>("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); setSelectedSection(null); setSelectedNodeId(null);
    const fetcher = agentFileId
      ? apiV2.subAgentAttributionTree(sessionId, agentFileId, callId)
      : apiV2.attributionTree(sessionId, callId);
    fetcher
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, agentFileId, callId]);

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
    return <div style={{ padding: "32px 0", textAlign: "center", fontSize: 11, color: "#9ca3af" }}>{t("attribution.loading")}</div>;
  }
  if (error) {
    return <div style={{ padding: 16, fontSize: 11, color: "#b91c1c", background: "#fef2f2", borderRadius: 6, border: "1px solid #fecaca" }}>
      {t("attribution.loadFailed", { error })}
    </div>;
  }
  if (!result?.snapshot) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "#9ca3af", background: "#fafafa", borderRadius: 6, border: "1px dashed #e5e7eb" }}>
        {result?.error ?? t("attribution.unavailable")}
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
