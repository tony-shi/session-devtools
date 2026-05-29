import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Player, type PlayerRef, type CallbackListener } from "@remotion/player";
import { AgentLoopStory, agentLoopStoryDuration } from "../../studio/scenes/AgentLoopStory";
import { getManifest } from "../../studio/scenes/narration";
import { loadLang, saveLang, type Lang } from "./i18n";

// 单源:live 的 /demo/agent-loop 不再走旧 AgentLoopView/RecapView,而是用 @remotion/player
// 直接播渲染视频用的同一套帧驱动场景(AgentLoopStory)。改一次 studio/scenes,live + 视频都更新。
//
// 旁白:Remotion 场景本身不画字幕(视频走音轨/SRT),这里在播放器下方补一条字幕带 ——
// 监听 player 的 frameupdate,按 manifest 把当前帧映射回旁白行。

const FPS = 30;

// 哪些 story 已 Remotion 化、走 Player。未来加一集就在这里登记。
export const REMOTION_STORIES: Record<string, { component: typeof AgentLoopStory; duration: (lang: string, fps: number) => number }> = {
  "agent-loop": { component: AgentLoopStory, duration: agentLoopStoryDuration },
};

// 当前帧 → 旁白行(从 manifest 累加 durMs + gapMs)。
function frameToLine(lang: string, frame: number): string {
  const m = getManifest(lang);
  if (!m) return "";
  const f = (ms: number) => Math.round((ms / 1000) * FPS);
  let cursor = 0;
  for (const step of m.steps) {
    for (const line of step.lines) {
      const dur = f(line.durMs);
      if (frame < cursor + dur) return line.text;
      cursor += dur + f(line.gapMs);
    }
  }
  return "";
}

export function RemotionStoryPlayer({ storyId }: { storyId: string }) {
  const navigate = useNavigate();
  const entry = REMOTION_STORIES[storyId];
  const [lang, setLang] = useState<Lang>(() => loadLang());
  useEffect(() => { saveLang(lang); }, [lang]);

  const playerRef = useRef<PlayerRef>(null);
  const [caption, setCaption] = useState("");
  const dur = useMemo(() => Math.max(1, entry ? entry.duration(lang, FPS) : 1), [entry, lang]);

  // 监听帧 → 更新字幕带。
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame: CallbackListener<"frameupdate"> = (e) => setCaption(frameToLine(lang, e.detail.frame));
    p.addEventListener("frameupdate", onFrame);
    return () => p.removeEventListener("frameupdate", onFrame);
  }, [lang]);

  // Esc 回目录。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") navigate("/demo"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  if (!entry) {
    return <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#6b7280" }}>该 story 未 Remotion 化:<code>{storyId}</code></div>;
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0b1020", display: "flex", flexDirection: "column", zIndex: 50 }}>
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 32px 12px" }}>
        <div style={{ width: "100%", maxWidth: 1280, aspectRatio: "16 / 9", boxShadow: "0 20px 60px rgba(0,0,0,0.45)", borderRadius: 12, overflow: "hidden" }}>
          <Player
            ref={playerRef}
            component={entry.component}
            inputProps={{ lang }}
            durationInFrames={dur}
            compositionWidth={1920}
            compositionHeight={1080}
            fps={FPS}
            style={{ width: "100%", height: "100%" }}
            controls
            autoPlay
            loop
          />
        </div>
      </div>

      {/* 字幕带(旁白)+ 语言切换 */}
      <div style={{ flexShrink: 0, padding: "0 32px 28px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <div style={{ width: "min(1100px, 100%)", minHeight: 36, textAlign: "center", fontSize: 20, lineHeight: 1.5, color: "#e2e8f0" }}>
          {caption}
        </div>
        <div style={{ display: "flex", gap: 2, padding: 3, background: "rgba(255,255,255,0.08)", borderRadius: 999 }}>
          {(["zh", "en"] as Lang[]).map((v) => (
            <button key={v} onClick={() => setLang(v)} style={{
              padding: "4px 12px", fontSize: 12, fontWeight: 700, border: "none", borderRadius: 999, cursor: "pointer",
              color: v === lang ? "#0b1020" : "#94a3b8", background: v === lang ? "#a5b4fc" : "transparent",
            }}>{v === "zh" ? "中" : "EN"}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
