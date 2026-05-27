import type { Focus } from "../types";

// ep7 概念图:skills / MCP / hooks —— 三种扩展,共同点都是"往 context 注入"。
// 三张卡逐拍亮起,底部一条"都流向 context"的汇聚说明。
// focus="inject" 按 beat 逐拍;focus="diagram" 静态全图。

const WAYS: { key: string; label: string; desc: string; color: string }[] = [
  { key: "skills", label: "Skills", desc: "一包专长说明。平时只占一行描述,被调用时才把全文加载进 context。", color: "#6366f1" },
  { key: "mcp", label: "MCP", desc: "接外部服务(数据库 / API / 设计稿)。它的工具和资源,注入进 tools 块。", color: "#10b981" },
  { key: "hooks", label: "Hooks", desc: "在固定时机自动跑命令,把结果或提醒注入进 context。", color: "#f59e0b" },
];

export function ExtendView({ focus, beat }: { focus: Focus; beat: number }) {
  const diagram = focus === "diagram";
  const stage = diagram ? 9 : beat;

  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "min(720px, 100%)", animation: "wt-fade .4s ease both" }}>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>内置工具之外,你可以往 context 里<b style={{ color: "#334155" }}>加新能力</b> —— 三种方式:</div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {WAYS.map((w, i) => {
            const shown = stage >= 1 + i;
            return (
              <div key={w.key} style={{ opacity: shown ? 1 : 0.12, transform: shown ? "none" : "translateY(8px)", transition: "all .35s ease", border: `1px solid ${w.color}40`, background: `${w.color}0d`, borderRadius: 12, padding: "14px 14px" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: w.color }}>{w.label}</div>
                <div style={{ fontSize: 12, color: "#475569", marginTop: 6, lineHeight: 1.5 }}>{w.desc}</div>
              </div>
            );
          })}
        </div>

        {/* 汇聚:都流向 context */}
        {stage >= 4 && (
          <div style={{ marginTop: 18, textAlign: "center", animation: "wt-fade .3s ease both" }}>
            <div style={{ color: "#94a3b8", fontSize: 18 }}>↓ ↓ ↓</div>
            <div style={{ display: "inline-block", marginTop: 4, padding: "10px 22px", borderRadius: 10, background: "#0f172a", color: "#fff", fontSize: 14, fontWeight: 700 }}>都在改变 context 里有什么</div>
          </div>
        )}
        {stage >= 5 && <div style={{ marginTop: 14, fontSize: 13, color: "#475569", textAlign: "center" }}>它们都不改模型本身 —— 只是改变"放进 context 的东西"。</div>}
      </div>
      <style>{`@keyframes wt-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}
