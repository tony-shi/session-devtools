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
// 暴露 useLedgerHover() hook 让 CallLedger / AggregateLedger 自己决定何时
// 把 wrapper 设为 position: relative；popover 节点位置 absolute，挂在
// wrapper 内部。

import React, { useState } from "react";
import { TOKEN_METRICS } from "../metricRegistry";

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
  /** popover 锚点。"above-right" 在 ledger 上方右对齐，"below-right" 在下方右对齐。
   *  默认 above-right —— 大多数 ledger 都贴在 page top，下方有内容容易遮住。 */
  anchor?: "above-right" | "below-right";
}

export function LedgerExplainer({
  variant, freshIn, cacheRead, cacheWrite, output, ratio, anchor = "above-right",
}: LedgerExplainerProps) {
  const M = TOKEN_METRICS;
  const isAgg = variant === "aggregate";
  const sigma = isAgg ? "Σ" : "";

  const inputTotal = freshIn + cacheRead + cacheWrite;
  const ratioFormula =
    ratio != null
      ? `${fmtK(cacheRead)} / (${fmtK(cacheRead)} + ${fmtK(cacheWrite)} + ${fmtK(freshIn)}) = ${fmtPct(ratio)}`
      : null;

  // 输入侧 4 行：cache_read / cache_write / fresh_input / cache_ratio (derived)
  // 顺序对齐 ledger 本体的列序：read → write → fresh → ratio
  const inputRows: ExplainerRow[] = [
    {
      color: M.cache_read.color,
      label: M.cache_read.label,
      value: fmtK(cacheRead),
      hint: isAgg
        ? "累计历史复用：从过往 call 的缓存命中读回"
        : "历史复用：从过往 call 的缓存读回，不需要重新过模型",
    },
    {
      color: M.cache_write.color,
      label: M.cache_write.label,
      value: fmtK(cacheWrite),
      hint: isAgg
        ? "累计写入缓存：被打了 cache breakpoint 的本轮新内容"
        : "本轮写入缓存：第一次给模型、且被打了 cache breakpoint 供下次复用",
    },
    {
      color: M.fresh_input.color,
      label: M.fresh_input.label,
      value: fmtK(freshIn),
      hint: isAgg
        ? "累计未缓存输入：本轮新内容中未被打 cache breakpoint 的部分"
        : "本轮未缓存：第一次给模型、且没被 cache breakpoint 拦下的部分",
    },
  ];

  const outputRows: ExplainerRow[] = [
    {
      color: M.output.color,
      label: M.output.label,
      value: fmtK(output),
      hint: isAgg ? "累计模型生成 token" : "LLM 这一 call 生成的 token",
    },
  ];

  // 上方 / 下方定位
  const popStyle: React.CSSProperties = anchor === "below-right"
    ? { position: "absolute", top: "calc(100% + 6px)", right: 0 }
    : { position: "absolute", bottom: "calc(100% + 6px)", right: 0 };

  return (
    <div
      role="tooltip"
      style={{
        ...popStyle,
        zIndex: 1000,
        width: 380,
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
        <span>Token 账本 · 计算说明</span>
        <span style={{
          fontSize: 9, fontWeight: 600, color: "#6366f1",
          background: "#eef2ff", border: "1px solid #c7d2fe",
          borderRadius: 3, padding: "1px 5px", letterSpacing: 0,
          textTransform: "none",
        }}>
          {isAgg ? "Σ 聚合" : "单 call"}
        </span>
      </div>

      {/* INPUT */}
      <SectionTitle>{sigma} 输入（喂给模型的内容）</SectionTitle>
      <RowList rows={inputRows} />

      {/* Cache Ratio derived */}
      {ratioFormula && (
        <div style={{
          marginTop: 6, padding: "6px 8px",
          background: "#fafafa", border: "1px solid #f3f4f6", borderRadius: 6,
          fontSize: 10, color: "#374151",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
            <span style={{ width: 6, height: 6, borderRadius: 1, background: M.cache_ratio.color }} />
            <span style={{ fontWeight: 700, color: M.cache_ratio.color }}>{M.cache_ratio.label}</span>
            <span style={{ color: "#9ca3af" }}>· {isAgg ? "Σcache_read / Σ(input 三件套)" : "cache_read / (cache_read + cache_write + fresh_in)"}</span>
          </div>
          <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "#111827" }}>
            = {ratioFormula}
          </div>
        </div>
      )}

      {inputTotal === 0 && (
        <div style={{ fontSize: 10, color: "#9ca3af", fontStyle: "italic", padding: "4px 0" }}>
          本次没有 input —— 三个 input 桶都为 0，Cache Ratio 无意义。
        </div>
      )}

      {/* OUTPUT */}
      <div style={{ height: 8 }} />
      <SectionTitle>{sigma} 输出（模型生成的内容）</SectionTitle>
      <RowList rows={outputRows} />

      {/* Footer note */}
      <div style={{
        marginTop: 10, paddingTop: 8, borderTop: "1px dashed #f3f4f6",
        fontSize: 10, color: "#9ca3af", lineHeight: 1.55,
      }}>
        以上 <strong style={{ color: "#6b7280" }}>四个桶互不重叠</strong>，
        对应 Anthropic API 的真实计费档位：
        cache_read ≈ 0.1× 折扣 · cache_write ≈ 1.25× 溢价 · fresh_in ≈ 1.0× 标准 · output 独立计费。
        {isAgg && " 聚合视图下，每个桶的数值都是 session/turn 范围内的累加。"}
      </div>
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

// ─── Hover wrapper ───────────────────────────────────────────────────────────
//
// 包装外壳 + 状态：把 onMouseEnter/Leave 挂在外层 div，hover 时渲染 popover。
// ledger 实现只需要把自己的内容塞进 children，再传 ledger 各字段过来。
//
// 用法：
//   <LedgerHoverWrapper variant="call" freshIn={...} ...>
//     {/* 原来 ledger 的 JSX */}
//   </LedgerHoverWrapper>

export interface LedgerHoverWrapperProps extends LedgerExplainerProps {
  children: React.ReactNode;
  /** 外层 wrapper 的样式补丁；继承 position:relative 给 popover 锚定。 */
  style?: React.CSSProperties;
}

export function LedgerHoverWrapper({
  children, style, ...explainerProps
}: LedgerHoverWrapperProps) {
  const [open, setOpen] = useState(false);
  return (
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      style={{ position: "relative", ...style }}
    >
      {children}
      {open && <LedgerExplainer {...explainerProps} />}
    </div>
  );
}
