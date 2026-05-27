import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useWalkthrough } from "./useWalkthrough";
import { STORIES } from "./stories";
import { STAGE_CONFIG } from "./config";
import type { ActId, Focus } from "./types";
import { apiV2 } from "../api";
import type { UserTurn, LlmCall, SessionDrilldown, CompactEvent, SubAgentSummary, ToolCallSlot } from "../drilldown-types";
import { AttributionGraphProvider } from "../attribution-graph-context";
import { ConversationView } from "./views/ConversationView";
import { AgentLoopView } from "./views/AgentLoopView";
import { RecapView } from "./views/RecapView";
import { ContextStackView } from "./views/ContextStackView";
import { AttributionTreeLensPanel } from "../AttributionTreeLensPanel";
import { DiffView } from "./views/DiffView";
import { ContextDiffRealView } from "./views/ContextDiffRealView";
import { CacheView } from "./views/CacheView";
import { CallLedger } from "../shared/CallLedger";
import { CompactView } from "./views/CompactView";
import { ToolsView } from "./views/ToolsView";
import { ExtendView } from "./views/ExtendView";
import { SubagentView } from "./views/SubagentView";
import { LlmCallDetailPanel } from "../session-detail/call/LlmCallDetailPanel";

const NOOP = () => { /* demo: inert */ };
const BEAT_MS = 2600; // 每行字幕 / 每个揭示阶段的停留时长

type StageData = { act: ActId; sessionId: string; turns: UserTurn[]; turn: UserTurn | null; call: LlmCall | null; compactEvents: CompactEvent[]; subAgents: SubAgentSummary[]; skillSlot: ToolCallSlot | null };

// 扫描会话里第一个带 skillInjection 的工具调用(用于 ep7 real 步;无则 null)。
function findSkillSlot(turns: UserTurn[]): ToolCallSlot | null {
  for (const t of turns) for (const c of t.calls) {
    const hit = c.toolCalls.find((s) => s.skillInjection || s.name === "Skill");
    if (hit) return hit;
  }
  return null;
}

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
  return { act, sessionId, turns, turn, call, compactEvents: dd.compactEvents ?? [], subAgents: dd.subAgents ?? [], skillSlot: findSkillSlot(turns) };
}

// 小统计块(ep8 subagent-real 用)。
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 12px", background: "#fff", minWidth: 96 }}>
      <div style={{ fontSize: 11, color: "#94a3b8" }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#334155" }}>{value}</div>
    </div>
  );
}

// 每一幕的特化编排:复用真实叶子组件,但布局由我们自己摆。
// Act2/Act3 的叶子依赖 useAttributionGraph → 包一层 AttributionGraphProvider。
function ActContent({ act, data, focus, beat, beatCount, playing, restartNonce }: { act: ActId; data: StageData | null; focus: Focus; beat: number; beatCount: number; playing: boolean; restartNonce: number }) {
  if (act === "recap") return <RecapView beat={beat} />;
  if (!data || !data.turn) return <div style={{ padding: 24, color: "#6b7280" }}>加载中…</div>;

  if (act === "conversation") {
    return <ConversationView turns={data.turns} focus={focus} playing={playing} restartNonce={restartNonce} />;
  }

  if (act === "turn-io") {
    return <AgentLoopView turn={data.turn} focus={focus} beat={beat} beatCount={beatCount} playing={playing} restartNonce={restartNonce} />;
  }

  if (act === "cw-stack") {
    return <ContextStackView turn={data.turn} focus={focus} beat={beat} />;
  }

  if (act === "cd-diff") {
    return <DiffView call={data.call} focus={focus} beat={beat} />;
  }

  if (act === "cd-real") {
    return <ContextDiffRealView sessionId={data.sessionId} callId={data.call?.id ?? 0} beat={beat} />;
  }

  if (act === "tools-concept") {
    return <ToolsView focus={focus} beat={beat} />;
  }

  if (act === "tools-real") {
    // 复用真实 attribution 面板,旁白把注意力引向其中的 tools 块(它通常是最大的一段)。
    return (
      <AttributionGraphProvider sessionId={data.sessionId} onJumpToCall={null}>
        <div style={{ height: "100%", overflowY: "auto", padding: 16, background: "#fff" }}>
          <AttributionTreeLensPanel sessionId={data.sessionId} callId={data.call?.id ?? 0} hideDiff />
        </div>
      </AttributionGraphProvider>
    );
  }

  if (act === "extend-concept") {
    return <ExtendView focus={focus} beat={beat} />;
  }

  if (act === "extend-real") {
    const s = data.skillSlot;
    if (!s) {
      return (
        <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
          <div style={{ width: "min(560px,100%)", color: "#6b7280", fontSize: 13, border: "1px dashed #cbd5e1", borderRadius: 10, padding: "14px 18px" }}>
            这条 demo 会话没有 Skill 调用 —— 但机制不变:skill 平时只占一行,被调用时才把全文注入 context。
            (想看真实数据,在 config.ts 把 extend-* 指向一条用过 /skill 的会话。)
          </div>
        </div>
      );
    }
    const inj = s.skillInjection;
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
        <div style={{ width: "min(620px,100%)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#334155", marginBottom: 12 }}>真实 Skill 调用 · {s.name}</div>
          {inj?.mode === "inline" && (
            <div style={{ fontSize: 13, color: "#312e81", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 8, padding: "10px 14px" }}>
              inline 模式:SKILL.md 全文({inj.totalChars.toLocaleString()} 字符)直接注入主对话 —— context 因此变大。
            </div>
          )}
          {inj?.mode === "forked" && (
            <div style={{ fontSize: 13, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px" }}>
              forked 模式:起子进程执行,主对话只剩 1 条 ack({inj.forkedResultChars.toLocaleString()} 字符结果)—— 主 context 几乎不涨。
            </div>
          )}
          {s.inputPreview && <div style={{ fontSize: 12, color: "#475569", marginTop: 10, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>调用:{s.inputPreview.slice(0, 200)}</div>}
        </div>
      </div>
    );
  }

  if (act === "subagent-concept") {
    return <SubagentView focus={focus} beat={beat} />;
  }

  if (act === "subagent-real") {
    const sa = data.subAgents[0];
    if (!sa) {
      return (
        <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
          <div style={{ width: "min(560px,100%)", color: "#6b7280", fontSize: 13, border: "1px dashed #cbd5e1", borderRadius: 10, padding: "14px 18px" }}>
            这条 demo 会话没有子 agent —— 但机制不变:派出隔离 context、独立走完一套、只带回摘要。
            (想看真实数据,在 config.ts 把 subagent-* 指向一条派过子 agent 的会话。)
          </div>
        </div>
      );
    }
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
        <div style={{ width: "min(640px,100%)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#334155", marginBottom: 10 }}>真实子 agent · {sa.agentType}</div>
          {sa.description && <div style={{ fontSize: 12, color: "#475569", marginBottom: 12 }}>任务:{sa.description}</div>}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <Stat label="独立 LLM 调用" value={`${sa.llmCallCount} 次`} />
            <Stat label="工具调用" value={`${sa.toolCallCount} 次`} />
            <Stat label="自身峰值 context" value={fmt(sa.peakContext)} />
            <Stat label="产出 token" value={fmt(sa.totalOutputTokens)} />
          </div>
          <div style={{ fontSize: 12, color: "#15803d", fontWeight: 700, marginBottom: 4 }}>← 只把这段摘要交回主 agent:</div>
          <div style={{ fontSize: 12, color: "#475569", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "10px 12px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {(sa.resultPreview || "(无摘要预览)").slice(0, 240)}
          </div>
        </div>
      </div>
    );
  }

  if (act === "cache-split") {
    return <CacheView call={data.call} focus={focus} beat={beat} />;
  }

  if (act === "compact-concept") {
    return <CompactView focus={focus} beat={beat} />;
  }

  if (act === "compact-real") {
    const ev = data.compactEvents[0];
    if (!ev) {
      return (
        <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
          <div style={{ width: "min(560px,100%)", color: "#6b7280", fontSize: 13, border: "1px dashed #cbd5e1", borderRadius: 10, padding: "14px 18px" }}>
            这条 demo 会话没有 compaction 事件 —— 但概念不变:涨满 → 总结 → 缩小,缓存失效、细节丢失。
            (想看真实数据,在 config.ts 把 compact-* 指向一条发生过 /compact 的会话。)
          </div>
        </div>
      );
    }
    const ratio = ev.preTokens > 0 ? Math.round((1 - ev.postTokens / ev.preTokens) * 100) : 0;
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const postPct = ev.preTokens > 0 ? Math.max(4, (ev.postTokens / ev.preTokens) * 100) : 20;
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
        <div style={{ width: "min(620px,100%)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#334155", marginBottom: 12 }}>真实 compaction 事件 · {ev.trigger}</div>
          <div style={{ fontSize: 14, color: "#15803d", fontWeight: 700, marginBottom: 10 }}>
            压缩前 {fmt(ev.preTokens)} → 压缩后 {fmt(ev.postTokens)} tokens(-{ratio}%)
          </div>
          <div style={{ height: 30, borderRadius: 8, background: "#fca5a5", overflow: "hidden", marginBottom: 6 }}>
            <div style={{ width: `${postPct}%`, height: "100%", background: "#86efac" }} />
          </div>
          {ev.userInstructions && <div style={{ fontSize: 12, color: "#6366f1", marginTop: 8 }}>/compact 指令:{ev.userInstructions}</div>}
          {ev.summaryText && <div style={{ fontSize: 12, color: "#475569", marginTop: 8, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>摘要预览:{ev.summaryText.slice(0, 200)}…</div>}
        </div>
      </div>
    );
  }

  if (act === "cache-real") {
    const c = data.call;
    if (!c) return <div style={{ padding: 24, color: "#6b7280" }}>该会话无可用 call。</div>;
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
        <div style={{ width: "min(620px, 100%)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#334155", marginBottom: 12 }}>这一次 Call 真实的 token 去向</div>
          <CallLedger
            size="full"
            freshIn={Math.max(0, c.contextSize - c.cacheRead - c.cacheWrite)}
            cacheRead={c.cacheRead}
            cacheWrite={c.cacheWrite}
            output={c.outputTokens}
            cacheMiss={c.cacheMiss}
            gapMs={c.gapSincePrevMs}
            ephemeral1h={c.cacheEphemeral1h}
            ephemeral5m={c.cacheEphemeral5m}
          />
        </div>
      </div>
    );
  }

  if (act === "cw-real") {
    // 复用 ep1 LLM Call 那套真实 attribution 面板,进一步 dig 进去;hideDiff 隐去
    // Diff lens(Cache lens 无拓扑时自动退化)—— 符合 ep2 只讲"context 构成"的边界。
    return (
      <AttributionGraphProvider sessionId={data.sessionId} onJumpToCall={null}>
        <div style={{ height: "100%", overflowY: "auto", padding: 16, background: "#fff" }}>
          <AttributionTreeLensPanel sessionId={data.sessionId} callId={data.call?.id ?? 0} hideDiff />
        </div>
      </AttributionGraphProvider>
    );
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
        const acts = [...new Set(s.steps.map((st) => st.act))].filter((a) => a !== "recap");
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
        {state === "ready" && <ActContent act={step.act} data={data} focus={step.focus} beat={beat} beatCount={step.lines.length} playing={playing} restartNonce={restartNonce} />}
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
