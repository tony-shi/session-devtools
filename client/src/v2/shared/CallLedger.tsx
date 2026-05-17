// 单 call 维度的 ledger —— 在 aggregate 版基础上加一层"历史复用 vs 本轮新
// 处理"的语义分组。
//
// 分组依据 = Claude API 真实计费档位：
//   历史复用    = cache_read              （0.1× 折扣，从过往 call 缓存命中）
//   本轮新处理  = cache_write + fresh_in  （1.25× 写入溢价 / 1× 标准价，
//                                          本 call 第一次给模型看的内容）
//
// 与 AggregateLedger 形成对照：Call 视图永远不带 Σ，让用户在任何视野内
// 扫到数字都能一眼判断"是聚合还是单 call"。
//
// 布局约定（与 AggregateLedger 对齐）：
//   - 上方 label / value 行按 INPUT vs OUTPUT 分组，中间 1px 竖线只分隔
//     描述，不延伸到 bar
//   - INPUT 区内部又用 subtitle 区分"历史复用 / 本轮新处理"两个分组
//   - 下方一条贯通 bar (cache_read | cache_write | fresh_in | output)，所有
//     段共享同一尺度，比例可直接对比
//
// 分组宽度 = 等分（不挂钩 token 数值）。早期版本错误地用 token 数值当 flex
// 权重，导致 cache_read 33k vs newProcess 700 的比例把"本轮新处理"卡片
// 压成 1 字宽 4 行高的竖条 —— 现在改为叙事卡片固定结构，比例完全由 bar 承担。

import React from "react";
import { TOKEN_METRICS } from "../metricRegistry";
import { LedgerHoverWrapper, LedgerInfoIcon } from "./LedgerExplainer";

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
// 字符串已经下线，不再需要这个函数。删除避免遗留死代码。

export interface CallLedgerFullProps {
  size: "full";
  freshIn: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cacheRatio?: number | null;
  noTopPadding?: boolean;
}

export interface CallLedgerCompactProps {
  size: "compact";
  freshIn: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cacheRatio?: number | null;
  maxTotal: number;
}

export type CallLedgerProps = CallLedgerFullProps | CallLedgerCompactProps;

export function CallLedger(p: CallLedgerProps) {
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

function FullView({ freshIn, cacheRead, cacheWrite, output, ratio, noTopPadding }:
                  ViewBase & { noTopPadding?: boolean }) {
  const M = TOKEN_METRICS;

  return (
    <LedgerHoverWrapper
      variant="call"
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
          {/* INPUT section header + ratio. cache_ratio is a derived
              percentage, no Σ in any view. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <span style={sectionHeaderStyle}>INPUT</span>
            {ratio != null && (
              <>
                <div style={{ width: 1, height: 12, background: "#e5e7eb" }} />
                {/* Cache ratio chip + inline info trigger. Vertical
                    separator visually disconnects the trigger from the
                    ratio number so users read it as "tap here to learn
                    more" rather than as part of the metric. */}
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  fontSize: 9, fontWeight: 700, color: M.cache_ratio.color,
                }}>
                  CACHE RATIO
                  <span>{fmtPct(ratio)}</span>
                </span>
                <div style={{ width: 1, height: 12, background: "#e5e7eb" }} />
                <LedgerInfoIcon
                  variant="call"
                  freshIn={freshIn} cacheRead={cacheRead} cacheWrite={cacheWrite}
                  output={output} ratio={ratio}
                  preferredAnchor="below"
                />
              </>
            )}
          </div>

          {/* Two equal-width groups inside INPUT */}
          <div style={{ display: "flex", gap: 24, alignItems: "stretch" }}>
            <Group title="历史复用" subtitle="从过往 call 沿用">
              <Stat label={M.cache_read.label} value={cacheRead} color={M.cache_read.color} />
            </Group>
            <div style={{ width: 1, background: "#f3f4f6", alignSelf: "stretch" }} />
            <Group title="本轮新处理" subtitle="这一轮第一次给模型">
              <div style={{ display: "flex", gap: 16 }}>
                <Stat label={M.cache_write.label} value={cacheWrite} color={M.cache_write.color} />
                <Stat label={M.fresh_input.label} value={freshIn}    color={M.fresh_input.color} />
              </div>
            </Group>
          </div>
        </div>

        {/* Separator between INPUT and OUTPUT regions (description only) */}
        <div style={{ width: 1, background: "#f3f4f6", alignSelf: "stretch" }} />

        {/* OUTPUT region — OUTPUT serves as both section header and metric
            label (only one metric), so no second "Output" label.
            Two invisible spacers keep the value baseline + subtitle line
            aligned with the input-side groups (which carry an extra "group
            title" + "metric label" row above the value). */}
        <div style={{ flex: "0 0 auto", minWidth: 90 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
            <span style={sectionHeaderStyle}>OUTPUT</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {/* Spacer for the "历史复用 / 本轮新处理" group title row on the left */}
            <div style={{ fontSize: 10, fontWeight: 700, visibility: "hidden" }}>&nbsp;</div>
            {/* Spacer for the metric label row on the left (Cache Read / etc.)
                + the value itself */}
            <div>
              <div style={{ fontSize: 9, fontWeight: 500, marginBottom: 2, visibility: "hidden" }}>&nbsp;</div>
              <div style={{ fontSize: 11, fontWeight: 700, lineHeight: 1, color: output > 0 ? M.output.color : "#d1d5db" }}>
                {output > 0 ? fmtK(output) : "—"}
              </div>
            </div>
            <div style={{ fontSize: 9, color: "#9ca3af", marginTop: 2 }}>模型生成</div>
          </div>
        </div>
      </div>

      {/* Unified bar — 4 segments end-to-end, scale shared across the whole
          ledger so widths are directly comparable. */}
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

  // Mirrors AggregateLedger CompactView's 5-column flat layout — Call card
  // thumbnails get the same visual rhythm as the Turn-top ledger, just
  // without the Σ prefix (since each row represents a single call, not an
  // aggregate). The two-group "历史复用 / 本轮新处理" narrative is dropped
  // here to keep the per-call thumbnail visually identical to its
  // aggregated siblings — much easier to scan rows at a glance.
  const columns: Array<{ id: string; label: string; value: number; color: string; isPct?: boolean }> = [
    { id: "cache_read",  label: M.cache_read.label,   value: cacheRead,  color: M.cache_read.color },
    { id: "cache_write", label: M.cache_write.label,  value: cacheWrite, color: M.cache_write.color },
    { id: "fresh_input", label: M.fresh_input.label,  value: freshIn,    color: M.fresh_input.color },
    { id: "cache_ratio", label: M.cache_ratio.label,  value: ratio ?? 0, color: M.cache_ratio.color, isPct: true },
    { id: "output",      label: M.output.label,       value: output,     color: M.output.color },
  ];

  return (
    <LedgerHoverWrapper
      variant="call"
      freshIn={freshIn} cacheRead={cacheRead} cacheWrite={cacheWrite}
      output={output} ratio={ratio}
      anchor="below-right"
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
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

function Group({ title, subtitle, children }: {
  title: string; subtitle: string; children: React.ReactNode;
}) {
  return (
    <div style={{
      flex: "1 1 0", minWidth: 0,
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      {title && (
        <div style={{
          fontSize: 10, color: "#374151", fontWeight: 700,
        }}>
          {title}
        </div>
      )}
      <div>{children}</div>
      <div style={{ fontSize: 9, color: "#9ca3af", marginTop: 2 }}>{subtitle}</div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  const has = value > 0;
  return (
    <div>
      <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, marginBottom: 2, whiteSpace: "nowrap" }}>
        {label}
      </div>
      <div style={{ fontSize: 11, fontWeight: 700, lineHeight: 1, color: has ? color : "#d1d5db" }}>
        {has ? fmtK(value) : "—"}
      </div>
    </div>
  );
}

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

// Section header (INPUT / OUTPUT) one tier above metric labels — matches
// AggregateLedger.sectionHeaderStyle so Call & Aggregate views share the
// same typographic rhythm.
const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#4b5563",
  textTransform: "uppercase", letterSpacing: "0.05em",
  whiteSpace: "nowrap",
};

