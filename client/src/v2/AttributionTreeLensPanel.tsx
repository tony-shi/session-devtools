// AttributionTreeLensPanel —— 旁路的 Lens-based attribution 视图。
//
// 和经典 AttributionTreePanel 的关系：
//   • 经典版（AttributionTreePanel）：固定只有 Audit 过滤器，单一视角。
//   • 本 Lens 版：把 Audit 抽象成众多 Lens 中的一个，加上 Provenance（来源）
//     和 Cache 两个新视角；上方有 Lens 切换器，下方动态展示当前 Lens 的桶 pill。
//
// 共享组件（从经典版 import）：
//   • SectionId / SectionStat / SECTION_META / computeSectionStats / sectionOf
//   • LeafLite / flattenLeaves / shortSlot / fmtK / leafFill / originLabel
//   • LeafStrip / LeafTable / SelectedDetail
//
// 本文件自带：
//   • LensSwitcher（顶部 lens 单选）
//   • BucketPillRow（当前 lens 的桶 pill —— 可点击过滤）
//   • LensSectionBar / LensSectionTable（lens-aware section 横条 + 表格）

import { useEffect, useMemo, useState } from "react";
import { apiV2 } from "./api";
import { useAttributionGraph } from "./attribution-graph-context";
import type { AttributionTreeResult } from "./attribution-tree-types";
import {
  SECTION_META,
  computeSectionStats,
  flattenLeaves,
  sectionOf,
  fmtK,
  LeafStrip,
  LeafTable,
  SelectedDetail,
  type LeafLite,
  type SectionId,
  type SectionStat,
} from "./AttributionTreePanel";
import {
  LENSES,
  getLens,
  getBucket,
  bucketStatsOf,
  type Lens,
  type LensBucket,
} from "./lens-framework";
import { DiffPanel } from "./DiffPanel";

// "Diff vs Previous" is folded into the lens switcher as a virtual lens —
// it's a special-case view (前后两个 call 的对比) that doesn't fit the
// regular "leaf 分桶" pattern, so when this id is active we replace the
// section/leaf rendering with <DiffPanel> entirely. The id lives only in
// this file (not in LENSES, which is the bucketing registry).
const DIFF_LENS_ID = "__diff__";
const DIFF_LENS_LABEL = "Diff vs Previous";
const DIFF_LENS_DESCRIPTION = "与前一次 call 的 prompt 差异 — 增/删/改的段";

const BAR_HEIGHT = 44;

// ─── Dev TODO strip ──────────────────────────────────────────────────────────
//
// 旁路 Lens 视图遗留的开发任务，以黄色 dashed chip 形式直接挂在 UI 上。
// 每条 TODO 写一个稳定的内部 id（dev-todo-*），便于在代码 / commit / PR
// 里互相引用。鼠标悬停看到完整描述。
//
// 用同一个 chip 视觉规范：fontSize 10 / 黄底 / 黄色虚线边框 / 鼠标 help
// 光标。和经典 AuditBadge 里 "TODO: 应移至 turn 视图" 那个 chip 同款。

interface DevTodo {
  /** dev-todo-* 稳定 id，可在代码注释 / 文档里反向引用。 */
  id: string;
  /** chip 上的短文案（< 24 字符）。 */
  label: string;
  /** hover 时的完整描述（说明背景 + 下一步动作）。 */
  detail: string;
  /** 仅在指定 lens 激活时显示；不指定则始终可见（跨 lens 通用 TODO）。 */
  showForLensId?: string;
}

const DEV_TODOS: DevTodo[] = [
  // 跨 Lens / 全局
  {
    id: "dev-todo-multi-select",
    label: "多选 / Lens 叠加",
    detail: "当前只支持单选 lens、单选桶。多选叠加（例：Cache + Provenance 同时高亮）和 lens 叠加待后续推进。",
  },
  {
    id: "dev-todo-diff-as-lens",
    label: "Diff 折叠为 Lens",
    detail: "Diff（与前次的差异）仍是顶部独立 tab，未抽象成 lens。后续可加 diffLens（added / removed / modified / kept 四桶），需要在前端引入 prev call diff tree data。",
  },
  // Provenance 视角专属
  {
    id: "dev-todo-provenance-harness-submech",
    label: "Skill vs 摘要细分",
    detail: "harness_injection 桶目前把 skill_invocation 和 compaction_summary 合并显示。若要再细分，需要在前端 SegmentOrigin 加 harness?: { mechanism; payload } 字段（后端已序列化），然后在 bucketOf 里分桶。当前粒度够用。",
    showForLensId: "provenance",
  },
  // Cache 视角专属
  {
    id: "dev-todo-cache-policy-coverage",
    label: "cachePolicy 覆盖度",
    detail: "Cache Lens 依赖 server 端 SerializedNode.cachePolicy 填充。如发现实际命中缓存的 leaf 被归到「未缓存」桶，说明 parser 端没在所有 cached leaves 上 propagate cachePolicy。需要检查 server 端 cache-control breakpoint → 子节点的传播逻辑。",
    showForLensId: "cache",
  },
];

function DevTodoStrip({ activeLensId }: { activeLensId: string }) {
  const visible = DEV_TODOS.filter((td) => !td.showForLensId || td.showForLensId === activeLensId);
  if (visible.length === 0) return null;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      flexWrap: "wrap",
      padding: "2px 0",
    }}>
      <span style={{
        fontSize: 9, fontWeight: 700, color: "#a16207",
        letterSpacing: "0.04em", textTransform: "uppercase",
      }}>
        DEV TODO
      </span>
      {visible.map((td) => (
        <span
          key={td.id}
          title={`${td.id}\n\n${td.detail}`}
          style={{
            fontSize: 10, color: "#a16207",
            padding: "1px 6px", borderRadius: 3,
            background: "#fef3c7", border: "1px dashed #fcd34d",
            cursor: "help", userSelect: "none",
            whiteSpace: "nowrap",
          }}
        >
          {td.label}
        </span>
      ))}
    </div>
  );
}

// ─── LensSwitcher（多 lens toggle）────────────────────────────────────────────

function LensSwitcher({
  lenses, activeLenses, baseLensId, onToggle,
}: {
  lenses: Lens[];
  activeLenses: Set<string>;
  /** 永远 active、不能关闭的基底 lens（一般是 Provenance）。 */
  baseLensId: string;
  onToggle: (id: string) => void;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "2px 0", flexWrap: "wrap",
    }}>
      <span style={{ fontWeight: 600, color: "#4b5563", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: 10 }}>
        视角
      </span>
      {lenses.map((lens) => {
        const isActive = activeLenses.has(lens.id);
        const isBase = lens.id === baseLensId;
        const description = isBase
          ? (lens.description ?? "") + "（基底视角，不能关闭）"
          : lens.description ?? "";
        return (
          <button
            key={lens.id}
            type="button"
            onClick={() => onToggle(lens.id)}
            disabled={isBase}
            title={description}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "3px 9px", borderRadius: 6,
              border: isActive ? "1px solid #6366f1" : "1px solid #e5e7eb",
              background: isActive ? "#eef2ff" : "transparent",
              color: isActive ? "#4338ca" : "#6b7280",
              fontWeight: isActive ? 700 : 500,
              fontSize: 11,
              cursor: isBase ? "default" : "pointer",
              opacity: isBase && !isActive ? 0.5 : 1,
              transition: "background 0.1s, border-color 0.1s",
            }}
          >
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 10, height: 10, borderRadius: 2,
              border: `1px solid ${isActive ? "#6366f1" : "#cbd5e1"}`,
              background: isActive ? "#6366f1" : "transparent",
              color: "#fff",
              fontSize: 8, fontWeight: 700, lineHeight: 1,
            }}>
              {isActive ? "✓" : ""}
            </span>
            {lens.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── BucketPillRow ──────────────────────────────────────────────────────────
//
// 当前 lens 的桶 pill 行。点击 pill = 把那个桶设为过滤；再点一次取消。
// 空桶（leafCount === 0）直接不渲染：本 call 没数据的分类不应该占视觉空间，
// 即使是为了"展示完整 lens 字典"。用户问的是这个 call 的数据。

function BucketPillRow({
  lens, selectedBucketId, onSelect, leaves,
}: {
  lens: Lens;
  selectedBucketId: string | null;
  onSelect: (bucketId: string | null) => void;
  leaves: LeafLite[];
}) {
  const stats = useMemo(() => bucketStatsOf(lens, leaves), [lens, leaves]);
  // 过滤掉本 call 没有命中的桶。如果全部为空（罕见 — 一般是 leaves 全跑空），
  // 整个 pill 行不渲染，避免留个空 row。
  const nonEmptyStats = stats.filter(s => s.leafCount > 0);
  if (nonEmptyStats.length === 0) return null;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      flexWrap: "wrap",  // 桶过多时换行（前端样式处理布局问题）
      padding: "2px 0",
    }}>
      {nonEmptyStats.map(({ bucket, leafCount, totalChars }) => {
        const isActive = selectedBucketId === bucket.id;
        return (
          <button
            key={bucket.id}
            type="button"
            onClick={() => onSelect(isActive ? null : bucket.id)}
            title={`${bucket.label}${bucket.description ? "：" + bucket.description : ""}\n${leafCount} 个 leaf · ${fmtK(totalChars)} chars`}
            style={{
              display: "inline-flex", alignItems: "baseline", gap: 6,
              padding: "3px 8px", borderRadius: 4,
              border: isActive ? `1px solid ${bucket.color}` : "1px solid transparent",
              background: isActive ? `${bucket.color}1a` : "transparent",
              color: "#374151",
              fontSize: 11,
              cursor: "pointer",
              transition: "background 0.1s, border-color 0.1s",
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: 1,
              background: bucket.color, alignSelf: "center",
            }} />
            <span style={{ fontWeight: 600, color: "#1f2937" }}>{leafCount}</span>
            <span style={{ color: "#6b7280" }}>{bucket.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── LensSectionBar ─────────────────────────────────────────────────────────
//
// 顶部三段大柱（System / Tools / Messages），形状按全集分布；激活桶时叠加角标
// 显示「本 section 内匹配桶的 leaf 数」，无命中的 section 灰化。这部分逻辑和
// 经典版 AuditBadge → SectionBar 的桥接一致，只是 filterColor 从 audit 桶颜色
// 换成 Lens 桶颜色。

function LensSectionBar({
  stats, totalChars, selectedSection, onSelect,
  filteredStats, bucketColor,
}: {
  stats: SectionStat[];
  totalChars: number;
  selectedSection: SectionId | null;
  onSelect: (s: SectionId) => void;
  filteredStats: SectionStat[] | null;
  bucketColor: string | null;
}) {
  const [hoveredId, setHoveredId] = useState<SectionId | null>(null);
  if (totalChars === 0) return null;
  const hasSelection = selectedSection !== null;
  const filterActive = filteredStats !== null && bucketColor !== null;
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
              {filterActive && bucketColor && hitCount !== null && pct >= 0.05 && (
                <span
                  title={`${hitCount} 个 leaf 匹配当前桶`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 4,
                    fontSize: 10, fontWeight: 700,
                    padding: "1px 5px", borderRadius: 3,
                    background: "rgba(255,255,255,0.7)",
                    color: "#1f2937",
                    whiteSpace: "nowrap", flexShrink: 0,
                  }}
                >
                  <span style={{ width: 5, height: 5, borderRadius: 1, background: bucketColor }} />
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

// ─── LensSectionTable ───────────────────────────────────────────────────────
//
// 默认（未选 section）的极简表格视图，列出三个 section 的字符数 / 占比 /
// section 内的子统计。Lens 桶过滤激活时叠加角标。

function LensSectionTable({
  stats, totalChars, onSelect, filteredStats, bucketColor,
}: {
  stats: SectionStat[];
  totalChars: number;
  onSelect: (id: SectionId) => void;
  filteredStats: SectionStat[] | null;
  bucketColor: string | null;
}) {
  const filterActive = filteredStats !== null && bucketColor !== null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {stats.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = totalChars > 0 ? (s.totalChars / totalChars) * 100 : 0;
        const hitCount = filterActive
          ? (filteredStats!.find((fs) => fs.id === s.id)?.leafCount ?? 0)
          : null;
        const dimmed = filterActive && hitCount === 0;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              display: "flex", alignItems: "center", gap: 14,
              padding: "8px 8px",
              background: "transparent",
              border: "none", borderRadius: 4,
              cursor: "pointer", textAlign: "left",
              transition: "background 0.1s",
              opacity: dimmed ? 0.45 : 1,
            }}
            onMouseEnter={(e) => { if (!dimmed) e.currentTarget.style.background = "#f9fafb"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.marker, flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: meta.textColor, minWidth: 90 }}>{meta.label}</span>
            <span style={{ fontSize: 11, color: "#374151", minWidth: 60 }}>{fmtK(s.totalChars)}</span>
            <span style={{ fontSize: 11, color: "#9ca3af", minWidth: 44 }}>{pct.toFixed(1)}%</span>
            <span style={{ fontSize: 10, color: "#9ca3af", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {s.leafCount} segments
              {s.toolCount !== undefined && ` · ${s.toolCount} tools`}
              {s.byRole && [
                s.byRole.user > 0 && `${s.byRole.user} user`,
                s.byRole.assistant > 0 && `${s.byRole.assistant} assistant`,
                s.byRole.system > 0 && `${s.byRole.system} system`,
              ].filter(Boolean).map(x => " · " + x).join("")}
            </span>
            {filterActive && bucketColor && hitCount !== null && (
              <span
                style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  fontSize: 10, fontWeight: 700,
                  padding: "1px 6px", borderRadius: 3,
                  background: `${bucketColor}1a`, color: "#1f2937",
                  border: `1px solid ${bucketColor}40`,
                  flexShrink: 0,
                }}
              >
                <span style={{ width: 5, height: 5, borderRadius: 1, background: bucketColor }} />
                {hitCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── 顶层 Panel ─────────────────────────────────────────────────────────────

export function AttributionTreeLensPanel({
  sessionId, agentFileId, callId, prevCallId, hideDiff, onLinkSource, onLeafSelect, prelude,
}: {
  sessionId: string;
  /** Present iff rendering a sub-agent call — routes to sub-agent endpoint. */
  agentFileId?: string;
  callId: number;
  /** Optional previous-call id — required for the Diff lens. */
  prevCallId?: number | null;
  /** When true, always hide the Diff chip (e.g. Diff is its own top-level tab). */
  hideDiff?: boolean;
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
  /** 选中 leaf 时回调（取消选中传 null）。供外层（如 CachePanel）联动高亮。
   *  注意：传入的是 SegmentNode.id（与 diff-tree leaves 同一套 id 体系）。 */
  onLeafSelect?: (nodeId: string | null) => void;
  /** 在 LensSectionBar 之上额外渲染的节点。CachePanel 用此插入 L1/L2/L3 紧凑行，
   *  让它们与下方 LensSectionBar 在同一容器内自然对齐（同宽 / 同 padding）。 */
  prelude?: React.ReactNode;
}) {
  const [result, setResult] = useState<AttributionTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 多 lens 同时激活：来源默认锁定 active，Diff/Cache/Audit 可独立 toggle on/off。
  // bucketFilters 是「每个 lens 选中的桶」的 map；过滤是各 lens 选择的 AND 合取。
  const [activeLenses, setActiveLenses] = useState<Set<string>>(new Set([LENSES[0].id]));
  const [bucketFilters, setBucketFilters] = useState<Record<string, string | null>>({});
  const [selectedSection, setSelectedSection] = useState<SectionId | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // 把选中状态外露给父组件（如 CachePanel），用于上方 bar 联动高亮。
  useEffect(() => {
    onLeafSelect?.(selectedNodeId);
  }, [selectedNodeId, onLeafSelect]);

  // toggle 某 lens：开启则加入 activeLenses；关闭则移除并清空它对应的 bucket。
  // Provenance（默认 LENSES[0]）锁定 active，禁止关闭。
  function toggleLens(id: string) {
    if (id === LENSES[0].id) return;
    setActiveLenses((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setBucketFilters((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelectedNodeId(null);
  }

  // 选/取消选 lens 的某个桶。bucketId 传 null 取消该 lens 的过滤。
  function setBucketFilter(lensId: string, bucketId: string | null) {
    setBucketFilters((prev) => {
      const next = { ...prev };
      if (bucketId === null) delete next[lensId];
      else next[lensId] = bucketId;
      return next;
    });
    setSelectedNodeId(null);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    setSelectedSection(null); setSelectedNodeId(null); setBucketFilters({});
    const fetcher = agentFileId
      ? apiV2.subAgentAttributionTree(sessionId, agentFileId, callId)
      : apiV2.attributionTree(sessionId, callId);
    fetcher
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, agentFileId, callId]);

  // 并行拉 diff-tree，用 leafId 把 diffKind 合并到 attribution leaves 上。
  // Diff lens / Diff 视角的双层 bar / Removed footer 都依赖这份数据。
  const [diffData, setDiffData] = useState<import("./diff-tree-types").DiffTreeResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetcher = agentFileId
      ? apiV2.subAgentDiffTree(sessionId, agentFileId, callId)
      : apiV2.diffTree(sessionId, callId);
    fetcher
      .then((r) => { if (!cancelled) setDiffData(r); })
      .catch(() => { if (!cancelled) setDiffData(null); }); // diff 失败不阻塞 attribution
    return () => { cancelled = true; };
  }, [sessionId, agentFileId, callId]);

  const allLeaves = useMemo(() => {
    if (!result) return [];
    const base = flattenLeaves(result);
    // 合并 diff-tree 的 diffKind 信息
    if (!diffData) return base;
    const kindById = new Map<string, "added" | "removed" | "modified" | "kept">();
    for (const sec of diffData.sections) {
      for (const l of sec.leaves) {
        kindById.set(l.id, l.kind);
      }
    }
    return base.map((leaf) => {
      const k = kindById.get(leaf.nodeId);
      return k ? { ...leaf, diffKind: k } : leaf;
    });
  }, [result, diffData]);

  // Pending-focus consumption: when a Turn-view event jump lands here with a
  // `{ lineIdx }` focus, find the leaf whose jsonl origin matches and
  // select it. Also drills into its containing section so the leaf
  // actually renders (top-level table starts in section overview, not
  // leaf detail).
  const { pendingFocus, clearPendingFocus } = useAttributionGraph();
  useEffect(() => {
    if (!pendingFocus || !("lineIdx" in pendingFocus) || allLeaves.length === 0) return;
    const target = pendingFocus.lineIdx;
    const match = allLeaves.find(
      (l) => l.origin.kind === "jsonl" && l.origin.jsonlLineIdx === target,
    );
    if (match) {
      setSelectedSection(sectionOf(match.rootSlotType));
      setSelectedNodeId(match.nodeId);
    }
    clearPendingFocus();
  }, [pendingFocus, allLeaves, clearPendingFocus]);

  // 把"任意 active lens 的桶选择"合并成一个谓词，AND 联合过滤。
  const passesAllFilters = useMemo(() => {
    const filters = Object.entries(bucketFilters).filter(([, b]) => !!b);
    if (filters.length === 0) return null;
    return (leaf: LeafLite): boolean => {
      for (const [lid, bid] of filters) {
        const ln = getLens(lid);
        if (ln.bucketOf(leaf) !== bid) return false;
      }
      return true;
    };
  }, [bucketFilters]);

  const leaves = useMemo(() => {
    if (!passesAllFilters) return allLeaves;
    return allLeaves.filter(passesAllFilters);
  }, [allLeaves, passesAllFilters]);

  const stats = useMemo(() => computeSectionStats(allLeaves), [allLeaves]);
  const totalChars = useMemo(() => allLeaves.reduce((s, l) => s + l.charCount, 0), [allLeaves]);

  // 过滤激活时给 section 大柱里也染上"通过过滤的部分"作为内嵌细条。
  const filteredStats = useMemo(
    () => passesAllFilters ? computeSectionStats(leaves) : null,
    [leaves, passesAllFilters],
  );
  // 用第一个有 bucket 过滤的 lens 的颜色作为过滤色（视觉一致性，避免多色混叠）。
  const filterAccentColor: string | null = useMemo(() => {
    for (const [lid, bid] of Object.entries(bucketFilters)) {
      if (!bid) continue;
      const ln = getLens(lid);
      const b = getBucket(ln, bid);
      if (b) return b.color;
    }
    return null;
  }, [bucketFilters]);

  const selectedStat = useMemo(() => {
    if (!selectedSection) return null;
    const stat = stats.find((s) => s.id === selectedSection);
    if (!stat) return null;
    if (!passesAllFilters) return stat;
    const filteredLeaves = stat.leaves.filter(passesAllFilters);
    return { ...stat, leaves: filteredLeaves };
  }, [selectedSection, stats, passesAllFilters]);

  const selectedLeaf = useMemo(
    () => selectedNodeId ? leaves.find((l) => l.nodeId === selectedNodeId) ?? null : null,
    [selectedNodeId, leaves],
  );

  // Leaf 着色：永远用 Provenance lens（来源是基底视角）。其他 lens 的信息通过
  // 行尾 badge 表达，而不是抢主色。
  const leafColor = useMemo(() => {
    const provLens = getLens(LENSES[0].id);
    return (leaf: LeafLite) => {
      const bid = provLens.bucketOf(leaf);
      const b = bid ? provLens.buckets.find((x) => x.id === bid) : null;
      return b?.color ?? "#d1d5db";
    };
  }, []);

  // 决定哪些 lens 出现在 toggle 行 + bucket pill 区。Provenance 永远出现；
  // Diff lens 在没有 prevCall 时无意义，隐藏。
  // 注意：useMemo 必须在所有 early return 之上，避免 hook 顺序变化。
  const visibleLenses = useMemo(
    () => LENSES.filter((l) => {
      if (l.id === "diff" && (hideDiff || prevCallId == null)) return false;
      return true;
    }),
    [hideDiff, prevCallId],
  );

  if (loading) {
    return <div style={{ padding: "32px 0", textAlign: "center", fontSize: 11, color: "#9ca3af" }}>Loading attribution tree…</div>;
  }
  if (error) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "#b91c1c", background: "#fef2f2", borderRadius: 6, border: "1px solid #fecaca" }}>
        Failed to load attribution tree: {error}
      </div>
    );
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
      {/* Layer 0: 多 lens toggle。来源永远 active（chip 显示禁用样式）；
          其他 lens 点击 toggle on/off。 */}
      <LensSwitcher
        lenses={visibleLenses}
        activeLenses={activeLenses}
        baseLensId={LENSES[0].id}
        onToggle={toggleLens}
      />

      {/* Layer 0.1: 开发者可见的 TODO 列表 —— 仅 Provenance（基底 lens）的 todo */}
      <DevTodoStrip activeLensId={LENSES[0].id} />

      {/* Prelude（CachePanel 旧路径用过；统一后由 cache lens 自管） */}
      {prelude}

      {/* Layer 0.5: 每个 active lens 一行 bucket pill */}
      {visibleLenses.filter((l) => activeLenses.has(l.id)).map((l) => (
        <BucketPillRow
          key={l.id}
          lens={l}
          selectedBucketId={bucketFilters[l.id] ?? null}
          onSelect={(bid) => setBucketFilter(l.id, bid)}
          leaves={allLeaves}
        />
      ))}

      {/* Layer 1: section 大柱 */}
      <LensSectionBar
        stats={stats}
        totalChars={totalChars}
        selectedSection={selectedSection}
        onSelect={(s) => {
          setSelectedSection((cur) => (cur === s ? null : s));
          setSelectedNodeId(null);
        }}
        filteredStats={filteredStats}
        bucketColor={filterAccentColor}
      />

      {selectedStat === null ? (
        <LensSectionTable
          stats={stats}
          totalChars={totalChars}
          onSelect={(s) => setSelectedSection(s)}
          filteredStats={filteredStats}
          bucketColor={filterAccentColor}
        />
      ) : (
        <>
          <LeafStrip
            leaves={selectedStat.leaves}
            selectedId={selectedNodeId}
            onSelect={(id) => setSelectedNodeId((cur) => (cur === id ? null : id))}
            getColor={leafColor}
          />
          <LeafTable
            leaves={selectedStat.leaves}
            selectedId={selectedNodeId}
            onSelect={(id) => setSelectedNodeId((cur) => (cur === id ? null : id))}
            getColor={leafColor}
          />
          {selectedLeaf && sectionOf(selectedLeaf.rootSlotType) === selectedStat.id && (
            <SelectedDetail leaf={selectedLeaf} onLinkSource={onLinkSource} />
          )}
        </>
      )}
    </div>
  );
}
