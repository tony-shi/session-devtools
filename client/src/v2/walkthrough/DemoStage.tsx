import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useWalkthrough } from "./useWalkthrough";
import { STORIES } from "./stories/agent-loop";
import { STAGE_CONFIG } from "./config";
import type { ActId, Focus } from "./types";
import { apiV2 } from "../api";
import type { UserTurn, LlmCall, SessionDrilldown } from "../drilldown-types";
import { AttributionGraphProvider } from "../attribution-graph-context";
import { ConversationView } from "./views/ConversationView";
import { AgentLoopView } from "./views/AgentLoopView";
import { LlmCallDetailPanel } from "../session-detail/call/LlmCallDetailPanel";

const NOOP = () => { /* demo: inert */ };
const BEAT_MS = 2600; // 每行字幕 / 每个揭示阶段的停留时长

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
function ActContent({ act, data, focus, beat, beatCount, playing, restartNonce }: { act: ActId; data: StageData; focus: Focus; beat: number; beatCount: number; playing: boolean; restartNonce: number }) {
  if (!data.turn) return <div style={{ padding: 24, color: "#6b7280" }}>该会话无可用 turn。</div>;

  if (act === "conversation") {
    return <ConversationView turns={data.turns} focus={focus} playing={playing} restartNonce={restartNonce} />;
  }

  if (act === "turn-io") {
    return <AgentLoopView turn={data.turn} focus={focus} beat={beat} beatCount={beatCount} playing={playing} restartNonce={restartNonce} />;
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
  const { index, next, prev } = useWalkthrough(story?.steps.length ?? 0);

  // 启动时把每一幕的数据一次性解析好,存进 act→data;切幕直接读,无加载闪烁。
  const [byAct, setByAct] = useState<Partial<Record<ActId, StageData>> | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const cacheRef = useRef<Map<string, SessionDrilldown>>(new Map());
  const [playing, setPlaying] = useState(true);
  const [restartNonce, setRestartNonce] = useState(0);
  // beat = 当前字幕行 / 揭示阶段(字幕与画面揭示共用同一个节拍,逐步同步推进)。
  const [beat, setBeat] = useState(0);

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

  // 键盘控制:← / → 切幕,Space 播放/暂停,R 重播,Esc 退出。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
      else if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === "r" || e.key === "R") { setRestartNonce((n) => n + 1); setPlaying(true); }
      else if (e.key === "Escape") { navigate("/sessions"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, navigate]);

  // 切幕时自动恢复播放、节拍归零;R 键(restartNonce)也归零。
  useEffect(() => { setPlaying(true); setBeat(0); }, [index]);
  useEffect(() => { setBeat(0); }, [restartNonce]);
  // 节拍时钟:每 BEAT_MS 前进一行,停在最后一行(由 ← / → 切幕)。
  useEffect(() => {
    if (!playing) return;
    const n = STORIES[storyId]?.steps[index]?.lines.length ?? 0;
    if (beat >= n - 1) return;
    const t = window.setTimeout(() => setBeat((b) => b + 1), BEAT_MS);
    return () => clearTimeout(t);
  }, [playing, beat, index, storyId]);

  if (!story) {
    return <div style={{ padding: 40, color: "#6b7280" }}>未找到 walkthrough：<code>{storyId}</code></div>;
  }

  const step = story.steps[index];
  const data = byAct?.[step.act] ?? null;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "#fff", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* 内容区:幕内容,绝不进入下方字幕带 */}
      <div style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}>
        {state === "loading" && <div style={{ padding: 24, color: "#6b7280" }}>正在加载…</div>}
        {state === "error" && <div style={{ padding: 24, color: "#b91c1c" }}>找不到可用会话。请在 config.ts 的 STAGE_CONFIG 指定 sessionId。</div>}
        {state === "ready" && data && <ActContent act={step.act} data={data} focus={step.focus} beat={beat} beatCount={step.lines.length} playing={playing} restartNonce={restartNonce} />}
      </div>

      {/* 字幕带:预留的固定区域,字幕只在这里出现,不与内容重叠 */}
      <div style={{ flexShrink: 0, display: "flex", justifyContent: "center", padding: "0 24px 40px" }}>
        {state === "ready" && <NarrationBox lines={step.lines} beat={beat} />}
      </div>
      <style>{`@keyframes wt-fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes wt-blink{50%{opacity:0}}@keyframes wt-rollup{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

// 悬浮字幕框:显示当前 beat 行(由 DemoStage 的节拍时钟驱动,和画面揭示同步)。
// 当前行打字播出,beat 变化时换行 + 上滚动画。
function NarrationBox({ lines, beat }: { lines: string[]; beat: number }) {
  const line = lines[beat] ?? "";
  const [n, setN] = useState(0);
  useEffect(() => { setN(0); }, [beat]);
  useEffect(() => {
    if (n >= line.length) return;
    const t = window.setTimeout(() => setN((x) => Math.min(line.length, x + 2)), 26);
    return () => clearTimeout(t);
  }, [n, line]);
  const typing = n < line.length;

  return (
    <div style={{ width: "min(820px, 100%)", animation: "wt-fade .4s ease both" }}>
      <div style={{ background: "rgba(15,23,42,0.82)", backdropFilter: "blur(6px)", borderRadius: 14, padding: "18px 24px", boxShadow: "0 12px 40px rgba(0,0,0,0.35)", minHeight: 30 }}>
        <div key={beat} style={{ fontSize: 21, lineHeight: 1.5, color: "#fff", fontWeight: 500, animation: "wt-rollup .45s ease both" }}>
          {line.slice(0, n)}
          {typing && <span style={{ marginLeft: 2, color: "#a5b4fc", animation: "wt-blink 1s step-end infinite" }}>▍</span>}
        </div>
        <div style={{ display: "flex", gap: 5, marginTop: 12 }}>
          {lines.map((_, i) => (
            <span key={i} style={{ width: 6, height: 6, borderRadius: 999, background: i === beat ? "#a5b4fc" : "rgba(255,255,255,0.25)" }} />
          ))}
        </div>
      </div>
    </div>
  );
}
