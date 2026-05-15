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
  system:   { label: "System",   barBg: "#bfdbfe", barText: "#1e3a8a", rowBg: "#eff6ff", marker: "#3b82f6", textColor: "#1e40af" },
  tools:    { label: "Tools",    barBg: "#3b82f6", barText: "#fff",    rowBg: "#eff6ff", marker: "#2563eb", textColor: "#1e40af" },
  messages: { label: "Messages", barBg: "#a78bfa", barText: "#fff",    rowBg: "#f5f3ff", marker: "#8b5cf6", textColor: "#5b21b6" },
  other:    { label: "Other",    barBg: "#d1d5db", barText: "#374151", rowBg: "#fafafa", marker: "#9ca3af", textColor: "#374151" },
};

// Leaf 颜色：解析清楚的（rule / jsonl / structural）使用所属 section 的色调；
// unknown 统一用「加重一号」的灰，与可解释段落明显区分。
const UNKNOWN_FILL = "#9ca3af";

function leafFill(leaf: { origin: SegmentOrigin; rootSlotType: string }): string {
  if (leaf.origin.kind === "unknown") return UNKNOWN_FILL;
  return SECTION_META[sectionOf(leaf.rootSlotType)].barBg;
}

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
  const [hoveredId, setHoveredId] = useState<SectionId | null>(null);
  if (totalChars === 0) return null;
  const hasSelection = selectedSection !== null;
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
        const opacity = intensity === 0 ? 0.18 : 1;
        const fontWeight = intensity >= 2 ? 800 : 700;
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
            <div style={{ fontSize: 13, fontWeight, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {meta.label}
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

function LeafStrip({
  leaves, selectedId, onSelect,
}: {
  leaves: LeafLite[];
  selectedId: string | null;
  onSelect: (id: string) => void;
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
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 2 }}>
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

      {/* Strip — getLabel 返回 shortSlot；模块按段宽决定 inside / 隐藏。
          minCount=5 让 attribution leaves 天然开启鱼眼。 */}
      <FisheyeStrip<LeafItem>
        items={items}
        getColor={(it) => leafFill(it.leaf)}
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
            <span style={{ fontSize: 11, color: "#374151", minWidth: 60 }}>{fmtK(s.totalChars)}</span>
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
        const fill = leafFill(l);
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
