// CachePanel — 单次 call 的 cache_control 分层可视化。
//
// 设计原则：
//   只有 4 行 bar：L1 / L2 / L3 三条紧凑的缓存累积条 + AttributionTreeLensPanel
//   自己的 LensSectionBar（这第 4 条就是"主行"）。
//
//   L1/L2/L3 通过 `prelude` 注入到 AttributionTreeLensPanel 内部，紧贴在主
//   LensSectionBar 的上方 —— 同一容器、同一 flex 配置、同一 gap，所以**section
//   X 位置在 4 条 bar 上像素对齐**，颜色/长度/分割自然一致。
//
//   底部 attribution 选中某 leaf → 通过 onLeafSelect 回调上来 →
//   在上方 3 条 cache bar 上画半透明高亮带。

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiV2 } from "./api";
import { AttributionTreeLensPanel } from "./AttributionTreeLensPanel";
import type { DiffSection, DiffSectionId, DiffTreeResult, PinInfo } from "./diff-tree-types";

// ─── 配色 — 与 AttributionTreePanel.SECTION_META 完全一致 ────────────────────

const SECTION_META: Record<DiffSectionId, { label: string; bg: string; text: string; marker: string }> = {
  system:   { label: "System",   bg: "#bfdbfe", text: "#1e3a8a", marker: "#3b82f6" },
  tools:    { label: "Tools",    bg: "#3b82f6", text: "#ffffff", marker: "#2563eb" },
  messages: { label: "Messages", bg: "#a78bfa", text: "#ffffff", marker: "#8b5cf6" },
  other:    { label: "Other",    bg: "#d1d5db", text: "#374151", marker: "#9ca3af" },
};

// ─── 工具 ────────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

function shortJsonPath(path: string | undefined): string {
  if (!path) return "?";
  let s = path.replace(/^reqBody\./, "");
  s = s.replace(/^system\[/, "sys[");
  s = s.replace(/^messages\[/, "msg[");
  s = s.replace(/\.content\[/g, "[");
  return s;
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  agentFileId?: string;
  callId: number;
}

export function CachePanel({ sessionId, agentFileId, callId }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<DiffTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedNodeId(null);
    const fetcher = agentFileId
      ? apiV2.subAgentDiffTree(sessionId, agentFileId, callId)
      : apiV2.diffTree(sessionId, callId);
    fetcher
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, agentFileId, callId]);

  // 即使 diff-tree 还没回，也先把 attribution panel 渲染出来（不至于黑屏）
  const sections = data?.sections ?? [];
  const allPins: PinInfo[] = useMemo(
    () =>
      sections
        .flatMap((s) => s.pins ?? [])
        .filter((p) => typeof p?.cumulativePrefixChars === "number")
        .sort((a, b) => a.cumulativePrefixChars - b.cumulativePrefixChars),
    [sections],
  );
  const grandTotal = useMemo(() => sections.reduce((sum, s) => sum + s.newTotal, 0), [sections]);
  const sectionRanges = useMemo(() => computeSectionRanges(sections), [sections]);
  const leafPositions = useMemo(() => computeLeafPositions(sections), [sections]);
  const selectedPos = selectedNodeId ? leafPositions.get(selectedNodeId) ?? null : null;

  const prelude = data && allPins.length > 0 ? (
    <CacheLayersStrip
      pins={allPins}
      grandTotal={grandTotal}
      sectionRanges={sectionRanges}
      selectedPos={selectedPos}
    />
  ) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {/* 顶部 meta 行：层数 / 总字符 / TTL 概览 */}
      <CacheHeader allPins={allPins} grandTotal={grandTotal} loading={loading} error={error} t={t} />

      {/* 主体：AttributionTreeLensPanel 直接嵌入，L1/L2/L3 作为 prelude 注入 */}
      <AttributionTreeLensPanel
        sessionId={sessionId}
        agentFileId={agentFileId}
        callId={callId}
        prevCallId={null}
        hideDiff
        prelude={prelude}
        onLeafSelect={setSelectedNodeId}
      />
    </div>
  );
}

// ─── CacheHeader ─────────────────────────────────────────────────────────────

function CacheHeader({
  allPins, grandTotal, loading, error, t,
}: {
  allPins: PinInfo[];
  grandTotal: number;
  loading: boolean;
  error: string | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  if (error) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "#b91c1c", background: "#fef2f2", borderRadius: 6, border: "1px solid #fecaca" }}>
        {t("cache.loadFailed", { error })}
      </div>
    );
  }
  if (loading) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "#9ca3af", background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 6 }}>
        {t("cache.loading")}
      </div>
    );
  }
  if (allPins.length === 0) {
    return (
      <div style={{ padding: "8px 12px", fontSize: 11, color: "#9ca3af", background: "#fafafa", borderRadius: 6, border: "1px dashed #e5e7eb" }}>
        {t("cache.noPins")}
      </div>
    );
  }
  const ttlBreakdown = allPins.reduce<Record<string, number>>((acc, p) => {
    acc[p.ttl] = (acc[p.ttl] ?? 0) + 1;
    return acc;
  }, {});
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      padding: "8px 12px",
      background: "#fafafa",
      border: "1px solid #e5e7eb",
      borderRadius: 6,
      fontSize: 11,
    }}>
      <span style={{ fontWeight: 700, color: "#111827" }}>
        {t("cache.totalLayers", { count: allPins.length })}
      </span>
      <span style={{ color: "#9ca3af" }}>·</span>
      <span style={{ color: "#374151" }}>
        {t("cache.totalChars", { chars: grandTotal.toLocaleString() })}
      </span>
      <span style={{ color: "#9ca3af" }}>·</span>
      <span style={{ color: "#374151" }}>
        TTL: {Object.entries(ttlBreakdown).map(([ttl, n]) => `${n}×${ttl}`).join(", ")}
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 10, color: "#6b7280", fontStyle: "italic" }}>
        {t("cache.headerNote")}
      </span>
    </div>
  );
}

// ─── CacheLayersStrip ────────────────────────────────────────────────────────
//
// L1 / L2 / L3 三条紧凑 bar，作为 AttributionTreeLensPanel 的 prelude 渲染。
// 每条 bar 的 flex 配置和下方主 LensSectionBar 完全一致（gap: 4），所以 section
// 边界在 4 条 bar 上对齐。
//
// 行布局：左侧 layer 徽标 → 中间 bar（占据剩余空间，flex:1）→ 右侧 meta 文字。
// 注意：右侧 meta 也参与 attribution 主行原本的"右侧空间"是空（LensSectionBar
// 是纯 flex），所以这里加 meta 不会影响主 bar 的对齐 —— 因为 4 条 bar 的中间
// `<div flex:1>` 容器是同宽的，只要 bar 在这个容器里都用 flex 平分就对齐。

function CacheLayersStrip({
  pins, grandTotal, sectionRanges, selectedPos,
}: {
  pins: PinInfo[];
  grandTotal: number;
  sectionRanges: SectionRange[];
  selectedPos: LeafPos | null;
}) {
  if (grandTotal === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 4 }}>
      {pins.map((pin, idx) => (
        <CacheLayerBar
          key={`L${idx + 1}`}
          idx={idx}
          pin={pin}
          grandTotal={grandTotal}
          sectionRanges={sectionRanges}
          selectedPos={selectedPos}
        />
      ))}
    </div>
  );
}

function CacheLayerBar({
  idx, pin, grandTotal, sectionRanges, selectedPos,
}: {
  idx: number;
  pin: PinInfo;
  grandTotal: number;
  sectionRanges: SectionRange[];
  selectedPos: LeafPos | null;
}) {
  const cumChars = pin.cumulativePrefixChars;
  const sectionBreakdown = sliceSections(sectionRanges, 0, cumChars);
  const uncovered = grandTotal - cumChars;

  // 选中 leaf 的高亮范围：与本 bar 覆盖区间求交集
  let highlight: { leftPct: number; widthPct: number } | null = null;
  if (selectedPos && grandTotal > 0) {
    const overlapStart = Math.max(0, selectedPos.start);
    const overlapEnd = Math.min(cumChars, selectedPos.end);
    if (overlapEnd > overlapStart) {
      highlight = {
        leftPct: (overlapStart / grandTotal) * 100,
        widthPct: ((overlapEnd - overlapStart) / grandTotal) * 100,
      };
    }
  }

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      fontSize: 10,
    }}>
      {/* 左 badge */}
      <span style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        minWidth: 30, height: 16, padding: "0 6px",
        background: "#fef2f2",
        color: "#dc2626",
        border: "1px solid #fecaca",
        borderRadius: 8,
        fontWeight: 700, letterSpacing: "0.04em",
        flexShrink: 0,
      }}>
        L{idx + 1}
      </span>

      {/* 中间 bar：与下方 LensSectionBar 同款 flex 配置（gap:4） */}
      <div style={{
        flex: 1, minWidth: 0,
        position: "relative",
        height: 14,
        display: "flex", gap: 4,
        background: "transparent",
      }}>
        {sectionBreakdown.map((b, i) => {
          const meta = SECTION_META[b.sectionId];
          return (
            <div
              key={`sb-${i}`}
              title={`${meta.label} · ${fmtK(b.chars)} chars`}
              style={{
                flex: b.chars,
                background: meta.bg,
                borderRadius: 2,
              }}
            />
          );
        })}
        {uncovered > 0 && (
          <div style={{ flex: uncovered, background: "transparent" }} />
        )}
        {/* 半透明高亮带 */}
        {highlight && (
          <div style={{
            position: "absolute",
            left: `${highlight.leftPct}%`,
            width: `${highlight.widthPct}%`,
            top: 0, bottom: 0,
            background: "rgba(17, 24, 39, 0.28)",
            borderRadius: 2,
            pointerEvents: "none",
          }} />
        )}
      </div>

      {/* 右 meta */}
      <span style={{
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        color: "#374151", minWidth: 48, textAlign: "right", flexShrink: 0,
      }}>
        {fmtK(cumChars)}
      </span>
      <span style={{
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        color: "#dc2626", minWidth: 110, textAlign: "left", flexShrink: 0,
      }}>
        {shortJsonPath(pin.jsonPath)} · {pin.ttl}
      </span>
    </div>
  );
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

interface SectionRange {
  sectionId: DiffSectionId;
  start: number;
  end: number;
}

interface LeafPos { start: number; end: number; }

function computeSectionRanges(sections: DiffSection[]): SectionRange[] {
  const out: SectionRange[] = [];
  let cum = 0;
  for (const s of sections) {
    out.push({ sectionId: s.id, start: cum, end: cum + s.newTotal });
    cum += s.newTotal;
  }
  return out;
}

function sliceSections(
  ranges: SectionRange[],
  from: number,
  to: number,
): Array<{ sectionId: DiffSectionId; chars: number }> {
  const out: Array<{ sectionId: DiffSectionId; chars: number }> = [];
  for (const r of ranges) {
    const overlapStart = Math.max(r.start, from);
    const overlapEnd = Math.min(r.end, to);
    const chars = Math.max(0, overlapEnd - overlapStart);
    if (chars > 0) out.push({ sectionId: r.sectionId, chars });
  }
  return out;
}

/** 按 cache prefix 顺序展平 sections.leaves，给每个 leaf 算 prefix 起止位置。 */
function computeLeafPositions(sections: DiffSection[]): Map<string, LeafPos> {
  const map = new Map<string, LeafPos>();
  let cum = 0;
  for (const sec of sections) {
    for (const leaf of sec.leaves) {
      if (leaf.kind === "removed") continue;
      const start = cum;
      const end = cum + leaf.newCharCount;
      map.set(leaf.id, { start, end });
      cum = end;
    }
  }
  return map;
}
