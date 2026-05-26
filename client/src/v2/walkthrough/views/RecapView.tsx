// 第七幕:回顾 —— 把整套结构按层级逐行点亮(StatQuest 式"回到同一张图")。
// 不再回到多轮对话视图,而是一张干净的结构小结。每行随 beat 揭示。

const ROWS: { depth: number; term: string; desc: string; color: string }[] = [
  { depth: 0, term: "Session", desc: "一次完整的会话", color: "#64748b" },
  { depth: 1, term: "Turn", desc: "一次用户请求,以及为回答它的全部工作", color: "#6366f1" },
  { depth: 2, term: "LLM Call", desc: "一次带着具体 context 的模型请求", color: "#6366f1" },
  { depth: 3, term: "tool_use", desc: "模型想做什么(提出的动作)", color: "#0f766e" },
  { depth: 3, term: "tool_result", desc: "现实返回了什么(执行的证据)", color: "#0f766e" },
  { depth: 1, term: "Loop", desc: "结果塞回 context,循环到 LLM 决定终止", color: "#16a34a" },
];

export function RecapView({ beat }: { beat: number }) {
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "100%", maxWidth: 620, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 6 }}>回顾 · 一整套结构</div>
        {ROWS.map((r, i) => {
          const shown = i <= beat;
          return (
            <div
              key={i}
              style={{
                marginLeft: r.depth * 30,
                display: "flex", alignItems: "baseline", gap: 12,
                opacity: shown ? 1 : 0.14,
                transition: "opacity .4s ease",
                animation: shown ? "wt-rise .35s ease both" : undefined,
              }}
            >
              <span style={{ fontSize: 17, fontWeight: 700, color: r.color, fontFamily: "monospace", flexShrink: 0 }}>
                {r.depth > 0 ? "└ " : ""}{r.term}
              </span>
              <span style={{ fontSize: 14, color: "#475569" }}>{r.desc}</span>
            </div>
          );
        })}

        {/* 结构点亮完后,点出官方心智模型:三阶段 + 两引擎 */}
        {beat >= ROWS.length && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px dashed #e5e7eb", animation: "wt-rise .4s ease both" }}>
            <div style={{ fontSize: 15, color: "#111827", fontWeight: 600 }}>
              🔁 整个循环 = <span style={{ color: "#6366f1" }}>收集上下文</span> → <span style={{ color: "#0f766e" }}>采取行动</span> → <span style={{ color: "#16a34a" }}>验证结果</span>
            </div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 8 }}>
              驱动它的只有两件事:<b style={{ color: "#6366f1" }}>模型</b>负责推理,<b style={{ color: "#0f766e" }}>工具</b>负责行动。
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes wt-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}
