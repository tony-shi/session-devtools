import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { ACTOR_COLOR } from "../../v2/walkthrough/actorPalette";
import { useT } from "../i18n";

// 「下一章」过渡幕 —— 独立的一幕,对上 recap 末尾两句旁白(切入 context)。
// 用 Turn 2 最后一次 LLM Call 的 context 样式做闪回预告。字幕由上层 NarrationTrack/Caption 自动对齐
// (这一幕占据的就是那两句旁白的帧区间)。内容居中,落在字幕之上,不遮挡。
const FONT = "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif";
const AGENT = ACTOR_COLOR.agent.main;

export const NextChapterScene = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tr = useT();
  const t = interpolate(frame, [0, Math.round(fps * 0.5)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const segs = [
    { label: tr.ctxPrompt, w: 3, bg: "#e2e8f0", fg: "#475569" },
    { label: tr.ctxUserInput, w: 1.5, bg: "#ede9fe", fg: "#6d28d9" },
    { label: "tool_use 1", w: 1.1, bg: "#e0e7ff", fg: "#4338ca" },
    { label: "tool_result 1", w: 1.6, bg: "#ccfbf1", fg: AGENT },
    { label: "tool_use 2", w: 1.1, bg: "#e0e7ff", fg: "#4338ca" },
    { label: "tool_result 2", w: 1.6, bg: "#ccfbf1", fg: AGENT },
  ];
  const tw = segs.reduce((s, c) => s + c.w, 0);
  const scale = interpolate(t, [0, 1], [0.94, 1], { easing: Easing.out(Easing.cubic) });
  return (
    <AbsoluteFill style={{ background: "#f8fafc", fontFamily: FONT, justifyContent: "center", alignItems: "center", opacity: t }}>
      <div style={{ transform: `scale(${scale})`, width: "100%", maxWidth: 1240, padding: "0 60px 120px", textAlign: "center" }}>
        <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 4, color: "#94a3b8", marginBottom: 16 }}>{tr.nextKicker}</div>
        <div style={{ fontSize: 48, fontWeight: 800, color: "#1e293b", marginBottom: 40 }}>{tr.nextTitle}</div>
        {/* 闪回:Turn 2 最后一次 LLM Call 的 context */}
        <div style={{ display: "flex", gap: 5, height: 56, marginBottom: 16 }}>
          {segs.map((s, i) => (
            <div key={i} style={{ width: `${(s.w / tw) * 100}%`, borderRadius: 9, background: s.bg, color: s.fg, fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{s.label}</div>
          ))}
        </div>
        <div style={{ fontSize: 18, color: "#94a3b8" }}>{tr.nextFooter}</div>
      </div>
    </AbsoluteFill>
  );
};
