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
    id: "dev-todo-provenance-skill-mcp",
    label: "Skill / MCP 细分",
    detail: "Harness 静态目前只按「有无 dynamicFields」粗分。要再细到 skill / mcp / system_reminder / tool_definition 等子桶，需要 server 端给 slotType 一套规范命名空间（skill.* / mcp.*），或在 client 端维护本地映射表。",
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

// ─── LensSwitcher ────────────────────────────────────────────────────────────

function LensSwitcher({
  activeLensId, onChange,
}: {
  activeLensId: string;
  onChange: (id: string) => void;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "2px 0",
    }}>
      <span style={{ fontWeight: 600, color: "#4b5563", letterSpacing: "0.04em", textTransform: "uppercase", fontSize: 10 }}>
        视角
      </span>
      {LENSES.map((lens) => {
        const active = lens.id === activeLensId;
        return (
          <button
            key={lens.id}
            type="button"
            onClick={() => onChange(lens.id)}
            title={lens.description}
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              padding: "3px 9px", borderRadius: 6,
              border: active ? "1px solid #6366f1" : "1px solid #e5e7eb",
              background: active ? "#eef2ff" : "transparent",
              color: active ? "#4338ca" : "#6b7280",
              fontWeight: active ? 700 : 500,
              fontSize: 11,
              cursor: "pointer",
              transition: "background 0.1s, border-color 0.1s",
            }}
          >
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
// 空桶（leafCount === 0）也保留位置，但灰色 + disable，避免布局跳动。

function BucketPillRow({
  lens, selectedBucketId, onSelect, leaves,
}: {
  lens: Lens;
  selectedBucketId: string | null;
  onSelect: (bucketId: string | null) => void;
  leaves: LeafLite[];
}) {
  const stats = useMemo(() => bucketStatsOf(lens, leaves), [lens, leaves]);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      flexWrap: "wrap",  // 桶过多时换行（前端样式处理布局问题）
      padding: "2px 0",
    }}>
      {stats.map(({ bucket, leafCount, totalChars }) => {
        const isActive = selectedBucketId === bucket.id;
        const isEmpty = leafCount === 0;
        return (
          <button
            key={bucket.id}
            type="button"
            disabled={isEmpty}
            onClick={() => onSelect(isActive ? null : bucket.id)}
            title={`${bucket.label}${bucket.description ? "：" + bucket.description : ""}\n${leafCount} 个 leaf · ${fmtK(totalChars)} chars`}
            style={{
              display: "inline-flex", alignItems: "baseline", gap: 6,
              padding: "3px 8px", borderRadius: 4,
              border: isActive ? `1px solid ${bucket.color}` : "1px solid transparent",
              background: isActive ? `${bucket.color}1a` : "transparent",
              color: isEmpty ? "#d1d5db" : "#374151",
              fontSize: 11,
              cursor: isEmpty ? "not-allowed" : "pointer",
              opacity: isEmpty ? 0.5 : 1,
              transition: "background 0.1s, border-color 0.1s",
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: 1,
              background: bucket.color, alignSelf: "center",
              opacity: isEmpty ? 0.4 : 1,
            }} />
            <span style={{ fontWeight: 600, color: isEmpty ? "#9ca3af" : "#1f2937" }}>{leafCount}</span>
            <span style={{ color: isEmpty ? "#9ca3af" : "#6b7280" }}>{bucket.label}</span>
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
  sessionId, callId, onLinkSource,
}: {
  sessionId: string;
  callId: number;
  onLinkSource?: (sourceCallId: number, sourceTurnId?: number) => void;
}) {
  const [result, setResult] = useState<AttributionTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [lensId, setLensId] = useState<string>(LENSES[0].id);
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null);
  const [selectedSection, setSelectedSection] = useState<SectionId | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // 切 lens 时清空桶选择 + leaf 选择，避免 stale state（不同 lens 的 bucketId
  // 不能直接复用）。Section drill-in 保留 —— Section 维度和 Lens 正交。
  useEffect(() => {
    setSelectedBucketId(null);
    setSelectedNodeId(null);
  }, [lensId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    setSelectedSection(null); setSelectedNodeId(null); setSelectedBucketId(null);
    apiV2.attributionTree(sessionId, callId)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, callId]);

  const lens = useMemo(() => getLens(lensId), [lensId]);
  const allLeaves = useMemo(() => result ? flattenLeaves(result) : [], [result]);

  // Bucket filtering — 选了桶就只留命中桶的 leaf；否则全集。
  const leaves = useMemo(() => {
    if (!selectedBucketId) return allLeaves;
    return allLeaves.filter((l) => lens.bucketOf(l) === selectedBucketId);
  }, [allLeaves, lens, selectedBucketId]);

  const stats = useMemo(() => computeSectionStats(allLeaves), [allLeaves]);
  const totalChars = useMemo(() => allLeaves.reduce((s, l) => s + l.charCount, 0), [allLeaves]);

  const filteredStats = useMemo(
    () => selectedBucketId ? computeSectionStats(leaves) : null,
    [leaves, selectedBucketId],
  );
  const activeBucket: LensBucket | null = useMemo(
    () => getBucket(lens, selectedBucketId),
    [lens, selectedBucketId],
  );
  const bucketColor = activeBucket?.color ?? null;

  const selectedStat = useMemo(() => {
    if (!selectedSection) return null;
    const stat = stats.find((s) => s.id === selectedSection);
    if (!stat) return null;
    if (!selectedBucketId) return stat;
    const filteredLeaves = stat.leaves.filter((l) => lens.bucketOf(l) === selectedBucketId);
    return { ...stat, leaves: filteredLeaves };
  }, [selectedSection, stats, selectedBucketId, lens]);

  const selectedLeaf = useMemo(
    () => selectedNodeId ? leaves.find((l) => l.nodeId === selectedNodeId) ?? null : null,
    [selectedNodeId, leaves],
  );

  // Leaf 着色：按当前 lens 把 leaf 分桶 → 取桶颜色。这样 leaf strip / table
  // 的颜色和顶部 pill 行的色方块完全对得上。
  const leafColor = useMemo(() => {
    return (leaf: LeafLite) => {
      const bid = lens.bucketOf(leaf);
      const b = bid ? lens.buckets.find((x) => x.id === bid) : null;
      return b?.color ?? "#d1d5db";
    };
  }, [lens]);

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
      {/* Layer 0: Lens 切换 */}
      <LensSwitcher activeLensId={lensId} onChange={setLensId} />

      {/* Layer 0.1: 开发者可见的 TODO 列表 —— 直接挂在视图上，方便迭代时
          一眼看到该 lens 还有哪些限制 / 下一步要做的事。每个 chip 鼠标
          悬停看完整描述。要去掉这一行只需删除 <DevTodoStrip /> 即可。 */}
      <DevTodoStrip activeLensId={lensId} />

      {/* Layer 0.5: 当前 lens 的桶 pill 行（点击过滤） */}
      <BucketPillRow
        lens={lens}
        selectedBucketId={selectedBucketId}
        onSelect={setSelectedBucketId}
        leaves={allLeaves}
      />

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
        bucketColor={bucketColor}
      />

      {selectedStat === null ? (
        <LensSectionTable
          stats={stats}
          totalChars={totalChars}
          onSelect={(s) => setSelectedSection(s)}
          filteredStats={filteredStats}
          bucketColor={bucketColor}
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
