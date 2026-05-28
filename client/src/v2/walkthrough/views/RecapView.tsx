// 第七幕:回顾 —— 把整套结构按层级逐行点亮(StatQuest 式"回到同一张图")。
// Loop 不再单列一行,而是直接画成 while 循环的「指针回跳」:从 tool_result
// 绕回 LLM Call,沿途有个动点(▶)在跑;唯一的出口是 LLM 自行决定停止。
// 配色沿用统一演员色:靛蓝 = 模型侧(Call / tool_use),teal = 现实侧(tool_result),绿 = 收束。

import { useLayoutEffect, useRef, useState } from "react";
import { ACTOR_COLOR } from "../actorPalette";

// 三阶段标签的配色 —— 和被打标行的"动作语义"对应(LLM 推理 / 工具执行 / 收束验证)。
type Stage = { label: string; bg: string; color: string; border: string };
const STAGE_GATHER: Stage = { label: "收集上下文", bg: "#eef2ff", color: "#4338ca", border: "#c7d2fe" };
const STAGE_ACT:    Stage = { label: "采取行动",   bg: "#f0fdfa", color: "#0f766e", border: "#99f6e4" };
const STAGE_VERIFY: Stage = { label: "验证结果",   bg: "#f0fdf4", color: "#15803d", border: "#bbf7d0" };

type Row = { depth: number; term: string; desc: string; color: string; loop?: "start" | "end"; stage?: Stage };
const ROWS: Row[] = [
  { depth: 0, term: "Session", desc: "一次完整的会话", color: "#64748b" },
  { depth: 1, term: "Turn", desc: "一次用户请求,以及为回答它的全部工作", color: ACTOR_COLOR.llm.main },
  { depth: 2, term: "LLM Call", desc: "一次带着具体 context 的模型请求", color: ACTOR_COLOR.llm.main, loop: "start", stage: STAGE_GATHER },
  { depth: 3, term: "tool_use", desc: "模型想做什么(提出的动作)", color: ACTOR_COLOR.llm.main, stage: STAGE_ACT },
  { depth: 3, term: "tool_result", desc: "现实返回了什么(执行的证据)", color: ACTOR_COLOR.agent.main, loop: "end", stage: STAGE_VERIFY },
  // 退出:由 LLM 自行判断"信息已充分,不再 tool_use" → 跳出循环 → 给出结论。
  { depth: 2, term: "└ 直到 LLM 自行决策停止", desc: "不再 tool_use → 跳出循环,给出最终结论", color: ACTOR_COLOR.done.main },
];

// 三阶段标签占的固定列宽(只在右栏给一个 slot,不会和 desc 互挤) —— 保证三行标签竖直对齐。
const STAGE_COL = 96;

// 右侧给 while 括号留出的固定空间(包含括号本体 + 文案)。
const BRACKET_GUTTER = 220;

export function RecapView({ beat }: { beat: number }) {
  const endIdx = ROWS.findIndex((r) => r.loop === "end");
  // 等到 LLM Call → tool_use → tool_result 都亮起,再点亮 while 回跳曲线。
  const loopOn = beat >= endIdx;
  // narration 第 7 句 "把循环抽象出来,其实就是三个阶段" 对应 beat = ROWS.length,
  // 这时把三阶段作为标签贴到对应行上 —— 不再开一张新图。
  const stageOn = beat >= ROWS.length;
  // narration 第 8 句 "驱动它的只有两件事" → 收束语登场。
  const enginesOn = beat >= ROWS.length + 1;

  const rowsRef = useRef<HTMLDivElement>(null);
  const startRowRef = useRef<HTMLDivElement>(null);
  const endRowRef = useRef<HTMLDivElement>(null);
  // 用真实 DOM 测量来定位括号 —— 避免拍脑袋估行高,布局变化时也能跟上。
  const [geom, setGeom] = useState<{ yTop: number; yBot: number; right: number } | null>(null);

  useLayoutEffect(() => {
    const parent = rowsRef.current;
    const s = startRowRef.current;
    const e = endRowRef.current;
    if (!parent || !s || !e) return;
    const measure = () => {
      const pr = parent.getBoundingClientRect();
      const sr = s.getBoundingClientRect();
      const er = e.getBoundingClientRect();
      setGeom({
        yTop: sr.top - pr.top + sr.height / 2,
        yBot: er.top - pr.top + er.height / 2,
        right: pr.width,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [beat]);

  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
      <div style={{ width: "100%", maxWidth: 980, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 6 }}>回顾 · 一整套结构</div>

        {/* 用 paddingRight 给括号让出右栏空间;括号绝对定位在这块右栏里,与对应行精确对齐。 */}
        <div ref={rowsRef} style={{ position: "relative", paddingRight: BRACKET_GUTTER }}>
          {ROWS.map((r, i) => {
            const shown = i <= beat;
            const ref = r.loop === "start" ? startRowRef : r.loop === "end" ? endRowRef : undefined;
            return (
              <div
                key={i}
                ref={ref}
                style={{
                  marginLeft: r.depth * 30,
                  display: "flex", alignItems: "baseline", gap: 12, padding: "5px 0",
                  opacity: shown ? 1 : 0.14,
                  transition: "opacity .4s ease",
                  animation: shown ? "wt-rise .35s ease both" : undefined,
                }}
              >
                <span style={{ fontSize: 17, fontWeight: 700, color: r.color, fontFamily: "monospace", flexShrink: 0 }}>
                  {r.depth > 0 && !r.term.startsWith("└") ? "└ " : ""}{r.term}
                </span>
                <span style={{ flex: 1, fontSize: 14, color: "#475569" }}>{r.desc}</span>
                {/* 三阶段标签的 slot —— 所有行都留出固定宽度,保持竖直对齐;只有标了 stage 的行才显示气泡。 */}
                <span style={{ flexShrink: 0, width: STAGE_COL, display: "flex", justifyContent: "flex-start" }}>
                  {r.stage && stageOn && <StagePill stage={r.stage} />}
                </span>
              </div>
            );
          })}

          {geom && <WhileLoopBracket on={loopOn} yTop={geom.yTop} yBot={geom.yBot} />}
        </div>

        {/* 收束语 —— 三阶段已经作为标签贴回上面那张图,这里只留二引擎的一句话。 */}
        {enginesOn && (
          <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px dashed #e5e7eb", fontSize: 13, color: "#64748b", textAlign: "center", animation: "wt-rise .4s ease both" }}>
            驱动它的只有两件事:<b style={{ color: "#6366f1" }}>模型</b>负责推理,<b style={{ color: "#0f766e" }}>工具</b>负责行动。
          </div>
        )}
      </div>
      <style>{`
        @keyframes wt-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        @keyframes wt-loop{0%,100%{opacity:.45}50%{opacity:1}}
        @keyframes wt-ptr{
          0%   {offset-distance: 0%; opacity:1}
          85%  {offset-distance:100%; opacity:1}
          90%  {opacity:0}
          100% {offset-distance: 0%; opacity:0}
        }
      `}</style>
    </div>
  );
}

function StagePill({ stage }: { stage: Stage }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: "3px 9px",
        borderRadius: 999,
        background: stage.bg,
        color: stage.color,
        border: `1px solid ${stage.border}`,
        whiteSpace: "nowrap",
        animation: "wt-rise .4s ease both",
      }}
    >
      {stage.label}
    </span>
  );
}

// 一个 ]-形括号,贴在右栏:左边开口对着 LLM Call 行(顶)和 tool_result 行(底),
// 顶端有个朝左的箭头表示「跳回 LLM Call」,一个 ▶ 沿同一路径循环跑表达指针回跳。
// yTop / yBot 是行中点在父容器中的纵坐标(用真实 DOM 测出来,不再估)。
function WhileLoopBracket({ on, yTop, yBot }: { on: boolean; yTop: number; yBot: number }) {
  const W = 44;            // 括号本体的宽度
  const PAD = 10;          // 上下各留一点呼吸
  const containerTop = yTop - PAD;
  const containerH = yBot - yTop + PAD * 2;
  const yIn = PAD;                  // 箭头落点(LLM Call 行中线)
  const yOut = containerH - PAD;    // 进入括号的起点(tool_result 行中线)
  // d:从左下出发 → 右 → 圆角上 → 圆角左 → 回到左上(箭头落点)。
  const d = `M 0 ${yOut} H ${W - 14} A 8 8 0 0 1 ${W - 6} ${yOut - 8} V ${yIn + 8} A 8 8 0 0 1 ${W - 14} ${yIn} H 0`;
  const color = "#6366f1";
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        right: 6,
        top: containerTop,
        width: BRACKET_GUTTER - 12,
        height: containerH,
        opacity: on ? 1 : 0,
        transition: "opacity .5s ease",
        pointerEvents: "none",
      }}
    >
      <svg width={W} height={containerH} viewBox={`0 0 ${W} ${containerH}`} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        <defs>
          <marker id="wt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
          </marker>
        </defs>
        {/* 括号本体:虚线 + 末端箭头(回到 LLM Call) */}
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeDasharray="5 4" markerEnd="url(#wt-arrow)" />
        {/* 沿同一路径来回跑的指针 —— 表达"循环回到开头" */}
        <circle r={4} fill={color} style={{ offsetPath: `path('${d}')`, animation: "wt-ptr 2.4s linear infinite" }} />
      </svg>
      {/* 文案:与括号竖直段对齐,单行更紧凑 */}
      <div
        style={{
          position: "absolute",
          left: W + 10,
          top: containerH / 2,
          transform: "translateY(-50%)",
          fontSize: 13,
          lineHeight: 1.5,
          color: "#334155",
          maxWidth: BRACKET_GUTTER - W - 24,
        }}
      >
        <div style={{ fontFamily: "monospace", fontWeight: 700, color, fontSize: 14 }}>while</div>
        <div style={{ color: "#64748b" }}>LLM 又给出 tool_use,跳回 LLM Call</div>
      </div>
    </div>
  );
}
