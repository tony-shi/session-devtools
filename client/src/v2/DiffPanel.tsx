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
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type {
  DiffKind, DiffLeaf, DiffSection, DiffSectionId, DiffTreeResult,
  DiffUnavailableReason,
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

/** Wire jsonPath → 短显式标签。明确告诉用户 pin 落在哪个具体字段。
 *  reqBody.system[3]                  → sys[3]
 *  reqBody.messages[4].content[1]     → msg[4][1]
 *  reqBody.tools[10]                  → tools[10]
 *  fallback: 截断尾巴
 */
function shortJsonPath(path: string | undefined): string {
  if (!path) return "?";
  let s = path.replace(/^reqBody\./, "");
  s = s.replace(/^system\[/, "sys[");
  s = s.replace(/^messages\[/, "msg[");
  s = s.replace(/\.content\[/g, "[");
  return s;
}

// ─── 主入口：DiffPanel ───────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  /** Present iff rendering a sub-agent call — routes to sub-agent endpoint. */
  agentFileId?: string;
  callId: number;
  prevCallId?: number | null;
  /** Cache token accounting for diagnostic row. All four must be present
   *  (and prev call must exist) for the row to render; otherwise we skip
   *  the row silently. */
  currCacheRead?: number;
  currCacheWrite?: number;
  prevCacheRead?: number;
  prevCacheWrite?: number;
}

export function DiffPanel({
  sessionId, agentFileId, callId, prevCallId,
  currCacheRead, currCacheWrite, prevCacheRead, prevCacheWrite,
}: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<DiffTreeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetcher = agentFileId
      ? apiV2.subAgentDiffTree(sessionId, agentFileId, callId)
      : apiV2.diffTree(sessionId, callId);
    fetcher
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, agentFileId, callId]);

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

  // "Diff 不可用" 是一等公民：prev reqBody 缺失 / 第一条 call / 解析失败时，UI 显式占位，
  // 不再走"全 added"那条假绿路径。reason 由 server 给（DiffUnavailableReason）；占位仍
  // 暴露 "vs Call #N"（如果服务端能算出 prevCallId），让用户知道本应对照的是哪条。
  //
  // 未来下拉框落地：父层会改成"始终渲染 DiffPanel"，no-prev 的占位位置正好用来挂下拉框
  // 让用户选别的对照对象 — 所以这里 4 种 reason 现在都实现完整，本期父层 hide 了 no-prev
  // 不展示，但 DiffPanel 内部已就绪。
  if (data.unavailableReason) {
    return <DiffUnavailablePlaceholder reason={data.unavailableReason} prevCallId={data.prevCallId} />;
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
              <span style={{ color: "#9ca3af" }}>·</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    style={{
                      fontFamily: "ui-monospace, SFMono-Regular, monospace",
                      color: sum.netCharDelta > 0
                        ? DIFF_TEXT_COLOR.added
                        : sum.netCharDelta < 0
                          ? DIFF_TEXT_COLOR.removed
                          : "#6b7280",
                      fontWeight: 700,
                    }}
                  >{fmtDelta(sum.netCharDelta)}</span>
                </TooltipTrigger>
                <TooltipContent>{t("diff.charsTooltip")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    style={{ color: "#9ca3af", cursor: "help", borderBottom: "1px dotted #d1d5db" }}
                  >{t("diff.charsLabel")}</span>
                </TooltipTrigger>
                <TooltipContent>{t("diff.charsTooltip")}</TooltipContent>
              </Tooltip>
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

      <CacheImpactRow
        currCacheRead={currCacheRead}
        currCacheWrite={currCacheWrite}
        prevCacheRead={prevCacheRead}
        prevCacheWrite={prevCacheWrite}
        sections={data.sections}
      />

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

// ─── DiffUnavailablePlaceholder — 显式表达"无法 diff" ────────────────────────
//
// 替代旧的"prev 缺失 → silent fallback 到全 added"路径。当 server 返回
// unavailableReason 时只渲染这一块；不展示 KindPillRow / SectionDiffBar /
// CacheImpactRow，避免空 sections 又被解读成"无变化 ✓"。
//
// 4 种 reason 共用同一视觉容器（中性灰），仅文案不同。下拉框落地后会在这里
// 加一个 "换条对照" 入口，所以保留为独立组件而不是 inline JSX。
const REASON_LABEL: Record<DiffUnavailableReason, string> = {
  "no-prev":            "diff.unavailable.noPrev",
  "prev-not-captured":  "diff.unavailable.prevNotCaptured",
  "cur-not-captured":   "diff.unavailable.curNotCaptured",
  "prev-parse-failed":  "diff.unavailable.prevParseFailed",
};

function DiffUnavailablePlaceholder({
  reason, prevCallId,
}: { reason: DiffUnavailableReason; prevCallId: number | null }) {
  const { t } = useTranslation();
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 4,
      padding: "16px 14px",
      fontSize: 11,
      background: "#fafafa",
      border: "1px dashed #e5e7eb",
      borderRadius: 6,
      color: "#6b7280",
    }}>
      <div style={{ color: "#374151", fontSize: 12 }}>{t(REASON_LABEL[reason])}</div>
      {/* prev id 还是给出来，方便用户感知"本应对照的是哪条" — no-prev 时为 null 隐藏 */}
      {prevCallId != null && (
        <div style={{ fontSize: 10, color: "#9ca3af" }}>
          {t("diff.vsCall")} <strong style={{ color: "#6b7280" }}>#{prevCallId}</strong>
        </div>
      )}
    </div>
  );
}

// ─── CacheImpactRow — drift 守恒诊断 ─────────────────────────────────────────
//
// 数学事实：相邻 LLM call 在缓存正常工作时，curr.cache_read 严格等于
// prev.cache_creation + prev.cache_read（实测多 session 0 偏差）。drift
// = curr.cr − (prev.cw + prev.cr) 偏离 0 越多，说明本次有越多本应能命中
// 的 cache 被某件事冲掉了。
//
// 不是预测器、不调 tokenizer。仅基于 response.usage 的精确数字做守恒校验。
// 三态：健康（drift 在 ±100 内）/ 轻微偏差 / 击穿。击穿时给出 diff 里最大
// 那段 added section 作为根因提示。
//
// 不在以下情况渲染：
//   - 首 call（无 prev）
//   - 调用方未提供 token 数（sub-agent / linked panel 路径暂未接）

interface CacheImpactRowProps {
  currCacheRead?: number;
  currCacheWrite?: number;
  prevCacheRead?: number;
  prevCacheWrite?: number;
  sections: DiffSection[];
}

const HEALTHY_DRIFT_THRESHOLD = 100;
const BREACH_DRIFT_THRESHOLD  = 1000;

function CacheImpactRow({
  currCacheRead, currCacheWrite, prevCacheRead, prevCacheWrite, sections,
}: CacheImpactRowProps) {
  const { t } = useTranslation();
  // 静默跳过：调用方未提供任一字段
  if (
    currCacheRead === undefined || currCacheWrite === undefined ||
    prevCacheRead === undefined || prevCacheWrite === undefined
  ) return null;
  // 首 call 守恒口径未定义（prev 全 0 时退化为只看 curr.cr），不强行渲染
  if (prevCacheRead + prevCacheWrite === 0) return null;

  const expected = prevCacheRead + prevCacheWrite;
  const drift    = currCacheRead - expected;
  const absDrift = Math.abs(drift);

  let state: "healthy" | "minor" | "broken";
  if (absDrift < HEALTHY_DRIFT_THRESHOLD)      state = "healthy";
  else if (absDrift < BREACH_DRIFT_THRESHOLD)  state = "minor";
  else                                         state = "broken";

  const palette = {
    healthy: { bg: "#f0fdf4", border: "#bbf7d0", fg: "#15803d", icon: "✅" },
    minor:   { bg: "#fffbeb", border: "#fde68a", fg: "#92400e", icon: "⚠️" },
    broken:  { bg: "#fef2f2", border: "#fecaca", fg: "#b91c1c", icon: "🔴" },
  }[state];

  // 「最大变更段」—— 启发式描述，不是因果证明。drift 显著为负时，挑出 diff 里
  // 变化最大的 section 给用户一个起点，但显式标注为「最大变更」而不是「根因」。
  // 真实的因果可能是 TTL 过期、compaction、tools 微改 + 多段同时改 ……单从 wire
  // diff 无法裁定。
  const biggestChange = state === "broken"
    ? sections
        .filter(s => s.counts.added + s.counts.removed + s.counts.modified > 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0]
    : null;
  const biggestChangeLabel = biggestChange ? SECTION_META[biggestChange.id].label : null;

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      padding: "6px 10px", fontSize: 11,
      background: palette.bg, border: `1px solid ${palette.border}`, borderRadius: 6,
    }}>
      <span style={{ fontSize: 13 }}>{palette.icon}</span>
      <span style={{ fontWeight: 600, color: palette.fg }}>
        {t("diff.cacheImpact.label")}
      </span>
      <span style={{ color: "#6b7280", fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
        cache_read {fmtK(currCacheRead)} · cache_create {fmtK(currCacheWrite)}
      </span>
      <span style={{ color: "#9ca3af" }}>·</span>
      <span style={{ color: palette.fg, fontWeight: 600 }}>
        {state === "healthy" && t("diff.cacheImpact.healthy")}
        {state === "minor"   && t("diff.cacheImpact.minor", { drift: fmtDelta(drift) })}
        {state === "broken"  && t("diff.cacheImpact.broken", { drift: fmtDelta(drift) })}
      </span>
      {biggestChangeLabel && (
        <>
          <span style={{ color: "#9ca3af" }}>·</span>
          <span style={{ color: palette.fg }}>
            {t("diff.cacheImpact.biggestChange", { section: biggestChangeLabel })}
          </span>
        </>
      )}
      <span style={{ flex: 1 }} />
      <HoverTip
        align="right"
        content={
          <CacheImpactExplain />
        }
      >
        <span
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 16, height: 16, borderRadius: 8,
            background: "rgba(255,255,255,0.6)",
            color: palette.fg, border: `1px solid ${palette.border}`,
            fontSize: 10, fontWeight: 700,
            cursor: "help", userSelect: "none",
          }}
          aria-label={t("diff.cacheImpact.help")}
        >?</span>
      </HoverTip>
    </div>
  );
}

// ─── HoverTip — 自定义浮层 tooltip（ledger 白卡风格） ─────────────────────────
// 对齐 LedgerExplainer 的视觉语言：白底 + 灰边 + 软阴影 + 深灰文字。
//   - 触发：onMouseEnter / onMouseLeave 切换 show 状态
//   - 定位：紧贴 trigger 下方，左/中/右对齐三档
//   - 不依赖任何外部 portal / 库
function HoverTip({
  content,
  children,
  align = "center",
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  /** 默认 center；right 时把 tooltip 锚到右下避免溢出 */
  align?: "left" | "center" | "right";
}) {
  const [show, setShow] = useState(false);
  const transform =
    align === "center" ? "translateX(-50%)" :
    align === "right"  ? "translateX(-100%)" : "none";
  const left = align === "left" ? "0" : align === "right" ? "100%" : "50%";
  return (
    <span
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left,
            transform,
            zIndex: 100,
            background: "#fff",
            color: "#374151",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: "12px 14px",
            fontSize: 11,
            lineHeight: 1.5,
            maxWidth: 420,
            minWidth: 280,
            boxShadow: "0 8px 24px rgba(15,23,42,0.12), 0 2px 6px rgba(15,23,42,0.06)",
            whiteSpace: "normal",
            textAlign: "left",
            pointerEvents: "none",
          }}
        >
          {content}
        </div>
      )}
    </span>
  );
}

// ─── CacheImpactExplain — drift 算法说明（i18n，ledger 白卡风格） ──────────────
function CacheImpactExplain() {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{
        fontWeight: 700, fontSize: 11, color: "#111827",
        letterSpacing: "0.04em", textTransform: "uppercase",
      }}>
        {t("diff.cacheImpact.explainTitle")}
      </div>
      <div style={{
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        background: "#fafafa",
        border: "1px solid #f3f4f6",
        padding: "6px 8px", borderRadius: 4,
        fontSize: 10, color: "#111827",
      }}>
        {t("diff.cacheImpact.explainFormula")}
      </div>
      <div style={{ color: "#6b7280", fontSize: 11 }}>{t("diff.cacheImpact.explainSource")}</div>
      <div style={{
        color: "#15803d", fontSize: 11,
        background: "#f0fdf4",
        borderLeft: "2px solid #16a34a",
        padding: "4px 8px",
      }}>
        ✓ {t("diff.cacheImpact.explainHealthy")}
      </div>
      <div style={{
        color: "#b91c1c", fontSize: 11,
        background: "#fef2f2",
        borderLeft: "2px solid #ef4444",
        padding: "4px 8px",
      }}>
        🔴 {t("diff.cacheImpact.explainBroken")}
      </div>
      <div style={{
        color: "#92400e", fontSize: 11,
        background: "#fffbeb",
        borderLeft: "2px solid #f59e0b",
        padding: "4px 8px",
      }}>
        ⚠ {t("diff.cacheImpact.explainAttribution")}
      </div>
      <div style={{
        color: "#9ca3af", fontStyle: "italic", fontSize: 10,
        borderTop: "1px dashed #f3f4f6", paddingTop: 6,
      }}>
        {t("diff.cacheImpact.explainNote")}
      </div>
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

  const grandNewTotal = sections.reduce((s, x) => s + x.newTotal, 0);
  const hasAnyChange =
    summary
      ? summary.addedCount + summary.removedCount + summary.modifiedCount > 0
      : sections.some((s) => s.delta !== 0 || s.counts.added + s.counts.removed + s.counts.modified > 0);

  const handleSectionSelect = (id: DiffSectionId) => {
    setSelectedSection((cur) => (cur === id ? null : id));
    setSelectedLeafId(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Kind pill row — same visual language as the Provenance / Cache /
          Audit lens "BucketPillRow" so the diff view reads as another
          lens-style view (not a separate UI tradition). Each pill counts
          leaves of that kind across all sections. Empty kinds are dropped
          (added=0 → hide the chip), matching how empty buckets are now
          dropped in the attribution lens. */}
      {summary && <DiffKindPillRow summary={summary} />}

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
        />
      )}
    </div>
  );
}

// ─── Layer 0: DiffKindPillRow ───────────────────────────────────────────────
//
// Mirrors AttributionTreeLensPanel's BucketPillRow visually: each "kind"
// (added / removed / modified) shows as a small pill with a colored dot,
// count, and label. Read-only — clicking doesn't filter (yet) — so the
// row functions as a quick scannable summary aligned with the rest of the
// attribution UI.

function DiffKindPillRow({ summary }: { summary: NonNullable<DiffTreeResult["summary"]> }) {
  const pills: Array<{ kind: DiffKind; count: number }> = [
    { kind: "added",    count: summary.addedCount },
    { kind: "modified", count: summary.modifiedCount },
    { kind: "removed",  count: summary.removedCount },
  ].filter(p => p.count > 0) as Array<{ kind: DiffKind; count: number }>;

  if (pills.length === 0) return null;

  const labelOf: Record<DiffKind, string> = {
    added:    "added",
    removed:  "removed",
    modified: "modified",
    kept:     "kept",
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      flexWrap: "wrap",
      padding: "2px 0",
    }}>
      {pills.map(({ kind, count }) => (
        <span
          key={kind}
          title={`${count} ${labelOf[kind]} leaves`}
          style={{
            display: "inline-flex", alignItems: "baseline", gap: 6,
            padding: "3px 8px", borderRadius: 4,
            border: "1px solid transparent",
            color: "#374151",
            fontSize: 11,
          }}
        >
          <span style={{
            width: 6, height: 6, borderRadius: 1,
            background: DIFF_TEXT_COLOR[kind], alignSelf: "center",
          }} />
          <span style={{ fontWeight: 600, color: "#1f2937" }}>{count}</span>
          <span style={{ color: "#6b7280" }}>{labelOf[kind]}</span>
        </span>
      ))}
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
              background: meta.barBg, opacity,
              border: "none", outline, outlineOffset: -2,
              borderRadius: 6,
              padding: "8px 14px",
              cursor: "pointer", textAlign: "left",
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
                color: meta.barText, flexShrink: 0,
              }}>{fmtDelta(s.delta)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Pin-related visualization removed from diff page. Cache topology now lives in
// the dedicated `CachePanel` tab. Diff page only carries `CacheImpactRow` as the
// drift-conservation summary linking diff content changes to cache outcomes.

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
            className="hover:bg-gray-50"
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
// 取消 bin 合并：每个 leaf 都是独立 strip item / 列表行；unchanged 在视觉上整体置灰。

interface DiffStripItem {
  id: string;
  size: number;
  merged: { kind: "single"; leaf: DiffLeaf };
}

function SectionDrillIn({
  section, selectedLeafId, onSelectLeaf,
}: {
  section: DiffSection;
  selectedLeafId: string | null;
  onSelectLeaf: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  // 不再合并 bin —— 每个 leaf 都是独立 item。unchanged 用浅色置灰，方便用户找到
  // 被 pin 命中的 leaf（之前 bin 折叠会把 pin 藏起来）。
  const items: DiffStripItem[] = useMemo(
    () => section.leaves.map((l) => {
      const size = l.kind === "removed" ? (l.oldCharCount ?? 100) : l.newCharCount;
      return { id: l.id, size: Math.max(size, 1), merged: { kind: "single", leaf: l } };
    }),
    [section.leaves],
  );

  const handleStripSelect = (it: DiffStripItem) => {
    onSelectLeaf(selectedLeafId === it.id ? null : it.id);
  };

  const selectedLeaf = useMemo(() => {
    if (!selectedLeafId) return null;
    return section.leaves.find((l) => l.id === selectedLeafId) ?? null;
  }, [section.leaves, selectedLeafId]);

  return (
    <>
      <div style={{ minWidth: 0, maxWidth: "100%", overflowX: "hidden" }}>
        <FisheyeStrip<DiffStripItem>
          items={items}
          // unchanged leaf 用 BIN_COLOR 浅灰；变化 leaf 用 diff 三色
          getColor={(it) => it.merged.leaf.kind === "kept" ? BIN_COLOR : DIFF_COLOR[it.merged.leaf.kind]}
          getLabel={(it) => {
            const l = it.merged.leaf;
            const slot = shortSlot(l.slotType);
            const prefix = DIFF_PREFIX[l.kind];
            return prefix ? `${prefix} ${slot}` : slot;
          }}
          getTitle={(it) => {
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

      <LeafDiffList
        leaves={section.leaves}
        selectedLeafId={selectedLeafId}
        onSelectLeaf={onSelectLeaf}
      />

      {selectedLeaf && <SelectedDiffDetail leaf={selectedLeaf} />}
    </>
  );
}

// ─── Layer 2.5: LeafDiffList — flat scannable list of every change ──────────
//
// Default state: every added/removed/modified leaf rendered as its own row.
// Consecutive unchanged leaves collapse into a single "▶ N unchanged" fold
// row that the user can expand on demand. Clicking any row also drives the
// FisheyeStrip selection above and the SelectedDiffDetail panel below.

function LeafDiffList({
  leaves, selectedLeafId, onSelectLeaf,
}: {
  leaves: DiffLeaf[];
  selectedLeafId: string | null;
  onSelectLeaf: (id: string | null) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 4 }}>
      {leaves.map((l) => (
        <DiffLeafRow
          key={l.id}
          leaf={l}
          selected={selectedLeafId === l.id}
          onClick={() => onSelectLeaf(selectedLeafId === l.id ? null : l.id)}
        />
      ))}
    </div>
  );
}

function DiffLeafRow({
  leaf, selected, onClick,
}: {
  leaf: DiffLeaf;
  selected: boolean;
  onClick: () => void;
}) {
  const isKept = leaf.kind === "kept";
  const fill = isKept ? BIN_COLOR : DIFF_COLOR[leaf.kind];
  const txtColor = isKept ? "#9ca3af" : DIFF_TEXT_COLOR[leaf.kind];
  const prefix = DIFF_PREFIX[leaf.kind] || "·";
  const sizeText =
    leaf.kind === "removed"
      ? `${fmtK(leaf.oldCharCount ?? 0)}`
      : leaf.kind === "modified"
        ? `${fmtK(leaf.oldCharCount ?? 0)} → ${fmtK(leaf.newCharCount)}`
        : `${fmtK(leaf.newCharCount)}`;
  const delta = leaf.kind === "modified"
    ? leaf.newCharCount - (leaf.oldCharCount ?? 0)
    : null;
  const preview = (leaf.preview ?? "").replace(/\s+/g, " ").trim();
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "5px 8px",
        background: selected ? "#eef2ff" : "transparent",
        border: "none",
        borderRadius: 4,
        cursor: "pointer", textAlign: "left",
        opacity: isKept ? 0.55 : 1,  // ← unchanged 行整行置灰，让有变化的行更醒目
        transition: "background 0.1s, opacity 0.1s",
      }}
      className={!selected ? "hover:bg-gray-50" : ""}
    >
      <span style={{ width: 8, height: 8, borderRadius: 2, background: fill, flexShrink: 0 }} />
      <span
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 11, fontWeight: 700,
          color: txtColor, minWidth: 14, textAlign: "center",
        }}
      >
        {prefix}
      </span>
      <span
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, monospace",
          fontSize: 11, color: isKept ? "#6b7280" : "#111827",
          minWidth: 180, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
      >
        {shortSlot(leaf.slotType)}
      </span>
      <span style={{ fontSize: 11, color: isKept ? "#9ca3af" : "#374151", minWidth: 110 }}>{sizeText}</span>
      {delta !== null && (
        <span style={{ minWidth: 52 }}>
          <DeltaPill delta={delta} small />
        </span>
      )}
      <span
        style={{
          fontSize: 10, color: "#6b7280",
          flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}
      >
        {preview}
      </span>
    </button>
  );
}

// ─── SelectedDiffDetail — 扁平展示，无 card 外框 ────────────────────────────

export function SelectedDiffDetail({ leaf }: { leaf: DiffLeaf }) {
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
      {leaf.kind === "modified" ? (() => {
        // Inline diff between BEFORE and AFTER — highlight only the bytes
        // that actually changed (git-style sub-line diff). Falls back to raw
        // DetailBlock when one side is missing or strings are identical.
        const beforeText = leaf.oldRawText ?? leaf.preview;
        const afterText  = leaf.rawText ?? leaf.preview;
        if (!beforeText || !afterText || beforeText === afterText) {
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <DetailBlock title="BEFORE" content={beforeText} muted />
              <DetailBlock title="AFTER" content={afterText} />
            </div>
          );
        }
        const ops = computeInlineDiff(beforeText, afterText);
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <InlineDiffBlock title="BEFORE" ops={ops} side="before" />
            <InlineDiffBlock title="AFTER"  ops={ops} side="after" />
          </div>
        );
      })() : leaf.kind === "removed" ? (
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

// ─── Inline (sub-line) diff — git-style highlight ───────────────────────────
//
// For "modified" leaves we want to show *where inside the string* the change
// happened, not just "the whole thing changed". Tokenise on word / whitespace
// / punctuation boundaries so a change like `cch=7e279` → `cch=ab3d9` ends up
// with `cch`, `=`, `;` as equal and only the value tokens flagged. The
// BEFORE block renders eq+del tokens (del highlighted red, strikethrough);
// the AFTER block renders eq+ins tokens (ins highlighted green). Same idea
// as GitHub's inline diff for a single-line change.

type InlineOp = { op: "eq" | "del" | "ins"; text: string };

function tokenizeForDiff(s: string): string[] {
  // Words (incl. underscores), runs of whitespace, or any single non-word char.
  // Keeps punctuation as separate tokens so e.g. `=` between `cch` and the
  // value stays equal across before/after.
  return s.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g) ?? [];
}

function computeInlineDiff(before: string, after: string): InlineOp[] {
  const a = tokenizeForDiff(before);
  const b = tokenizeForDiff(after);
  const m = a.length, n = b.length;
  // LCS DP — text snippets here are leaf-sized so O(n²) is fine.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const ops: InlineOp[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) { ops.push({ op: "eq",  text: a[i-1] }); i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { ops.push({ op: "ins", text: b[j-1] }); j--; }
    else { ops.push({ op: "del", text: a[i-1] }); i--; }
  }
  ops.reverse();
  // Coalesce consecutive same-kind ops so background pills don't fragment.
  const merged: InlineOp[] = [];
  for (const o of ops) {
    const last = merged[merged.length - 1];
    if (last && last.op === o.op) last.text += o.text;
    else merged.push({ ...o });
  }
  return merged;
}

function InlineDiffBlock({
  title, ops, side,
}: { title: string; ops: InlineOp[]; side: "before" | "after" }) {
  // Filter to the tokens this side cares about:
  //   BEFORE shows eq + del (the original string with deleted bits flagged)
  //   AFTER  shows eq + ins (the new string with inserted bits flagged)
  const visible = ops.filter((o) =>
    o.op === "eq" || (side === "before" ? o.op === "del" : o.op === "ins"),
  );
  return (
    <div>
      <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600, letterSpacing: "0.05em", marginBottom: 3 }}>{title}</div>
      <CodeBlock variant="preview" mono muted={side === "before"} maxHeight={240}>
        {visible.map((o, k) => {
          if (o.op === "eq") return <span key={k}>{o.text}</span>;
          if (o.op === "del") {
            return (
              <span
                key={k}
                style={{
                  background: "#fecaca",
                  color: "#7f1d1d",
                  textDecoration: "line-through",
                  borderRadius: 2,
                  padding: "0 2px",
                }}
              >
                {o.text}
              </span>
            );
          }
          // ins
          return (
            <span
              key={k}
              style={{
                background: "#bbf7d0",
                color: "#14532d",
                borderRadius: 2,
                padding: "0 2px",
              }}
            >
              {o.text}
            </span>
          );
        })}
      </CodeBlock>
    </div>
  );
}
