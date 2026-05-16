// LedgerExplainer —— Token 账本整体 hover 时弹出的解释 popover。
//
// 替代之前散落在各处的 `title={ratioTooltip(...)}` 原生浏览器 tooltip。
// 原生 tooltip 的问题：触发慢（~700ms）、样式不可控、不支持结构化排版、
// 多行文本经常被 OS 截断。这里改成纯前端 styled popover：
//
//   - 整个 ledger 任意位置悬停就出现（onMouseEnter/Leave 挂在外层）
//   - 用 4 个色点 row 配 metric 名 + 当次实际数值 + 一行简短解读
//   - Cache Ratio 给出完整代入公式
//   - 区分 "input 四桶 / output 一桶"，把 Anthropic API 计费档位讲清楚
//   - aggregate 版本额外标 Σ 累加语义
//
// 渲染策略：通过 createPortal 把 popover 节点挂在 document.body，定位用
// position:fixed + 由 wrapper 测量的 boundingClientRect 计算。这样可以
// 完全逃出任何 overflow:hidden 祖先（Turn card / Call card 都有），
// 不被裁切。视口空间不够时自动上下翻转。

import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { TOKEN_METRICS } from "../metricRegistry";

const POP_WIDTH = 460;
const POP_EST_HEIGHT = 360; // 用于上下翻转的粗略估计；之后用真实测高校正
const POP_GAP = 6;
const VIEWPORT_PADDING = 8;

function fmtK(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

function fmtPct(n: number): string {
  return n.toFixed(1) + "%";
}

export interface LedgerExplainerProps {
  /** "call" — 单 call 视图（输入是这一 call 真实计费档位）。
   *  "aggregate" — Σ 聚合视图（累加值，分子分母均为求和）。 */
  variant: "call" | "aggregate";
  freshIn: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** 已计算好的 cache ratio (0-100)；null 表示输入侧无数据。 */
  ratio: number | null;
  /** Wrapper 测出的锚点矩形（screen coords）。popover 自身负责上下翻转 + 越界纠偏。 */
  anchorRect: DOMRect;
  /** 偏好方向：默认 below。空间不足时仍会自动翻转。 */
  preferredAnchor?: "above" | "below";
}

export function LedgerExplainer({
  variant, freshIn, cacheRead, cacheWrite, output, ratio, anchorRect,
  preferredAnchor = "below",
}: LedgerExplainerProps) {
  const { t } = useTranslation();
  const M = TOKEN_METRICS;
  const isAgg = variant === "aggregate";
  const sigma = isAgg ? "Σ " : "";

  const inputTotal = freshIn + cacheRead + cacheWrite;
  const ratioFormula =
    ratio != null
      ? `${fmtK(cacheRead)} / (${fmtK(cacheRead)} + ${fmtK(cacheWrite)} + ${fmtK(freshIn)}) = ${fmtPct(ratio)}`
      : null;

  // 输入侧 3 行：cache_read / cache_write / fresh_input
  // 顺序对齐 ledger 本体的列序：read → write → fresh
  const inputRows: ExplainerRow[] = [
    {
      color: M.cache_read.color,
      label: M.cache_read.label,
      value: fmtK(cacheRead),
      hint: t(isAgg ? "ledgerExplainer.rows.cacheReadAgg" : "ledgerExplainer.rows.cacheReadCall"),
    },
    {
      color: M.cache_write.color,
      label: M.cache_write.label,
      value: fmtK(cacheWrite),
      hint: t(isAgg ? "ledgerExplainer.rows.cacheWriteAgg" : "ledgerExplainer.rows.cacheWriteCall"),
    },
    {
      color: M.fresh_input.color,
      label: M.fresh_input.label,
      value: fmtK(freshIn),
      hint: t(isAgg ? "ledgerExplainer.rows.freshInAgg" : "ledgerExplainer.rows.freshInCall"),
    },
  ];

  const outputRows: ExplainerRow[] = [
    {
      color: M.output.color,
      label: M.output.label,
      value: fmtK(output),
      hint: t(isAgg ? "ledgerExplainer.rows.outputAgg" : "ledgerExplainer.rows.outputCall"),
    },
  ];

  // ── Portal 定位：fixed + 视口感知 ────────────────────────────────────────
  // 先按"上方优先"放，如果上方空间不够（rect.top 不够装下 popover），翻到下方。
  // 横向：右对齐 anchor.right；若右对齐导致左边越界，则左对齐 anchor.left。
  // 渲染后用真实高度做一次校正（防止估算偏差）。
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>(() =>
    computePosition(anchorRect, POP_EST_HEIGHT, preferredAnchor));

  useLayoutEffect(() => {
    if (!popRef.current) return;
    const h = popRef.current.offsetHeight;
    setPos(computePosition(anchorRect, h, preferredAnchor));
  }, [anchorRect.top, anchorRect.bottom, anchorRect.left, anchorRect.right, preferredAnchor]);

  const node = (
    <div
      ref={popRef}
      role="tooltip"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        zIndex: 1000,
        width: POP_WIDTH,
        background: "#fff",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.06)",
        padding: "12px 14px",
        fontSize: 11, color: "#374151", lineHeight: 1.5,
        // 让 popover 自身 hover 也能保持显示（光标移过去看公式时不消失）
        pointerEvents: "auto",
      }}
    >
      {/* Title */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontWeight: 700, fontSize: 11, color: "#111827",
        letterSpacing: "0.04em", textTransform: "uppercase",
        marginBottom: 8,
      }}>
        <span>{t("ledgerExplainer.title")}</span>
        <span style={{
          fontSize: 9, fontWeight: 600, color: "#6366f1",
          background: "#eef2ff", border: "1px solid #c7d2fe",
          borderRadius: 3, padding: "1px 5px", letterSpacing: 0,
          textTransform: "none",
        }}>
          {t(isAgg ? "ledgerExplainer.variantAggregate" : "ledgerExplainer.variantCall")}
        </span>
      </div>

      {/* INPUT */}
      <SectionTitle>{t("ledgerExplainer.inputSection", { sigma })}</SectionTitle>
      <RowList rows={inputRows} />

      {/* Cache Ratio derived */}
      {ratioFormula && (
        <div style={{
          marginTop: 6, padding: "6px 8px",
          background: "#fafafa", border: "1px solid #f3f4f6", borderRadius: 6,
          fontSize: 10, color: "#374151",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
            <span style={{ width: 6, height: 6, borderRadius: 1, background: M.cache_ratio.color, flexShrink: 0 }} />
            <span style={{ fontWeight: 700, color: M.cache_ratio.color }}>{t("ledgerExplainer.ratioLabel")}</span>
            <span style={{ color: "#9ca3af", wordBreak: "break-word" }}>
              · {t(isAgg ? "ledgerExplainer.ratioFormulaAgg" : "ledgerExplainer.ratioFormulaCall")}
            </span>
          </div>
          <div style={{
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            color: "#111827",
            wordBreak: "break-word", whiteSpace: "normal",
          }}>
            {t("ledgerExplainer.ratioFormulaEquals", { formula: ratioFormula })}
          </div>
        </div>
      )}

      {inputTotal === 0 && (
        <div style={{ fontSize: 10, color: "#9ca3af", fontStyle: "italic", padding: "4px 0" }}>
          {t("ledgerExplainer.emptyInput")}
        </div>
      )}

      {/* OUTPUT */}
      <div style={{ height: 8 }} />
      <SectionTitle>{t("ledgerExplainer.outputSection", { sigma })}</SectionTitle>
      <RowList rows={outputRows} />

      {/* Footer note —— 含 <strong> 标签，用 dangerouslySetInnerHTML 渲染 i18n value */}
      <div
        style={{
          marginTop: 10, paddingTop: 8, borderTop: "1px dashed #f3f4f6",
          fontSize: 10, color: "#9ca3af", lineHeight: 1.55,
        }}
        dangerouslySetInnerHTML={{
          __html: t("ledgerExplainer.footer") + (isAgg ? t("ledgerExplainer.footerAggSuffix") : ""),
        }}
      />
    </div>
  );

  return createPortal(node, document.body);
}

function computePosition(
  rect: DOMRect,
  popHeight: number,
  preferred: "above" | "below",
): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 偏好方向先放；空间不够再翻转（只在确实装不下时翻，否则尊重 preferred）。
  const need = popHeight + POP_GAP + VIEWPORT_PADDING;
  const spaceAbove = rect.top;
  const spaceBelow = vh - rect.bottom;
  let placeAbove: boolean;
  if (preferred === "above") {
    placeAbove = spaceAbove >= need || spaceAbove >= spaceBelow;
  } else {
    placeAbove = !(spaceBelow >= need || spaceBelow >= spaceAbove);
  }
  let top = placeAbove ? rect.top - popHeight - POP_GAP : rect.bottom + POP_GAP;
  // 视口纠偏
  top = Math.max(VIEWPORT_PADDING, Math.min(top, vh - popHeight - VIEWPORT_PADDING));

  // 横向：右对齐 anchor.right；若导致 left < padding，则改为 left = padding。
  let left = rect.right - POP_WIDTH;
  if (left < VIEWPORT_PADDING) left = VIEWPORT_PADDING;
  if (left + POP_WIDTH > vw - VIEWPORT_PADDING) left = vw - POP_WIDTH - VIEWPORT_PADDING;

  return { top, left };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

interface ExplainerRow {
  color: string;
  label: string;
  value: string;
  hint: string;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 9, fontWeight: 700, color: "#6b7280",
      letterSpacing: "0.05em", textTransform: "uppercase",
      marginBottom: 4,
    }}>
      {children}
    </div>
  );
}

function RowList({ rows }: { rows: ExplainerRow[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <span style={{
            width: 7, height: 7, borderRadius: 2, background: r.color,
            flexShrink: 0, marginTop: 5,
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: "#111827", whiteSpace: "nowrap" }}>
                {r.label}
              </span>
              <span style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 11, fontWeight: 700, color: r.color,
              }}>
                {r.value}
              </span>
            </div>
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 1 }}>{r.hint}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Hover wrapper ───────────────────────────────────────────────────────────
//
// 包装外壳 + 状态：把 onMouseEnter/Leave 挂在外层 div，hover 时测量自身
// boundingClientRect 并交给 LedgerExplainer 通过 portal 渲染到 body。
// 这样不论外层 card 是否 overflow:hidden 都不会被裁切。
//
// 用法：
//   <LedgerHoverWrapper variant="call" freshIn={...} ...>
//     {/* 原来 ledger 的 JSX */}
//   </LedgerHoverWrapper>

export interface LedgerHoverWrapperProps extends Omit<LedgerExplainerProps, "anchorRect"> {
  children: React.ReactNode;
  /** 外层 wrapper 的样式补丁。 */
  style?: React.CSSProperties;
  /** 兼容旧调用：`anchor="below-right"` 映射到 preferredAnchor="below"，"above-right" 同理。 */
  anchor?: "above-right" | "below-right";
}

export function LedgerHoverWrapper({
  children, style, anchor, preferredAnchor, ...explainerProps
}: LedgerHoverWrapperProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // 把旧 anchor 写法映射到新 preferredAnchor；显式 preferredAnchor 优先
  const effectivePreferred: "above" | "below" =
    preferredAnchor ?? (anchor === "above-right" ? "above" : "below");

  const open = () => {
    if (wrapperRef.current) setRect(wrapperRef.current.getBoundingClientRect());
  };
  const close = () => setRect(null);

  return (
    <div
      ref={wrapperRef}
      onMouseEnter={open}
      onMouseLeave={close}
      style={style}
    >
      {children}
      {rect && (
        <LedgerExplainer
          {...explainerProps}
          anchorRect={rect}
          preferredAnchor={effectivePreferred}
        />
      )}
    </div>
  );
}
