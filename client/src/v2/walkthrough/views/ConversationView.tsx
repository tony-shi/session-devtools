import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UserTurn } from "../../drilldown-types";
import type { Focus } from "../types";
import { ACTOR_COLOR } from "../actorPalette";

// 第一幕:多轮对话的「播放」。镜像官方 context-window simulation 的感觉 ——
// auto-play + 逐步揭示 + 跟随滚动。用户输入在左、Claude 输出在右,Claude 回答
// 带「思考中」指示 + 打字机逐字输出。数据来自 drilldown,真实组件不碰。

const USER_HOLD = 450;    // 用户气泡出现后停顿
const THINK_MS = 750;     // "思考中" 时长
const TYPE_TICK = 22;     // 打字机每帧间隔(ms)
const CHARS_PER_TICK = 2; // 每帧揭示字符数
const DONE_HOLD = 650;    // 一轮结束后进入下一轮的停顿
const MAX_USER = 200;      // demo 用:用户输入截断,避免超长拖慢打字
const MAX_ASSISTANT = 420; // demo 用:回答截断,避免超长拖慢节奏(放宽以容纳 markdown 结构)

type Stage = "user" | "thinking" | "typing" | "done";
type Item = { id: number; user: string; assistant: string; llmCalls: number; tools: { name: string; count: number }[] };

function buildItems(turns: UserTurn[]): Item[] {
  return turns.map((t) => {
    const u = t.userInput.trim();
    const full = (t.finalOutput ?? "").trim();
    const tally = new Map<string, number>();
    for (const c of t.calls) for (const tc of c.toolCalls ?? []) tally.set(tc.name, (tally.get(tc.name) ?? 0) + 1);
    const tools = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
    return {
      id: t.id,
      user: u.length > MAX_USER ? u.slice(0, MAX_USER) + "…" : u,
      assistant: full.length > MAX_ASSISTANT ? full.slice(0, MAX_ASSISTANT) + "…" : full,
      llmCalls: t.calls.length,
      tools,
    };
  });
}

export function ConversationView({ turns, focus, playing, restartNonce, instantReveal = false }: { turns: UserTurn[]; focus: Focus; playing: boolean; restartNonce: number; instantReveal?: boolean }) {
  const [items] = useState<Item[]>(() => buildItems(turns));
  // 末态:所有 turn 全展示,最后一条 assistant 完整。回看时(instantReveal)直接初始化到这里。
  const endTurn = Math.max(0, items.length - 1);
  const endTyped = items[endTurn]?.assistant.length ?? 0;
  const [turnIdx, setTurnIdx] = useState(() => (instantReveal ? endTurn : 0));
  const [stage, setStage] = useState<Stage>(() => (instantReveal ? "done" : "user"));
  const [typed, setTyped] = useState(() => (instantReveal ? endTyped : 0));
  const bottomRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 外部(R 键)重播 → 回到开头
  useEffect(() => { setTurnIdx(0); setStage("user"); setTyped(0); }, [restartNonce]);
  // 切幕回看 → 快进到末态(不跑打字机)。同 act 内部步骤切换、组件未 unmount 时也会触发。
  useEffect(() => {
    if (!instantReveal) return;
    setTurnIdx(endTurn);
    setStage("done");
    setTyped(endTyped);
  }, [instantReveal, endTurn, endTyped]);

  const cur = items[turnIdx];
  const hasAssistant = !!cur?.assistant;

  // 播放状态机:user → thinking → typing → done → 下一轮
  useEffect(() => {
    if (!playing || !cur) return;
    let timer: number;
    if (stage === "user") {
      timer = typed >= cur.user.length
        ? window.setTimeout(() => { setTyped(0); setStage(hasAssistant ? "thinking" : "done"); }, USER_HOLD)
        : window.setTimeout(() => setTyped((n) => Math.min(cur.user.length, n + CHARS_PER_TICK)), TYPE_TICK);
    } else if (stage === "thinking") {
      timer = window.setTimeout(() => { setTyped(0); setStage("typing"); }, THINK_MS);
    } else if (stage === "typing") {
      timer = typed >= cur.assistant.length
        ? window.setTimeout(() => setStage("done"), 0)
        : window.setTimeout(() => setTyped((n) => Math.min(cur.assistant.length, n + CHARS_PER_TICK)), TYPE_TICK);
    } else if (stage === "done" && turnIdx < items.length - 1) {
      timer = window.setTimeout(() => { setTurnIdx((i) => i + 1); setStage("user"); setTyped(0); }, DONE_HOLD);
    }
    return () => clearTimeout(timer);
  }, [playing, stage, typed, turnIdx, cur, hasAssistant, items.length]);

  // 跟随滚动:overview 跟到底;turn 滚到被框住的那一轮;final 落到底部最终回答。
  useEffect(() => {
    if (focus === "overview") bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turnIdx, stage, typed, focus]);
  useEffect(() => {
    // turn 强调第一轮 → 直接把滚动容器拉到顶(比 scrollIntoView 在动画中更可靠);
    // final → 落到底部最终回答。用 rAF 等布局稳定后再滚。
    const id = requestAnimationFrame(() => {
      if (focus === "turn") scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      else if (focus === "final") bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
    return () => cancelAnimationFrame(id);
  }, [focus]);

  const target = focus === "turn" ? 0 : focus === "final" ? items.length - 1 : -1;

  return (
    <div ref={scrollRef} style={{ height: "100%", overflowY: "auto", padding: "48px 0", minHeight: 0 }}>
      <style>{`.wt-md p{margin:0 0 8px}.wt-md p:last-child{margin-bottom:0}.wt-md ul,.wt-md ol{margin:4px 0;padding-left:20px}.wt-md li{margin:2px 0}.wt-md code{background:rgba(15,23,42,0.06);padding:1px 5px;border-radius:4px;font-size:0.9em}.wt-md pre{background:#0f172a;color:#e2e8f0;padding:10px 12px;border-radius:8px;overflow:auto;font-size:13px}.wt-md pre code{background:none;padding:0}.wt-md h1,.wt-md h2,.wt-md h3{margin:6px 0;font-size:1.05em;font-weight:700}.wt-md table{border-collapse:collapse;font-size:0.92em}.wt-md th,.wt-md td{border:1px solid #e5e7eb;padding:4px 8px}`}</style>
      <div style={{ width: "100%", maxWidth: 820, margin: "0 auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 30 }}>
        {items.slice(0, turnIdx + 1).map((it, i) => {
          const isCurrent = i === turnIdx;
          const userTyping = isCurrent && stage === "user";
          const userText = userTyping ? it.user.slice(0, typed) : it.user;
          const showThinking = isCurrent && stage === "thinking";
          const showAssistant = it.assistant && (!isCurrent || stage === "typing" || stage === "done");
          const assistantText = !isCurrent ? it.assistant : stage === "typing" ? it.assistant.slice(0, typed) : it.assistant;
          const isTyping = isCurrent && stage === "typing";
          const dimmed = target >= 0 && i !== target;
          const framed = focus === "turn" && i === target;
          const bubbles = (
            <>
              <Bubble side="left" role="User" text={userText} caret={userTyping && typed < it.user.length} />
              {showThinking && <Thinking />}
              {showAssistant && <Bubble side="right" role="Claude" text={assistantText} caret={isTyping} markdown />}
            </>
          );
          return (
            <div key={it.id} ref={i === target ? targetRef : undefined} style={{ opacity: dimmed ? 0.3 : 1, transition: "opacity .4s ease" }}>
              {framed ? (
                <div style={{ border: "2px solid #6366f1", borderRadius: 14, padding: "16px 16px 12px", position: "relative", background: "#fff" }}>
                  <div style={{ position: "absolute", top: -11, left: 16, background: "#6366f1", color: "#fff", fontSize: 11, fontWeight: 700, padding: "2px 10px", borderRadius: 999 }}>
                    Turn {it.id} · 轮次
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>{bubbles}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 14, paddingTop: 10, borderTop: "1px dashed #e5e7eb", fontSize: 12 }}>
                    <span style={{ fontWeight: 700, color: ACTOR_COLOR.llm.main }}>{it.llmCalls} 次 LLM 调用</span>
                    <span style={{ color: "#cbd5e1" }}>|</span>
                    {it.tools.map((tl) => (
                      <span key={tl.name} style={{ color: ACTOR_COLOR.agent.main, fontWeight: 600 }}>✓ {tl.name} ×{tl.count}</span>
                    ))}
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>{bubbles}</div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function Bubble({ side, role, text, caret, markdown }: { side: "left" | "right"; role: string; text: string; caret?: boolean; markdown?: boolean }) {
  const left = side === "left";
  // 左=User(slate),右=Claude/模型(靛蓝)—— 与后续 loop/recap 的演员配色一致。
  const c = left ? ACTOR_COLOR.user : ACTOR_COLOR.llm;
  // 打字时用纯文本(避免半截 markdown 闪烁);打完那条再转成 Markdown 渲染。
  const showMd = markdown && !caret;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: left ? "flex-start" : "flex-end", gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.3, color: c.main }}>{role}</span>
      <div
        style={{
          maxWidth: "82%",
          padding: "14px 18px",
          borderRadius: 16,
          fontSize: 16,
          lineHeight: 1.65,
          color: "#1f2937",
          background: c.bg,
          border: `1px solid ${c.border}`,
          wordBreak: "break-word",
          ...(showMd ? {} : { whiteSpace: "pre-wrap" }),
          ...(left ? { display: "-webkit-box", WebkitLineClamp: 6, WebkitBoxOrient: "vertical", overflow: "hidden" } : {}),
        }}
      >
        {showMd ? (
          <div className="wt-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
        ) : (
          <>
            {text}
            {caret && <span style={{ display: "inline-block", width: 8, marginLeft: 2, color: c.main, animation: "wt-blink 1s step-end infinite" }}>▍</span>}
          </>
        )}
      </div>
    </div>
  );
}

function Thinking() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, alignSelf: "flex-end", color: ACTOR_COLOR.llm.main, fontSize: 13 }}>
      <span>Claude is thinking</span>
      <span style={{ display: "inline-flex", gap: 3 }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 5, height: 5, borderRadius: 999, background: ACTOR_COLOR.llm.main, animation: `wt-pulse 1.2s ${i * 0.2}s infinite ease-in-out` }} />
        ))}
      </span>
      <style>{`@keyframes wt-blink{50%{opacity:0}}@keyframes wt-pulse{0%,80%,100%{opacity:0.3;transform:scale(0.8)}40%{opacity:1;transform:scale(1)}}`}</style>
    </div>
  );
}
