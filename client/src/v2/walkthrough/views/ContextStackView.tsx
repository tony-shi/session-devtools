import type { UserTurn } from "../../drilldown-types";
import type { Focus } from "../types";

// ep2 第一/三幕:Context Stack —— 一次 LLM Call 前 runtime 组装出来的工作集。
// 用「横条」表达(和 cw-real 真实构成条同款,风格统一):分层 = 横条里的分段,
// 按 beat 逐拍长出;段宽在已显示的层之间按权重分配 —— 于是「用户输入」一开始占满,
// 随着 Runtime / Project / Trace 加入,被挤成一小段,直观呈现"prompt 只是一部分"。
// focus="diagram":静态全条(收尾)。

const clip = (s: string, n: number) => { const t = (s ?? "").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

type LayerDef = { label: string; sub: string; color: string; weight: number; minStage: number; trace?: boolean };
// 横条从左到右(右端=最近追加的 Current task)
const LAYERS: LayerDef[] = [
  { label: "Runtime 指令", sub: "行为规则 · 工具用法 · 边界(不暴露具体内容)", color: "#3b82f6", weight: 28, minStage: 3 },
  { label: "Project memory / rules", sub: "CLAUDE.md · 用户 memory · 团队约定", color: "#8b5cf6", weight: 16, minStage: 4 },
  { label: "Conversation trace", sub: "历史消息 · assistant 回复 · tool_result · 文件内容", color: "#0d9488", weight: 42, minStage: 5, trace: true },
  { label: "Current task", sub: "本轮真实用户输入", color: "#6366f1", weight: 14, minStage: 2 },
];

export function ContextStackView({ turn, focus, beat }: { turn: UserTurn; focus: Focus; beat: number }) {
  const userInput = clip(turn.userInput, 160);
  const diagram = focus === "diagram";
  const stage = diagram ? 99 : beat;

  // 阶段 0-1:大 prompt + 问号(误解)
  if (!diagram && stage <= 1) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
        <div style={{ width: "min(560px, 100%)", textAlign: "center", animation: "wt-fade .4s ease both" }}>
          <div style={{ position: "relative", border: "1px solid #e0e7ff", background: "#eef2ff", borderRadius: 14, padding: "20px 22px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6366f1", marginBottom: 8 }}>用户 prompt</div>
            <div style={{ fontSize: 16, color: "#1f2937", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{userInput}</div>
            <div style={{ position: "absolute", top: -18, right: -10, fontSize: 36, color: "#a5b4fc" }}>?</div>
          </div>
          {stage >= 1 && (
            <div style={{ marginTop: 16, fontSize: 14, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "8px 12px", animation: "wt-fade .35s ease both" }}>
              误解:模型看到的 = 就这句用户输入?
            </div>
          )}
        </div>
        <style>{`@keyframes wt-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
      </div>
    );
  }

  const shown = LAYERS.filter((l) => stage >= l.minStage);
  const sum = shown.reduce((s, l) => s + l.weight, 0) || 1;
  const merged = diagram || stage >= 7;

  const barAndLegend = (
    <div>
      {/* 横条:已显示的层按权重分段 */}
      <div style={{ display: "flex", height: 40, borderRadius: 8, overflow: "hidden", gap: 2 }}>
        {shown.map((l) => {
          const pct = (l.weight / sum) * 100;
          const hl = !diagram && l.trace && stage === 6;
          return (
            <div key={l.label} title={l.label} style={{
              width: `${pct}%`, background: l.color, display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontSize: 11, fontWeight: 700, overflow: "hidden", whiteSpace: "nowrap",
              boxShadow: hl ? "0 0 0 3px #0d948855 inset" : "none", animation: "wt-rise .35s ease both",
            }}>{pct > 12 ? l.label : ""}</div>
          );
        })}
      </div>
      {/* 图例 / 阐述:每层 label + sub,逐层出现 */}
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        {shown.map((l) => {
          const hl = !diagram && l.trace && stage === 6;
          return (
            <div key={l.label} style={{ display: "flex", gap: 8, fontSize: 12, animation: "wt-rise .35s ease both" }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: l.color, flexShrink: 0, marginTop: 3 }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 700, color: l.color }}>{l.label === "Current task" ? "Current task · 用户输入" : l.label}</span>
                <span style={{ color: "#64748b", marginLeft: 8 }}>{l.label === "Current task" ? userInput : l.sub}</span>
                {hl && <span style={{ color: l.color, fontWeight: 700, marginLeft: 8 }}>← tool_result 进入 context</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div style={{ height: "100%", overflowY: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "min(680px, 100%)", animation: "wt-fade .4s ease both" }}>
        {merged ? (
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ flex: 1, border: "2px solid #6366f1", borderRadius: 14, padding: "14px 16px 12px", position: "relative", background: "#fff" }}>
              <div style={{ position: "absolute", top: -11, left: 16, background: "#6366f1", color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 10px", borderRadius: 999 }}>
                LLM Request Context
              </div>
              <div style={{ marginTop: 6 }}>{barAndLegend}</div>
            </div>
            <div style={{ flexShrink: 0, textAlign: "center", color: "#6366f1" }}>
              <div style={{ fontSize: 22 }}>→</div>
              <div style={{ fontSize: 28 }}>🧠</div>
              <div style={{ fontSize: 12, fontWeight: 700 }}>模型</div>
            </div>
          </div>
        ) : barAndLegend}
      </div>
      <style>{`@keyframes wt-fade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@keyframes wt-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}
