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
import { CodeBlock } from "./shared/CodeBlock";
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

// 与 AttributionTreePanel 同色（淡蓝 / 蓝 / 紫）
const SECTION_META: Record<DiffSectionId, SectionMeta> = {
  system:   { label: "System",   barBg: "#bfdbfe", barText: "#1e3a8a", marker: "#3b82f6", textColor: "#1e40af" },
  tools:    { label: "Tools",    barBg: "#3b82f6", barText: "#fff",    marker: "#2563eb", textColor: "#1e40af" },
  messages: { label: "Messages", barBg: "#a78bfa", barText: "#fff",    marker: "#8b5cf6", textColor: "#5b21b6" },
  other:    { label: "Other",    barBg: "#d1d5db", barText: "#374151", marker: "#9ca3af", textColor: "#374151" },
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
  const sum = data.summary;
  const changedSegments = sum ? sum.addedCount + sum.removedCount + sum.modifiedCount : 0;
  const hasAnyChange = changedSegments > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* 顶部 meta 行：紧凑 git 风格 — 无变化压缩成一句 */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        fontSize: 11, color: "#6b7280",
        padding: "2px 2px",
      }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", letterSpacing: "0.05em" }}>
          {t("diff.vsCall")}{" "}
          <strong style={{ color: "#374151" }}>
            {effectivePrevId != null ? `#${effectivePrevId}` : "—"}
          </strong>
        </span>
        {sum && (
          hasAnyChange ? (
            <>
              <span style={{ color: "#9ca3af" }}>·</span>
              <span style={{ color: "#374151", fontWeight: 600 }}>
                {t("diff.segmentsChanged", { count: changedSegments })}
              </span>
              {sum.insertedChars > 0 && (
                <span style={{
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  color: DIFF_TEXT_COLOR.added, fontWeight: 700,
                }}>+{fmtK(sum.insertedChars)}</span>
              )}
              {sum.deletedChars > 0 && (
                <span style={{
                  fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  color: DIFF_TEXT_COLOR.removed, fontWeight: 700,
                }}>−{fmtK(sum.deletedChars)}</span>
              )}
              <span style={{ color: "#9ca3af" }}>{t("diff.charsLabel")}</span>
            </>
          ) : (
            <>
              <span style={{ color: "#9ca3af" }}>·</span>
              <span style={{ color: DIFF_TEXT_COLOR.added, fontWeight: 600 }}>
                ✓ {t("diff.noChangesShort")}
              </span>
            </>
          )
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
  const [hoveredId, setHoveredId] = useState<DiffSectionId | null>(null);
  if (grandTotal === 0) return null;
  const hasSelection = selectedSection !== null;
  return (
    <div
      style={{ display: "flex", gap: 4, height: 44 }}
      onMouseLeave={() => setHoveredId(null)}
    >
      {sections.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = s.newTotal / grandTotal;
        const isSel = selectedSection === s.id;
        const isHov = hoveredId === s.id;
        // 三档强度（与 attribution 同规则）
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
        const hasChange = s.delta !== 0 || s.counts.added + s.counts.removed + s.counts.modified > 0;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            onMouseEnter={() => setHoveredId(s.id)}
            title={`${meta.label} · ${fmtK(s.newTotal)} chars${hasChange ? ` · Δ ${fmtDelta(s.delta)}` : ""}`}
            style={{
              flex: Math.max(pct, 0.05), minWidth: 64,
              background: meta.barBg,
              opacity,
              border: "none",
              outline, outlineOffset: -2,
              borderRadius: 6,
              padding: "8px 14px",
              cursor: "pointer",
              textAlign: "left",
              color: meta.barText,
              display: "flex", alignItems: "center", gap: 8,
              overflow: "hidden",
              transition: "opacity 0.15s, outline-color 0.15s",
            }}
          >
            <div style={{ fontSize: 13, fontWeight, lineHeight: 1.25, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>
              {meta.label}
            </div>
            {hasChange && s.delta !== 0 && (
              <span style={{
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontSize: 11, fontWeight: 700,
                padding: "1px 6px", borderRadius: 3,
                background: "rgba(255,255,255,0.28)",
                color: meta.barText,
                flexShrink: 0,
              }}>{fmtDelta(s.delta)}</span>
            )}
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
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {sections.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = grandTotal > 0 ? (s.newTotal / grandTotal) * 100 : 0;
        const changeTotal = s.counts.added + s.counts.removed + s.counts.modified;
        const sectionChanged = changeTotal > 0 || s.delta !== 0;
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
            <span style={{ fontSize: 11, color: "#374151", minWidth: 60 }}>{fmtK(s.newTotal)}</span>
            <span style={{ fontSize: 11, color: "#9ca3af", minWidth: 44 }}>{pct.toFixed(1)}%</span>
            {sectionChanged ? (
              <>
                {s.delta !== 0 && <DeltaPill delta={s.delta} />}
                <span style={{ flex: 1, display: "flex", gap: 8, fontSize: 10 }}>
                  {s.counts.added > 0 && <CountChip count={s.counts.added} kind="added" />}
                  {s.counts.removed > 0 && <CountChip count={s.counts.removed} kind="removed" />}
                  {s.counts.modified > 0 && <CountChip count={s.counts.modified} kind="modified" />}
                </span>
              </>
            ) : (
              <span style={{ flex: 1, fontSize: 10, color: "#9ca3af", fontStyle: "italic" }}>
                {t("diff.noChangesShort")}
              </span>
            )}
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
      {/* LeafStrip — hover/select 反馈完全交给 FisheyeStrip 内部三档强度 */}
      <div style={{ minWidth: 0, maxWidth: "100%", overflowX: "hidden" }}>
        <FisheyeStrip<DiffStripItem>
          items={items}
          getColor={(it) => {
            if (it.merged.kind === "bin") return BIN_COLOR;
            return DIFF_COLOR[it.merged.leaf.kind];
          }}
          getLabel={(it) => {
            // 段内 label：只显示前缀 + slot，不带 delta 数字（数字在 detail 中显示）
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
        />
      </div>

      {/* SelectedDetail — 扁平展示，无 card 外框 */}
      {selectedLeaf && <SelectedDiffDetail leaf={selectedLeaf} />}
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
      <CodeBlock variant="preview" mono muted={muted} maxHeight={240}>{content}</CodeBlock>
    </div>
  );
}
