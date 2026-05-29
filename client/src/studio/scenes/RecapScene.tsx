import { AbsoluteFill, useCurrentFrame } from "remotion";
import { ACTOR_COLOR } from "../../v2/walkthrough/actorPalette";
import type { ActClock } from "./storyClock";

// recap 幕 —— 把整套结构收成一个「while 循环」:
//   1) Session 下有多个 Turn(用户任务边界);放大其中一个 Turn。
//   2) 用教程级 while 画法解读循环:菱形判定(还要 tool_use?)+ 回边(要→循环体→绕回)
//      + 退出边(不要→final answer)。配伪代码对照。
// beat 映射(旁白 8 句):
//   0 Session + 多个 Turn / 1 高亮 Turn 2(放大) / 2 LLM Call / 3 ◇tool_use?◇ + tool_use
//   / 4 tool_result + 回边 / 5 退出 → final answer / 6 三阶段标签 / 7 二引擎收束
// 内容为主,样式后续打磨。

const FONT = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif";
const LLM = ACTOR_COLOR.llm.main;
const AGENT = ACTOR_COLOR.agent.main;
const DONE = ACTOR_COLOR.done.main;
const COND = "#d97706"; // 判定菱形:琥珀(决策色)

const op = (on: boolean) => (on ? 1 : 0.12);

export const RecapScene = ({ clock }: { clock: ActClock }) => {
  const frame = useCurrentFrame();
  const beat = clock.at(frame).beat;

  return (
    <AbsoluteFill style={{ background: "#fff", fontFamily: FONT, padding: "56px 72px", flexDirection: "column" }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#94a3b8", letterSpacing: 1, textTransform: "uppercase", marginBottom: 24 }}>
        回顾 · 把它串成一个 while 循环
      </div>

      {/* 1) Session 含多个 Turn */}
      <SessionBand beat={beat} />

      {/* 2) 放大的 Turn → while 流程图 + 伪代码 */}
      <div style={{ display: "flex", gap: 56, marginTop: 18, flex: 1, minHeight: 0 }}>
        <Flowchart beat={beat} />
        <PseudoCode beat={beat} />
      </div>

      {/* 二引擎收束 */}
      <div style={{ height: 40, marginTop: 8 }}>
        {beat >= 7 && (
          <div style={{ fontSize: 22, color: "#64748b", textAlign: "center" }}>
            驱动它的只有两件事:<b style={{ color: LLM }}>模型</b>负责推理,<b style={{ color: AGENT }}>工具</b>负责行动。
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

// Session 容器 + 多个 Turn 盒子(beat 0 全现,beat 1 高亮 Turn 2 = 被放大的那个)。
function SessionBand({ beat }: { beat: number }) {
  const turns = [1, 2, 3];
  const expanded = 2;
  return (
    <div style={{ border: "2px dashed #cbd5e1", borderRadius: 16, padding: "16px 22px", opacity: op(beat >= 0) }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 22, fontWeight: 800, color: "#64748b", fontFamily: "monospace" }}>Session</span>
        <span style={{ fontSize: 18, color: "#94a3b8" }}>一次完整会话,组织起多个 Turn</span>
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 14 }}>
        {turns.map((t) => {
          const isExp = t === expanded;
          const hot = isExp && beat >= 1;
          return (
            <div key={t} style={{
              flex: 1, padding: "12px 18px", borderRadius: 12,
              border: `2px solid ${hot ? LLM : "#e5e7eb"}`,
              background: hot ? "#eef2ff" : "#fff",
              boxShadow: hot ? `0 0 0 3px ${ACTOR_COLOR.llm.border}` : "none",
              opacity: t === expanded ? 1 : (beat >= 1 ? 0.4 : 1),
            }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: hot ? LLM : "#475569", fontFamily: "monospace" }}>Turn {t}</div>
              <div style={{ fontSize: 15, color: "#94a3b8", marginTop: 2 }}>{t === expanded ? "一次用户任务 ↓ 放大" : "一次用户任务"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 固定坐标的 while 流程图(容器 720×430)。
const W = 720, H = 430;
const BOX = {
  call:   { x: 190, y: 24,  w: 220, h: 58 },
  use:    { x: 190, y: 262, w: 220, h: 52 },
  result: { x: 190, y: 342, w: 220, h: 52 },
  final:  { x: 470, y: 136, w: 250, h: 58 },
};
const DIA = { cx: 300, cy: 165, r: 58 }; // 菱形(决策):还要 tool_use?

function Flowchart({ beat }: { beat: number }) {
  const showCall = beat >= 2;
  const showDecide = beat >= 3;   // 菱形 + tool_use(要)
  const showResult = beat >= 4;   // tool_result + 回边
  const showExit = beat >= 5;     // 不要 → final answer
  const stageOn = beat >= 6;

  return (
    <div style={{ position: "relative", width: W, height: H, flexShrink: 0 }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <defs>
          <marker id="rc-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="#64748b" />
          </marker>
          <marker id="rc-arr-loop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill={LLM} />
          </marker>
        </defs>
        {/* LLM Call → 菱形 */}
        <path d={`M300 ${BOX.call.y + BOX.call.h} V ${DIA.cy - DIA.r}`} stroke="#64748b" strokeWidth={2} markerEnd="url(#rc-arr)" opacity={op(showDecide)} fill="none" />
        {/* 菱形 → tool_use(要 / yes) */}
        <path d={`M300 ${DIA.cy + DIA.r} V ${BOX.use.y}`} stroke="#64748b" strokeWidth={2} markerEnd="url(#rc-arr)" opacity={op(showDecide)} fill="none" />
        {/* tool_use → tool_result */}
        <path d={`M300 ${BOX.use.y + BOX.use.h} V ${BOX.result.y}`} stroke="#64748b" strokeWidth={2} markerEnd="url(#rc-arr)" opacity={op(showResult)} fill="none" />
        {/* 回边:tool_result 左 → 上 → 绕回 LLM Call 左(loop) */}
        <path d={`M${BOX.result.x} ${BOX.result.y + BOX.result.h / 2} H 110 V 53 H ${BOX.call.x}`} stroke={LLM} strokeWidth={2.5} strokeDasharray="6 5" markerEnd="url(#rc-arr-loop)" opacity={op(showResult)} fill="none" />
        {/* 退出边:菱形右 → final answer(不要 / no) */}
        <path d={`M${DIA.cx + DIA.r} ${DIA.cy} H ${BOX.final.x}`} stroke={DONE} strokeWidth={2.5} markerEnd="url(#rc-arr)" opacity={op(showExit)} fill="none" />
      </svg>

      {/* 边标签 */}
      <EdgeLabel x={312} y={238} text="要" color="#64748b" shown={showDecide} />
      <EdgeLabel x={388} y={138} text="不要 → 退出" color={DONE} shown={showExit} />
      <EdgeLabel x={40} y={205} text="循环:塞回 context" color={LLM} shown={showResult} />

      {/* 盒子 */}
      <FlowBox b={BOX.call} color={LLM} title="LLM Call" sub="一次带 context 的模型决策" shown={showCall} stage={stageOn ? "收集上下文" : undefined} stageColor="#4338ca" />
      <Diamond shown={showDecide} />
      <FlowBox b={BOX.use} color={LLM} title="tool_use" sub="模型想做什么" shown={showDecide} stage={stageOn ? "采取行动" : undefined} stageColor={AGENT} />
      <FlowBox b={BOX.result} color={AGENT} title="tool_result" sub="现实返回的证据" shown={showResult} stage={stageOn ? "验证结果" : undefined} stageColor="#15803d" />
      <FlowBox b={BOX.final} color={DONE} title="final answer" sub="不再 tool_use,Turn 结束" shown={showExit} double />
    </div>
  );
}

function FlowBox({ b, color, title, sub, shown, stage, stageColor, double }: {
  b: { x: number; y: number; w: number; h: number }; color: string; title: string; sub: string; shown: boolean; stage?: string; stageColor?: string; double?: boolean;
}) {
  return (
    <div style={{
      position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h,
      border: `${double ? 2.5 : 2}px solid ${color}`, borderRadius: 12, background: "#fff",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      boxShadow: double ? `0 0 0 3px ${color}22` : "none", opacity: op(shown),
    }}>
      <div style={{ fontSize: 21, fontWeight: 700, color, fontFamily: "monospace" }}>{title}</div>
      <div style={{ fontSize: 14, color: "#94a3b8", marginTop: 2 }}>{sub}</div>
      {stage && (
        <div style={{ position: "absolute", top: -14, right: 10, fontSize: 13, fontWeight: 700, color: stageColor, background: "#fff", border: `1px solid ${stageColor}`, borderRadius: 999, padding: "1px 10px" }}>{stage}</div>
      )}
    </div>
  );
}

function Diamond({ shown }: { shown: boolean }) {
  const { cx, cy, r } = DIA;
  return (
    <div style={{
      position: "absolute", left: cx - r, top: cy - r, width: r * 2, height: r * 2,
      transform: "rotate(45deg)", border: `2px solid ${COND}`, background: "#fffbeb", borderRadius: 10,
      display: "flex", alignItems: "center", justifyContent: "center", opacity: op(shown),
    }}>
      <span style={{ transform: "rotate(-45deg)", fontSize: 17, fontWeight: 700, color: COND, textAlign: "center", lineHeight: 1.25 }}>还要<br />tool_use?</span>
    </div>
  );
}

function EdgeLabel({ x, y, text, color, shown }: { x: number; y: number; text: string; color: string; shown: boolean }) {
  return <div style={{ position: "absolute", left: x, top: y, fontSize: 15, fontWeight: 700, color, opacity: op(shown) }}>{text}</div>;
}

// 伪代码,逐行随 beat 点亮 —— 让"这是个 while"一眼可读。
function PseudoCode({ beat }: { beat: number }) {
  const lines: { code: string; comment?: string; on: boolean; indent: number; kind: "kw" | "body" | "exit" }[] = [
    { code: "while 模型还要 tool_use:", on: beat >= 3, indent: 0, kind: "kw" },
    { code: "tool_use", comment: "模型想做什么", on: beat >= 3, indent: 1, kind: "body" },
    { code: "tool_result", comment: "塞回 context,绕回循环", on: beat >= 4, indent: 1, kind: "body" },
    { code: "# 信息足够 → 跳出循环", on: beat >= 5, indent: 0, kind: "exit" },
    { code: "final answer", comment: "Turn 结束", on: beat >= 5, indent: 0, kind: "exit" },
  ];
  return (
    <div style={{ flex: 1, minWidth: 0, alignSelf: "center" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.5, marginBottom: 14 }}>同一个东西,写成代码就是:</div>
      <div style={{ background: "#0f172a", borderRadius: 14, padding: "22px 26px", fontFamily: "monospace", fontSize: 23, lineHeight: 1.85 }}>
        {lines.map((l, i) => {
          const c = l.kind === "kw" ? "#a5b4fc" : l.kind === "exit" ? "#86efac" : "#e2e8f0";
          return (
            <div key={i} style={{ opacity: op(l.on), paddingLeft: l.indent * 32, whiteSpace: "pre" }}>
              <span style={{ color: c }}>{l.code}</span>
              {l.comment && <span style={{ color: "#64748b" }}>  {"  # " + l.comment}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
