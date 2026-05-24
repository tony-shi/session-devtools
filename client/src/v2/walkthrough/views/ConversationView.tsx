import { useEffect, useRef, useState } from "react";
import type { UserTurn } from "../../drilldown-types";

// 第一幕:多轮对话的「播放」。镜像官方 context-window simulation 的感觉 ——
// auto-play + 逐步揭示 + 跟随滚动。用户输入在左、Claude 输出在右,Claude 回答
// 带「思考中」指示 + 打字机逐字输出。数据来自 drilldown,真实组件不碰。

const USER_HOLD = 450;    // 用户气泡出现后停顿
const THINK_MS = 750;     // "思考中" 时长
const TYPE_TICK = 22;     // 打字机每帧间隔(ms)
const CHARS_PER_TICK = 2; // 每帧揭示字符数
const DONE_HOLD = 650;    // 一轮结束后进入下一轮的停顿
const MAX_USER = 200;      // demo 用:用户输入截断,避免超长拖慢打字
const MAX_ASSISTANT = 280; // demo 用:回答截断,避免超长拖慢节奏

type Stage = "user" | "thinking" | "typing" | "done";
type Item = { id: number; user: string; assistant: string };

function buildItems(turns: UserTurn[]): Item[] {
  return turns.map((t) => {
    const u = t.userInput.trim();
    const full = (t.finalOutput ?? "").trim();
    return {
      id: t.id,
      user: u.length > MAX_USER ? u.slice(0, MAX_USER) + "…" : u,
      assistant: full.length > MAX_ASSISTANT ? full.slice(0, MAX_ASSISTANT) + "…" : full,
    };
  });
}

export function ConversationView({ turns }: { turns: UserTurn[] }) {
  const [items] = useState<Item[]>(() => buildItems(turns));
  const [turnIdx, setTurnIdx] = useState(0);
  const [stage, setStage] = useState<Stage>("user");
  const [typed, setTyped] = useState(0);
  const [playing, setPlaying] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

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

  // 跟随滚动
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turnIdx, stage, typed]);

  const restart = () => { setTurnIdx(0); setStage("user"); setTyped(0); setPlaying(true); };
  const skip = () => {
    setPlaying(false);
    setTurnIdx(items.length - 1);
    setStage("done");
    setTyped(items[items.length - 1]?.assistant.length ?? 0);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* 播放控件 */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderBottom: "1px solid #f1f5f9" }}>
        <button onClick={() => setPlaying((p) => !p)} style={ctrlBtn}>{playing ? "⏸ 暂停" : "▶ 播放"}</button>
        <button onClick={restart} style={ctrlBtn}>⟲ 重播</button>
        <button onClick={skip} style={ctrlBtn}>⤏ 跳到底</button>
      </div>

      {/* 对话流 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "40px 0", minHeight: 0 }}>
        <div style={{ width: "100%", maxWidth: 820, margin: "0 auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 30 }}>
          {items.slice(0, turnIdx + 1).map((it, i) => {
            const isCurrent = i === turnIdx;
            const userTyping = isCurrent && stage === "user";
            const userText = userTyping ? it.user.slice(0, typed) : it.user;
            const showThinking = isCurrent && stage === "thinking";
            const showAssistant = it.assistant && (!isCurrent || stage === "typing" || stage === "done");
            const assistantText = !isCurrent ? it.assistant : stage === "typing" ? it.assistant.slice(0, typed) : it.assistant;
            const isTyping = isCurrent && stage === "typing";
            return (
              <div key={it.id} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <Bubble side="left" role="User" text={userText} caret={userTyping && typed < it.user.length} />
                {showThinking && <Thinking />}
                {showAssistant && <Bubble side="right" role="Claude" text={assistantText} caret={isTyping} />}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

function Bubble({ side, role, text, caret }: { side: "left" | "right"; role: string; text: string; caret?: boolean }) {
  const left = side === "left";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: left ? "flex-start" : "flex-end", gap: 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.3, color: left ? "#6366f1" : "#0f766e" }}>{role}</span>
      <div
        style={{
          maxWidth: "82%",
          padding: "14px 18px",
          borderRadius: 16,
          borderTopLeftRadius: left ? 4 : 16,
          borderTopRightRadius: left ? 16 : 4,
          fontSize: 16,
          lineHeight: 1.65,
          color: "#1f2937",
          background: left ? "#eef2ff" : "#f0fdfa",
          border: `1px solid ${left ? "#e0e7ff" : "#ccfbf1"}`,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          ...(left ? { display: "-webkit-box", WebkitLineClamp: 6, WebkitBoxOrient: "vertical", overflow: "hidden" } : {}),
        }}
      >
        {text}
        {caret && <span style={{ display: "inline-block", width: 8, marginLeft: 2, color: "#0f766e", animation: "wt-blink 1s step-end infinite" }}>▍</span>}
      </div>
    </div>
  );
}

function Thinking() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, alignSelf: "flex-end", color: "#0f766e", fontSize: 13 }}>
      <span>Claude is thinking</span>
      <span style={{ display: "inline-flex", gap: 3 }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 5, height: 5, borderRadius: 999, background: "#14b8a6", animation: `wt-pulse 1.2s ${i * 0.2}s infinite ease-in-out` }} />
        ))}
      </span>
      <style>{`@keyframes wt-blink{50%{opacity:0}}@keyframes wt-pulse{0%,80%,100%{opacity:0.3;transform:scale(0.8)}40%{opacity:1;transform:scale(1)}}`}</style>
    </div>
  );
}

const ctrlBtn: React.CSSProperties = {
  padding: "5px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer",
  border: "1px solid #e5e7eb", background: "#fff", color: "#374151",
};
