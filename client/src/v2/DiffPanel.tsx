// DiffPanel — 消费 /api/v2/sessions/:id/calls/:callId/diff-tree 真实数据视图。
//
// 视觉精简版（参考 attribution 风格）：
//   - 顶部 SectionBar — system / tools / messages 三段，按 newTotal 比例
//   - 默认 SectionTable 列表
//   - 进入 section（点击 bar 或 row）→ Hover readout + LeafStrip（鱼眼）+ SelectedDetail
//   - 无 "← back"（顶部 SectionBar 可直接切换）
//   - 无 Legend（+/-/~ 前缀 + 三色已足够）
//   - SelectedDetail 扁平展示，无 card 外框

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiV2 } from "./api";
import { FisheyeStrip } from "./fisheye-strip";
import type {
  DiffKind, DiffLeaf, DiffSection, DiffSectionId, DiffTreeResult,
} from "./diff-tree-types";

// ─── 配色 ─────────────────────────────────────────────────────────────────────

interface SectionMeta {
  label: string;
  barBg: string;
  barText: string;
  marker: string;
  textColor: string;
}

const SECTION_META: Record<DiffSectionId, SectionMeta> = {
  system:   { label: "System",   barBg: "#818cf8", barText: "#fff", marker: "#6366f1", textColor: "#3730a3" },
  tools:    { label: "Tools",    barBg: "#9ca3af", barText: "#fff", marker: "#6b7280", textColor: "#374151" },
  messages: { label: "Messages", barBg: "#7c8df6", barText: "#fff", marker: "#6366f1", textColor: "#1e40af" },
  other:    { label: "Other",    barBg: "#d1d5db", barText: "#fff", marker: "#9ca3af", textColor: "#374151" },
};

// Diff 三色 — 增/删/改
const DIFF_COLOR: Record<DiffKind, string> = {
  kept:     "#e5e7eb",
  added:    "#bbf7d0",  // 绿
  removed:  "#fecaca",  // 红
  modified: "#fde68a",  // 黄
};
const DIFF_TEXT_COLOR: Record<DiffKind, string> = {
  kept:     "#6b7280",
  added:    "#15803d",
  removed:  "#b91c1c",
  modified: "#92400e",
};
const DIFF_PREFIX: Record<DiffKind, string> = {
  kept: "", added: "+", removed: "−", modified: "~",
};
const BIN_COLOR = "#f1f5f9";

// ─── 工具 ─────────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}
function fmtDelta(n: number): string {
  if (Math.abs(n) < 1) return "±0";
  const sign = n > 0 ? "+" : "−";
  return sign + fmtK(Math.abs(n));
}
function shortSlot(s: string): string {
  return s.replace("messages.", "msg.").replace("system.", "sys.").replace("tools.builtin.", "tool.");
}

// ─── 主入口：DiffPanel ───────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  callId: number;
  prevCallId?: number | null;
}

export function DiffPanel({ sessionId, callId, prevCallId }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<DiffTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiV2.diffTree(sessionId, callId)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, callId]);

  if (loading) {
    return <div style={{ padding: "32px 0", textAlign: "center", fontSize: 11, color: "#9ca3af" }}>{t("diff.loading")}</div>;
  }
  if (error) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "#b91c1c", background: "#fef2f2", borderRadius: 6, border: "1px solid #fecaca" }}>
        {t("diff.loadFailed", { error })}
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "#9ca3af", background: "#fafafa", borderRadius: 6, border: "1px dashed #e5e7eb" }}>
        {t("diff.noData")}
      </div>
    );
  }

  const effectivePrevId = data.prevCallId ?? prevCallId ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* 顶部 meta 行：仅 prev call 引用 + summary chips */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        fontSize: 11, color: "#6b7280",
        padding: "2px 2px",
      }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em" }}>
          {t("diff.vsCall")}{" "}
          <strong style={{ color: "#374151" }}>
            {effectivePrevId != null ? `#${effectivePrevId}` : "—"}
          </strong>
        </span>
        {data.summary && (
          <>
            {data.summary.addedCount > 0 && (
              <span style={{ color: DIFF_TEXT_COLOR.added }}>+{data.summary.addedCount}</span>
            )}
            {data.summary.removedCount > 0 && (
              <span style={{ color: DIFF_TEXT_COLOR.removed }}>−{data.summary.removedCount}</span>
            )}
            {data.summary.modifiedCount > 0 && (
              <span style={{ color: DIFF_TEXT_COLOR.modified }}>~{data.summary.modifiedCount}</span>
            )}
            <span style={{ color: "#9ca3af" }}>· {data.summary.keptCount} {t("diff.unchanged")}</span>
            <span style={{
              marginLeft: "auto",
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              fontWeight: 700,
              color: data.summary.netCharDelta > 0 ? DIFF_TEXT_COLOR.added
                   : data.summary.netCharDelta < 0 ? DIFF_TEXT_COLOR.removed : "#6b7280",
            }}>
              {fmtDelta(data.summary.netCharDelta)}
            </span>
          </>
        )}
      </div>

      {data.error && (
        <div style={{
          padding: "8px 12px", fontSize: 11, color: "#92400e",
          background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6,
        }}>
          ⚠ {data.error}
        </div>
      )}

      <DiffView sections={data.sections} summary={data.summary} />
    </div>
  );
}

// ─── DiffView：核心渲染 ──────────────────────────────────────────────────────

interface DiffViewProps {
  sections: DiffSection[];
  summary?: DiffTreeResult["summary"];
}

export function DiffView({ sections, summary }: DiffViewProps) {
  const { t } = useTranslation();
  const [selectedSection, setSelectedSection] = useState<DiffSectionId | null>(null);
  const [selectedLeafId, setSelectedLeafId] = useState<string | null>(null);
  const [expandedBins, setExpandedBins] = useState<Set<string>>(new Set());

  const grandNewTotal = sections.reduce((s, x) => s + x.newTotal, 0);
  const hasAnyChange =
    summary
      ? summary.addedCount + summary.removedCount + summary.modifiedCount > 0
      : sections.some((s) => s.delta !== 0 || s.counts.added + s.counts.removed + s.counts.modified > 0);

  const handleSectionSelect = (id: DiffSectionId) => {
    setSelectedSection((cur) => (cur === id ? null : id));
    setSelectedLeafId(null);
    setExpandedBins(new Set());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <SectionDiffBar
        sections={sections}
        grandTotal={grandNewTotal}
        selectedSection={selectedSection}
        onSelect={handleSectionSelect}
      />

      {!hasAnyChange ? (
        <div style={{
          padding: "20px 16px", textAlign: "center",
          background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6,
          color: DIFF_TEXT_COLOR.added, fontSize: 12,
        }}>
          {t("diff.noChanges")}
        </div>
      ) : selectedSection === null ? (
        <SectionDiffTable
          sections={sections}
          grandTotal={grandNewTotal}
          onSelect={handleSectionSelect}
        />
      ) : (
        <SectionDrillIn
          section={sections.find((s) => s.id === selectedSection)!}
          selectedLeafId={selectedLeafId}
          onSelectLeaf={setSelectedLeafId}
          expandedBins={expandedBins}
          setExpandedBins={setExpandedBins}
        />
      )}
    </div>
  );
}

// ─── Layer 1: SectionBar ─────────────────────────────────────────────────────

function SectionDiffBar({
  sections, grandTotal, selectedSection, onSelect,
}: {
  sections: DiffSection[];
  grandTotal: number;
  selectedSection: DiffSectionId | null;
  onSelect: (s: DiffSectionId) => void;
}) {
  if (grandTotal === 0) return null;
  return (
    <div style={{ display: "flex", gap: 4, height: 44 }}>
      {sections.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = s.newTotal / grandTotal;
        const isSel = selectedSection === s.id;
        const dimmed = selectedSection !== null && !isSel;
        const hasChange = s.delta !== 0 || s.counts.added + s.counts.removed + s.counts.modified > 0;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            title={`${meta.label}: ${fmtK(s.newTotal)} chars · Δ ${fmtDelta(s.delta)}`}
            style={{
              flex: Math.max(pct, 0.05), minWidth: 64,
              background: meta.barBg,
              opacity: dimmed ? 0.32 : 1,
              border: "none",
              borderRadius: 6,
              padding: "6px 12px",
              cursor: "pointer",
              textAlign: "left",
              color: meta.barText,
              display: "flex", flexDirection: "column", justifyContent: "center",
              overflow: "hidden",
              transition: "opacity 0.15s",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta.label}</div>
            <div style={{ fontSize: 10, fontWeight: 500, opacity: 0.95, lineHeight: 1.2, display: "flex", gap: 6, alignItems: "center" }}>
              <span>~{fmtK(s.newTotal)}</span>
              {hasChange && <DeltaPill delta={s.delta} small inverse />}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Layer 1: SectionTable ───────────────────────────────────────────────────

function SectionDiffTable({
  sections, grandTotal, onSelect,
}: {
  sections: DiffSection[];
  grandTotal: number;
  onSelect: (id: DiffSectionId) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {sections.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = grandTotal > 0 ? (s.newTotal / grandTotal) * 100 : 0;
        const changeTotal = s.counts.added + s.counts.removed + s.counts.modified;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            style={{
              display: "flex", alignItems: "center", gap: 14,
              padding: "10px 8px",
              background: "transparent",
              border: "none", borderRadius: 4,
              cursor: "pointer", textAlign: "left",
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#f9fafb"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, background: meta.marker, flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: meta.textColor, minWidth: 90 }}>{meta.label}</span>
            <span style={{ fontSize: 11, color: "#374151", minWidth: 60 }}>~{fmtK(s.newTotal)}</span>
            <span style={{ fontSize: 11, color: "#9ca3af", minWidth: 44 }}>{pct.toFixed(1)}%</span>
            {s.delta !== 0
              ? <DeltaPill delta={s.delta} />
              : changeTotal === 0
                ? <span style={{ fontSize: 10, color: "#9ca3af", fontStyle: "italic" }}>±0</span>
                : <DeltaPill delta={0} label="±0" />}
            <span style={{ flex: 1, display: "flex", gap: 8, fontSize: 10 }}>
              {s.counts.added > 0 && <CountChip count={s.counts.added} kind="added" />}
              {s.counts.removed > 0 && <CountChip count={s.counts.removed} kind="removed" />}
              {s.counts.modified > 0 && <CountChip count={s.counts.modified} kind="modified" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CountChip({ count, kind }: { count: number; kind: DiffKind }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      padding: "1px 6px", borderRadius: 3,
      background: DIFF_COLOR[kind], color: DIFF_TEXT_COLOR[kind],
      fontWeight: 600, fontSize: 10,
    }}>
      <span>{DIFF_PREFIX[kind] || "·"}</span>
      <span>{count}</span>
    </span>
  );
}

function DeltaPill({ delta, small, inverse, label }: {
  delta: number; small?: boolean; inverse?: boolean; label?: string;
}) {
  const isZero = Math.abs(delta) < 1;
  const text = label ?? fmtDelta(delta);
  const color = isZero ? "#6b7280" : delta > 0 ? DIFF_TEXT_COLOR.added : DIFF_TEXT_COLOR.removed;
  const bg = isZero ? "rgba(107,114,128,0.12)" : delta > 0 ? "rgba(34,197,94,0.18)" : "rgba(220,38,38,0.18)";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: small ? "0 5px" : "1px 7px",
      borderRadius: 3,
      background: inverse ? "rgba(255,255,255,0.25)" : bg,
      color: inverse ? "#fff" : color,
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
      fontSize: small ? 9 : 10, fontWeight: 700, letterSpacing: "0.01em",
    }}>{text}</span>
  );
}

// ─── Layer 2: SectionDrillIn ─────────────────────────────────────────────────

interface UnchangedBin { kind: "bin"; id: string; leaves: DiffLeaf[]; totalSize: number; }
interface SingleLeaf  { kind: "single"; leaf: DiffLeaf; }
type MergedItem = UnchangedBin | SingleLeaf;

function mergeBins(leaves: DiffLeaf[]): MergedItem[] {
  const out: MergedItem[] = [];
  let pending: DiffLeaf[] = [];
  let binCounter = 0;
  const flush = () => {
    if (pending.length === 0) return;
    out.push({ kind: "bin", id: `bin-${binCounter++}`, leaves: pending, totalSize: pending.reduce((s, l) => s + l.newCharCount, 0) });
    pending = [];
  };
  for (const l of leaves) {
    if (l.kind === "kept") pending.push(l);
    else { flush(); out.push({ kind: "single", leaf: l }); }
  }
  flush();
  return out;
}

interface DiffStripItem { id: string; size: number; merged: MergedItem; }

function toStripItems(merged: MergedItem[], expandedBins: Set<string>): DiffStripItem[] {
  const items: DiffStripItem[] = [];
  for (const m of merged) {
    if (m.kind === "bin") {
      if (expandedBins.has(m.id)) {
        for (const l of m.leaves) items.push({ id: l.id, size: Math.max(l.newCharCount, 1), merged: { kind: "single", leaf: l } });
      } else {
        items.push({ id: m.id, size: Math.max(m.totalSize, 1), merged: m });
      }
    } else {
      const l = m.leaf;
      const size = l.kind === "removed" ? (l.oldCharCount ?? 100) : l.newCharCount;
      items.push({ id: l.id, size: Math.max(size, 1), merged: m });
    }
  }
  return items;
}

function SectionDrillIn({
  section, selectedLeafId, onSelectLeaf,
  expandedBins, setExpandedBins,
}: {
  section: DiffSection;
  selectedLeafId: string | null;
  onSelectLeaf: (id: string | null) => void;
  expandedBins: Set<string>;
  setExpandedBins: (s: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const merged = useMemo(() => mergeBins(section.leaves), [section.leaves]);
  const items = useMemo(() => toStripItems(merged, expandedBins), [merged, expandedBins]);
  const [hoveredItem, setHoveredItem] = useState<DiffStripItem | null>(null);

  const handleStripSelect = (it: DiffStripItem) => {
    if (it.merged.kind === "bin") {
      const next = new Set(expandedBins);
      if (next.has(it.id)) next.delete(it.id); else next.add(it.id);
      setExpandedBins(next);
      onSelectLeaf(null);
    } else {
      onSelectLeaf(selectedLeafId === it.id ? null : it.id);
    }
  };

  const selectedLeaf = useMemo(() => {
    if (!selectedLeafId) return null;
    for (const m of merged) {
      if (m.kind === "single" && m.leaf.id === selectedLeafId) return m.leaf;
      if (m.kind === "bin") {
        const f = m.leaves.find((l) => l.id === selectedLeafId);
        if (f) return f;
      }
    }
    return null;
  }, [merged, selectedLeafId]);

  return (
    <>
      {/* Hover readout — 顶部固定行 */}
      <div style={{
        height: 20, display: "flex", alignItems: "center", gap: 8,
        padding: "0 2px", fontSize: 10,
        whiteSpace: "nowrap", overflow: "hidden",
        color: hoveredItem ? "#111827" : "#9ca3af",
        transition: "color 0.15s",
      }}>
        <HoverReadout item={hoveredItem} idleText={t("diff.hoverHint")} />
      </div>

      {/* LeafStrip */}
      <div style={{ minWidth: 0, maxWidth: "100%", overflowX: "hidden" }}>
        <FisheyeStrip<DiffStripItem>
          items={items}
          getColor={(it) => {
            if (it.merged.kind === "bin") return BIN_COLOR;
            return DIFF_COLOR[it.merged.leaf.kind];
          }}
          getLabel={(it) => {
            // 段内 label：只显示前缀 + slot，不带 delta 数字（数字在 hover readout / detail 中显示）
            if (it.merged.kind === "bin") {
              return `${it.merged.leaves.length} ${t("diff.unchanged")}`;
            }
            const l = it.merged.leaf;
            const slot = shortSlot(l.slotType);
            const prefix = DIFF_PREFIX[l.kind];
            return prefix ? `${prefix} ${slot}` : slot;
          }}
          getTitle={(it) => {
            if (it.merged.kind === "bin") return `${it.merged.leaves.length} ${t("diff.unchanged")} · ${fmtK(it.merged.totalSize)} chars · ${t("diff.clickToExpand")}`;
            const l = it.merged.leaf;
            const slot = shortSlot(l.slotType);
            if (l.kind === "removed")  return `− ${slot} · ${fmtK(l.oldCharCount ?? 0)} chars`;
            if (l.kind === "modified") return `~ ${slot} · ${fmtK(l.oldCharCount ?? 0)} → ${fmtK(l.newCharCount)} (${fmtDelta(l.newCharCount - (l.oldCharCount ?? 0))})`;
            if (l.kind === "added")    return `+ ${slot} · ${fmtK(l.newCharCount)} chars`;
            return slot;
          }}
          height={36}
          background="transparent"
          autoConfig={{ minCount: 8, clickableThresholdPx: 16 }}
          selectedId={selectedLeafId}
          onSelect={handleStripSelect}
          onHover={(it) => setHoveredItem(it ?? null)}
        />
      </div>

      {/* SelectedDetail — 扁平展示，无 card 外框 */}
      {selectedLeaf && <SelectedDiffDetail leaf={selectedLeaf} />}
    </>
  );
}

function HoverReadout({ item, idleText }: { item: DiffStripItem | null; idleText: string }) {
  const { t } = useTranslation();
  if (!item) {
    return <span style={{ fontStyle: "italic", letterSpacing: "0.02em" }}>{idleText}</span>;
  }
  if (item.merged.kind === "bin") {
    const b = item.merged;
    return (
      <>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: BIN_COLOR, border: "1px solid #d1d5db", flexShrink: 0 }} />
        <span style={{ fontWeight: 600, color: "#374151" }}>{t("diff.binDescription", { count: b.leaves.length })}</span>
        <span style={{ color: "#6b7280" }}>{t("diff.totalChars", { count: fmtK(b.totalSize) })}</span>
        <span style={{ color: "#9ca3af" }}>· {t("diff.clickToExpand")}</span>
      </>
    );
  }
  const l = item.merged.leaf;
  const color = DIFF_TEXT_COLOR[l.kind];
  const fill = DIFF_COLOR[l.kind];
  const kindLabel = t(`diff.${l.kind}` as const);
  return (
    <>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: fill, flexShrink: 0 }} />
      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontWeight: 600, color: "#111827" }}>{shortSlot(l.slotType)}</span>
      <span style={{ fontSize: 10, fontWeight: 700, color, letterSpacing: "0.04em", textTransform: "uppercase" }}>{kindLabel}</span>
      {l.kind === "modified" && (
        <span style={{ color: "#6b7280" }}>
          {fmtK(l.oldCharCount ?? 0)} → {fmtK(l.newCharCount)}{" "}
          <strong style={{ color, fontFamily: "ui-monospace, monospace" }}>({fmtDelta(l.newCharCount - (l.oldCharCount ?? 0))})</strong>
        </span>
      )}
      {l.kind === "added" && <strong style={{ color, fontFamily: "ui-monospace, monospace" }}>+{fmtK(l.newCharCount)}</strong>}
      {l.kind === "removed" && <strong style={{ color, fontFamily: "ui-monospace, monospace" }}>−{fmtK(l.oldCharCount ?? 0)}</strong>}
    </>
  );
}

// ─── SelectedDiffDetail — 扁平展示，无 card 外框 ────────────────────────────

function SelectedDiffDetail({ leaf }: { leaf: DiffLeaf }) {
  const { t } = useTranslation();
  const color = DIFF_TEXT_COLOR[leaf.kind];
  const kindLabel = t(`diff.${leaf.kind}` as const);

  return (
    <div style={{ paddingTop: 6 }}>
      {/* 简洁标题行 */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "4px 2px",
        fontSize: 11,
      }}>
        <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontWeight: 700, color: "#111827" }}>
          {DIFF_PREFIX[leaf.kind]} {shortSlot(leaf.slotType)}
        </span>
        <span style={{ fontSize: 9, fontWeight: 700, color, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          {kindLabel}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "#6b7280" }}>
          {leaf.kind === "removed"
            ? `${fmtK(leaf.oldCharCount ?? 0)} chars`
            : leaf.kind === "modified"
              ? `${fmtK(leaf.oldCharCount ?? 0)} → ${fmtK(leaf.newCharCount)} (${fmtDelta(leaf.newCharCount - (leaf.oldCharCount ?? 0))})`
              : `${fmtK(leaf.newCharCount)} chars`}
        </span>
      </div>

      {/* 内容（无 card 外框） */}
      {leaf.kind === "modified" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <DetailBlock title="BEFORE" content={leaf.oldRawText ?? leaf.preview} muted />
          <DetailBlock title="AFTER" content={leaf.rawText ?? leaf.preview} />
        </div>
      ) : leaf.kind === "removed" ? (
        <DetailBlock title="REMOVED" content={leaf.oldRawText ?? leaf.preview} muted />
      ) : leaf.kind === "added" ? (
        <DetailBlock title="ADDED" content={leaf.rawText ?? leaf.preview} />
      ) : (
        <DetailBlock title="CONTENT" content={leaf.rawText ?? leaf.preview} muted />
      )}
    </div>
  );
}

function DetailBlock({ title, content, muted }: { title: string; content: string; muted?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600, letterSpacing: "0.05em", marginBottom: 3 }}>{title}</div>
      <pre style={{
        margin: 0, fontSize: 11, color: muted ? "#6b7280" : "#374151",
        lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word",
        background: muted ? "#f9fafb" : "#fafafa",
        padding: "8px 10px", maxHeight: 240, overflowY: "auto",
        borderRadius: 4,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
      }}>{content}</pre>
    </div>
  );
}
