import type { Focus } from "../types";

// ep4 概念图:tools 是 context 的关键部分。
// 放大 Ep2 三块条里的 tools 块 → 五大类逐拍揭示 → 强调"稳定大前缀"(给 cache 埋钩子)。
// focus="tools-cat" 按 beat 逐拍;focus="diagram" 静态全图。

const CATS: { label: string; tools: string; color: string }[] = [
  { label: "文件", tools: "Read · Write · Edit", color: "#3b82f6" },
  { label: "搜索", tools: "Grep · Glob", color: "#8b5cf6" },
  { label: "执行", tools: "Bash · git", color: "#ef4444" },
  { label: "网络", tools: "WebFetch · WebSearch", color: "#10b981" },
  { label: "代码智能", tools: "LSP · 跳转 / 诊断", color: "#f59e0b" },
];

export function ToolsView({ focus, beat }: { focus: Focus; beat: number }) {
  const diagram = focus === "diagram";
  const stage = diagram ? 9 : beat;

  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "min(680px, 100%)", animation: "wt-fade .4s ease both" }}>
        {/* Ep2 三块条:高亮中间 tools 块 */}
        <div style={{ display: "flex", height: 30, borderRadius: 8, overflow: "hidden", marginBottom: 4, border: "1px solid #e5e7eb" }}>
          <div style={{ width: "22%", background: "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#64748b" }}>system</div>
          <div style={{ width: "50%", background: "#6366f1", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#fff", fontWeight: 700, boxShadow: stage >= 1 ? "inset 0 0 0 2px #312e81" : "none" }}>tools(常常最大的一块)</div>
          <div style={{ width: "28%", background: "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#64748b" }}>messages</div>
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 18 }}>放大中间这块 —— 每个可用工具的完整说明书。Piebald 数过:<b style={{ color: "#6366f1" }}>82 段</b>。</div>

        {/* 五大类 */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {CATS.map((c, i) => {
            const shown = stage >= 2 + i;
            return (
              <div key={c.label} style={{ opacity: shown ? 1 : 0.12, transform: shown ? "none" : "translateY(6px)", transition: "all .35s ease", border: `1px solid ${c.color}33`, background: `${c.color}0d`, borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: c.color }}>{c.label}</div>
                <div style={{ fontSize: 12, color: "#475569", marginTop: 2 }}>{c.tools}</div>
              </div>
            );
          })}
        </div>

        {stage >= 7 && <div style={{ marginTop: 16, fontSize: 13, color: "#312e81", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 8, padding: "8px 12px", animation: "wt-fade .3s ease both" }}>它几乎每轮都不变 —— 一块巨大的<b>稳定前缀</b>。(记住这点,下一集 cache 会用到。)</div>}
      </div>
      <style>{`@keyframes wt-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}
