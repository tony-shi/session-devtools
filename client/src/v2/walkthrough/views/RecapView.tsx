// 第七幕:回顾 —— 把整套结构按层级逐行点亮(StatQuest 式"回到同一张图")。
// 不再回到多轮对话视图,而是一张干净的结构小结。每行随 beat 揭示。
// 配色沿用统一演员色:靛蓝 = 模型侧(Call / tool_use),teal = 现实侧(tool_result),绿 = 收束。

import { ACTOR_COLOR } from "../actorPalette";

const ROWS: { depth: number; term: string; desc: string; color: string }[] = [
  { depth: 0, term: "Session", desc: "一次完整的会话", color: "#64748b" },
  { depth: 1, term: "Turn", desc: "一次用户请求,以及为回答它的全部工作", color: ACTOR_COLOR.llm.main },
  { depth: 2, term: "LLM Call", desc: "一次带着具体 context 的模型请求", color: ACTOR_COLOR.llm.main },
  { depth: 3, term: "tool_use", desc: "模型想做什么(提出的动作)", color: ACTOR_COLOR.llm.main },
  { depth: 3, term: "tool_result", desc: "现实返回了什么(执行的证据)", color: ACTOR_COLOR.agent.main },
  { depth: 1, term: "Loop", desc: "结果塞回 context,跳回一次新的 LLM Call —— 循环到 LLM 决定终止", color: ACTOR_COLOR.done.main },
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

        {/* 结构点亮完后,点出官方心智模型:三阶段闭环(带「回到开头」的回环箭头)+ 两引擎 */}
        {beat >= ROWS.length && (
          <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px dashed #e5e7eb", animation: "wt-rise .4s ease both" }}>
            <div style={{ position: "relative", paddingBottom: 52 }}>
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 700 }}>
                <span style={{ padding: "7px 14px", borderRadius: 10, background: ACTOR_COLOR.llm.bg, color: ACTOR_COLOR.llm.main, border: `1px solid ${ACTOR_COLOR.llm.border}` }}>收集上下文</span>
                <span style={{ color: "#cbd5e1" }}>→</span>
                <span style={{ padding: "7px 14px", borderRadius: 10, background: ACTOR_COLOR.agent.bg, color: ACTOR_COLOR.agent.main, border: `1px solid ${ACTOR_COLOR.agent.border}` }}>采取行动</span>
                <span style={{ color: "#cbd5e1" }}>→</span>
                <span style={{ padding: "7px 14px", borderRadius: 10, background: ACTOR_COLOR.done.bg, color: ACTOR_COLOR.done.main, border: `1px solid ${ACTOR_COLOR.done.border}` }}>验证结果</span>
              </div>
              {/* 回环:验证结果(右)→ 沿底部折回 → 收集上下文(左),左端箭头朝上 */}
              <div style={{ position: "absolute", left: "16%", right: "16%", top: 46, height: 22, borderLeft: `2px solid ${ACTOR_COLOR.llm.main}`, borderRight: `2px solid ${ACTOR_COLOR.done.main}`, borderBottom: "2px dashed #94a3b8", borderBottomLeftRadius: 12, borderBottomRightRadius: 12, animation: "wt-loop 1.8s ease-in-out infinite" }} />
              <div style={{ position: "absolute", left: "16%", top: 38, transform: "translateX(-6px)", color: ACTOR_COLOR.llm.main, fontSize: 13, animation: "wt-loop 1.8s ease-in-out infinite" }}>▲</div>
              <div style={{ position: "absolute", left: 0, right: 0, top: 74, textAlign: "center", fontSize: 12, color: "#64748b" }}>
                ↩ 把 tool_result 塞回 context,回到开头 —— 直到 LLM 决定终止
              </div>
            </div>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 4, textAlign: "center" }}>
              驱动它的只有两件事:<b style={{ color: ACTOR_COLOR.llm.main }}>模型</b>负责推理,<b style={{ color: ACTOR_COLOR.agent.main }}>工具</b>负责行动。
            </div>
          </div>
        )}
      </div>
      <style>{`@keyframes wt-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes wt-loop{0%,100%{opacity:.45}50%{opacity:1}}`}</style>
    </div>
  );
}
