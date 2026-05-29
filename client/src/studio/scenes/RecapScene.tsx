import { AbsoluteFill, useCurrentFrame } from "remotion";
import { ACTOR_COLOR } from "../../v2/walkthrough/actorPalette";
import type { ActClock } from "./storyClock";

// recap 幕的 frame-driven 版本 —— 移植自 live RecapView。结构树按 beat 点亮,
// while 括号几何由固定行高算(不用 ResizeObserver),三阶段标签 + 二引擎收束语随 beat 出现。
// 尺寸放大到 1080p。

const FONT = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif";

type Stage = { label: string; bg: string; color: string; border: string };
const STAGE_GATHER: Stage = { label: "收集上下文", bg: "#eef2ff", color: "#4338ca", border: "#c7d2fe" };
const STAGE_ACT: Stage = { label: "采取行动", bg: "#f0fdfa", color: "#0f766e", border: "#99f6e4" };
const STAGE_VERIFY: Stage = { label: "验证结果", bg: "#f0fdf4", color: "#15803d", border: "#bbf7d0" };

type Row = { depth: number; term: string; desc: string; color: string; loop?: "start" | "end"; stage?: Stage };
const ROWS: Row[] = [
  { depth: 0, term: "Session", desc: "一次完整的会话", color: "#64748b" },
  { depth: 1, term: "Turn", desc: "一次用户请求,以及为回答它的全部工作", color: ACTOR_COLOR.llm.main },
  { depth: 2, term: "LLM Call", desc: "一次带着具体 context 的模型请求", color: ACTOR_COLOR.llm.main, loop: "start", stage: STAGE_GATHER },
  { depth: 3, term: "tool_use", desc: "模型想做什么(提出的动作)", color: ACTOR_COLOR.llm.main, stage: STAGE_ACT },
  { depth: 3, term: "tool_result", desc: "现实返回了什么(执行的证据)", color: ACTOR_COLOR.agent.main, loop: "end", stage: STAGE_VERIFY },
  // final answer 与 LLM Call 同级(depth 2)、在 Turn 之下 —— 信息足够时模型不再 tool_use,Turn 结束。
  { depth: 2, term: "final answer", desc: "模型不再 tool_use,给出最终回答 → Turn 结束", color: ACTOR_COLOR.done.main },
];

const ROW_H = 62;        // 固定行高(用于 while 括号几何)
const STAGE_COL = 150;
const BRACKET_GUTTER = 320;
const INDENT = 44;

export const RecapScene = ({ clock }: { clock: ActClock }) => {
  const frame = useCurrentFrame();
  const beat = clock.at(frame).beat;

  const endIdx = ROWS.findIndex((r) => r.loop === "end");   // 4
  const startIdx = ROWS.findIndex((r) => r.loop === "start"); // 2
  const loopOn = beat >= endIdx;
  const stageOn = beat >= ROWS.length;       // 6
  const enginesOn = beat >= ROWS.length + 1; // 7

  // while 括号锚点:行中心 Y(相对 rows 容器顶)
  const yTop = startIdx * ROW_H + ROW_H / 2;
  const yBot = endIdx * ROW_H + ROW_H / 2;

  return (
    <AbsoluteFill style={{ background: "#fff", fontFamily: FONT, alignItems: "center", justifyContent: "center", padding: 60 }}>
      <div style={{ width: "100%", maxWidth: 1280, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#94a3b8", letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>回顾 · 一整套结构</div>

        <div style={{ position: "relative", paddingRight: BRACKET_GUTTER }}>
          {ROWS.map((r, i) => {
            const shown = i <= beat;
            return (
              <div key={i} style={{ height: ROW_H, marginLeft: r.depth * INDENT, display: "flex", alignItems: "center", gap: 16, opacity: shown ? 1 : 0.14 }}>
                <span style={{ fontSize: 26, fontWeight: 700, color: r.color, fontFamily: "monospace", flexShrink: 0 }}>
                  {r.depth > 0 && !r.term.startsWith("└") ? "└ " : ""}{r.term}
                </span>
                <span style={{ flex: 1, fontSize: 21, color: "#475569" }}>{r.desc}</span>
                <span style={{ flexShrink: 0, width: STAGE_COL, display: "flex" }}>
                  {r.stage && stageOn && <StagePill stage={r.stage} />}
                </span>
              </div>
            );
          })}
          <WhileLoopBracket on={loopOn} yTop={yTop} yBot={yBot} />
        </div>

        {enginesOn && (
          <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px dashed #e5e7eb", fontSize: 21, color: "#64748b", textAlign: "center" }}>
            驱动它的只有两件事:<b style={{ color: "#6366f1" }}>模型</b>负责推理,<b style={{ color: "#0f766e" }}>工具</b>负责行动。
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

function StagePill({ stage }: { stage: Stage }) {
  return (
    <span style={{ fontSize: 17, fontWeight: 700, padding: "5px 14px", borderRadius: 999, background: stage.bg, color: stage.color, border: `1px solid ${stage.border}`, whiteSpace: "nowrap" }}>
      {stage.label}
    </span>
  );
}

function WhileLoopBracket({ on, yTop, yBot }: { on: boolean; yTop: number; yBot: number }) {
  const W = 60;
  const PAD = 14;
  const containerTop = yTop - PAD;
  const containerH = yBot - yTop + PAD * 2;
  const yIn = PAD;
  const yOut = containerH - PAD;
  const d = `M 0 ${yOut} H ${W - 18} A 10 10 0 0 1 ${W - 8} ${yOut - 10} V ${yIn + 10} A 10 10 0 0 1 ${W - 18} ${yIn} H 0`;
  const color = "#6366f1";
  return (
    <div aria-hidden style={{ position: "absolute", right: 10, top: containerTop, width: BRACKET_GUTTER - 20, height: containerH, opacity: on ? 1 : 0, pointerEvents: "none" }}>
      <svg width={W} height={containerH} viewBox={`0 0 ${W} ${containerH}`} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        <defs>
          <marker id="wt-arrow-recap" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
          </marker>
        </defs>
        <path d={d} fill="none" stroke={color} strokeWidth={3} strokeDasharray="6 5" markerEnd="url(#wt-arrow-recap)" />
      </svg>
      <div style={{ position: "absolute", left: W + 14, top: containerH / 2, transform: "translateY(-50%)", fontSize: 19, lineHeight: 1.5, maxWidth: BRACKET_GUTTER - W - 30 }}>
        <div style={{ fontFamily: "monospace", fontWeight: 700, color, fontSize: 21 }}>while</div>
        <div style={{ color: "#64748b" }}>LLM 又给出 tool_use,跳回 LLM Call</div>
      </div>
    </div>
  );
}
