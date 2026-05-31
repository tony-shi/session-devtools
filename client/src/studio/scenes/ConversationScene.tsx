import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, interpolateColors } from "remotion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ACTOR_COLOR } from "../../v2/walkthrough/actorPalette";
import { buildConversationTimeline, type SceneTurn } from "./timeline";

// 第一幕「会话」的 frame-driven 版本:
//   - 整个 session 的 N 个 Turn 都渲染出来(和 recap 的「多个 Turn」一致),垂直居中、偏上,
//     底部留白给字幕。纯 CSS(justify-center + 不对称留白),不测量 DOM、与缩放无关。
//   - 焦点态随旁白切换:overview(step 0,整段会话) → turn(step 1,把「拿出来的那一轮」框住、其余变暗)。
//     被框的就是下一幕要展开的 Turn;它正好是中间那一轮,居中后天然落在画面中心偏上。
//   - 打字机 / 思考点 / caret / 框选淡入 全是 useCurrentFrame() 的纯函数。
// overviewEndFrame:旁白 step 0 结束的帧(焦点从 overview 切到 turn 的时刻)。
// focusTurnIdx:要「拿出来」的那一轮下标(下一幕展开的同一轮),被框住强调;缺省取最后一轮。

const FONT =
  "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, 'Segoe UI', sans-serif";
const MD_CSS = `.wt-md p{margin:0 0 8px}.wt-md p:last-child{margin-bottom:0}.wt-md ul,.wt-md ol{margin:4px 0;padding-left:20px}.wt-md li{margin:2px 0}.wt-md code{background:rgba(15,23,42,0.06);padding:1px 6px;border-radius:5px;font-size:0.92em}.wt-md table{border-collapse:collapse;font-size:0.95em;margin:4px 0}.wt-md th,.wt-md td{border:1px solid #e5e7eb;padding:6px 12px}.wt-md th{background:#f8fafc}`;

const PAD_TOP = 70;
// 视觉重心放在「中央偏上」:底部留出更大空白给字幕条 + 呼吸。内容整体垂直居中(justify-center)
// 后被这条不对称留白往上推 —— 焦点(被框的那一轮)落在画面中心偏上,且底部不会压到字幕行。
const PAD_BOTTOM = 285;
const floorChars = (len: number, t: number) => Math.max(0, Math.floor(len * t));

export const ConversationScene = ({
  turns,
  overviewEndFrame,
  focusTurnIdx,
}: {
  turns: SceneTurn[];
  overviewEndFrame: number;
  focusTurnIdx?: number;
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tl = buildConversationTimeline(turns, fps);

  // 聚焦的目标轮 = 下一幕要展开的那一轮(由外部传入);它就是「拿出来的 Turn」(中间那一轮)。
  const target =
    focusTurnIdx != null && focusTurnIdx >= 0 && focusTurnIdx < tl.turns.length
      ? focusTurnIdx
      : tl.turns.length - 1;
  // 渲染整段会话的所有轮次 —— 让「一个 Session 有多个 Turn」如实可见,和 recap 一致。
  const visibleTurns = tl.turns;

  const B = overviewEndFrame;
  // 焦点淡入(0→1):把目标轮框起来 + 其余轮变暗。镜头不动,只是「就地强调」。
  const focusIn = interpolate(frame, [B, B + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const caretOn = Math.floor(frame / Math.round(fps * 0.5)) % 2 === 0;

  return (
    <AbsoluteFill style={{ background: "#fff", fontFamily: FONT }}>
      <style>{MD_CSS}</style>
      {/* 垂直居中 + 底部不对称留白 → 整段会话落在画面中心偏上,底部留给字幕。
          overflow:hidden 裁掉超出画面的部分;flexShrink:0 保证正文是完整内容高度不被压缩。 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          padding: `${PAD_TOP}px 0 ${PAD_BOTTOM}px`,
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 1280,
            flexShrink: 0,
            padding: "0 48px",
            display: "flex",
            flexDirection: "column",
            gap: 30,
          }}
        >
          {visibleTurns.map((tt, i) => {
            if (frame < tt.start) return null;

            const userT = interpolate(frame, [tt.start, tt.userTypeEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const userTyping = frame < tt.userTypeEnd;
            const inThink = !!tt.turn.assistant && frame >= tt.userTypeEnd && frame < tt.thinkEnd;
            const asstActive = !!tt.turn.assistant && frame >= tt.thinkEnd;
            const asstT = interpolate(frame, [tt.thinkEnd, tt.asstTypeEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const asstTyping = asstActive && frame < tt.asstTypeEnd;

            const bubbles = (
              <>
                <Bubble side="left" role="用户" text={tt.turn.user.slice(0, floorChars(tt.turn.user.length, userT))} typing={userTyping} caretOn={caretOn} />
                {inThink && <Thinking frame={frame} fps={fps} />}
                {asstActive && (
                  <Bubble side="right" role="Claude" markdown text={tt.turn.assistant.slice(0, floorChars(tt.turn.assistant.length, asstT))} typing={asstTyping} caretOn={caretOn} />
                )}
              </>
            );

            // 非目标轮:turn 焦点态下变暗
            const dim = i === target ? 1 : interpolate(focusIn, [0, 1], [1, 0.3]);

            if (i === target) {
              // 目标轮:turn 阶段渐显框选 + 角标 + 底部统计(focusIn 驱动)。框就地淡入,不移动镜头。
              const borderCol = interpolateColors(focusIn, [0, 1], ["rgba(99,102,241,0)", "rgba(99,102,241,1)"]);
              return (
                <div key={tt.turn.id} style={{ position: "relative", border: `2px solid ${borderCol}`, borderRadius: 18, padding: 22, background: focusIn > 0.01 ? "#fff" : "transparent" }}>
                  {focusIn > 0.01 && (
                    <div style={{ position: "absolute", top: -16, left: 22, background: "#6366f1", color: "#fff", fontSize: 16, fontWeight: 700, padding: "3px 14px", borderRadius: 999, opacity: focusIn }}>
                      Turn {tt.turn.id} · 轮次
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{bubbles}</div>
                  {focusIn > 0.01 && (
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, marginTop: 18, paddingTop: 14, borderTop: "1px dashed #e5e7eb", fontSize: 18, opacity: focusIn }}>
                      <span style={{ fontWeight: 700, color: ACTOR_COLOR.llm.main }}>{tt.turn.llmCalls} 次 LLM 调用</span>
                      <span style={{ color: "#cbd5e1" }}>|</span>
                      {tt.turn.tools.map((tool) => (
                        <span key={tool.name} style={{ color: ACTOR_COLOR.agent.main, fontWeight: 600 }}>✓ {tool.name} ×{tool.count}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div key={tt.turn.id} style={{ display: "flex", flexDirection: "column", gap: 16, opacity: dim }}>{bubbles}</div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

// typing:这条是否正在逐字打(稳定布尔,决定渲染纯文本还是 markdown);
// caretOn:光标闪烁相位(只控制 ▍ 是否可见)。两者分开 —— 否则光标闪灭那半秒会误渲染半截 markdown。
function Bubble({ side, role, text, typing, caretOn, markdown }: { side: "left" | "right"; role: string; text: string; typing: boolean; caretOn: boolean; markdown?: boolean }) {
  const left = side === "left";
  const c = left ? ACTOR_COLOR.user : ACTOR_COLOR.llm;
  const showMd = markdown && !typing && text.length > 0;
  const caret = typing && caretOn;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: left ? "flex-start" : "flex-end", gap: 6 }}>
      <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: 0.5, color: c.main }}>{role}</span>
      <div
        style={{
          maxWidth: "84%",
          padding: "15px 22px",
          borderRadius: 20,
          fontSize: 25,
          lineHeight: 1.55,
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
          const phase = ((frame / (fps * 1.2)) + i * 0.18) % 1;
          const opacity = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
          return <span key={i} style={{ width: 9, height: 9, borderRadius: 999, background: ACTOR_COLOR.llm.main, opacity }} />;
        })}
      </span>
    </div>
  );
}
