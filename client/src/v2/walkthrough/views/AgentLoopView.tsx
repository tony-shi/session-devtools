import { useEffect, useRef, useState } from "react";
import type { UserTurn } from "../../drilldown-types";
import type { Focus } from "../types";
import { sectionPalette } from "../../lens-palette";
import { fmtK } from "../../lib/format";
import { ACTOR_COLOR } from "../actorPalette";

// 第二幕(turn-io):深入一个 Turn —— 纵向链,揭示进度由外部 beat(字幕节拍)驱动,
// 字幕和画面逐步同步推进。
// 用户输入(本轮任务)→ [ Context(请求)→ LLM 结果(AI + tool_use)→ Agent 执行(tool_result) ]×N
//   → Turn 完成(LLM 自行决定结束)。

const MAX_ITERS = 3;

const TOOL_VERB: Record<string, string> = {
  Bash: "执行命令", Read: "读取文件", Grep: "搜索代码", Glob: "匹配文件",
  Edit: "修改文件", Write: "写入文件", Task: "派生子 Agent", WebFetch: "抓取网页",
  WebSearch: "搜索网络", TodoWrite: "更新任务清单", NotebookEdit: "修改 Notebook",
};

type ParsedTool = { name: string; explain: string; param: string };
type ResultItem = { name: string; output: string; isError: boolean };
type Node =
  | { kind: "task"; text: string }
  | { kind: "context"; iter: number; tokens: number; lastText: string }
  | { kind: "response"; iter: number; aiText: string; tools: ParsedTool[] }
  | { kind: "result"; iter: number; results: ResultItem[] }
  | { kind: "more"; remaining: number }
  | { kind: "final"; text: string; calls: number };

const clip = (s: string, n: number) => { const t = (s ?? "").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

function parseTool(name: string, inputPreview: string): ParsedTool {
  let param = (inputPreview ?? "").trim();
  try {
    const o = JSON.parse(inputPreview);
    if (o && typeof o === "object") {
      const v = o.command ?? o.file_path ?? o.pattern ?? o.path ?? o.url ?? o.query ?? o.description ?? Object.values(o)[0];
      if (v != null) param = String(v);
    }
  } catch { /* 非 JSON,直接用预览 */ }
  // 展示用:不截断 —— 命令 / 路径完整可见(容器已拉宽,过长才换行)。
  return { name, explain: TOOL_VERB[name] ?? "调用工具", param };
}

function buildNodes(turn: UserTurn): Node[] {
  const userInput = (turn.userInput ?? "").trim();

  const allTool = turn.calls.filter((c) => c.toolCalls?.length);
  const iters = allTool.slice(0, MAX_ITERS);
  const nodes: Node[] = [{ kind: "task", text: userInput }];
  iters.forEach((c, i) => {
    const lastText = i === 0 ? userInput : clip(iters[i - 1].toolCalls[0]?.outputPreview ?? "", 80);
    nodes.push({ kind: "context", iter: i, tokens: c.contextSize, lastText });
    // 展示用:assistantText / tool_result 全文,不折叠。
    nodes.push({ kind: "response", iter: i, aiText: (c.assistantText ?? "").trim(), tools: c.toolCalls.map((tc) => parseTool(tc.name, tc.inputPreview)) });
    nodes.push({ kind: "result", iter: i, results: c.toolCalls.map((tc) => ({ name: tc.name, output: (tc.outputPreview ?? "").trim(), isError: tc.isError })) });
  });
  const remaining = allTool.length - iters.length;
  if (remaining > 0) nodes.push({ kind: "more", remaining });
  // 最后一次 LLM 调用:context 已含最新 tool_result → 模型不再 tool_use → 给出结论 → Turn 终止。
  const lastIter = iters[iters.length - 1];
  const finalCtxText = lastIter ? clip(lastIter.toolCalls[0]?.outputPreview ?? "", 80) : userInput;
  const finalCall = turn.calls[turn.calls.length - 1] ?? null;
  nodes.push({ kind: "context", iter: iters.length, tokens: finalCall?.contextSize ?? 0, lastText: finalCtxText });
  nodes.push({ kind: "final", text: (turn.finalOutput ?? "").trim(), calls: turn.calls.length });
  return nodes;
}

type CtxStage = "prefix" | "full";
// 每个 focus 内,beat 推进 → 揭示到第几个节点 + Context 填充阶段 + 是否显示 tool_use。
function plan(focus: Focus, beat: number, total: number, beatCount: number): { count: number; ctxStage: CtxStage; showTools: boolean } {
  switch (focus) {
    case "call":
      // beats: 0 用户输入 / 1 Agent 填前缀 / 2 填入用户输入 / 3 发起调用
      return { count: beat >= 1 ? 2 : 1, ctxStage: beat >= 2 ? "full" : "prefix", showTools: false };
    case "tool-use":
      // beats: 0 模型在判断(只 AI 文本) / 1 返回 tool_use / 2 解释
      return { count: 3, ctxStage: "full", showTools: beat >= 1 };
    case "tool-result":
      return { count: 4, ctxStage: "full", showTools: true };
    case "loop":
      // 前面逐拍展开循环体;最后两拍揭示「最终一次 LLM 调用 + 结论」(模型不再 tool_use)。
      if (beat >= beatCount - 2) return { count: total, ctxStage: "full", showTools: true };
      return { count: Math.min(total - 2, 4 + beat * 2), ctxStage: "full", showTools: true };
    default:
      return { count: total, ctxStage: "full", showTools: true };
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

export function AgentLoopView({ turn, focus, beat, beatCount }: { turn: UserTurn; focus: Focus; beat: number; beatCount: number; playing: boolean; restartNonce: number }) {
  const [nodes] = useState<Node[]>(() => buildNodes(turn));
  const bottomRef = useRef<HTMLDivElement>(null);
  const { count, ctxStage, showTools } = plan(focus, beat, nodes.length, beatCount);
  const hasFocus = FOCUSED.has(focus);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [count, beat]);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "36px 0", minHeight: 0 }}>
      <div style={{ width: "100%", maxWidth: 880, margin: "0 auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 10 }}>
        {nodes.slice(0, count).map((n, i) => {
          const active = isActive(n, focus);
          const dim = hasFocus && !active;
          return (
            <div key={i} style={{ animation: "wt-rise 0.32s ease both", opacity: dim ? 0.4 : 1, transition: "opacity .35s ease" }}>
              {n.kind === "more"
                ? <MoreNode remaining={n.remaining} />
                : <Lane actor={n.kind === "final" ? "llm" : n.kind === "result" ? "agent" : n.kind === "task" ? "user" : "llm"}>
                    {n.kind === "final"
                      ? <FinalNode text={n.text} calls={n.calls} active={active} />
                      : <NodeBox node={n} active={active} ctxStage={ctxStage} showTools={showTools} highlightTool={focus === "tool-use"} />}
                  </Lane>}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <style>{`@keyframes wt-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
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
    <div style={{ display: "flex", gap: 10 }}>
      <div style={{ width: 44, flexShrink: 0, textAlign: "right", paddingTop: 10, fontSize: 11, fontWeight: 700, color }}>{label}</div>
      <div style={{ width: 2, background: color, borderRadius: 2, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function NodeBox({ node, active, ctxStage, showTools, highlightTool }: { node: Node; active: boolean; ctxStage: CtxStage; showTools: boolean; highlightTool: boolean }) {
  if (node.kind === "task") {
    return (
      <EventRow accent={ACTOR.user.color} label="用户输入 · 本轮任务" active={active}>
        <div style={{ fontSize: 15, color: "#1f2937", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{node.text}</div>
      </EventRow>
    );
  }
  if (node.kind === "context") return <ContextBar iter={node.iter} tokens={node.tokens} lastText={node.lastText} active={active} stage={node.iter === 0 ? ctxStage : "full"} />;
  if (node.kind === "response") {
    return (
      <EventRow accent={ACTOR.llm.color} label="LLM 调用结果" active={active}>
        {node.aiText
          ? <div style={{ fontSize: 14, color: "#374151", lineHeight: 1.5, marginBottom: showTools ? 8 : 0 }}>{node.aiText}</div>
          : (!showTools && <div style={{ fontSize: 13, color: "#94a3b8", fontStyle: "italic" }}>模型在判断该做什么…</div>)}
        {showTools && node.tools.map((t, i) => (
          <div key={i} style={{
            border: `1px solid ${highlightTool ? ACTOR_COLOR.llm.main : ACTOR_COLOR.llm.border}`, borderRadius: 10, padding: "8px 10px", marginTop: i ? 6 : 0,
            background: ACTOR_COLOR.llm.bg, boxShadow: highlightTool ? "0 0 0 3px rgba(217,119,87,0.22)" : "none",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: ACTOR_COLOR.llm.main, borderRadius: 5, padding: "1px 8px" }}>{t.name}</span>
              <span style={{ fontSize: 12, color: ACTOR_COLOR.llm.main }}>{t.explain}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: ACTOR_COLOR.llm.border }}>tool_use</span>
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 13, color: "#334155", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {t.name === "Bash" ? "$ " : ""}{t.param}
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
        <div key={i} style={{ marginTop: i ? 10 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, fontSize: 13 }}>
            <span style={{ color: o.isError ? "#b91c1c" : ACTOR_COLOR.agent.main, fontWeight: 700 }}>{o.isError ? "✗" : "✓"} {o.name}</span>
            <span style={{ marginLeft: "auto", fontSize: 10, color: ACTOR_COLOR.agent.border }}>tool_result</span>
          </div>
          <div style={{ fontFamily: "monospace", fontSize: 13, color: "#334155", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "8px 12px", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55 }}>
            {o.output || "(空)"}
          </div>
        </div>
      ))}
    </EventRow>
  );
}

function MoreNode({ remaining }: { remaining: number }) {
  return (
    <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 13, border: "1px dashed #cbd5e1", borderRadius: 12, padding: "10px 16px" }}>
      … 还有 {remaining} 轮 Call ↔ Tool,Agent 持续循环,直到 LLM 决定终止 …
    </div>
  );
}

// 最终输出:LLM 不再 tool_use,直接给出结论 → Turn 结束。展示真实 finalOutput。
function FinalNode({ text, calls, active }: { text: string; calls: number; active: boolean }) {
  return (
    <div style={{
      borderRadius: 12, padding: "14px 18px", background: ACTOR_COLOR.done.bg,
      border: `1px solid ${active ? ACTOR_COLOR.done.main : ACTOR_COLOR.done.border}`, boxShadow: active ? "0 0 0 3px rgba(85,138,66,0.15)" : "none",
      transition: "box-shadow .3s, border-color .3s",
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: ACTOR_COLOR.done.main, marginBottom: 6 }}>✅ 最后一次 LLM 调用 · 无 tool_use → 结论</div>
      <div style={{ fontSize: 14, color: "#2F4A26", lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text || "(无最终文本)"}</div>
      <div style={{ fontSize: 12, color: ACTOR_COLOR.done.main, marginTop: 8 }}>
        模型判断信息已充分,这一次不再请求工具,直接给出结论 —— 本轮共 {calls} 次调用,Turn 到此终止。
      </div>
    </div>
  );
}

function EventRow({ accent, label, active, children }: { accent: string; label: string; active: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      border: `1px solid ${active ? accent : "#eef2f6"}`, borderRadius: 10, background: "#fff", padding: "10px 14px",
      boxShadow: active ? `0 0 0 3px ${accent}22` : "none", transition: "box-shadow .3s, border-color .3s",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: accent, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>{label}</span>
      </div>
      {children}
    </div>
  );
}

// 两段式 Context 横条:前缀(各种 agent 注入,弱化,借 sectionPalette 配色)+ 最后一段(高亮)。
// stage="prefix":只填前缀(Agent 正在准备上下文);stage="full":再填入最后一段 + 显示真实内容。
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
    <div style={{
      border: `1px solid ${active ? ACTOR_COLOR.llm.main : "#eef2f6"}`, borderRadius: 10, background: "#fff", padding: "10px 14px",
      boxShadow: active ? "0 0 0 3px rgba(217,119,87,0.13)" : "none", transition: "box-shadow .3s, border-color .3s",
    }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>Context · 发给模型的</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>{fmtK(tokens)} tok</span>
      </div>
      <div style={{ display: "flex", height: 24, borderRadius: 6, overflow: "hidden", gap: 2 }}>
        {prefixSegs.map((s, i) => (
          <div key={i} style={{ width: `${s.w}%`, background: s.c, opacity: 0.5 }} />
        ))}
        {full
          ? <div style={{ width: `${lastPct}%`, background: ACTOR_COLOR.llm.main, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700, animation: "wt-rise .35s ease both" }}>{lastLabel}</div>
          : <div style={{ width: `${lastPct}%`, border: "1px dashed #cbd5e1", borderRadius: 4, color: "#cbd5e1", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>待填入</div>}
      </div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>前缀:系统 · 记忆 · 规则 · 历史 · 工具定义(各种 agent 注入)</div>
      {full && (
        <div style={{ marginTop: 6, background: ACTOR_COLOR.llm.bg, border: `1px solid ${ACTOR_COLOR.llm.border}`, borderRadius: 8, padding: "6px 10px", animation: "wt-rise .35s ease both" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: ACTOR_COLOR.llm.main }}>{lastLabel}:</span>{" "}
          <span style={{ fontSize: 13, color: "#374151", wordBreak: "break-word" }}>{lastText || "(空)"}</span>
        </div>
      )}
    </div>
  );
}
