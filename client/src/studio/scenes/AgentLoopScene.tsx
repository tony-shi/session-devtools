import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import type { Focus } from "../../v2/walkthrough/types";
import { sectionPalette } from "../../v2/lens-palette";
import { fmtK } from "../../v2/lib/format";
import { ACTOR_COLOR } from "../../v2/walkthrough/actorPalette";
import type { LoopTurn } from "../fixtures/turn";
import type { ActClock } from "./storyClock";

// turn-io 幕(Agent Loop 纵向链)的 frame-driven 版本 —— 移植自 live AgentLoopView。
// 揭示 / focus 由 storyClock 从旁白拍号推导;无 CSS keyframe(Remotion 会冻结),
// 改用「测量跟随滚动」让最新节点始终在画面内。尺寸放大到 1080p 可读。

const FONT = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif";
const PAD = 64;

const TOOL_VERB: Record<string, string> = {
  Bash: "执行命令", Read: "读取文件", Grep: "搜索代码", Glob: "匹配文件",
  Edit: "修改文件", Write: "写入文件", Task: "派生子 Agent", WebFetch: "抓取网页",
};

function softWrapBash(cmd: string): string {
  return cmd.replace(/\s*(;|&&|\|\||\|)\s+/g, "\n  $1 ");
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
    case "loop":
      if (beat >= beatCount - 2) return { count: total, ctxStage: "full", showTools: true };
      return { count: Math.min(total - 2, 4 + beat * 2), ctxStage: "full", showTools: true };
    default: return { count: total, ctxStage: "full", showTools: true };
  }
}

const FOCUSED = new Set<Focus>(["call", "tool-use", "tool-result", "loop"]);
function isActive(node: Node, focus: Focus): boolean {
  switch (focus) {
    case "call": return node.kind === "context" && node.iter === 0;
    case "tool-use": return node.kind === "response" && node.iter === 0;
    case "tool-result": return node.kind === "result" && node.iter === 0;
    case "loop": return node.kind === "context" || node.kind === "final";
    default: return true;
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
  const { fps, height } = useVideoConfig();
  const nodes = buildNodes(turn);
  const N = nodes.length;
  const { focus, beat, beatCount } = clock.at(frame);
  const { count, ctxStage, showTools } = plan(focus, beat, N, beatCount);
  const hasFocus = FOCUSED.has(focus);

  // 工具循环轮数 = 有 toolCalls 的 call 数。context 节点 iter < loopCount → 第几轮;= loopCount → Final 调用。
  const loopCount = turn.calls.filter((c) => c.toolCalls.length).length;
  // 当前活跃轮 = 已揭示的最后一个 context 节点的 iter(给右侧进度条)。
  let activeIter = 0;
  for (let i = 0; i < count && i < N; i++) { const nn = nodes[i]; if (nn.kind === "context") activeIter = nn.iter; }
  const finalRevealed = count >= N;

  // 揭示时刻表:每个节点 index 在哪一帧变为"已揭示"(plan 的 count 越过它)。
  // 用它把镜头按真实揭示帧缓动、给新节点淡入 —— 不再随 reveal 硬跳。
  const revealFrame = useMemo(() => {
    const rf = new Array<number>(N).fill(Infinity);
    for (const seg of clock.segments) {
      const c = plan(seg.focus, seg.beat, N, seg.beatCount).count;
      for (let i = 0; i < c; i++) rf[i] = Math.min(rf[i], seg.start);
    }
    return rf;
  }, [clock, N]);

  // 全节点常驻渲染(布局稳定、可测量),揭示靠 opacity —— 这样能拿到每个节点真实高度,
  // 镜头才能精确地"把已揭示的块"居中/跟随。
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [heights, setHeights] = useState<number[]>([]);
  useLayoutEffect(() => {
    const hs = itemRefs.current.map((el) => (el ? el.getBoundingClientRect().height : 0));
    // 仅当高度真的变了才 setState —— 否则每帧新数组引用会触发无限重渲染。
    setHeights((prev) => (prev.length === hs.length && prev.every((v, i) => Math.abs(v - hs[i]) < 0.5) ? prev : hs));
  });

  const usable = height - PAD * 2;
  // 已揭示前 c 个节点的总高
  const revealedH = (c: number) => {
    let h = 0;
    for (let i = 0; i < c && i < heights.length; i++) h += (heights[i] || 0) + (i > 0 ? GAP : 0);
    return h;
  };
  // 目标镜头:已揭示块短 → 居中;长 → 跟随底部(最新可见)。
  const targetFor = (c: number) => {
    const rh = revealedH(c);
    return rh <= usable ? (usable - rh) / 2 : -(rh - usable);
  };

  // 镜头缓动:每进入一个新拍(segment),从"上一拍的镜头目标"缓动到"当前拍的目标"(~0.5s)。
  // 按 segment 边界缓动 → 即使某一拍一次揭示多个节点,也是平滑滑动而非硬跳。
  const EASE = Math.round(fps * 0.5);
  const segIdx = clock.segments.findIndex((s) => frame < s.end);
  const curSeg = segIdx >= 0 ? clock.segments[segIdx] : clock.segments[clock.segments.length - 1];
  const prevSeg = segIdx > 0 ? clock.segments[segIdx - 1] : null;
  const countAt = (s: typeof curSeg) => plan(s.focus, s.beat, N, s.beatCount).count;
  const curCount = curSeg ? countAt(curSeg) : count;
  const prevCount = prevSeg ? countAt(prevSeg) : curCount;
  const segStart = curSeg ? curSeg.start : 0;
  const scrollY = interpolate(frame, [segStart, segStart + EASE], [targetFor(prevCount), targetFor(curCount)], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const FADE = Math.round(fps * 0.35);
  // 右栏解说内容:loop 末段(final 已现)切到"退出"注解,否则按 focus。
  const railLines = focus === "loop" && finalRevealed ? RAIL_EXIT : (RAIL[focus] ?? []);

  return (
    <AbsoluteFill style={{ background: "#fff", fontFamily: FONT }}>
      <div style={{ position: "absolute", inset: 0, display: "flex" }}>
        {/* 左+中:滚动卡片(核心 loop 动画,保持简洁) */}
        <div style={{ flex: 1, minWidth: 0, position: "relative", overflow: "hidden", padding: `${PAD}px 0 ${PAD}px 72px` }}>
          <div style={{ width: "100%", maxWidth: 1040, display: "flex", flexDirection: "column", gap: GAP, transform: `translateY(${scrollY}px)` }}>
            {nodes.map((n, i) => {
              const revealed = i < count;
              const active = isActive(n, focus);
              const fadeIn = Number.isFinite(revealFrame[i]) ? interpolate(frame, [revealFrame[i], revealFrame[i] + FADE], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
              const op = !revealed ? 0 : (hasFocus && !active ? 0.4 : 1) * fadeIn;
              // 每一轮工具循环在它的 context 节点前打 Loop N 标;final 调用的 context 打 Final 标。
              const badge = n.kind === "context"
                ? (n.iter < loopCount ? { label: `Loop ${n.iter + 1}`, color: ACTOR_COLOR.llm.main } : { label: "Final", color: ACTOR_COLOR.done.main })
                : null;
              return (
                <div key={i} ref={(el) => { itemRefs.current[i] = el; }} style={{ opacity: op }}>
                  {badge && (
                    <div style={{ marginLeft: 80, marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: 0.5, color: "#fff", background: badge.color, borderRadius: 999, padding: "3px 14px" }}>{badge.label}</span>
                      <span style={{ flex: 1, height: 1, background: "#eef2f6" }} />
                    </div>
                  )}
                  <Lane actor={n.kind === "final" ? "llm" : n.kind === "result" ? "agent" : n.kind === "task" ? "user" : "llm"}>
                    {n.kind === "final"
                      ? <FinalNode text={n.text} calls={n.calls} />
                      : <NodeBox node={n} active={active} ctxStage={ctxStage} showTools={showTools} highlightTool={focus === "tool-use"} />}
                  </Lane>
                </div>
              );
            })}
          </div>
        </div>

        {/* 右:解说栏(固定,不随卡片滚动)—— 进度推进 + 随旁白浮现的关键词注解 */}
        <div style={{ width: 470, flexShrink: 0, padding: `${PAD}px 56px ${PAD}px 28px`, borderLeft: "1px solid #eef2f6", display: "flex", flexDirection: "column", gap: 36 }}>
          <Progression activeIter={activeIter} loopCount={loopCount} />
          <Rail lines={railLines} beat={beat} />
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

// 解说栏:关键词注解随 beat 逐条浮现(已过的亮,未到的淡)。
function Rail({ lines, beat }: { lines: string[]; beat: number }) {
  if (lines.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {lines.map((ln, j) => {
        const shown = j <= beat;
        const emphasis = j === 0; // 第一行(带序号)作小标
        return (
          <div key={ln} style={{
            fontSize: emphasis ? 26 : 23, fontWeight: emphasis ? 700 : 500,
            color: emphasis ? "#334155" : "#475569", lineHeight: 1.5,
            opacity: shown ? 1 : 0.14,
            transform: shown ? "none" : "translateY(6px)",
          }}>{ln}</div>
        );
      })}
    </div>
  );
}

const ACTOR = {
  user: { color: ACTOR_COLOR.user.main, label: "User" },
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

function NodeBox({ node, active, ctxStage, showTools, highlightTool }: { node: Node; active: boolean; ctxStage: CtxStage; showTools: boolean; highlightTool: boolean }) {
  if (node.kind === "task") {
    return (
      <EventRow accent={ACTOR.user.color} label="用户输入 · 本轮任务" active={active}>
        <div style={{ fontSize: 22, color: "#1f2937", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{node.text}</div>
      </EventRow>
    );
  }
  if (node.kind === "context") return <ContextBar iter={node.iter} tokens={node.tokens} lastText={node.lastText} active={active} stage={node.iter === 0 ? ctxStage : "full"} />;
  if (node.kind === "response") {
    return (
      <EventRow accent={ACTOR.llm.color} label="LLM 调用结果" active={active}>
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
              {t.name === "Bash" ? `$ ${softWrapBash(t.param)}` : t.param}
            </div>
          </div>
        ))}
      </EventRow>
    );
  }
  if (node.kind !== "result") return null;
  return (
    <EventRow accent={ACTOR.agent.color} label="Agent 执行结果 · tool_result" active={active}>
      {node.results.map((o, i) => (
        <div key={i} style={{ marginTop: i ? 12 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, fontSize: 19 }}>
            <span style={{ color: o.isError ? "#b91c1c" : "#0f766e", fontWeight: 700 }}>{o.isError ? "✗" : "✓"} {o.name}</span>
            <span style={{ marginLeft: "auto", fontSize: 15, color: "#99f6e4" }}>tool_result</span>
          </div>
          <div style={{ fontFamily: "monospace", fontSize: 19, color: "#334155", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 16px", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55 }}>
            {o.output || "(空)"}
          </div>
        </div>
      ))}
    </EventRow>
  );
}

// 简洁版:只留最终回答(双框 = 特化)。退出/原因说明已移到右侧解说栏,不再撑大卡片。
function FinalNode({ text, calls }: { text: string; calls: number }) {
  return (
    <div style={{ borderRadius: 14, padding: "18px 22px", background: "#f0fdf4", border: "2px solid #16a34a", boxShadow: "0 0 0 3px rgba(22,163,74,0.12)" }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#15803d", marginBottom: 10 }}>Final · 最终回答 · 本轮 {calls} 次 LLM 调用</div>
      <div style={{ fontSize: 21, color: "#14532d", lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text || "(无最终文本)"}</div>
    </div>
  );
}

function EventRow({ accent, label, active, children }: { accent: string; label: string; active: boolean; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${active ? accent : "#eef2f6"}`, borderRadius: 12, background: "#fff", padding: "14px 18px", boxShadow: active ? `0 0 0 3px ${accent}22` : "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span style={{ width: 9, height: 9, borderRadius: 3, background: accent, flexShrink: 0 }} />
        <span style={{ fontSize: 18, fontWeight: 700, color: "#334155" }}>{label}</span>
      </div>
      {children}
    </div>
  );
}

function ContextBar({ iter, tokens, lastText, active, stage }: { iter: number; tokens: number; lastText: string; active: boolean; stage: CtxStage }) {
  const prefixPct = Math.min(82, 56 + iter * 12);
  const lastPct = 100 - prefixPct;
  const lastLabel = iter === 0 ? "当前问题" : "工具结果";
  const prefixSegs = [
    { c: sectionPalette.system.barBg, w: prefixPct * 0.34 },
    { c: sectionPalette.tools.barBg, w: prefixPct * 0.24 },
    { c: sectionPalette.messages.barBg, w: prefixPct * 0.42 },
  ];
  const full = stage === "full";
  return (
    <div style={{ border: `1px solid ${active ? "#6366f1" : "#eef2f6"}`, borderRadius: 12, background: "#fff", padding: "14px 18px", boxShadow: active ? "0 0 0 3px rgba(99,102,241,0.13)" : "none" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: "#334155" }}>Context · 发给模型的</span>
        <span style={{ marginLeft: "auto", fontSize: 16, color: "#94a3b8", fontFamily: "monospace" }}>{fmtK(tokens)} tok</span>
      </div>
      <div style={{ display: "flex", height: 34, borderRadius: 8, overflow: "hidden", gap: 3 }}>
        {prefixSegs.map((s, i) => (<div key={i} style={{ width: `${s.w}%`, background: s.c, opacity: 0.5 }} />))}
        {full
          ? <div style={{ width: `${lastPct}%`, background: "#6366f1", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 16, fontWeight: 700 }}>{lastLabel}</div>
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
