// Σ 标识的"聚合"层 ledger —— 用于 Dashboard 顶 / Session 顶 / Turn 顶 /
// Dashboard 列表行（4 处共用）。与 CallLedger 形成对照：Call 视图永远不带
// Σ，让用户在任何视野内扫到数字都能一眼判断"是聚合的还是单 call 的"。
//
// 列序固定为 prefix 物理装配顺序：
//   Cache Read（历史复用） → Cache Write（本轮写入缓存） → Fresh In（本轮未缓存）
//   + Output（独立计费桶，与 input 三件套并列）
//
// 布局约定：
//   - 上方 label / value 行按 INPUT vs OUTPUT 分组，中间用 1px 竖线分隔（只
//     分隔描述，不分隔 bar）
//   - 下方一条贯通的 bar，4 段并排按 token 比例渲染 —— 跨 ledger 直接可比
//     长度，不会因为 input/output 各自缩放而失真
//
// freshIn 字段语义：严格 API input_tokens（未进缓存的部分），不再带"广义"
// 折叠 cache_write 的旧 hack —— bar 和 column 完全同源，cache_write 单独
// 成列。

import React from "react";
import { TOKEN_METRICS } from "../metricRegistry";
import { LedgerHoverWrapper, LedgerInfoIcon } from "./LedgerExplainer";

const SIGMA = "∑";

function fmtK(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

function fmtPct(n: number): string {
  return n.toFixed(1) + "%";
}

// ratioTooltip 已被 LedgerExplainer (popover) 取代；旧的 native title=
// 字符串已经下线，删除避免遗留死代码。

export interface AggregateLedgerFullProps {
  size: "full";
  freshIn: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cacheRatio?: number | null;
  /** Drop top padding when used inside a horizontal layout. */
  noTopPadding?: boolean;
}

export interface AggregateLedgerCompactProps {
  size: "compact";
  freshIn: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cacheRatio?: number | null;
  /** Required for compact: max grand-total (input+output) across siblings,
   *  used to scale the unified bar consistently row-to-row. */
  maxTotal: number;
}

export type AggregateLedgerProps = AggregateLedgerFullProps | AggregateLedgerCompactProps;

export function AggregateLedger(p: AggregateLedgerProps) {
  const inputTotal = p.freshIn + p.cacheRead + p.cacheWrite;
  const ratio = p.cacheRatio ?? (inputTotal > 0 ? (p.cacheRead / inputTotal) * 100 : null);
  if (p.size === "full") {
    return <FullView freshIn={p.freshIn} cacheRead={p.cacheRead} cacheWrite={p.cacheWrite}
      output={p.output} ratio={ratio} inputTotal={inputTotal} noTopPadding={p.noTopPadding} />;
  }
  return <CompactView freshIn={p.freshIn} cacheRead={p.cacheRead} cacheWrite={p.cacheWrite}
    output={p.output} ratio={ratio} inputTotal={inputTotal} maxTotal={p.maxTotal} />;
}

// ─── Full ─────────────────────────────────────────────────────────────────────

interface ViewBase {
  freshIn: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  ratio: number | null;
  inputTotal: number;
}

function FullView({ freshIn, cacheRead, cacheWrite, output, ratio, inputTotal, noTopPadding }:
                  ViewBase & { noTopPadding?: boolean }) {
  const M = TOKEN_METRICS;

  const inputCols = [
    { id: "cache_read",  value: cacheRead },
    { id: "cache_write", value: cacheWrite },
    { id: "fresh_input", value: freshIn },
  ];

  return (
    <LedgerHoverWrapper
      variant="aggregate"
      freshIn={freshIn} cacheRead={cacheRead} cacheWrite={cacheWrite}
      output={output} ratio={ratio}
      anchor="below-right"
      style={{
        paddingTop: noTopPadding ? 0 : 10,
        display: "flex", flexDirection: "column", gap: 6,
      }}
    >
      {/* Top: labels + values, INPUT and OUTPUT regions split by a 1px line
          (description only — the bar below stays unified). */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 16 }}>
        {/* INPUT region */}
        <div style={{ flex: "1 1 auto", minWidth: 0 }}>
          {/* Section header row: Σ INPUT + Cache Ratio.
              cache_ratio is a derived percentage — no Σ (accumulation is
              meaningless), and styled as a regular "metric label + value"
              pair so it visually slots next to Cache Read / Cache Write /
              Fresh In rather than competing with the section header. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <span style={sectionHeaderStyle}>{SIGMA} INPUT</span>
            {ratio != null && (
              <>
                <div style={{ width: 1, height: 12, background: "#e5e7eb" }} />
                {/* Cache ratio chip + inline info trigger. Vertical
                    separator visually disconnects the trigger from the
                    ratio number. */}
                <span style={{
                  display: "inline-flex", alignItems: "baseline", gap: 4,
                }}>
                  <span style={metricLabelStyle}>{M.cache_ratio.label}</span>
                  <span style={{ ...metricValueStyle, color: M.cache_ratio.color }}>
                    {fmtPct(ratio)}
                  </span>
                </span>
                <div style={{ width: 1, height: 12, background: "#e5e7eb" }} />
                <LedgerInfoIcon
                  variant="aggregate"
                  freshIn={freshIn} cacheRead={cacheRead} cacheWrite={cacheWrite}
                  output={output} ratio={ratio}
                  preferredAnchor="below"
                />
              </>
            )}
          </div>

          <div style={{ display: "flex", gap: 20, alignItems: "flex-end" }}>
            {inputCols.map(({ id, value }) => {
              const m = M[id];
              const has = value > 0;
              return (
                <div key={id} style={{ whiteSpace: "nowrap" }}>
                  <div style={metricLabelStyle}>{m.label}</div>
                  <div style={{ ...metricValueStyle, color: has ? m.color : "#d1d5db" }}>
                    {has ? fmtK(value) : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Separator — description only, does not extend to bar */}
        <div style={{ width: 1, background: "#f3f4f6", alignSelf: "stretch" }} />

        {/* OUTPUT region — Σ OUTPUT serves as both the section header *and*
            the metric label (only one metric here), so no second "Output"
            label below. A 1-line spacer keeps the value baseline aligned
            with the input-side values. */}
        <div style={{ flex: "0 0 auto", minWidth: 80, whiteSpace: "nowrap" }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
            <span style={sectionHeaderStyle}>{SIGMA} OUTPUT</span>
          </div>
          <div>
            {/* Invisible spacer matching input-side metric label line height
                so the value rows on both sides land on the same baseline. */}
            <div style={{ ...metricLabelStyle, visibility: "hidden" }}>&nbsp;</div>
            <div style={{ ...metricValueStyle, color: output > 0 ? M.output.color : "#d1d5db" }}>
              {output > 0 ? fmtK(output) : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Unified bar — 4 segments end-to-end so widths are directly comparable
          across the whole ledger (and across sibling ledgers). */}
      <UnifiedBar
        segments={[
          { value: cacheRead,  color: M.cache_read.color },
          { value: cacheWrite, color: M.cache_write.color },
          { value: freshIn,    color: M.fresh_input.color },
          { value: output,     color: M.output.color },
        ]}
      />
    </LedgerHoverWrapper>
  );
}

// ─── Compact ──────────────────────────────────────────────────────────────────

function CompactView({ freshIn, cacheRead, cacheWrite, output, ratio, inputTotal, maxTotal }:
                     ViewBase & { maxTotal: number }) {
  const M = TOKEN_METRICS;
  const grandTotal = inputTotal + output;

  // List rows live in a tight horizontal slot — fall back to a flat 5-column
  // layout (no Σ prefix, no INPUT/OUTPUT grouping headers). The dashboard list
  // context already implies aggregate, so the Σ semantic is redundant here.
  // Column order matches user request:
  //   Cache Read · Cache Write · Fresh In · Cache Ratio · Output
  const columns: Array<{ id: string; label: string; value: number; color: string; isPct?: boolean }> = [
    { id: "cache_read",  label: M.cache_read.label,   value: cacheRead,  color: M.cache_read.color },
    { id: "cache_write", label: M.cache_write.label,  value: cacheWrite, color: M.cache_write.color },
    { id: "fresh_input", label: M.fresh_input.label,  value: freshIn,    color: M.fresh_input.color },
    { id: "cache_ratio", label: M.cache_ratio.label,  value: ratio ?? 0, color: M.cache_ratio.color, isPct: true },
    { id: "output",      label: M.output.label,       value: output,     color: M.output.color },
  ];

  return (
    <LedgerHoverWrapper
      variant="aggregate"
      freshIn={freshIn} cacheRead={cacheRead} cacheWrite={cacheWrite}
      output={output} ratio={ratio}
      anchor="below-right"
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      {/* Flat 5-column grid: label on top row, value below, fixed column
          widths sized to fit each label without wrapping. */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "60px 64px 52px 56px 52px",
        alignItems: "end",
      }}>
        {columns.map(({ id, label, value, color, isPct }) => {
          const has = isPct ? (ratio != null) : (value > 0);
          return (
            <div key={id} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, whiteSpace: "nowrap" }}>
                {label}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: has ? color : "#d1d5db", lineHeight: 1, whiteSpace: "nowrap" }}>
                {has ? (isPct ? fmtPct(ratio!) : fmtK(value)) : "—"}
              </span>
            </div>
          );
        })}
      </div>

      {/* Unified stacked bar, scaled to maxTotal so adjacent rows are
          visually comparable. */}
      {grandTotal > 0 && (
        <div style={{
          width: "100%", height: 3, borderRadius: 2,
          background: "#f3f4f6", overflow: "hidden",
        }}>
          <div style={{
            width: maxTotal > 0 ? `${(grandTotal / maxTotal) * 100}%` : 0,
            height: "100%", display: "flex",
          }}>
            {cacheRead  > 0 && <div style={{ flex: cacheRead,  background: M.cache_read.color }} />}
            {cacheWrite > 0 && <div style={{ flex: cacheWrite, background: M.cache_write.color }} />}
            {freshIn    > 0 && <div style={{ flex: freshIn,    background: M.fresh_input.color }} />}
            {output     > 0 && <div style={{ flex: output,     background: M.output.color }} />}
          </div>
        </div>
      )}
    </LedgerHoverWrapper>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function UnifiedBar({ segments }: { segments: { value: number; color: string }[] }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return null;
  return (
    <div style={{
      height: 4, borderRadius: 2, overflow: "hidden",
      display: "flex", background: "#f3f4f6",
    }}>
      {segments.filter(s => s.value > 0).map((s, i) => (
        <div key={i} style={{ flex: s.value, background: s.color }} />
      ))}
    </div>
  );
}

// Section header (Σ INPUT / Σ OUTPUT) sits one tier above metric labels so
// the hierarchy "section → metric → value" reads at a glance.
const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#4b5563",
  textTransform: "uppercase", letterSpacing: "0.05em",
  whiteSpace: "nowrap",
};

const metricLabelStyle: React.CSSProperties = {
  fontSize: 9, color: "#9ca3af", fontWeight: 500,
  marginBottom: 2, whiteSpace: "nowrap",
};

const metricValueStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, lineHeight: 1,
};

