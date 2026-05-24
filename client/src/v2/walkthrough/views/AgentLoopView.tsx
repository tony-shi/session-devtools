import { useEffect, useRef, useState } from "react";
import type { UserTurn } from "../../drilldown-types";
import { ChainNarrativeNode } from "../../session-detail/turn/call-chain-rows";
import { fmtK } from "../../lib/format";

// 第二幕:一个 Turn 内的 Agent loop,按「请求 / 结果 / 批准 / 执行」掰成事件行,
// 逐步生长 + 跟随滚动。风格对齐主 jsonl event 链;左缘写 actor(User/LLM/Agent)。
//
// 每一轮:
//   LLM 调用请求 : Context(首轮=系统+历史;后续=上文 + 上一轮 TOOL RESULT)
//   LLM 调用结果 : AI 描述 + TOOL USE(请求调用)
//   Agent 批准执行
//   Agent 执行 → TOOL result
//   → 下一轮(结果并入 Context)
//
// User 输入 / Final 复用真实 ChainNarrativeNode;循环体是 mimic jsonl 风格的事件行
// (因为 request/response 的拆分在现有组件里没有对应件,需插入)。

const STEP_MS = 700;
const MAX_CALLS = 3;     // demo:展开几轮 Call↔Tool,其余折叠
const TEXT_MAX = 320;
const REASON_MAX = 140;

const ACTORS = {
  user: { color: "#64748b", label: "User" },
  llm: { color: "#6366f1", label: "LLM" },
  agent: { color: "#14b8a6", label: "Agent" },
  neutral: { color: "#cbd5e1", label: "" },
} as const;
type Actor = keyof typeof ACTORS;

type Tool = { name: string; input: string };
type Out = { name: string; output: string; isError: boolean };
type Node =
  | { kind: "user"; text: string }
  | { kind: "request"; tokens: number; withResult: boolean }
  | { kind: "response"; text: string; tools: Tool[] }
  | { kind: "approve"; names: string[] }
  | { kind: "result"; outs: Out[] }
  | { kind: "more"; count: number }
  | { kind: "final"; text: string };

const clip = (s: string, n: number) => { const t = (s ?? "").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

function actorOf(k: Node["kind"]): Actor {
  if (k === "user") return "user";
  if (k === "request" || k === "response" || k === "final") return "llm";
  if (k === "approve" || k === "result") return "agent";
  return "neutral";
}

function buildNodes(turn: UserTurn): Node[] {
  const nodes: Node[] = [{ kind: "user", text: clip(turn.userInput, TEXT_MAX) }];
  const loops = turn.calls.filter((c) => c.toolCalls?.length);
  loops.slice(0, MAX_CALLS).forEach((c, i) => {
    nodes.push({ kind: "request", tokens: c.contextSize, withResult: i > 0 });
    nodes.push({ kind: "response", text: clip(c.assistantText ?? "", REASON_MAX), tools: c.toolCalls.map((tc) => ({ name: tc.name, input: clip(tc.inputPreview, 60) })) });
    nodes.push({ kind: "approve", names: c.toolCalls.map((tc) => tc.name) });
    nodes.push({ kind: "result", outs: c.toolCalls.map((tc) => ({ name: tc.name, output: clip(tc.outputPreview, 100), isError: tc.isError })) });
  });
  if (loops.length > MAX_CALLS) nodes.push({ kind: "more", count: loops.length - MAX_CALLS });
  const fin = (turn.finalOutput ?? "").trim();
  if (fin) nodes.push({ kind: "final", text: clip(fin, TEXT_MAX) });
  return nodes;
}

export function AgentLoopView({ turn }: { turn: UserTurn }) {
  const [nodes] = useState<Node[]>(() => buildNodes(turn));
  const [revealed, setRevealed] = useState(1);
  const [playing, setPlaying] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!playing || revealed >= nodes.length) return;
    const t = window.setTimeout(() => setRevealed((r) => Math.min(nodes.length, r + 1)), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, revealed, nodes.length]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [revealed]);

  const restart = () => { setRevealed(1); setPlaying(true); };
  const skip = () => { setPlaying(false); setRevealed(nodes.length); };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderBottom: "1px solid #f1f5f9" }}>
        <button onClick={() => setPlaying((p) => !p)} style={ctrlBtn}>{playing ? "⏸ 暂停" : "▶ 播放"}</button>
        <button onClick={restart} style={ctrlBtn}>⟲ 重播</button>
        <button onClick={skip} style={ctrlBtn}>⤏ 跳到底</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "28px 0", minHeight: 0 }}>
        <div style={{ width: "100%", maxWidth: 680, margin: "0 auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 10 }}>
          {nodes.slice(0, revealed).map((n, i) => (
            <div key={i} style={{ animation: "wt-rise 0.3s ease both" }}>
              <Lane actor={actorOf(n.kind)}><NodeBox node={n} /></Lane>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      <style>{`@keyframes wt-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

// 左缘:actor 文字 + 彩色竖条(swimlane 标识)
function Lane({ actor, children }: { actor: Actor; children: React.ReactNode }) {
  const { color, label } = ACTORS[actor];
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
      <div style={{ width: 46, flexShrink: 0, display: "flex", justifyContent: "flex-end", paddingTop: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color }}>{label}</span>
      </div>
      <div style={{ width: 2, background: color, borderRadius: 2, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function EventRow({ accent, label, size, preview, children }: {
  accent: string; label: string; size?: string; preview?: string; children?: React.ReactNode;
}) {
  return (
    <div style={{ border: "1px solid #eef2f6", borderRadius: 10, background: "#fff", padding: "10px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: accent, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>{label}</span>
        {size && <span style={{ marginLeft: "auto", fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>{size}</span>}
      </div>
      {preview && <div style={{ marginTop: 6, fontSize: 13, color: "#64748b", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{preview}</div>}
      {children}
    </div>
  );
}

function NodeBox({ node }: { node: Node }) {
  switch (node.kind) {
    case "user":
      return <ChainNarrativeNode kind="user" label="User" text={node.text} lineIdx={null} />;
    case "final":
      return <ChainNarrativeNode kind="final" label="Final response" text={node.text} />;
    case "request":
      return (
        <EventRow
          accent={ACTORS.llm.color}
          label="LLM 调用请求 · Context"
          size={`${fmtK(node.tokens)} tok`}
          preview={node.withResult ? "上文 + 上一轮 TOOL RESULT 已并入" : "系统提示 · CLAUDE.md · 历史消息"}
        />
      );
    case "response":
      return (
        <EventRow accent={ACTORS.llm.color} label="LLM 调用结果" preview={node.text || "(无文本,直接请求工具)"}>
          {node.tools.length > 0 && (
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {node.tools.map((tl, i) => (
                <div key={i} style={{ fontSize: 13, color: "#4338ca", background: "#eef2ff", border: "1px solid #e0e7ff", borderRadius: 8, padding: "6px 10px", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  → TOOL USE: {tl.name}({tl.input})
                </div>
              ))}
            </div>
          )}
        </EventRow>
      );
    case "approve":
      return <EventRow accent={ACTORS.agent.color} label="Agent · 批准执行" preview={`批准 TOOL USE: ${node.names.join(", ")}`} />;
    case "result":
      return (
        <EventRow accent={ACTORS.agent.color} label="TOOL result">
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
            {node.outs.map((o, i) => (
              <div key={i} style={{ fontSize: 13, color: o.isError ? "#b91c1c" : "#0f766e", background: o.isError ? "#fef2f2" : "#f0fdfa", borderRadius: 8, padding: "6px 10px", fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {o.name}: {o.output}
              </div>
            ))}
          </div>
        </EventRow>
      );
    case "more":
      return (
        <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 14, border: "1px dashed #cbd5e1", borderRadius: 12, padding: "12px 16px" }}>
          ⋮ 还有 {node.count} 次 Call ↔ Tool 循环
        </div>
      );
  }
}

const ctrlBtn: React.CSSProperties = {
  padding: "5px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer",
  border: "1px solid #e5e7eb", background: "#fff", color: "#374151",
};
