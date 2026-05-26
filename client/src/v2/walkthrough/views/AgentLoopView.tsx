import { useEffect, useRef, useState } from "react";
import type { UserTurn } from "../../drilldown-types";
import type { Focus } from "../types";
import { sectionPalette } from "../../lens-palette";
import { fmtK } from "../../lib/format";

// 第二幕(turn-io):深入一个 Turn —— 纵向链,揭示进度由外部 beat(字幕节拍)驱动,
// 字幕和画面逐步同步推进。
// 用户输入(本轮任务)→ [ Context(请求)→ LLM 结果(AI + tool_use)→ Agent 执行(tool_result) ]×N
//   → Turn 完成(LLM 自行决定结束)。

const MAX_ITERS = 3;
const REASON_MAX = 110;

const TOOL_VERB: Record<string, string> = {
  Bash: "执行命令", Read: "读取文件", Grep: "搜索代码", Glob: "匹配文件",
  Edit: "修改文件", Write: "写入文件", Task: "派生子 Agent", WebFetch: "抓取网页",
  WebSearch: "搜索网络", TodoWrite: "更新任务清单", NotebookEdit: "修改 Notebook",
};

type ParsedTool = { name: string; explain: string; param: string };
type ResultItem = { name: string; output: string; isError: boolean };
type Node =
  | { kind: "task"; text: string; summary: string }
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
  return { name, explain: TOOL_VERB[name] ?? "调用工具", param: clip(param, 72) };
}

function buildNodes(turn: UserTurn): Node[] {
  const userInput = clip(turn.userInput, 160);
  const tally = new Map<string, number>();
  for (const c of turn.calls) for (const tc of c.toolCalls ?? []) tally.set(tc.name, (tally.get(tc.name) ?? 0) + 1);
  const summary = `这个 Turn:${turn.calls.length} 次调用 · ` +
    [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(" · ");

  const allTool = turn.calls.filter((c) => c.toolCalls?.length);
  const iters = allTool.slice(0, MAX_ITERS);
  const nodes: Node[] = [{ kind: "task", text: userInput, summary }];
  iters.forEach((c, i) => {
    const lastText = i === 0 ? userInput : clip(iters[i - 1].toolCalls[0]?.outputPreview ?? "", 80);
    nodes.push({ kind: "context", iter: i, tokens: c.contextSize, lastText });
    nodes.push({ kind: "response", iter: i, aiText: clip(c.assistantText ?? "", REASON_MAX), tools: c.toolCalls.map((tc) => parseTool(tc.name, tc.inputPreview)) });
    nodes.push({ kind: "result", iter: i, results: c.toolCalls.map((tc) => ({ name: tc.name, output: clip(tc.outputPreview, 90), isError: tc.isError })) });
  });
  const remaining = allTool.length - iters.length;
  if (remaining > 0) nodes.push({ kind: "more", remaining });
  nodes.push({ kind: "final", text: clip(turn.finalOutput ?? "", 280), calls: turn.calls.length });
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
      // 后续轮真实链路逐拍展开;最后两拍揭示「最终输出」节点(LLM 不再 tool_use)。
      if (beat >= beatCount - 2) return { count: total, ctxStage: "full", showTools: true };
      return { count: Math.min(total - 1, 6 + beat * 2), ctxStage: "full", showTools: true };
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
      <div style={{ width: "100%", maxWidth: 700, margin: "0 auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 10 }}>
        {nodes.slice(0, count).map((n, i) => {
          const active = isActive(n, focus);
          const dim = hasFocus && !active;
          return (
            <div key={i} style={{ animation: "wt-rise 0.32s ease both", opacity: dim ? 0.4 : 1, transition: "opacity .35s ease" }}>
              {n.kind === "final"
                ? <FinalNode text={n.text} calls={n.calls} active={active} />
                : n.kind === "more"
                ? <MoreNode remaining={n.remaining} />
                : <Lane actor={n.kind === "result" ? "agent" : n.kind === "task" ? "user" : "llm"}>
                    <NodeBox node={n} active={active} ctxStage={ctxStage} showTools={showTools} highlightTool={focus === "tool-use"} />
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
  user: { color: "#64748b", label: "User" },
  llm: { color: "#6366f1", label: "LLM" },
  agent: { color: "#14b8a6", label: "Agent" },
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
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>{node.summary}</div>
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
            border: `1px solid ${highlightTool ? "#6366f1" : "#e0e7ff"}`, borderRadius: 8, padding: "8px 10px", marginTop: i ? 6 : 0,
            background: "#f8f9ff", boxShadow: highlightTool ? "0 0 0 3px rgba(99,102,241,0.22)" : "none",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#fff", background: "#6366f1", borderRadius: 5, padding: "1px 8px" }}>{t.name}</span>
              <span style={{ fontSize: 12, color: "#6366f1" }}>{t.explain}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: "#a5b4fc" }}>tool_use</span>
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
        <div key={i} style={{ display: "flex", gap: 8, marginTop: i ? 6 : 0, fontSize: 13 }}>
          <span style={{ color: o.isError ? "#b91c1c" : "#0f766e", fontWeight: 700, flexShrink: 0 }}>{o.isError ? "✗" : "✓"} {o.name}</span>
          <span style={{ color: "#cbd5e1" }}>→</span>
          <span style={{ fontFamily: "monospace", color: "#475569", whiteSpace: "pre-wrap", wordBreak: "break-word", minWidth: 0 }}>{o.output || "(空)"}</span>
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
      borderRadius: 12, padding: "14px 18px", background: "#f0fdf4",
      border: `1px solid ${active ? "#16a34a" : "#bbf7d0"}`, boxShadow: active ? "0 0 0 3px rgba(22,163,74,0.15)" : "none",
      transition: "box-shadow .3s, border-color .3s",
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#15803d", marginBottom: 6 }}>✅ Final response · Turn 完成</div>
      <div style={{ fontSize: 14, color: "#14532d", lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text || "(无最终文本)"}</div>
      <div style={{ fontSize: 12, color: "#16a34a", marginTop: 8 }}>
        信息已充分,LLM 不再调用工具,直接输出结论 —— 从用户输入到最终结果,本轮共 {calls} 次调用,到此结束。
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
      border: `1px solid ${active ? "#6366f1" : "#eef2f6"}`, borderRadius: 10, background: "#fff", padding: "10px 14px",
      boxShadow: active ? "0 0 0 3px rgba(99,102,241,0.13)" : "none", transition: "box-shadow .3s, border-color .3s",
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
          ? <div style={{ width: `${lastPct}%`, background: "#6366f1", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, fontWeight: 700, animation: "wt-rise .35s ease both" }}>{lastLabel}</div>
          : <div style={{ width: `${lastPct}%`, border: "1px dashed #cbd5e1", borderRadius: 4, color: "#cbd5e1", fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center" }}>待填入</div>}
      </div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 6 }}>前缀:系统 · 记忆 · 规则 · 历史 · 工具定义(各种 agent 注入)</div>
      {full && (
        <div style={{ marginTop: 6, background: "#eef2ff", border: "1px solid #e0e7ff", borderRadius: 8, padding: "6px 10px", animation: "wt-rise .35s ease both" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#6366f1" }}>{lastLabel}:</span>{" "}
          <span style={{ fontSize: 13, color: "#374151", wordBreak: "break-word" }}>{lastText || "(空)"}</span>
        </div>
      )}
    </div>
  );
}
