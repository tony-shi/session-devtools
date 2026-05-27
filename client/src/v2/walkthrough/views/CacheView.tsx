import type { LlmCall } from "../../drilldown-types";
import type { Focus } from "../types";

// ep4 第一/三幕:Prompt Cache 概念图 —— 整份 context 拆成 命中(灰,几乎免费)/
// 新鲜(绿,要计算)。focus="cache" 按 beat 逐拍揭示;focus="diagram" 静态全图。
// 用真实 call 的 cacheRead / contextSize 算占比。

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function CacheView({ call, focus, beat }: { call: LlmCall | null; focus: Focus; beat: number }) {
  if (!call) return <div style={{ padding: 24, color: "#6b7280" }}>该会话无可用 call。</div>;
  const diagram = focus === "diagram";
  const stage = diagram ? 9 : beat;

  const total = call.contextSize || 1;
  const cached = Math.min(total, call.cacheRead || 0);
  const fresh = Math.max(0, total - cached);
  const cachedPct = (cached / total) * 100;
  const freshPct = 100 - cachedPct;
  const split = stage >= 1; // beat0 = 整条;beat1+ = 拆开

  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "min(640px, 100%)", animation: "wt-fade .4s ease both" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", marginBottom: 10 }}>这一次 Call 的 context · {fmtK(total)} tokens</div>

        {/* 主条 */}
        <div style={{ display: "flex", height: 40, borderRadius: 8, overflow: "hidden", gap: split ? 2 : 0 }}>
          {!split ? (
            <div style={{ width: "100%", background: "#cbd5e1", display: "flex", alignItems: "center", justifyContent: "center", color: "#334155", fontSize: 12, fontWeight: 700 }}>
              整份 context(每次都重新发、重新算?)
            </div>
          ) : (
            <>
              <div style={{ width: `${cachedPct}%`, background: "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: 11, fontWeight: 700 }}>
                {cachedPct > 14 ? `命中 ${fmtK(cached)}` : ""}
              </div>
              <div style={{
                width: `${freshPct}%`, background: "#22c55e", display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: 11, fontWeight: 700, boxShadow: stage >= 2 ? "0 0 0 2px #16a34a inset" : "none",
              }}>
                {freshPct > 8 ? `新鲜 ${fmtK(fresh)}` : ""}
              </div>
            </>
          )}
        </div>

        {/* 图例 / 成本说明 */}
        {split && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 12, fontSize: 12, color: "#475569" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "#e2e8f0" }} /> 缓存命中 · 稳定前缀(tools+system+历史)· 几乎免费
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: "#22c55e" }} /> 新鲜 · 本次新增的尾部(上一章的 diff)· 要计算
            </span>
          </div>
        )}
        {stage >= 3 && (
          <div style={{ marginTop: 14, fontSize: 13, color: "#15803d", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "8px 12px", animation: "wt-fade .3s ease both" }}>
            成本不随 context 线性增长 —— 大头命中缓存,代价只在新鲜的尾部。
          </div>
        )}
        {split && cached === 0 && (
          <div style={{ marginTop: 10, fontSize: 12, color: "#94a3b8" }}>(这条 call 没有缓存命中数据 —— 概念不变:命中部分≈免费,新鲜部分才计算。)</div>
        )}
      </div>
      <style>{`@keyframes wt-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}
