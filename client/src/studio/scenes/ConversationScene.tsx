import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ACTOR_COLOR } from "../../v2/walkthrough/actorPalette";
import { buildConversationTimeline, type SceneTurn } from "./timeline";

// 第一幕「会话」的 frame-driven 版本 —— 与现在 live 的 ConversationView 视觉一致,
// 但所有动画都是 useCurrentFrame() 的纯函数:打字机、思考点、caret 全部按帧推进。
// 同一个组件既能在 Remotion Studio 预览,又能 remotion render 出 mp4(将来还能塞进
// @remotion/player 嵌进网页)—— 预览即出片,parity 由 Remotion 帧引擎保证。

const FONT =
  "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, 'Segoe UI', sans-serif";

const MD_CSS = `.wt-md p{margin:0 0 8px}.wt-md p:last-child{margin-bottom:0}.wt-md ul,.wt-md ol{margin:4px 0;padding-left:20px}.wt-md li{margin:2px 0}.wt-md code{background:rgba(15,23,42,0.06);padding:1px 6px;border-radius:5px;font-size:0.92em}.wt-md table{border-collapse:collapse;font-size:0.95em;margin:4px 0}.wt-md th,.wt-md td{border:1px solid #e5e7eb;padding:6px 12px}.wt-md th{background:#f8fafc}`;

const floorChars = (len: number, t: number) => Math.max(0, Math.floor(len * t));

export const ConversationScene = ({ turns }: { turns: SceneTurn[] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tl = buildConversationTimeline(turns, fps);

  // caret 闪烁:每 ~0.5s 翻转一次,帧驱动(不用 CSS keyframe,保证渲染确定)
  const caretOn = Math.floor(frame / Math.round(fps * 0.5)) % 2 === 0;

  return (
    <AbsoluteFill style={{ background: "#fff", fontFamily: FONT }}>
      <style>{MD_CSS}</style>
      {/* 底部锚定:对话像聊天一样从下往上堆,新内容贴着底部 —— 省掉 Phase 1 的滚动测量。
          (超出整屏的滚动留到 Phase 2 polish。) */}
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "70px 0" }}>
        <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", padding: "0 48px", display: "flex", flexDirection: "column", gap: 34 }}>
          {tl.turns.map((tt) => {
            if (frame < tt.start) return null; // 还没轮到这一轮

            const userT = interpolate(frame, [tt.start, tt.userTypeEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const userTyping = frame < tt.userTypeEnd;
            const inThink = !!tt.turn.assistant && frame >= tt.userTypeEnd && frame < tt.thinkEnd;
            const asstActive = !!tt.turn.assistant && frame >= tt.thinkEnd;
            const asstT = interpolate(frame, [tt.thinkEnd, tt.asstTypeEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const asstTyping = asstActive && frame < tt.asstTypeEnd;

            return (
              <div key={tt.turn.id} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Bubble
                  side="left"
                  role="User"
                  text={tt.turn.user.slice(0, floorChars(tt.turn.user.length, userT))}
                  caret={userTyping && caretOn}
                />
                {inThink && <Thinking frame={frame} fps={fps} />}
                {asstActive && (
                  <Bubble
                    side="right"
                    role="Claude"
                    markdown
                    text={tt.turn.assistant.slice(0, floorChars(tt.turn.assistant.length, asstT))}
                    caret={asstTyping && caretOn}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

function Bubble({ side, role, text, caret, markdown }: { side: "left" | "right"; role: string; text: string; caret: boolean; markdown?: boolean }) {
  const left = side === "left";
  const c = left ? ACTOR_COLOR.user : ACTOR_COLOR.llm;
  // 打字途中用纯文本(避免半截 markdown 抖动);打完那条再转 Markdown 渲染。
  const showMd = markdown && !caret && text.length > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: left ? "flex-start" : "flex-end", gap: 8 }}>
      <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: 0.5, color: c.main }}>{role}</span>
      <div
        style={{
          maxWidth: "82%",
          padding: "20px 26px",
          borderRadius: 22,
          fontSize: 28,
          lineHeight: 1.65,
          color: "#1f2937",
          background: c.bg,
          border: `1px solid ${c.border}`,
          wordBreak: "break-word",
          ...(showMd ? {} : { whiteSpace: "pre-wrap" }),
        }}
      >
        {showMd ? (
          <div className="wt-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
        ) : (
          <>
            {text}
            {caret && <span style={{ display: "inline-block", width: 10, marginLeft: 3, color: c.main }}>▍</span>}
          </>
        )}
      </div>
    </div>
  );
}

function Thinking({ frame, fps }: { frame: number; fps: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, alignSelf: "flex-end", color: ACTOR_COLOR.llm.main, fontSize: 22 }}>
      <span>Claude is thinking</span>
      <span style={{ display: "inline-flex", gap: 5 }}>
        {[0, 1, 2].map((i) => {
          // 三点错相位脉动,帧驱动(替代 CSS @keyframes,保证逐帧确定)
          const phase = ((frame / (fps * 1.2)) + i * 0.18) % 1;
          const opacity = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
          return <span key={i} style={{ width: 9, height: 9, borderRadius: 999, background: ACTOR_COLOR.llm.main, opacity }} />;
        })}
      </span>
    </div>
  );
}
