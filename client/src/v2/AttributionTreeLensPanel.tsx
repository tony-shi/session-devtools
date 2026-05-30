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
import { useTranslation } from "react-i18next";
import { apiV2 } from "./api";
import { useAttributionGraph } from "./attribution-graph-context";
import type { AttributionTreeResult, VersionDiag } from "./attribution-tree-types";
import {
  SECTION_META,
  computeSectionStats,
  flattenLeaves,
  sectionOf,
  leafLabel,
  fmtK,
  LeafStrip,
  LeafTable,
  SelectedDetail,
  type LeafLite,
  type LeafItem,
  type SectionId,
  type SectionStat,
} from "./AttributionTreePanel";
import { FisheyeStrip } from "./fisheye-strip";
import {
  LENSES,
  getLens,
  getBucket,
  bucketStatsOf,
  type Lens,
  type BucketStat,
} from "./lens-framework";
// DiffPanel 旧入口已废弃，但其中的 SelectedDiffDetail 仍然复用（行级 inline diff）。
import type { DiffSection, DiffTreeResult, PinInfo } from "./diff-tree-types";
import { SelectedDiffDetail } from "./DiffPanel";
import {
  diffUnderlineFor,
  sectionFrame,
  intentGroupPalette,
  intentGroupI18nKey,
  INTENT_GROUP_ORDER,
  type IntentGroupId,
} from "./lens-palette";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BRAND } from "./shared/brand";

// Diff 现在是真正的 lens（在 lens-framework.ts 里定义为 diffLens），不再是
// "虚拟"的 chip 切换 + DiffPanel 替换。这套老 DIFF_LENS_ID 常量已废除。

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
              background: isActive ? BRAND.indigo50 : "transparent",
              color: isActive ? BRAND.indigo700 : "#6b7280",
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
              border: `1px solid ${isActive ? BRAND.indigo500 : "#cbd5e1"}`,
              background: isActive ? BRAND.indigo500 : "transparent",
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

// 单个 bucket pill —— 复用在分组和平铺两种渲染路径下。
function BucketPill({
  bucket, leafCount, totalChars, isActive, onClick,
}: {
  bucket: { id: string; label: string; color: string; description?: string };
  leafCount: number;
  totalChars: number;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          style={{
            display: "inline-flex", alignItems: "baseline", gap: 5,
            padding: "3px 7px", borderRadius: 4,
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
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="max-w-xs">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
            <span style={{ width: 8, height: 8, borderRadius: 1, background: bucket.color }} />
            {bucket.label}
          </div>
          {bucket.description && (
            <div style={{ opacity: 0.85, lineHeight: 1.45 }}>{bucket.description}</div>
          )}
          <div style={{ opacity: 0.65, fontSize: 10 }}>
            {leafCount} leaf · {fmtK(totalChars)} chars
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// 版本 badge：attribution 关键位置显示本次 call 的 cc_version + 与 corpus 基线的
// 匹配状态。同时承担"为什么没归因"的诊断 —— contextOk=false（billing header 未命中，
// 常见于 CC 版本格式漂移）时显示红色警告，解释 system prompt / reminder 类内容
// 为何全部落「未归因」。文案走 i18n（attribution.version.*）。
function VersionBadge({ diag }: { diag?: VersionDiag }) {
  const { t } = useTranslation();
  if (!diag) return null;
  const failed = !diag.contextOk;
  const lv = diag.matchLevel;
  // 配色：绿(exact/minor-match) / 黄(minor-mismatch/unparseable/baseline-missing) / 红(失败/major)
  let bg = "#f0fdf4", fg = "#15803d", border = "#bbf7d0", dot = "#22c55e";
  if (failed || lv === "major-mismatch") {
    bg = "#fef2f2"; fg = "#b91c1c"; border = "#fecaca"; dot = "#ef4444";
  } else if (lv === "minor-mismatch" || lv === "unparseable" || lv === "baseline-missing") {
    bg = "#fffbeb"; fg = "#b45309"; border = "#fde68a"; dot = "#f59e0b";
  }
  const label = failed
    ? t("attribution.version.contextFailed")
    : (diag.ccVersion
        ? t("attribution.version.ccLabel", { version: diag.ccVersion })
        : t("attribution.version.ccUnknown"));
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "2px 9px", borderRadius: 999,
          fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums",
          background: bg, color: fg, border: `1px solid ${border}`,
          cursor: "help", whiteSpace: "nowrap", userSelect: "none",
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: dot }} />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-sm">
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {failed ? (
            <>
              <div style={{ fontWeight: 700 }}>⚠️ {t("attribution.version.contextFailed")}</div>
              <div style={{ opacity: 0.85, lineHeight: 1.45 }}>{t("attribution.version.contextFailedHint")}</div>
              {diag.contextFailureKind && (
                <div style={{ opacity: 0.6, fontSize: 10 }}>kind: {diag.contextFailureKind}</div>
              )}
              {diag.baseline && (
                <div style={{ opacity: 0.6, fontSize: 10 }}>{t("attribution.version.baseline", { baseline: diag.baseline })}</div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontWeight: 700 }}>
                {diag.ccVersion ? t("attribution.version.ccLabel", { version: diag.ccVersion }) : t("attribution.version.ccUnknown")}
              </div>
              <div style={{ opacity: 0.85, lineHeight: 1.45 }}>{t(`attribution.version.match.${lv}`)}</div>
              {diag.baseline && (
                <div style={{ opacity: 0.6, fontSize: 10 }}>{t("attribution.version.baseline", { baseline: diag.baseline })}</div>
              )}
            </>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

// 单个 intent group 块：group label（带 i18n tooltip）+ 组内 pill 行。
// isFirst 控制左分隔线（每行第一个 group 无左边框）。
function GroupBlock({
  g, isFirst, inGroup, selectedBucketId, onSelect,
}: {
  g: IntentGroupId;
  isFirst: boolean;
  inGroup: BucketStat[];
  selectedBucketId: string | null;
  onSelect: (bucketId: string | null) => void;
}) {
  const { t } = useTranslation();
  const color = intentGroupPalette[g].color;
  const i18nBase = intentGroupI18nKey(g);
  const groupLabel = t(`${i18nBase}.label`);
  const groupDesc  = t(`${i18nBase}.description`);
  const groupTotal = inGroup.reduce((s, x) => s + x.leafCount, 0);
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 4,
      paddingLeft: isFirst ? 0 : 12,
      borderLeft: isFirst ? "none" : "1px dashed #d1d5db",
    }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 12, fontWeight: 700, color, cursor: "help", userSelect: "none",
          }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: color }} />
            {groupLabel}
            <span style={{ color: "#9ca3af", fontWeight: 500, fontSize: 11 }}>· {groupTotal}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6} className="max-w-sm">
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: color }} />
              {groupLabel}
            </div>
            <div style={{ opacity: 0.85, lineHeight: 1.45 }}>{groupDesc}</div>
            <div style={{ opacity: 0.65, fontSize: 10 }}>
              {inGroup.length} bucket{inGroup.length > 1 ? "s" : ""} · {groupTotal} leaf
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
        {inGroup.map(({ bucket, leafCount, totalChars }) => (
          <BucketPill
            key={bucket.id}
            bucket={bucket}
            leafCount={leafCount}
            totalChars={totalChars}
            isActive={selectedBucketId === bucket.id}
            onClick={() => onSelect(selectedBucketId === bucket.id ? null : bucket.id)}
          />
        ))}
      </div>
    </div>
  );
}

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

  // L0 意图分组渲染：若 lens 的 buckets 携带 groupId（当前仅 structure lens），按
  // INTENT_GROUP_ORDER 分块，同 group 内 pills 紧贴 + 顶部一个显著 group 标签；不同
  // group 间用细虚线分隔。其他 lens（cache / diff / audit）的 buckets 不带 groupId，
  // 回退到平铺渲染。group 文案走 i18n（attribution.lensGroup.<id>.label/description）。
  const hasGroups = nonEmptyStats.some(s => s.bucket.groupId !== undefined);
  if (hasGroups) {
    const byGroup = new Map<IntentGroupId, BucketStat[]>();
    for (const s of nonEmptyStats) {
      const g = (s.bucket.groupId ?? "other") as IntentGroupId;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(s);
    }
    const orderedGroups = INTENT_GROUP_ORDER.filter(g => byGroup.has(g));
    // 可控换行（替代 flex-wrap 随机断点）：≤3 个 group 排一行；≥4 个均分两行
    // （第一行 ceil(n/2)，第二行余下），保证视觉整齐、不出现孤儿换行。
    const n = orderedGroups.length;
    const rowsOfGroups: IntentGroupId[][] = n <= 3
      ? [orderedGroups]
      : [orderedGroups.slice(0, Math.ceil(n / 2)), orderedGroups.slice(Math.ceil(n / 2))];
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "2px 0" }}>
        {rowsOfGroups.map((row, ri) => (
          <div key={ri} style={{ display: "flex", alignItems: "stretch", gap: 14, flexWrap: "wrap" }}>
            {row.map((g, gi) => (
              <GroupBlock
                key={g}
                g={g}
                isFirst={gi === 0}
                inGroup={byGroup.get(g)!}
                selectedBucketId={selectedBucketId}
                onSelect={onSelect}
              />
            ))}
          </div>
        ))}
      </div>
    );
  }

  // 平铺渲染（无 group 概念的 lens：cache / diff / audit）。
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      flexWrap: "wrap",
      padding: "2px 0",
    }}>
      {nonEmptyStats.map(({ bucket, leafCount, totalChars }) => (
        <BucketPill
          key={bucket.id}
          bucket={bucket}
          leafCount={leafCount}
          totalChars={totalChars}
          isActive={selectedBucketId === bucket.id}
          onClick={() => onSelect(selectedBucketId === bucket.id ? null : bucket.id)}
        />
      ))}
    </div>
  );
}

// ─── MainSectionBar ─────────────────────────────────────────────────────────
//
// 顶部主 bar —— 不再是 "三段 section 大色块"，而是按 leaf 级 provenance 颜色
// 拼接 + 三个 section 细描边框框住（视觉传达"section 是分组容器，内容是 leaf
// 的来源"）。
//
// 状态/行为：
//   - section 框宽度 = 该 section 字符占比（flex 比例）
//   - section 框头部带 label + 字符数/段数小标
//   - section 框内部一个 FisheyeStrip，渲染该 section 的 leaves（按 provenance
//     色着色，diff lens 激活时叠 underline，bucket 过滤激活时非命中 leaf dim）
//   - 点击 section 框头部 = drill into 该 section（外层 onSelectSection 处理）
//   - 点击 leaf = onSelectLeaf

function MainSectionBar({
  sections, totalChars,
  selectedSection, onSelectSection,
  selectedLeafId, onSelectLeaf,
  leafColor, leafUnderline, isDimmed,
}: {
  sections: SectionStat[];
  totalChars: number;
  selectedSection: SectionId | null;
  onSelectSection: (s: SectionId) => void;
  selectedLeafId: string | null;
  onSelectLeaf: (id: string) => void;
  leafColor: (leaf: LeafLite) => string;
  leafUnderline?: (leaf: LeafLite) => string | null;
  isDimmed?: (leaf: LeafLite) => boolean;
}) {
  if (totalChars === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
      {sections.map((s) => {
        const meta = SECTION_META[s.id];
        const pct = s.totalChars / totalChars;
        const isSelectedSec = selectedSection === s.id;
        const items: LeafItem[] = s.leaves.map((l) => ({
          id: l.nodeId,
          size: Math.max(l.charCount, 0.001),
          leaf: l,
        }));
        // Fieldset / legend 风格：四周中性灰细描边，label 浮在顶边线上（白底
        // 小字嵌入顶边），不再有 barBg 大色块。选中态：边框变深灰。
        // 整个 section 框可点击（点框 / 点 label / 点框内空白都 = 选中 section）；
        // 点 leaf 由内部 FisheyeStrip 处理（带 stopPropagation，不会冒泡到这里），
        // 但 FisheyeStrip 的 onSelect 回调里也会顺便设 selectedSection。
        const frameColor = isSelectedSec ? sectionFrame.borderSelected : sectionFrame.border;
        // 有 section 被选中时，其他同级 section 整体 dim，凸显"当前钻入的段"。
        const dimByOtherSelected = selectedSection !== null && !isSelectedSec;
        return (
          <div
            key={s.id}
            onClick={() => onSelectSection(s.id)}
            title={`${meta.label} · ${fmtK(s.totalChars)} chars · ${s.leafCount} segments — 点击钻入`}
            style={{
              flex: pct, minWidth: 80,
              position: "relative",
              display: "flex", flexDirection: "column",
              border: `1px solid ${frameColor}`,
              borderRadius: 4,
              paddingTop: 8, // 给 label 浮出顶边留位
              background: "transparent",
              transition: "border-color 0.15s, opacity 0.15s",
              cursor: "pointer",
              opacity: dimByOtherSelected ? 0.35 : 1,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: -8, // label 竖向居中横线
                left: 10,
                background: "#fff",
                color: meta.textColor,
                padding: "0 6px",
                fontSize: 11,
                fontWeight: 700,
                display: "inline-flex", alignItems: "center", gap: 6,
                lineHeight: 1.4,
                whiteSpace: "nowrap",
                maxWidth: "calc(100% - 20px)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                pointerEvents: "none", // label 本身不接事件，点击由外层 div 统一处理
              }}
            >
              <span>{meta.label}</span>
              <span style={{
                fontSize: 9, fontWeight: 600,
                padding: "0 4px", borderRadius: 2,
                background: `${meta.marker}1a`,
                color: meta.textColor,
                whiteSpace: "nowrap",
              }}>
                {fmtK(s.totalChars)} · {s.leafCount}
              </span>
            </span>
            <div style={{ flex: 1, minWidth: 0, padding: 4 }}>
              {items.length > 0 ? (
                <FisheyeStrip<LeafItem>
                  items={items}
                  getColor={(it) => leafColor(it.leaf)}
                  getUnderlineColor={leafUnderline ? (it) => leafUnderline(it.leaf) : undefined}
                  getDimmed={isDimmed ? (it) => isDimmed(it.leaf) : undefined}
                  getLabel={(it) => leafLabel(it.leaf)}
                  getTitle={(it) => `${leafLabel(it.leaf)} · ${fmtK(it.leaf.charCount)} chars`}
                  height={MAIN_BAR_LEAF_HEIGHT}
                  background="transparent"
                  autoConfig={{ minCount: 4, clickableThresholdPx: 12 }}
                  selectedId={selectedLeafId}
                  onSelect={(it) => onSelectLeaf(it.id)}
                />
              ) : (
                <div style={{ height: MAIN_BAR_LEAF_HEIGHT, fontSize: 10, color: "#9ca3af", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  empty
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const MAIN_BAR_LEAF_HEIGHT = 34;

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
            className={!dimmed ? "hover:bg-gray-50" : ""}
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

// ─── DiffUnavailableBanner ───────────────────────────────────────────────────
// 当 diff endpoint 返回 unavailableReason（前 call 没 proxy / 解析失败 / 首条
// call 无 prev）时，Lens 面板顶部插这一条 banner 解释「Diff 视角为何不可用」，
// 并提示「缓存视角仍可用」—— Cache 视角只读当前 snapshot 的 pins + 各 section
// 字符数，服务端在 prev 缺失时仍会 emit cur-only sections（参见
// diff-tree-service buildCurOnlySections）。
function DiffUnavailableBanner({
  reason, prevCallId,
}: {
  reason: NonNullable<DiffTreeResult["unavailableReason"]>;
  prevCallId: number | null;
}) {
  const { t } = useTranslation();
  const descKey = reason === "prev-not-captured"  ? "attribution.lensBanner.prevNotCaptured"
                : reason === "cur-not-captured"   ? "attribution.lensBanner.curNotCaptured"
                : reason === "prev-parse-failed"  ? "attribution.lensBanner.prevParseFailed"
                : /* no-prev */                     "attribution.lensBanner.noPrev";
  // 三个 proxy 相关的 reason → 提供「去配置代理」link（CustomEvent 路由）；
  // no-prev 是会话首条，不是代理问题，不展示 link。
  const showProxyLink = reason !== "no-prev";
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 10,
      padding: "10px 12px", borderRadius: 6,
      background: "#fffbeb", border: "1px solid #fde68a",
      fontSize: 12, lineHeight: 1.5,
    }}>
      <span style={{
        marginTop: 2,
        width: 8, height: 8, borderRadius: 999,
        background: "#f59e0b", flexShrink: 0,
        display: "inline-block",
      }} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={{ fontWeight: 600, color: "#92400e" }}>
          {t("attribution.lensBanner.diffUnavailableTitle")}
        </div>
        <div style={{ color: "#78350f" }}>
          {t(descKey, { prevCallId: prevCallId ?? "—" })}
        </div>
        <div style={{ color: "#a16207", fontSize: 11 }}>
          {t("attribution.lensBanner.diffUnavailableCacheStillOk")}
        </div>
      </div>
      {showProxyLink && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(
            new CustomEvent("dashboard:navigate", { detail: { tab: "proxy-v2" } }),
          )}
          style={{
            border: "none", background: "transparent", padding: 0,
            color: BRAND.indigo500, fontWeight: 600, fontSize: 12,
            cursor: "pointer", whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          className="hover:underline"
        >
          {t("attribution.lensBanner.goSetup")}
        </button>
      )}
    </div>
  );
}


export function AttributionTreeLensPanel({
  sessionId, agentFileId, compactIdx, proxyRequestId, callId, prevCallId, hideDiff, onLinkSource, onLeafSelect, prelude,
}: {
  sessionId: string;
  /** Present iff rendering a sub-agent call — routes to sub-agent endpoint. */
  agentFileId?: string;
  /** Present iff rendering a compact summarization call — routes to compact endpoint.
   *  互斥于 agentFileId。compact 没有 diffTree 端点（语义上"和上一条 call diff"
   *  对 compact 价值不大），diffData 自然落 null，Diff lens 自动退化展示。 */
  compactIdx?: number;
  /** Present iff rendering a side call（后台 LLM 请求，仅 proxyRequestId 寻址）。
   *  互斥于 callId/compactIdx/agentFileId 的寻址语义。side call 没有 transcript
   *  turn / prev call / jsonl 坐标 —— attribution fetch 切到 side-call 端点，
   *  Diff 与 Cache 两个 lens 都被强制隐藏（无 prev、无 cache 拓扑可言）。 */
  proxyRequestId?: number;
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
  const { t } = useTranslation();
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
    const fetcher = proxyRequestId != null
      ? apiV2.sideCallAttributionTree(sessionId, proxyRequestId)
      : compactIdx != null
        ? apiV2.compactAttributionTree(sessionId, compactIdx)
        : agentFileId
          ? apiV2.subAgentAttributionTree(sessionId, agentFileId, callId)
          : apiV2.attributionTree(sessionId, callId);
    fetcher
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, agentFileId, compactIdx, proxyRequestId, callId]);

  // 并行拉 diff-tree，用 leafId 把 diffKind 合并到 attribution leaves 上。
  // Diff lens / Diff 视角的双层 bar / Removed footer 都依赖这份数据。
  //
  // TODO(远 diff · 用户已确认采用方案 C): 当前 diffTree(sessionId, callId) 隐式
  // 以「上一次 call」为 basis。用户需要支持「任选某个 call 作为 basis（含跨
  // sub-agent）」。实施需要：
  //   1. 后端 api：diffTree(sessionId, callId, basisCallId?) 接受可选 basis
  //      （subAgentDiffTree 同步）
  //   2. 后端实现：从 attribution snapshot 仓库取 basisCallId 的 snapshot，
  //      做 diff（基础设施已具备）
  //   3. 前端 UI：Diff lens pill 行右侧加 "vs #N" 下拉，列出所有可作为 basis
  //      的 call（含 sub-agent call）
  //   4. 前端 state：basisCallId 进入本组件 state，作为 useEffect 依赖
  // 暂缓不实施（复杂度中等，先收敛当前 UI 体验）。
  const [diffData, setDiffData] = useState<import("./diff-tree-types").DiffTreeResult | null>(null);
  useEffect(() => {
    // compact / side-call 都没有 diffTree 端点（语义上和 "上一条 call diff" 价值
    // 不大，side call 更是无 prev）—— 直接 null，Diff lens 退化展示，整体不影响
    // attribution。
    if (compactIdx != null || proxyRequestId != null) {
      setDiffData(null);
      return;
    }
    let cancelled = false;
    const fetcher = agentFileId
      ? apiV2.subAgentDiffTree(sessionId, agentFileId, callId)
      : apiV2.diffTree(sessionId, callId);
    fetcher
      .then((r) => { if (!cancelled) setDiffData(r); })
      .catch(() => { if (!cancelled) setDiffData(null); }); // diff 失败不阻塞 attribution
    return () => { cancelled = true; };
  }, [sessionId, agentFileId, compactIdx, proxyRequestId, callId]);

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
  // 注意：cache lens 的桶只用于联动 CacheTopologyStrip 高亮，不参与 leaf 过滤
  // （用户明确要求：cache 选中不应该 dim 主 bar 的 leaf）。
  const passesAllFilters = useMemo(() => {
    const filters = Object.entries(bucketFilters).filter(([lid, b]) => !!b && lid !== "cache");
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

  // Leaf 着色：永远用基底 lens（LENSES[0] = 结构/语义角色）。其他 lens（来源/
  // 缓存/diff/audit）的信息通过行尾 badge 表达，而不是抢主色。
  const leafColor = useMemo(() => {
    const baseLens = getLens(LENSES[0].id);
    return (leaf: LeafLite) => {
      const bid = baseLens.bucketOf(leaf);
      const b = bid ? baseLens.buckets.find((x) => x.id === bid) : null;
      return b?.color ?? "#d1d5db";
    };
  }, []);

  // Diff 视角的 underline 色条：Diff lens 激活时，给 added/modified 的 leaf
  // bar 底下加 3px 实色色条（add 绿 / modify 黄）。bar 本体和 provenance 底色
  // 完全不动。kept / removed 没有 underline（removed 在 Prev bar / Removed
  // footer 单独表达）。
  const leafUnderline = useMemo(() => {
    if (!activeLenses.has("diff")) return undefined;
    return (leaf: LeafLite) => diffUnderlineFor(leaf.diffKind ?? null);
  }, [activeLenses]);

  // 每个 leaf 行尾的 badge 列：按 active lens（除 provenance 外）逐个输出。
  // 各 lens 自己负责给 leaf 算桶 + 桶颜色，badge 用 lens 的桶元数据。
  const leafBadges = useMemo(() => {
    const otherLenses = LENSES.filter((l) => l.id !== LENSES[0].id && activeLenses.has(l.id));
    return (leaf: LeafLite) => {
      return otherLenses
        .map((ln) => {
          const bid = ln.bucketOf(leaf);
          if (!bid) return null;
          const b = ln.buckets.find((x) => x.id === bid);
          if (!b) return null;
          return {
            key: ln.id,
            label: b.label,
            color: b.color,
            bg: `${b.color}1a`, // ~10% alpha tint
            border: `${b.color}40`,
            title: `${ln.label}: ${b.label}${b.description ? "\n" + b.description : ""}`,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    };
  }, [activeLenses]);

  // unavailableReason 提到一等公民。老逻辑只看 diffData 是否 null，会把"空
  // sections"误当成"成功无变化"——Diff chip 出现却显示无变化（假绿）、Cache
  // 拓扑返回 null（点了无反馈）。
  //
  // 两个 lens 的可用条件不一样：
  //   • Diff：需要 prev snapshot —— unavailableReason !== null 时一律隐藏。
  //   • Cache：只读 curSnap 的 pins/newTotal —— 服务端在 prev 缺失时也会
  //     emit cur-only sections（diff-tree-service buildCurOnlySections），
  //     所以只要 sections 非空就能渲染。
  const diffUnavailableReason = diffData?.unavailableReason ?? null;
  const diffUsable = diffData != null && diffUnavailableReason == null;
  // 拓扑视角需要有 section 数据（不管是不是 diff 完整版）。cur-not-captured
  // 这一支返回 sections=[]，Cache 也无能为力，但 prev-not-captured / no-prev
  // 这两支现在会带 cur-only sections，Cache 仍能用。
  const cacheUsable = (diffData?.sections.length ?? 0) > 0;

  // 决定哪些 lens 出现在 toggle 行 + bucket pill 区。Provenance 永远出现；
  // Diff 在 prev snapshot 不可用时隐藏；Cache 单独按 cacheUsable 判断。
  // 注意：useMemo 必须在所有 early return 之上，避免 hook 顺序变化。
  const visibleLenses = useMemo(
    () => LENSES.filter((l) => {
      // side-call 模式：Diff（无 prev）与 Cache（无 cache 拓扑）一律隐藏。
      if (proxyRequestId != null && (l.id === "diff" || l.id === "cache")) return false;
      if (l.id === "diff" && (hideDiff || prevCallId == null || !diffUsable)) return false;
      if (l.id === "cache" && !cacheUsable) return false;
      return true;
    }),
    [proxyRequestId, hideDiff, prevCallId, diffUsable, cacheUsable],
  );

  // Lens 被强制隐藏时，把它从 activeLenses 里同步剔除（否则下方对
  // `activeLenses.has(...)` 的判断会在 chip 不显示的情况下还触发渲染分支）。
  useEffect(() => {
    setActiveLenses((prev) => {
      const next = new Set(prev);
      let mutated = false;
      if (!diffUsable && next.has("diff"))   { next.delete("diff");  mutated = true; }
      if (!cacheUsable && next.has("cache")) { next.delete("cache"); mutated = true; }
      return mutated ? next : prev;
    });
  }, [diffUsable, cacheUsable]);

  if (loading) {
    return <div style={{ padding: "32px 0", textAlign: "center", fontSize: 11, color: "#9ca3af" }}>{t("attribution.loading")}</div>;
  }
  if (error) {
    return (
      <Alert variant="destructive" className="text-xs">
        <AlertDescription>{t("attribution.loadFailed")}: {error}</AlertDescription>
      </Alert>
    );
  }
  if (!result?.snapshot) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "#9ca3af", background: "#fafafa", borderRadius: 6, border: "1px dashed #e5e7eb" }}>
        {result?.error ?? t("attribution.lensBanner.curNotCaptured")}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Diff 不可用 banner：在 Lens 切换器之上显式说明 Diff 视角为什么没了，
          并强调 Cache 视角仍然可用（避免用户以为整块功能挂了）。提供「去配置
          代理」入口让用户一键跳代理 tab。no-prev 是会话首条 call，是预期内
          事件不是问题，不展示 banner。 */}
      {diffUnavailableReason && diffUnavailableReason !== "no-prev" && (
        <DiffUnavailableBanner
          reason={diffUnavailableReason}
          prevCallId={diffData?.prevCallId ?? prevCallId ?? null}
        />
      )}

      {/* Layer 0: lens toggle 行 + 版本 badge。基底（来源）永远 active 且不出现在
          toggle 行；只列出可切换的 lens（diff / cache / 可选 audit）。右侧版本 badge
          显示本次 call 的 cc_version 与基线匹配状态，并在 ctx 失败时解释"为何未归因"。 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <LensSwitcher
          lenses={visibleLenses.filter((l) => l.id !== LENSES[0].id)}
          activeLenses={activeLenses}
          baseLensId={LENSES[0].id}
          onToggle={toggleLens}
        />
        <VersionBadge diag={result?.snapshot?.versionDiag} />
      </div>

      {/* Prelude（CachePanel 旧路径用过；统一后由 cache lens 自管） */}
      {prelude}

      {/* Layer 0.5: 每个 active lens 一行 bucket pill。
          cache lens 跳过 —— L1/L2/L3 拓扑条本身就是 cache 桶的索引视图。

          每个 lens 的桶数字按"被其他 lens 过滤后剩下的子集"统计，正交语义：
          选了来源=系统提示词(35) → diff 桶显示的就是这 35 个里的 added/modified/
          kept 分布，三者加起来恰好 = 35。 */}
      {visibleLenses
        .filter((l) => activeLenses.has(l.id) && l.id !== "cache")
        .map((l) => {
          // 排除自己的桶过滤 + cache（cache 不过滤），按其余 lens 的桶过滤交集筛 leaves
          const otherFilters = Object.entries(bucketFilters)
            .filter(([lid, b]) => !!b && lid !== l.id && lid !== "cache");
          const leavesForThisLens = otherFilters.length === 0
            ? allLeaves
            : allLeaves.filter((leaf) => {
                for (const [lid, bid] of otherFilters) {
                  const ln = getLens(lid);
                  if (ln.bucketOf(leaf) !== bid) return false;
                }
                return true;
              });
          return (
            <BucketPillRow
              key={l.id}
              lens={l}
              selectedBucketId={bucketFilters[l.id] ?? null}
              onSelect={(bid) => setBucketFilter(l.id, bid)}
              leaves={leavesForThisLens}
            />
          );
        })}

      {/* Layer 0.8: Cache lens 激活时，在主 SectionBar 上方插入 L1/L2/L3 紧凑条
          （现在的 prelude 旧路径之外，新路径走这里） */}
      {activeLenses.has("cache") && diffData && (() => {
        // 计算 selected leaf 在全局 prefix 字符流中的 [start, end] 位置
        // （供 CacheTopologyStrip 在每条 L 行画"leaf 位置小块"的联动）。
        // 整行高亮只在用户显式点击 L 行时出现，不会因为选 leaf 自动触发。
        let leafPos: { start: number; end: number } | null = null;
        if (selectedLeaf) {
          let cum = 0;
          outer: for (const sec of diffData.sections) {
            for (const l of sec.leaves) {
              if (l.id === selectedLeaf.nodeId) {
                leafPos = { start: cum, end: cum + (l.newCharCount ?? 0) };
                break outer;
              }
              cum += l.newCharCount ?? 0;
            }
          }
        }
        return (
          <CacheTopologyStrip
            diffData={diffData}
            selectedLeafPosition={leafPos}
          />
        );
      })()}

      {/* Layer 1: 主 bar —— diff lens 的对比靠 leaf 上的 underline + 底部
          RemovedFooter + 选中后的行级 diff 详情，不再画"上一轮 bar"。 */}
      <MainSectionBar
        sections={stats}
        totalChars={totalChars}
        selectedSection={selectedSection}
        onSelectSection={(s) => {
          setSelectedSection((cur) => (cur === s ? null : s));
          setSelectedNodeId(null);
        }}
        selectedLeafId={selectedNodeId}
        onSelectLeaf={(id) => {
          // 主 bar 内点 leaf → 自动 drill 到该 leaf 的 section + 选中
          const leaf = allLeaves.find((l) => l.nodeId === id);
          if (leaf) setSelectedSection(sectionOf(leaf.rootSlotType));
          setSelectedNodeId((cur) => (cur === id ? null : id));
        }}
        leafColor={leafColor}
        leafUnderline={leafUnderline}
        isDimmed={passesAllFilters ? (l) => !passesAllFilters(l) : undefined}
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
            getUnderlineColor={leafUnderline}
          />
          <LeafTable
            leaves={selectedStat.leaves}
            selectedId={selectedNodeId}
            onSelect={(id) => setSelectedNodeId((cur) => (cur === id ? null : id))}
            getColor={leafColor}
            getBadges={leafBadges}
            totalContextChars={totalChars}
          />
          {selectedLeaf && sectionOf(selectedLeaf.rootSlotType) === selectedStat.id && (
            <>
              <SelectedDetail leaf={selectedLeaf} onLinkSource={onLinkSource} totalContextChars={totalChars} />
              {/* Diff lens 激活时，选中 leaf 有 diff 变化的话，叠加行级 diff 详情。
                  modified → before/after 字级 inline diff；
                  added / removed → 单边内容展示。
                  kept / 无 diffData / 找不到对应 diff leaf → 不渲染。 */}
              {activeLenses.has("diff") && diffData && (() => {
                const diffLeaf = diffData.sections
                  .flatMap((s) => s.leaves)
                  .find((l) => l.id === selectedLeaf.nodeId);
                if (!diffLeaf || diffLeaf.kind === "kept") return null;
                return (
                  <div style={{
                    marginTop: 6,
                    borderTop: "1px solid #e5e7eb",
                    paddingTop: 6,
                  }}>
                    <SelectedDiffDetail leaf={diffLeaf} />
                  </div>
                );
              })()}
            </>
          )}
        </>
      )}

      {/* Layer 末尾：Diff lens 激活 + 有 removed leaves 时显示底部"被删除"卡 */}
      {activeLenses.has("diff") && diffData && (
        <RemovedFooterCard diffData={diffData} />
      )}
    </div>
  );
}

// ─── RemovedFooterCard — Diff lens 激活时底部"被删除"列表 ───────────────────

function RemovedFooterCard({ diffData }: { diffData: DiffTreeResult }) {
  const removed = diffData.sections.flatMap((s) =>
    s.leaves.filter((l) => l.kind === "removed").map((l) => ({ ...l, sectionId: s.id })),
  );
  if (removed.length === 0) return null;
  return (
    <div style={{
      marginTop: 6,
      background: "#fef2f2",
      border: "1px solid #fecaca",
      borderRadius: 6,
      padding: "10px 12px",
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, color: "#b91c1c",
        letterSpacing: "0.05em", textTransform: "uppercase",
        marginBottom: 6,
      }}>
        ⊖ 本轮删除 · {removed.length} 段（在上一轮存在、本轮已不在）
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {removed.map((l) => {
          const meta = SECTION_META[l.sectionId];
          return (
            <div key={l.id} style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "2px 0",
              fontSize: 11,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: 2, background: meta?.marker ?? "#9ca3af", flexShrink: 0 }} />
              <span style={{
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                color: "#111827",
                minWidth: 220, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {l.slotType}
              </span>
              <span style={{ fontSize: 10, color: "#6b7280" }}>
                {(l.oldCharCount ?? 0).toLocaleString()} chars
              </span>
              <span style={{
                fontSize: 10, color: "#9ca3af",
                flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                fontStyle: "italic",
              }}>
                {(l.oldRawText ?? "").replace(/\s+/g, " ").slice(0, 120)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── CacheTopologyStrip — Cache lens 激活时的 L1/L2/L3 紧凑条 ────────────────

function CacheTopologyStrip({
  diffData,
  selectedLeafPosition,
}: {
  diffData: DiffTreeResult;
  /** sub-bar 选中 leaf 在全局 prefix 字符流中的 [start, end]。当存在时，
   *  在每条 L 行的对应字符位置画一个透明小块，用户视觉上能看到"该 leaf
   *  在哪些 L 层被缓存（落在 L 行 cum 内）"。 */
  selectedLeafPosition?: { start: number; end: number } | null;
}) {
  const pins: PinInfo[] = diffData.sections
    .flatMap((s) => s.pins ?? [])
    .filter((p) => typeof p?.cumulativePrefixChars === "number")
    .sort((a, b) => a.cumulativePrefixChars - b.cumulativePrefixChars);

  const grandTotal = diffData.sections.reduce((sum, s) => sum + s.newTotal, 0);

  if (pins.length === 0 || grandTotal === 0) return null;

  // 把 sections 按 tools→sys→msgs 顺序累积，给每个 section 算出 [start, end]
  const ranges: Array<{ id: DiffSection["id"]; start: number; end: number }> = [];
  let cum = 0;
  for (const s of diffData.sections) {
    ranges.push({ id: s.id, start: cum, end: cum + s.newTotal });
    cum += s.newTotal;
  }

  function sliceBy(from: number, to: number) {
    return ranges
      .map((r) => ({
        id: r.id,
        chars: Math.max(0, Math.min(r.end, to) - Math.max(r.start, from)),
      }))
      .filter((x) => x.chars > 0);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {pins.map((pin, idx) => {
        const cumChars = pin.cumulativePrefixChars;
        const sectionBreakdown = sliceBy(0, cumChars);
        const uncovered = grandTotal - cumChars;
        return (
          <div
            key={`L${idx + 1}`}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 10,
              position: "relative",
            }}
          >
            <div style={{
              flex: 1, minWidth: 0,
              height: 12,
              display: "flex", gap: 4,
              position: "relative",  // 给 selectedLeafPosition 小块作为定位参考
            }}>
              {sectionBreakdown.map((b, i) => {
                const meta = SECTION_META[b.id];
                if (!meta) return null;
                return (
                  <div key={i} title={`${meta.label} · ${b.chars} chars`} style={{
                    flex: b.chars,
                    background: meta.barBg,
                    borderRadius: 2,
                  }} />
                );
              })}
              {uncovered > 0 && (
                <div style={{ flex: uncovered, background: "transparent" }} />
              )}
              {/* sub-bar 选中 leaf 时，在每条 L 行的字符位置画半透明小块。
                  落在 [0, cumChars] 内 → 实色（说明被该 L 层缓存）
                  落在 [cumChars, grandTotal] 内 → 淡色 + 虚线（未缓存到该层） */}
              {selectedLeafPosition && grandTotal > 0 && (() => {
                const { start, end } = selectedLeafPosition;
                if (end <= start) return null;
                const leftPct = (start / grandTotal) * 100;
                const widthPct = ((end - start) / grandTotal) * 100;
                const inCache = end <= cumChars;
                return (
                  <div
                    style={{
                      position: "absolute",
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      top: -2, bottom: -2,
                      background: inCache ? "rgba(31, 41, 55, 0.22)" : "rgba(31, 41, 55, 0.06)",
                      border: inCache
                        ? "1px solid rgba(31, 41, 55, 0.65)"
                        : "1px dashed rgba(31, 41, 55, 0.35)",
                      borderRadius: 2,
                      pointerEvents: "none",
                      boxSizing: "border-box",
                    }}
                  />
                );
              })()}
            </div>
            {/* 右侧合并信息：L# · chars · ttl · scope，加 ℹ 信息点 hover 说明 */}
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              flexShrink: 0,
              fontFamily: "ui-monospace, SFMono-Regular, monospace",
              fontSize: 10,
            }}>
              <span style={{
                color: "#dc2626", fontWeight: 700, letterSpacing: "0.04em",
                minWidth: 22,
              }}>
                L{idx + 1}
              </span>
              <span style={{ color: "#6b7280", minWidth: 48, textAlign: "right" }}>
                {cumChars.toLocaleString()}
              </span>
              <span style={{ color: "#9ca3af", fontSize: 9, minWidth: 50 }}>
                {pin.ttl} · {pin.scope === "global" ? "G" : "org"}
              </span>
              <span
                title={
                  `L${idx + 1} 层缓存\n\n` +
                  `这是请求中第 ${idx + 1} 个 cache_control breakpoint（按 prefix 顺序）。\n` +
                  `它把请求体的前 ${cumChars.toLocaleString()} 个字符标为可缓存，\n` +
                  `TTL = ${pin.ttl}（${pin.ttl === "5m" ? "5 分钟" : pin.ttl === "1h" ? "1 小时" : pin.ttl}），` +
                  `scope = ${pin.scope === "global" ? "global（跨 org 复用）" : "org（仅本 org）"}。\n\n` +
                  `下方 bar 显示该层覆盖了哪些 section（tools / system / messages）。\n` +
                  `右端如有空白 = 未被该层缓存的部分（${(grandTotal - cumChars).toLocaleString()} 字符）。`
                }
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 14, height: 14, borderRadius: "50%",
                  fontSize: 9, fontWeight: 700,
                  background: "#f3f4f6", color: "#6b7280",
                  border: "1px solid #d1d5db",
                  cursor: "help",
                  userSelect: "none",
                }}
              >
                i
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
