import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useWalkthrough } from "./useWalkthrough";
import { STORIES } from "./stories/agent-loop";
import { STAGE_CONFIG } from "./config";
import type { ActId } from "./types";
import { apiV2 } from "../api";
import type { UserTurn, LlmCall, SessionDrilldown } from "../drilldown-types";
import { AttributionGraphProvider } from "../attribution-graph-context";
import { ConversationView } from "./views/ConversationView";
import { AgentLoopView } from "./views/AgentLoopView";
import { LlmCallDetailPanel } from "../session-detail/call/LlmCallDetailPanel";

const NOOP = () => { /* demo: inert */ };

type StageData = { act: ActId; sessionId: string; turns: UserTurn[]; turn: UserTurn | null; call: LlmCall | null };

// 按某一幕的 STAGE_CONFIG 解析其 demo 目标。drilldown 按 sessionId 缓存,多幕共享
// 同一会话时只取一次。任意字段留空 → 自动推导。
async function resolveForAct(act: ActId, cache: Map<string, SessionDrilldown>): Promise<StageData> {
  const cfg = STAGE_CONFIG[act];
  let sessionId = (cfg.sessionId ?? "").trim();
  if (!sessionId) {
    const resp = await apiV2.sessions({ limit: 20 });
    sessionId = (resp.sessions.find((s) => s.llm_call_count >= 2) ?? resp.sessions[0])?.session_id ?? "";
  }
  if (!sessionId) throw new Error("no session");
  let dd = cache.get(sessionId);
  if (!dd) { dd = await apiV2.sessionDrilldown(sessionId); cache.set(sessionId, dd); }
  const turns = dd.turns;
  const turn =
    (cfg.turnId != null ? turns.find((t) => t.id === cfg.turnId) : undefined) ??
    turns.find((t) => t.calls.length >= 2) ??
    turns.find((t) => t.calls.length >= 1) ??
    turns[0] ?? null;
  const call =
    (cfg.callId != null ? turn?.calls.find((c) => c.id === cfg.callId) : undefined) ??
    turn?.calls[0] ?? null;
  return { act, sessionId, turns, turn, call };
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
  const { index, next, prev, isFirst, isLast } = useWalkthrough(story?.steps.length ?? 0);

  // 启动时把每一幕的数据一次性解析好,存进 act→data;切幕直接读,无加载闪烁。
  const [byAct, setByAct] = useState<Partial<Record<ActId, StageData>> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const cacheRef = useRef<Map<string, SessionDrilldown>>(new Map());

  useEffect(() => {
    const s = STORIES[storyId];
    if (!s) return;
    let cancelled = false;
    (async () => {
      try {
        const acts = [...new Set(s.steps.map((st) => st.act))];
        const entries = await Promise.all(acts.map(async (a) => [a, await resolveForAct(a, cacheRef.current)] as const));
        if (!cancelled) { setByAct(Object.fromEntries(entries)); setState("ready"); }
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => { cancelled = true; };
  }, [storyId]);

  if (!story) {
    return <div style={{ padding: 40, color: "#6b7280" }}>未找到 walkthrough：<code>{storyId}</code></div>;
  }

  const step = story.steps[index];
  const data = byAct?.[step.act] ?? null;

  return (
    <div style={{ flex: 1, position: "relative", minHeight: 0, background: "#fff", overflow: "hidden", borderRadius: 12 }}>
      {/* 视频画面:幕内容全幅铺满 */}
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {state === "loading" && <div style={{ padding: 24, color: "#6b7280" }}>正在加载…</div>}
        {state === "error" && <div style={{ padding: 24, color: "#b91c1c" }}>找不到可用会话。请在 config.ts 的 STAGE_CONFIG 指定 sessionId。</div>}
        {state === "ready" && data && <ActContent act={step.act} data={data} />}
      </div>

      {/* 悬浮字幕(播报):配置的文案逐字播出 */}
      {state === "ready" && <NarrationBox key={index} caption={step.caption} takeaway={step.takeaway} />}

      {/* 右侧 hover 才显示的极简控件 */}
      <div className="wt-nav" style={navZone}>
        <button onClick={prev} disabled={isFirst} style={navBtn(isFirst)} title="上一幕">‹</button>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.75)", fontVariantNumeric: "tabular-nums" }}>{index + 1}/{story.steps.length}</span>
        <button onClick={next} disabled={isLast} style={navBtn(isLast)} title="下一幕">›</button>
        <button onClick={() => navigate("/sessions")} style={{ ...navBtn(false), marginTop: 10, fontSize: 13 }} title="退出">✕</button>
      </div>
      <style>{`.wt-nav{opacity:0;transition:opacity .25s ease}.wt-nav:hover{opacity:1}@keyframes wt-fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes wt-blink{50%{opacity:0}}`}</style>
    </div>
  );
}

// 悬浮字幕框:配置好的文案逐字"播报"(打字机),takeaway 打完淡入。
function NarrationBox({ caption, takeaway }: { caption: string; takeaway?: string }) {
  const [n, setN] = useState(0);
  useEffect(() => { setN(0); }, [caption]);
  useEffect(() => {
    if (n >= caption.length) return;
    const t = window.setTimeout(() => setN((x) => Math.min(caption.length, x + 2)), 28);
    return () => clearTimeout(t);
  }, [n, caption]);
  const typing = n < caption.length;
  return (
    <div style={{ position: "absolute", left: "50%", bottom: 44, transform: "translateX(-50%)", width: "min(760px, calc(100% - 130px))", animation: "wt-fade .4s ease both" }}>
      <div style={{ background: "rgba(15,23,42,0.82)", backdropFilter: "blur(6px)", borderRadius: 14, padding: "16px 22px", boxShadow: "0 12px 40px rgba(0,0,0,0.35)" }}>
        <div style={{ fontSize: 20, lineHeight: 1.5, color: "#fff", fontWeight: 500 }}>
          {caption.slice(0, n)}
          {typing && <span style={{ marginLeft: 2, color: "#a5b4fc", animation: "wt-blink 1s step-end infinite" }}>▍</span>}
        </div>
        {takeaway && !typing && (
          <div style={{ marginTop: 10, fontSize: 14, color: "#c7d2fe", animation: "wt-fade .3s ease both" }}>{takeaway}</div>
        )}
      </div>
    </div>
  );
}

const navZone: React.CSSProperties = {
  position: "absolute", top: 0, right: 0, height: "100%", width: 92,
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10,
  background: "linear-gradient(to left, rgba(15,23,42,0.30), transparent)",
};

function navBtn(disabled: boolean): React.CSSProperties {
  return {
    width: 40, height: 40, borderRadius: 999, border: "none",
    background: "rgba(15,23,42,0.72)", color: disabled ? "rgba(255,255,255,0.3)" : "#fff",
    fontSize: 20, lineHeight: 1, cursor: disabled ? "default" : "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
  };
}
