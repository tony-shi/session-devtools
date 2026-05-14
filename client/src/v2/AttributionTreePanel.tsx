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
import { useTranslation } from "react-i18next";
import { apiV2 } from "./api";
import { FisheyeStrip, computeLinearPositions } from "./fisheye-strip";
import type { FisheyeStatus } from "./fisheye-strip";
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

// ORIGIN 配色：与 diff 三色（绿/红/黄）严格错开，避免视觉混淆。
//   rule:       紫     (#c7d2fe)
//   jsonl:      蓝     (#bae6fd)
//   structural: 灰     (#e5e7eb)
//   unknown:    橙     (#fed7aa)
const ORIGIN_FILL: Record<OriginKind, string> = {
  rule:       "#c7d2fe",
  jsonl:      "#bae6fd",
  structural: "#e5e7eb",
  unknown:    "#fed7aa",
};

const ORIGIN_BORDER: Record<OriginKind, string> = {
  rule:       "#a5b4fc",
  jsonl:      "#7dd3fc",
  structural: "#d1d5db",
  unknown:    "#fb923c",
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

// ─── 二级 strip：leaves（消费 fisheye-strip 模块） ────────────────────────────
//
// 组合结构：
//   [above callout lane]   ← 业务侧：基于线性位置静态布局窄段 label
//   [FisheyeStrip]         ← 模块：bar 本体 + hover fisheye 放大
//   [below callout lane]   ← 业务侧
//
// callout 仅在「未 hover strip」时显示（hover 时由 fisheye 内部放大段直接显示 label）。
// callout 位置基于线性 origPositions —— fisheye 激活时 bar 移位，callout 会与之错位，
// 因此 hover 期间整体隐藏 callout。

const STRIP_FONT_PX = 9;
const STRIP_CHAR_PX = 5.2;
const STRIP_LABEL_PAD = 6;
const STRIP_LANE_HEIGHT = 13;
const STRIP_LANE_GAP = 2;

type LabelPlacement =
  | { type: "inside" }
  | { type: "above"; left: number; width: number }
  | { type: "below"; left: number; width: number }
  | { type: "hidden" };

/** 基于线性位置（FisheyeStrip 内部静态布局也是线性）算 callout 位置。
 *  位置被严格 clamp 到 [0, containerWidth]，避免溢出撑开父布局。 */
function computeCalloutPlacements(
  leaves: LeafLite[],
  positions: number[],
  containerWidth: number,
): LabelPlacement[] {
  const n = leaves.length;
  if (n === 0 || positions.length < 2) return [];

  const placements: LabelPlacement[] = new Array(n);
  const aboveOcc: Array<[number, number]> = [];
  const belowOcc: Array<[number, number]> = [];

  for (let i = 0; i < n; i++) {
    const left = positions[i];
    const right = positions[i + 1];
    const barW = Math.max(right - left - 1, 0);
    const label = shortSlot(leaves[i].slotType);
    // label 宽度上限：不超过容器宽度（极端情况防止溢出）
    const labelW = Math.min(label.length * STRIP_CHAR_PX + STRIP_LABEL_PAD, 220, Math.max(containerWidth, 0));

    if (barW >= labelW + 4) {
      placements[i] = { type: "inside" };
    } else {
      // 居中 → clamp 到容器内
      let cL = left + barW / 2 - labelW / 2;
      if (cL < 0) cL = 0;
      if (cL + labelW > containerWidth) cL = Math.max(0, containerWidth - labelW);
      const cR = cL + labelW;
      const fits = (occ: Array<[number, number]>) =>
        !occ.some(([oL, oR]) => !(cR <= oL || cL >= oR));

      if (fits(aboveOcc)) {
        placements[i] = { type: "above", left: cL, width: labelW };
        aboveOcc.push([cL, cR]);
      } else if (fits(belowOcc)) {
        placements[i] = { type: "below", left: cL, width: labelW };
        belowOcc.push([cL, cR]);
      } else {
        placements[i] = { type: "hidden" };
      }
    }
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

/** Leaf item — 适配 FisheyeStrip 接口（id + size），保留原 leaf 引用便于回调取数据 */
interface LeafItem {
  id: string;
  size: number;
  leaf: LeafLite;
}

type LayoutMode = "proportional" | "equal";

/** 过载阈值：最窄段 < 此像素值时认为「太密」，提示用户改用 table */
const OVERLOAD_MIN_BAR_PX = 1.5;

function LeafStrip({
  leaves, selectedId, onSelect,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { ref, width } = useContainerWidth<HTMLDivElement>();
  const [hoveredLeaf, setHoveredLeaf] = useState<LeafLite | null>(null);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("proportional");
  const [stripStatus, setStripStatus] = useState<FisheyeStatus | null>(null);
  const isStripHovered = hoveredLeaf !== null;
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

  // 线性位置（用于 callout 定位）
  const { positions: origPositions } = useMemo(
    () => computeLinearPositions(items, width),
    [items, width],
  );

  // callout 仅在 proportional 模式下计算（等宽时每段都够宽，inside 即可）
  const placements = useMemo(
    () => layoutMode === "proportional"
      ? computeCalloutPlacements(leaves, origPositions, width)
      : leaves.map(() => ({ type: "inside" } as LabelPlacement)),
    [leaves, origPositions, layoutMode, width],
  );

  if (leaves.length === 0) return null;

  return (
    <div
      ref={ref}
      style={{
        display: "flex", flexDirection: "column", gap: STRIP_LANE_GAP,
        // 防御：callout 标签绝不允许撑开横轴
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
      {/* 过载横幅 */}
      {isOverloaded && (
        <div
          role="status"
          style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "6px 10px",
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: 4,
            fontSize: 10.5,
            color: "#92400e",
            lineHeight: 1.5,
          }}
        >
          <span style={{ flexShrink: 0 }}>⚠️</span>
          <span>{t("attribution.overloadBanner", { count: leaves.length })}</span>
        </div>
      )}

      {/* Hover readout + 布局切换 */}
      <div style={{
        height: 20, display: "flex", alignItems: "center", gap: 8,
        padding: "0 2px",
        fontSize: 10,
        whiteSpace: "nowrap", overflow: "hidden",
      }}>
        <div style={{
          flex: 1, display: "flex", alignItems: "center", gap: 8,
          overflow: "hidden",
          color: hoveredLeaf ? "#111827" : "#9ca3af",
          transition: "color 0.15s",
        }}>
          {hoveredLeaf ? (
            <>
              <span style={{
                width: 8, height: 8, borderRadius: 2,
                background: ORIGIN_FILL[hoveredLeaf.origin.kind], flexShrink: 0,
              }} />
              <span style={{
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontWeight: 600, color: "#111827",
              }}>{shortSlot(hoveredLeaf.slotType)}</span>
              <span style={{ color: "#6b7280" }}>{fmtK(hoveredLeaf.charCount)} chars</span>
              <span style={{ color: "#9ca3af" }}>·</span>
              <span style={{ color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis" }}>
                {originLabel(hoveredLeaf.origin)}
              </span>
            </>
          ) : (
            <span style={{ fontStyle: "italic", letterSpacing: "0.02em" }}>
              {isOverloaded ? t("attribution.overloadHint") : t("attribution.hoverHint")}
            </span>
          )}
        </div>
        {/* 等宽 / 按比例 toggle */}
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          {([
            { id: "proportional" as const, label: t("attribution.layoutProportional"), title: t("attribution.layoutProportionalTitle") },
            { id: "equal" as const,        label: t("attribution.layoutEqual"),        title: t("attribution.layoutEqualTitle") },
          ]).map((o) => {
            const isSel = layoutMode === o.id;
            return (
              <button
                key={o.id}
                title={o.title}
                onClick={() => setLayoutMode(o.id)}
                style={{
                  fontSize: 9, padding: "2px 8px",
                  background: isSel ? "#4338ca" : "transparent",
                  color: isSel ? "#fff" : "#6b7280",
                  border: `1px solid ${isSel ? "#4338ca" : "#e5e7eb"}`,
                  borderRadius: 3, cursor: "pointer",
                  fontWeight: isSel ? 600 : 400,
                }}
              >{o.label}</button>
            );
          })}
        </div>
      </div>

      {/* 上方 callout lane */}
      <div style={{ position: "relative", height: STRIP_LANE_HEIGHT, overflow: "hidden" }}>
        {!isStripHovered && placements.map((p, i) => {
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

      {/* Strip — 委托给 FisheyeStrip 模块。
          getLabel 总返回真实文字，模块按实测段宽决定是否能放下。
          minCount=5 让 attribution leaves 天然开启鱼眼。 */}
      <FisheyeStrip<LeafItem>
        items={items}
        getColor={(it) => ORIGIN_FILL[it.leaf.origin.kind]}
        getLabel={(it) => shortSlot(it.leaf.slotType)}
        getTitle={(it) => `${shortSlot(it.leaf.slotType)} · ${fmtK(it.leaf.charCount)} chars · ${originLabel(it.leaf.origin)}`}
        height={SUB_BAR_HEIGHT}
        background="transparent"
        autoConfig={{ minCount: 5, clickableThresholdPx: 16 }}
        selectedId={selectedId}
        onSelect={(it) => onSelect(it.id)}
        onHover={(it) => setHoveredLeaf(it?.leaf ?? null)}
        onStatusChange={setStripStatus}
      />

      {/* 下方 callout lane */}
      <div style={{ position: "relative", height: STRIP_LANE_HEIGHT, overflow: "hidden" }}>
        {!isStripHovered && placements.map((p, i) => {
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
  // 选中后只显示该 leaf 行，其他兄弟不再列出（避免与 SelectedDetail 重复信息）
  const visibleLeaves = selectedId ? leaves.filter((l) => l.nodeId === selectedId) : leaves;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {visibleLeaves.map((l) => {
        const pct = total > 0 ? (l.charCount / total) * 100 : 0;
        const isSel = selectedId === l.nodeId;
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

function SelectedDetail({ leaf }: { leaf: LeafLite }) {
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
      <pre style={{
        margin: 0, fontSize: 11, color: "#374151", lineHeight: 1.5,
        whiteSpace: "pre-wrap", wordBreak: "break-word",
        background: "#fafafa", padding: "8px 10px", borderRadius: 4,
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
            <SelectedDetail leaf={selectedLeaf} />
          )}
        </>
      )}
    </div>
  );
}
