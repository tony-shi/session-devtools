import { useMemo } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import type { Focus } from "../../v2/walkthrough/types";
import { sectionPalette } from "../../v2/lens-palette";
import { fmtK } from "../../v2/lib/format";
import { ACTOR_COLOR } from "../../v2/walkthrough/actorPalette";
import type { LoopTurn } from "../fixtures/turn";
import type { ActClock } from "./storyClock";

// turn-io 幕(Agent Loop 纵向链)的 frame-driven 版本 —— 移植自 live AgentLoopView。
// 揭示 / focus 由 storyClock 从旁白拍号推导;无 CSS keyframe(Remotion 会冻结)。
// 镜头 = 底部锚定的「流」(flex-end):只渲染已揭示节点,最新一个永远落在底部、被高亮,
//        旧节点向上溢出裁掉。和第一幕一致的终端式观感 —— 不测量、不位移、不受缩放影响。
// 右栏 = 进度(Loop N → Final)+「指针卡」:贴在底部、用 ◀ 指向当前这一步的活跃节点,起强调作用。

const FONT = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif";
const PAD = 64;
// 底部留较大空白:让「活跃节点」(流的最新一个)落在画面中间偏上,而不是贴着底边;
// 底部空出来给字幕 + 呼吸。右栏指针卡也对齐到这条底线,和活跃节点同高 —— ◀ 才指得准。
const PAD_BOTTOM = 380;
// 右栏解说统一一个中性色(slate),不随节点变色 —— 避免和节点配色抢戏。
const RAIL_COLOR = "#64748b";

const TOOL_VERB: Record<string, string> = {
  Bash: "执行命令", Read: "读取文件", Grep: "搜索代码", Glob: "匹配文件",
  Edit: "修改文件", Write: "写入文件", Task: "派生子 Agent", WebFetch: "抓取网页",
};

function softWrapBash(cmd: string): string {
  return cmd.replace(/\s*(;|&&|\|\||\|)\s+/g, "\n  $1 ");
}

// 把多行文本裁到前 n 行(工具输出 / 命令往往很长,只留可读的预览,免得节点撑到几屏高)。
function clipLines(s: string, n: number): string {
  const lines = (s ?? "").split("\n");
  if (lines.length <= n) return s ?? "";
  return lines.slice(0, n).join("\n") + `\n… (+${lines.length - n} 行)`;
}

type ParsedTool = { name: string; explain: string; param: string };
type Node =
  | { kind: "task"; text: string }
  | { kind: "context"; iter: number; tokens: number; lastText: string }
  | { kind: "response"; iter: number; aiText: string; tools: ParsedTool[] }
  | { kind: "result"; iter: number; results: { name: string; output: string; isError: boolean }[] }
  | { kind: "final"; text: string; calls: number };

const clip = (s: string, n: number) => { const t = (s ?? "").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

function parseTool(name: string, inputPreview: string): ParsedTool {
  let param = (inputPreview ?? "").trim();
  try {
    const o = JSON.parse(inputPreview);
    if (o && typeof o === "object") {
      const v = o.command ?? o.file_path ?? o.pattern ?? o.path ?? o.url ?? o.query ?? Object.values(o)[0];
      if (v != null) param = String(v);
    }
  } catch { /* 非 JSON */ }
  return { name, explain: TOOL_VERB[name] ?? "调用工具", param };
}

function buildNodes(turn: LoopTurn): Node[] {
  const userInput = turn.userInput.trim();
  const iters = turn.calls.filter((c) => c.toolCalls.length);
  const nodes: Node[] = [{ kind: "task", text: userInput }];
  iters.forEach((c, i) => {
    const lastText = i === 0 ? userInput : clip(iters[i - 1].toolCalls[0]?.outputPreview ?? "", 80);
    nodes.push({ kind: "context", iter: i, tokens: c.contextSize, lastText });
    nodes.push({ kind: "response", iter: i, aiText: c.assistantText.trim(), tools: c.toolCalls.map((tc) => parseTool(tc.name, tc.inputPreview)) });
    nodes.push({ kind: "result", iter: i, results: c.toolCalls.map((tc) => ({ name: tc.name, output: (tc.outputPreview ?? "").trim(), isError: tc.isError })) });
  });
  const lastIter = iters[iters.length - 1];
  const finalCtxText = lastIter ? clip(lastIter.toolCalls[0]?.outputPreview ?? "", 80) : userInput;
  const finalCall = turn.calls[turn.calls.length - 1];
  nodes.push({ kind: "context", iter: iters.length, tokens: finalCall?.contextSize ?? 0, lastText: finalCtxText });
  nodes.push({ kind: "final", text: turn.finalOutput.trim(), calls: turn.calls.length });
  return nodes;
}

type CtxStage = "prefix" | "full";
function plan(focus: Focus, beat: number, total: number, beatCount: number): { count: number; ctxStage: CtxStage; showTools: boolean } {
  switch (focus) {
    case "call": return { count: beat >= 1 ? 2 : 1, ctxStage: beat >= 2 ? "full" : "prefix", showTools: false };
    case "tool-use": return { count: 3, ctxStage: "full", showTools: beat >= 1 };
    case "tool-result": return { count: 4, ctxStage: "full", showTools: true };
    case "loop": {
      // 为 fixture(2 轮工具循环,9 个节点)调好的揭示节奏:让 Loop 2 的 context 单独占一拍
      // (beat 1)成为活跃节点「塞回填充」,对上旁白「塞回 context,触发下一次 Call」。
      void beatCount;
      const c = beat <= 0 ? 4 : beat === 1 ? 5 : beat === 2 ? 7 : beat === 3 ? 8 : total;
      return { count: Math.min(total, c), ctxStage: "full", showTools: true };
    }
    default: return { count: total, ctxStage: "full", showTools: true };
  }
}

const GAP = 16;

// 右侧解说栏:按 focus 给关键词式注解(强调 + 解释,不与旁白逐字重复)。随 beat 逐条浮现。
const RAIL: Partial<Record<Focus, string[]>> = {
  "call": ["① 组装 context", "系统 · 记忆 · 规则 · 历史 · 工具定义", "再填入本轮要解决的问题"],
  "tool-use": ["② 模型不直接回答", "提出 tool_use:一个动作请求", "读文件 / 搜代码 / 跑命令"],
  "tool-result": ["③ 执行 → tool_result", "拿到真实结果,不靠幻想", "结果进入下一次 Call 的 context"],
  "loop": ["④ tool_result 塞回 context", "触发下一次 LLM Call", "context 越滚越大,理解越完整", "—— 这就是 Agent Loop"],
};
// loop 末段(final 已出现)切到"退出循环"注解 —— 退出说明从 final 卡片挪到这里。
const RAIL_EXIT = ["⑤ 信息已足够", "模型不再 tool_use", "跳出循环 → 最终回答", "Turn 到此结束"];

export const AgentLoopScene = ({ turn, clock }: { turn: LoopTurn; clock: ActClock }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nodes = buildNodes(turn);
  const N = nodes.length;
  const { focus, beat, beatCount } = clock.at(frame);
  const { count, ctxStage, showTools } = plan(focus, beat, N, beatCount);

  // 工具循环轮数 = 有 toolCalls 的 call 数。context 节点 iter < loopCount → 第几轮;= loopCount → Final 调用。
  const loopCount = turn.calls.filter((c) => c.toolCalls.length).length;
  // 当前活跃轮 = 已揭示的最后一个 context 节点的 iter(给右侧进度条)。
  let activeIter = 0;
  for (let i = 0; i < count && i < N; i++) { const nn = nodes[i]; if (nn.kind === "context") activeIter = nn.iter; }
  const finalRevealed = count >= N;
  // 当前活跃节点 = 已揭示的最新一个(流的底部那一个)—— 它被高亮。
  const activeIdx = Math.min(count, N) - 1;

  // 揭示时刻表:每个节点 index 在哪一帧变为"已揭示"(plan 的 count 越过它)。给新节点淡入用。
  const revealFrame = useMemo(() => {
    const rf = new Array<number>(N).fill(Infinity);
    for (const seg of clock.segments) {
      const c = plan(seg.focus, seg.beat, N, seg.beatCount).count;
      for (let i = 0; i < c; i++) rf[i] = Math.min(rf[i], seg.start);
    }
    return rf;
  }, [clock, N]);

  // 右栏解说内容:loop 末段(final 已现)切到"退出"注解,否则按 focus。
  const railLines = focus === "loop" && finalRevealed ? RAIL_EXIT : (RAIL[focus] ?? []);

  return (
    <AbsoluteFill style={{ background: "#fff", fontFamily: FONT }}>
      <div style={{ position: "absolute", inset: 0, display: "flex" }}>
        {/* 左+中:底部锚定的滚动卡片(flex-end)。只渲染已揭示节点,最新一个落底、被高亮。 */}
        <div style={{ flex: 1, minWidth: 0, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: `${PAD}px 0 ${PAD_BOTTOM}px 72px` }}>
          <div style={{ width: "100%", maxWidth: 1040, flexShrink: 0, display: "flex", flexDirection: "column", gap: GAP }}>
            {nodes.map((n, i) => {
              if (i >= count) return null; // 未揭示:不渲染(让流从底部生长)
              const active = i === activeIdx; // 最新一个 = 活跃 = 高亮
              const op = active ? 1 : 0.5; // 高亮/变暗;入场透明度由 enter 单独控制
              // 入场 0→1(~0.6s):节点整体淡入 + 从上方「下拉」就位;内容比框体略晚浮现(见 EventRow/FinalNode)。
              const enter = Number.isFinite(revealFrame[i])
                ? interpolate(frame, [revealFrame[i], revealFrame[i] + Math.round(fps * 0.6)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
                : 1;
              const enterTy = interpolate(enter, [0, 1], [-26, 0], { easing: Easing.out(Easing.cubic) });
              const enterOp = interpolate(enter, [0, 0.5], [0, 1], { extrapolateRight: "clamp" });
              // 每一轮工具循环在它的 context 节点前打 Loop N 标;final 调用的 context 打 Final 标。
              const badge = n.kind === "context"
                ? (n.iter < loopCount ? { label: `Loop ${n.iter + 1}`, color: ACTOR_COLOR.llm.main } : { label: "Final", color: ACTOR_COLOR.done.main })
                : null;
              // context 的「塞回联动」:后续每一轮的 context 用 inflow(0→1,~0.7s)驱动曲线 + 数据包行进,
              // 到达(≈0.85)时该段填「工具结果」;connHold 让这条链路再多停留 ~2.4s(便于看清)后淡出。
              const life = Number.isFinite(revealFrame[i]) ? frame - revealFrame[i] : 99999;
              const isBackfill = n.kind === "context" && n.iter > 0;
              const inflow = isBackfill ? interpolate(life, [0, Math.round(fps * 0.7)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
              const connHold = isBackfill ? interpolate(life, [0, Math.round(fps * 0.15), Math.round(fps * 2.4), Math.round(fps * 3.0)], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
              const nodeCtxStage: CtxStage = isBackfill ? (inflow >= 0.85 ? "full" : "prefix") : ctxStage;
              return (
                <div key={i} style={{ opacity: op }}>
                  {/* 入场:整框淡入 + 从上方下拉就位(translateY)。内容的二段浮现在 EventRow/FinalNode 里。 */}
                  <div style={{ opacity: enterOp, transform: `translateY(${enterTy}px)` }}>
                    {badge && (
                      <div style={{ marginLeft: 80, marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: 0.5, color: "#fff", background: badge.color, borderRadius: 999, padding: "3px 14px" }}>{badge.label}</span>
                        <span style={{ flex: 1, height: 1, background: "#eef2f6" }} />
                      </div>
                    )}
                    <Lane actor={n.kind === "final" ? "llm" : n.kind === "result" ? "agent" : n.kind === "task" ? "user" : "llm"}>
                      {n.kind === "final"
                        ? <FinalNode text={n.text} calls={n.calls} active={active} enter={enter} />
                        : <NodeBox node={n} active={active} ctxStage={nodeCtxStage} showTools={showTools} highlightTool={focus === "tool-use"} enter={enter} inflow={inflow} connHold={connHold} />}
                    </Lane>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 右:解说栏 —— 顶部进度推进 + 底部「指针卡」(◀ 指向当前活跃节点,强调这一步) */}
        <div style={{ width: 470, flexShrink: 0, padding: `${PAD}px 56px ${PAD_BOTTOM}px 28px`, borderLeft: "1px solid #eef2f6", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <Progression activeIter={activeIter} loopCount={loopCount} />
          <PointerCard lines={railLines} beat={beat} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

// 循环进度条:Loop 1 · Loop 2 · … → Final,高亮当前轮。给"在推进"的感觉。
function Progression({ activeIter, loopCount }: { activeIter: number; loopCount: number }) {
  const Pill = ({ label, state }: { label: string; state: "done" | "cur" | "todo" }) => (
    <span style={{
      fontSize: 16, fontWeight: 700, padding: "5px 14px", borderRadius: 999, whiteSpace: "nowrap",
      color: state === "cur" ? "#fff" : state === "done" ? ACTOR_COLOR.llm.main : "#cbd5e1",
      background: state === "cur" ? ACTOR_COLOR.llm.main : state === "done" ? "#eef2ff" : "transparent",
      border: `1px solid ${state === "todo" ? "#e5e7eb" : ACTOR_COLOR.llm.border}`,
    }}>{label}</span>
  );
  const finalState = activeIter >= loopCount ? "cur" : "todo";
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.5, marginBottom: 12 }}>循环进度</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {Array.from({ length: loopCount }).map((_, i) => (
          <Pill key={i} label={`Loop ${i + 1}`} state={i < activeIter ? "done" : i === activeIter ? "cur" : "todo"} />
        ))}
        <span style={{ color: "#cbd5e1", fontSize: 18 }}>→</span>
        <span style={{
          fontSize: 16, fontWeight: 800, padding: "5px 14px", borderRadius: 999,
          color: finalState === "cur" ? "#fff" : "#cbd5e1",
          background: finalState === "cur" ? ACTOR_COLOR.done.main : "transparent",
          border: `1px solid ${finalState === "cur" ? ACTOR_COLOR.done.main : "#e5e7eb"}`,
        }}>Final</span>
      </div>
    </div>
  );
}

// 指针卡:贴在右栏底部、与流底部的活跃节点对齐,用 ◀ 指向它。单一中性色,不带标题。
function PointerCard({ lines, beat }: { lines: string[]; beat: number }) {
  if (lines.length === 0) return null;
  const accent = RAIL_COLOR;
  const tint = "#f8fafc";
  return (
    <div style={{ position: "relative", background: tint, border: `2px solid ${accent}`, borderRadius: 16, padding: "20px 24px", boxShadow: "0 12px 34px rgba(15,23,42,0.10)" }}>
      {/* ◀ 箭头:外层描边 + 内层填充,贴在卡片左边缘指向左侧的活跃节点 */}
      <div style={{ position: "absolute", left: -15, top: 30, width: 0, height: 0, borderTop: "13px solid transparent", borderBottom: "13px solid transparent", borderRight: `15px solid ${accent}` }} />
      <div style={{ position: "absolute", left: -11, top: 32, width: 0, height: 0, borderTop: "11px solid transparent", borderBottom: "11px solid transparent", borderRight: `13px solid ${tint}` }} />
      <Rail lines={lines} beat={beat} accent={accent} />
    </div>
  );
}

// 解说栏:关键词注解随 beat 逐条浮现(已过的亮,未到的淡)。
function Rail({ lines, beat, accent }: { lines: string[]; beat: number; accent: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {lines.map((ln, j) => {
        const shown = j <= beat;
        const emphasis = j === 0; // 第一行(带序号)作小标
        return (
          <div key={ln} style={{
            fontSize: emphasis ? 25 : 22, fontWeight: emphasis ? 700 : 500,
            color: emphasis ? accent : "#475569", lineHeight: 1.5,
            opacity: shown ? 1 : 0.16,
            transform: shown ? "none" : "translateY(6px)",
          }}>{ln}</div>
        );
      })}
    </div>
  );
}

const ACTOR = {
  user: { color: ACTOR_COLOR.user.main, label: "用户" },
  llm: { color: ACTOR_COLOR.llm.main, label: "LLM" },
  agent: { color: ACTOR_COLOR.agent.main, label: "Agent" },
} as const;

function Lane({ actor, children }: { actor: keyof typeof ACTOR; children: React.ReactNode }) {
  const { color, label } = ACTOR[actor];
  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={{ width: 64, flexShrink: 0, textAlign: "right", paddingTop: 14, fontSize: 17, fontWeight: 700, color }}>{label}</div>
      <div style={{ width: 3, background: color, borderRadius: 3, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function NodeBox({ node, active, ctxStage, showTools, highlightTool, enter = 1, inflow = 1, connHold = 0 }: { node: Node; active: boolean; ctxStage: CtxStage; showTools: boolean; highlightTool: boolean; enter?: number; inflow?: number; connHold?: number }) {
  if (node.kind === "task") {
    return (
      <EventRow accent={ACTOR.user.color} label="用户输入 · 本轮任务" active={active} enter={enter}>
        <div style={{ fontSize: 22, color: "#1f2937", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{node.text}</div>
      </EventRow>
    );
  }
  if (node.kind === "context") return <ContextBar iter={node.iter} tokens={node.tokens} lastText={node.lastText} active={active} stage={ctxStage} inflow={inflow} connHold={connHold} />;
  if (node.kind === "response") {
    return (
      <EventRow accent={ACTOR.llm.color} label="LLM 调用结果" active={active} enter={enter}>
        {node.aiText
          ? <div style={{ fontSize: 21, color: "#374151", lineHeight: 1.5, marginBottom: showTools ? 12 : 0 }}>{node.aiText}</div>
          : (!showTools && <div style={{ fontSize: 20, color: "#94a3b8", fontStyle: "italic" }}>模型在判断该做什么…</div>)}
        {showTools && node.tools.map((t, i) => (
          <div key={i} style={{ border: `1px solid ${highlightTool ? "#6366f1" : "#e0e7ff"}`, borderRadius: 12, padding: "12px 14px", marginTop: i ? 8 : 0, background: "#f8f9ff", boxShadow: highlightTool ? "0 0 0 3px rgba(99,102,241,0.22)" : "none" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 700, color: "#fff", background: "#6366f1", borderRadius: 6, padding: "2px 12px" }}>{t.name}</span>
              <span style={{ fontSize: 18, color: "#6366f1" }}>{t.explain}</span>
              <span style={{ marginLeft: "auto", fontSize: 15, color: "#a5b4fc" }}>tool_use</span>
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 19, color: "#334155", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {clipLines(t.name === "Bash" ? `$ ${softWrapBash(t.param)}` : t.param, 6)}
            </div>
          </div>
        ))}
      </EventRow>
    );
  }
  if (node.kind !== "result") return null;
  return (
    <EventRow accent={ACTOR.agent.color} label="Agent 执行结果 · tool_result" active={active} enter={enter}>
      {node.results.map((o, i) => (
        <div key={i} style={{ marginTop: i ? 12 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, fontSize: 19 }}>
            <span style={{ color: o.isError ? "#b91c1c" : "#0f766e", fontWeight: 700 }}>{o.isError ? "✗" : "✓"} {o.name}</span>
            <span style={{ marginLeft: "auto", fontSize: 15, color: "#99f6e4" }}>tool_result</span>
          </div>
          <div style={{ fontFamily: "monospace", fontSize: 19, color: "#334155", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 16px", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55 }}>
            {clipLines(o.output, 7) || "(空)"}
          </div>
        </div>
      ))}
    </EventRow>
  );
}

// 简洁版:只留最终回答(双框 = 特化)。退出/原因说明已移到右侧指针卡,不再撑大卡片。
function FinalNode({ text, calls, active, enter = 1 }: { text: string; calls: number; active: boolean; enter?: number }) {
  const bodyOp = interpolate(enter, [0.4, 0.9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const bodyTy = interpolate(enter, [0.4, 0.9], [10, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ borderRadius: 14, padding: "18px 22px", background: "#f0fdf4", border: "2px solid #16a34a", boxShadow: active ? "0 0 0 4px rgba(22,163,74,0.18)" : "0 0 0 3px rgba(22,163,74,0.1)" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#15803d", marginBottom: 10 }}>Final · 最终回答 · 本轮 {calls} 次 LLM 调用</div>
      <div style={{ fontSize: 21, color: "#14532d", lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", opacity: bodyOp, transform: `translateY(${bodyTy}px)` }}>{text || "(无最终文本)"}</div>
    </div>
  );
}

function EventRow({ accent, label, active, enter = 1, children }: { accent: string; label: string; active: boolean; enter?: number; children: React.ReactNode }) {
  // 内容比「框 + 标题」略晚浮现 —— 框先下拉到位、标题先亮,执行信息再淡入上移。
  const bodyOp = interpolate(enter, [0.4, 0.9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const bodyTy = interpolate(enter, [0.4, 0.9], [10, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ border: `1px solid ${active ? accent : "#eef2f6"}`, borderRadius: 12, background: "#fff", padding: "14px 18px", boxShadow: active ? `0 0 0 3px ${accent}22` : "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ width: 9, height: 9, borderRadius: 3, background: accent, flexShrink: 0 }} />
        <span style={{ fontSize: 18, fontWeight: 700, color: "#334155" }}>{label}</span>
      </div>
      <div style={{ opacity: bodyOp, transform: `translateY(${bodyTy}px)` }}>{children}</div>
    </div>
  );
}

function ContextBar({ iter, tokens, lastText, active, stage, inflow = 1, connHold = 0 }: { iter: number; tokens: number; lastText: string; active: boolean; stage: CtxStage; inflow?: number; connHold?: number }) {
  const f = useCurrentFrame();
  const prefixPct = Math.min(82, 56 + iter * 12);
  const lastPct = 100 - prefixPct;
  const lastLabel = iter === 0 ? "当前问题" : "工具结果";
  const prefixSegs = [
    { c: sectionPalette.system.barBg, w: prefixPct * 0.34 },
    { c: sectionPalette.tools.barBg, w: prefixPct * 0.24 },
    { c: sectionPalette.messages.barBg, w: prefixPct * 0.42 },
  ];
  const full = stage === "full";
  // 塞回联动:iter>0 的 context,用 inflow(行进)+ connHold(到达后停留几秒)驱动 teal 曲线把 tool_result 流入本段。
  const TEAL = ACTOR_COLOR.agent.main;
  const showInflow = iter > 0 && active && connHold > 0.01;
  const connOp = connHold;
  const segGlow = interpolate(inflow, [0.74, 0.88, 1], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // 塞回曲线:从 tool_result 右下角,向右甩进右侧留白,再回勾进「工具结果」段(带箭头)。
  // 数据包沿曲线行进到该段(inflow);到达后链路停留几秒,期间虚线持续流动、数据包呼吸。坐标系 = SVG viewBox(440×190)。
  const BZ = { p0: [285, 44] as const, c1: [432, 72] as const, c2: [412, 150] as const, p3: [200, 155] as const };
  const drawT = interpolate(inflow, [0, 0.82], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const bezAt = (t: number, a: number, b: number, c: number, d: number) => {
    const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  };
  const blobX = bezAt(drawT, BZ.p0[0], BZ.c1[0], BZ.c2[0], BZ.p3[0]);
  const blobY = bezAt(drawT, BZ.p0[1], BZ.c1[1], BZ.c2[1], BZ.p3[1]);
  const dashShift = -((f * 0.9) % 19); // 虚线持续向段内流动(活着的感觉)
  const blobR = 10 + Math.sin(f * 0.25) * 1.4; // 数据包轻微呼吸
  return (
    <div style={{ position: "relative", border: `1px solid ${active ? "#6366f1" : "#eef2f6"}`, borderRadius: 12, background: "#fff", padding: "14px 18px", boxShadow: active ? "0 0 0 3px rgba(99,102,241,0.13)" : "none" }}>
      {showInflow && (
        <div style={{ position: "absolute", top: -90, right: -170, width: 440, height: 190, opacity: connOp, pointerEvents: "none", zIndex: 3 }}>
          <svg width={440} height={190} viewBox="0 0 440 190" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            <defs>
              <marker id="rs-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                <path d="M0 0 L10 5 L0 10 z" fill={TEAL} />
              </marker>
            </defs>
            {/* 粗曲线:从结果框右下甩向右侧留白,再回勾进「工具结果」段,末端箭头 */}
            <path
              d={`M ${BZ.p0[0]} ${BZ.p0[1]} C ${BZ.c1[0]} ${BZ.c1[1]} ${BZ.c2[0]} ${BZ.c2[1]} ${BZ.p3[0]} ${BZ.p3[1]}`}
              fill="none" stroke={TEAL} strokeWidth={4} strokeLinecap="round" strokeDasharray="11 8" strokeDashoffset={dashShift} markerEnd="url(#rs-arr)"
            />
            {/* 发光数据包,沿曲线行进到段,停留时轻微呼吸 */}
            <circle cx={blobX} cy={blobY} r={blobR + 10} fill={TEAL} opacity={0.16} />
            <circle cx={blobX} cy={blobY} r={blobR} fill={TEAL} />
            <circle cx={blobX} cy={blobY} r={4} fill="#ffffff" opacity={0.85} />
          </svg>
          <div style={{ position: "absolute", left: 300, top: 2, fontSize: 15, fontWeight: 800, color: TEAL, whiteSpace: "nowrap" }}>塞回 ↩</div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: "#334155" }}>Context · 发给模型的</span>
        <span style={{ marginLeft: "auto", fontSize: 16, color: "#94a3b8", fontFamily: "monospace" }}>{fmtK(tokens)} tok</span>
      </div>
      <div style={{ display: "flex", height: 34, borderRadius: 8, overflow: "hidden", gap: 3 }}>
        {prefixSegs.map((s, i) => (<div key={i} style={{ width: `${s.w}%`, background: s.c, opacity: 0.5 }} />))}
        {full
          ? <div style={{ width: `${lastPct}%`, background: segGlow > 0.01 ? TEAL : "#6366f1", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 16, fontWeight: 700, boxShadow: segGlow > 0.01 ? `inset 0 0 0 ${2 + Math.round(3 * segGlow)}px rgba(255,255,255,0.7)` : "none" }}>{lastLabel}</div>
          : <div style={{ width: `${lastPct}%`, border: "1px dashed #cbd5e1", borderRadius: 6, color: "#cbd5e1", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center" }}>待填入</div>}
      </div>
      <div style={{ fontSize: 16, color: "#9ca3af", marginTop: 8 }}>前缀:系统 · 记忆 · 规则 · 历史 · 工具定义(各种 agent 注入)</div>
      {full && (
        <div style={{ marginTop: 8, background: "#eef2ff", border: "1px solid #e0e7ff", borderRadius: 10, padding: "8px 14px" }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#6366f1" }}>{lastLabel}:</span>{" "}
          <span style={{ fontSize: 19, color: "#374151", wordBreak: "break-word" }}>{lastText || "(空)"}</span>
        </div>
      )}
    </div>
  );
}
