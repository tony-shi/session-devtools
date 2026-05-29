import { useLayoutEffect, useRef, useState } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, interpolateColors } from "remotion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ACTOR_COLOR } from "../../v2/walkthrough/actorPalette";
import { buildConversationTimeline, type SceneTurn } from "./timeline";

// 第一幕「会话」的 frame-driven 版本 —— 对齐 live ConversationView:
//   - 内容自顶部向下排,跟随滚动(超出视口才上滚,保留最新)—— 不再底部锚定/居中
//   - 焦点态随旁白切换:overview(step 0,全局播放) → turn(step 1,框住 Turn 1、其余变暗)
//   - 打字机 / 思考点 / caret / 滚动 / 框选淡入 全是 useCurrentFrame() 的纯函数
// overviewEndFrame:旁白 step 0 结束的帧(= 焦点从 overview 切到 turn 的时刻),由 Root 传入。

const FONT =
  "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, 'Segoe UI', sans-serif";
const MD_CSS = `.wt-md p{margin:0 0 8px}.wt-md p:last-child{margin-bottom:0}.wt-md ul,.wt-md ol{margin:4px 0;padding-left:20px}.wt-md li{margin:2px 0}.wt-md code{background:rgba(15,23,42,0.06);padding:1px 6px;border-radius:5px;font-size:0.92em}.wt-md table{border-collapse:collapse;font-size:0.95em;margin:4px 0}.wt-md th,.wt-md td{border:1px solid #e5e7eb;padding:6px 12px}.wt-md th{background:#f8fafc}`;

const PAD = 70;
const floorChars = (len: number, t: number) => Math.max(0, Math.floor(len * t));

export const ConversationScene = ({ turns, overviewEndFrame }: { turns: SceneTurn[]; overviewEndFrame: number }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const tl = buildConversationTimeline(turns, fps);

  const B = overviewEndFrame;
  const isTurn = frame >= B;
  const target = 0; // turn 焦点态强调第一轮

  // 测量内容真实高度(含 markdown 表格)→ 决定 overview 阶段要不要上滚。
  const innerRef = useRef<HTMLDivElement>(null);
  const [contentH, setContentH] = useState(0);
  useLayoutEffect(() => {
    if (innerRef.current) setContentH(innerRef.current.getBoundingClientRect().height);
  });

  // 镜头:内容短 → 垂直居中(不再顶到上边留空板);内容长 → 跟随底部(最新可见)。
  // contentH 随打字连续增长,所以这条曲线天生平滑。
  const usable = height - PAD * 2;
  const fits = contentH > 0 && contentH <= usable;
  const centerY = (usable - contentH) / 2;
  const followBottomY = -Math.max(0, contentH - usable);
  const overviewY = fits ? centerY : followBottomY;
  // turn 焦点态:要让框住的 Turn 1(第一轮)可见 —— 放得下就居中,放不下就从顶部显示。
  const turnY = fits ? centerY : 0;
  const scrollY = interpolate(frame, [B - 8, B + 8], [overviewY, turnY], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  // 焦点切换的淡入进度(0→1)
  const focusIn = interpolate(frame, [B, B + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const caretOn = Math.floor(frame / Math.round(fps * 0.5)) % 2 === 0;

  return (
    <AbsoluteFill style={{ background: "#fff", fontFamily: FONT }}>
      <style>{MD_CSS}</style>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", padding: `${PAD}px 0` }}>
        <div ref={innerRef} style={{ width: "100%", maxWidth: 980, margin: "0 auto", padding: "0 48px", display: "flex", flexDirection: "column", gap: 34, transform: `translateY(${scrollY}px)` }}>
          {tl.turns.map((tt, i) => {
            if (frame < tt.start) return null;

            const userT = interpolate(frame, [tt.start, tt.userTypeEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const userTyping = frame < tt.userTypeEnd;
            const inThink = !!tt.turn.assistant && frame >= tt.userTypeEnd && frame < tt.thinkEnd;
            const asstActive = !!tt.turn.assistant && frame >= tt.thinkEnd;
            const asstT = interpolate(frame, [tt.thinkEnd, tt.asstTypeEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const asstTyping = asstActive && frame < tt.asstTypeEnd;

            const bubbles = (
              <>
                <Bubble side="left" role="User" text={tt.turn.user.slice(0, floorChars(tt.turn.user.length, userT))} typing={userTyping} caretOn={caretOn} />
                {inThink && <Thinking frame={frame} fps={fps} />}
                {asstActive && (
                  <Bubble side="right" role="Claude" markdown text={tt.turn.assistant.slice(0, floorChars(tt.turn.assistant.length, asstT))} typing={asstTyping} caretOn={caretOn} />
                )}
              </>
            );

            // 非目标轮:turn 焦点态下变暗
            const dim = i === target ? 1 : interpolate(focusIn, [0, 1], [1, 0.3]);

            if (i === target) {
              // 目标轮:turn 阶段渐显框选 + 角标 + 底部统计(focusIn 驱动)
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
          const phase = ((frame / (fps * 1.2)) + i * 0.18) % 1;
          const opacity = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos(phase * 2 * Math.PI));
          return <span key={i} style={{ width: 9, height: 9, borderRadius: 999, background: ACTOR_COLOR.llm.main, opacity }} />;
        })}
      </span>
    </div>
  );
}
