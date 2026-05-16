// Cache 公式盒：把 TokenLedger 顶部的 4 个数字之间的关系用公式形式显式写出，
// 帮助新人在 dashboard 上一眼建立"输入 token 是怎么拆出来的"心智模型。
//
// 设计折中：
//   - 借鉴 claude-visual dark 范式的 formula-box（monospace + 灰副标 + 居中），
//     但适配我们的浅色主题（#f9fafb 底 / #e5e7eb 边）。
//   - 默认折叠成一个小 "Cache 公式" 按钮，点击展开 —— 避免占用 dashboard
//     summary 现有的紧凑布局。
//   - 当前实现只展示**本 call / aggregate 的 4 桶恒等式**（input_total =
//     fresh_in + cache_read + cache_write）。跨 call 的滚雪球公式
//     (cache_read[N+1] = cache_read[N] + cache_creation[N]) 等 OriginCall lens
//     接入后再补。

import { useState } from "react";
import { TOKEN_METRICS } from "../metricRegistry";

interface Props {
  freshIn: number;
  cacheRead: number;
  cacheWrite: number;
}

function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

export function CacheFormulaBox({ freshIn, cacheRead, cacheWrite }: Props) {
  const [open, setOpen] = useState(false);
  const total = freshIn + cacheRead + cacheWrite;
  if (total <= 0) return null;
  const ratio = (cacheRead / total) * 100;
  const M = TOKEN_METRICS;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          alignSelf: "flex-start",
          border: "1px dashed #d1d5db",
          background: "transparent",
          color: "#6b7280",
          fontSize: 9,
          fontWeight: 600,
          padding: "2px 8px",
          borderRadius: 4,
          cursor: "pointer",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          lineHeight: 1.4,
        }}
        title="展开 cache 公式"
      >
        Cache 公式
      </button>
    );
  }

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        background: "#f9fafb",
        border: "1px solid #e5e7eb",
        borderRadius: 6,
        padding: "8px 12px",
        cursor: "pointer",
        lineHeight: 1.6,
      }}
      title="点击折叠"
    >
      <div style={{
        color: "#9ca3af", fontSize: 9, fontWeight: 600,
        textTransform: "uppercase", letterSpacing: "0.05em",
        marginBottom: 4,
      }}>
        输入 token 拆解
      </div>
      <div style={{
        fontFamily: '"SF Mono", Menlo, monospace',
        fontSize: 11, color: "#374151",
      }}>
        <div>
          <span style={{ color: "#111827", fontWeight: 600 }}>input_total</span>
          {" = "}
          <span style={{ color: M.fresh_input.color, fontWeight: 600 }}>fresh_in</span>
          {" + "}
          <span style={{ color: M.cache_read.color, fontWeight: 600 }}>cache_read</span>
          {" + "}
          <span style={{ color: M.cache_write.color, fontWeight: 600 }}>cache_write</span>
        </div>
        <div style={{ color: "#6b7280" }}>
          {" = "}{fmt(freshIn)} + {fmt(cacheRead)} + {fmt(cacheWrite)}
          {" = "}
          <span style={{ color: "#111827", fontWeight: 600 }}>{fmt(total)}</span>
        </div>
        <div style={{ marginTop: 4 }}>
          <span style={{ color: M.cache_ratio.color, fontWeight: 600 }}>cache_ratio</span>
          {" = cache_read / input_total = "}
          <span style={{ color: M.cache_ratio.color, fontWeight: 600 }}>
            {ratio.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}
