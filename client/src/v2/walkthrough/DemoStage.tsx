import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useWalkthrough } from "./useWalkthrough";
import { STORIES } from "./stories/agent-loop";
import { DEMO_SESSION_ID } from "./config";
import type { ActId } from "./types";
import { apiV2 } from "../api";
import type { UserTurn, LlmCall } from "../drilldown-types";
import { AttributionGraphProvider } from "../attribution-graph-context";
import { ConversationView } from "./views/ConversationView";
import { AgentLoopView } from "./views/AgentLoopView";
import { LlmCallDetailPanel } from "../session-detail/call/LlmCallDetailPanel";

const NOOP = () => { /* demo: inert */ };

type StageData = { sessionId: string; turns: UserTurn[]; turn: UserTurn | null; call: LlmCall | null };

// 解析本机 demo 目标:config 指定的 session,或列表第一条 >=2 call 的会话;
// turn/call 从其 drilldown 自动推导(第一个 >=2 call 的 turn 的首个 call)。
async function resolveStageData(): Promise<StageData> {
  const resp = await apiV2.sessions({ limit: 20 });
  const sessionId =
    DEMO_SESSION_ID ||
    (resp.sessions.find((s) => s.llm_call_count >= 2) ?? resp.sessions[0])?.session_id;
  if (!sessionId) throw new Error("no session");
  const dd = await apiV2.sessionDrilldown(sessionId);
  const turn =
    dd.turns.find((t) => t.calls.length >= 2) ??
    dd.turns.find((t) => t.calls.length >= 1) ??
    dd.turns[0] ?? null;
  return { sessionId, turns: dd.turns, turn, call: turn?.calls[0] ?? null };
}

// 每一幕的特化编排:复用真实叶子组件,但布局由我们自己摆。
// Act2/Act3 的叶子依赖 useAttributionGraph → 包一层 AttributionGraphProvider。
function ActContent({ act, data }: { act: ActId; data: StageData }) {
  if (!data.turn) return <div style={{ padding: 24, color: "#6b7280" }}>该会话无可用 turn。</div>;

  if (act === "conversation") {
    return <ConversationView turns={data.turns} />;
  }

  if (act === "turn-io") {
    return <AgentLoopView turn={data.turn} />;
  }

  // llm-call
  return data.call ? (
    <AttributionGraphProvider sessionId={data.sessionId} onJumpToCall={null}>
      <div style={{ height: "100%", overflowY: "auto", padding: 16 }}>
        <LlmCallDetailPanel call={data.call} sessionId={data.sessionId} onSelectEntry={NOOP} />
      </div>
    </AttributionGraphProvider>
  ) : (
    <div style={{ padding: 24, color: "#6b7280" }}>该 turn 无可用 call。</div>
  );
}

// 独立 path /demo/:storyId 上的教学画板。深色外框 + 白色舞台(承载浅色叶子组件)。
export function DemoStage() {
  const { storyId = "" } = useParams();
  const navigate = useNavigate();
  const story = STORIES[storyId];
  const { index, next, prev, goTo, isFirst, isLast } = useWalkthrough(story?.steps.length ?? 0);

  const [data, setData] = useState<StageData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    resolveStageData()
      .then((d) => { if (!cancelled) { setData(d); setState("ready"); } })
      .catch(() => { if (!cancelled) setState("error"); });
    return () => { cancelled = true; };
  }, []);

  if (!story) {
    return <div style={{ padding: 40, color: "#6b7280" }}>未找到 walkthrough：<code>{storyId}</code></div>;
  }

  const step = story.steps[index];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, background: "#0f172a", borderRadius: 12, overflow: "hidden" }}>
      {/* 顶条 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: "#a5b4fc", textTransform: "uppercase" }}>
          {story.title}
        </span>
        <button onClick={() => navigate("/sessions")} style={ghostBtn}>退出 ✕</button>
      </div>

      {/* 舞台:白色承载区(浅色叶子组件按设计渲染) */}
      <div style={{ flex: 1, margin: 16, borderRadius: 12, background: "#fff", overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" }}>
        {state === "loading" && <div style={{ padding: 24, color: "#6b7280" }}>正在加载 demo 会话…</div>}
        {state === "error" && <div style={{ padding: 24, color: "#b91c1c" }}>找不到可用会话。请先在 session 列表同步,或在 config.ts 指定 DEMO_SESSION_ID。</div>}
        {state === "ready" && data && <ActContent act={step.act} data={data} />}
      </div>

      {/* 底部:文案 + 控件 */}
      <div style={{ padding: "16px 24px", borderTop: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" }}>
        <div style={{ fontSize: 16, color: "#f1f5f9", lineHeight: 1.5 }}>{step.caption}</div>
        {step.takeaway && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#c7d2fe", borderLeft: "3px solid #818cf8", paddingLeft: 10 }}>
            {step.takeaway}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {story.steps.map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                aria-label={`step ${i + 1}`}
                style={{ width: 9, height: 9, borderRadius: 999, border: "none", padding: 0, cursor: "pointer", background: i === index ? "#818cf8" : "rgba(148,163,184,0.4)" }}
              />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#94a3b8", marginRight: 4 }}>{index + 1} / {story.steps.length}</span>
            <button onClick={prev} disabled={isFirst} style={stepBtn(isFirst)}>← 上一步</button>
            <button onClick={next} disabled={isLast} style={stepBtn(isLast, true)}>下一步 →</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const ghostBtn: React.CSSProperties = {
  border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 13,
};

function stepBtn(disabled: boolean, primary = false): React.CSSProperties {
  return {
    padding: "7px 16px", borderRadius: 8, fontSize: 13,
    cursor: disabled ? "default" : "pointer",
    border: primary ? "none" : "1px solid rgba(148,163,184,0.35)",
    background: disabled ? "rgba(148,163,184,0.15)" : primary ? "#6366f1" : "transparent",
    color: disabled ? "#64748b" : primary ? "#fff" : "#e2e8f0",
  };
}
