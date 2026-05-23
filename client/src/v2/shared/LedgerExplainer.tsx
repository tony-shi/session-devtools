// LedgerExplainer —— Token 账本 hover 时弹出的解释 popover。
//
// 历史背景：之前用 createPortal + 手写 boundingClientRect 计算 + 上下翻转
// 共 ~365 行；现已迁移到 shadcn HoverCard（Radix 底层），自动处理 portal、
// collision detection、翻转、视口纠偏、focus/keyboard 可达性。
//
// 仍保留：
//   - 4 色点 metric row（cache_read / cache_write / fresh_input / output）
//   - Cache Ratio 公式段
//   - call / aggregate 两个 variant 的不同提示文案
//   - i18n footer 用 dangerouslySetInnerHTML 渲染 <strong>

import React from "react";
import { useTranslation } from "react-i18next";
import { TOKEN_METRICS } from "../metricRegistry";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { BRAND } from "./brand";

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
}

/**
 * 纯内容渲染——不含 portal/定位逻辑，由 HoverCardContent 或调用者负责挂载。
 */
export function LedgerExplainerBody({
  variant, freshIn, cacheRead, cacheWrite, output, ratio,
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

  return (
    <div style={{ fontSize: 11, color: "#374151", lineHeight: 1.5 }}>
      {/* Title */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontWeight: 700, fontSize: 11, color: "#111827",
        letterSpacing: "0.04em", textTransform: "uppercase",
        marginBottom: 8,
      }}>
        <span>{t("ledgerExplainer.title")}</span>
        <span style={{
          fontSize: 9, fontWeight: 600, color: BRAND.indigo500,
          background: BRAND.indigo50, border: "1px solid #c7d2fe",
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

// ─── Hover wrapper (back-compat pass-through) ────────────────────────────────

export interface LedgerHoverWrapperProps extends LedgerExplainerProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
  anchor?: "above-right" | "below-right";
}

/**
 * @deprecated Use a plain wrapper `<div>` + `<LedgerInfoIcon>` placed inline
 * where you want the info trigger to appear. This wrapper is kept as a
 * pass-through so old callers don't break, but it no longer renders an icon.
 */
export function LedgerHoverWrapper({
  children, style,
}: LedgerHoverWrapperProps) {
  return <div style={style}>{children}</div>;
}

/**
 * Inline info trigger that pops the ledger explainer on hover. Uses shadcn
 * HoverCard under the hood (Radix portal + collision detection).
 */
export function LedgerInfoIcon({
  preferredAnchor = "below",
  ...explainerProps
}: LedgerExplainerProps & { preferredAnchor?: "above" | "below" }) {
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <span
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 16, height: 16, borderRadius: "50%",
            background: BRAND.indigo50, color: BRAND.indigo700,
            border: "1px solid #c7d2fe",
            fontSize: 11, fontWeight: 700, fontStyle: "italic",
            fontFamily: "'Georgia', 'Times New Roman', serif",
            lineHeight: 1, cursor: "help", userSelect: "none",
            flexShrink: 0,
          }}
        >
          i
        </span>
      </HoverCardTrigger>
      <HoverCardContent
        side={preferredAnchor === "above" ? "top" : "bottom"}
        align="end"
        className="w-[460px] p-3"
      >
        <LedgerExplainerBody {...explainerProps} />
      </HoverCardContent>
    </HoverCard>
  );
}
