import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { ConversationScene } from "./ConversationScene";
import { AgentLoopScene } from "./AgentLoopScene";
import { RecapScene } from "./RecapScene";
import { NextChapterScene } from "./NextChapterScene";
import { NarrationTrack } from "./NarrationTrack";
import { getManifest, buildNarrationClips, frameToLine } from "./narration";
import { buildActClock } from "./storyClock";
import { conversationFixture } from "../fixtures/conversation";
import { turnFixture } from "../fixtures/turn";

// 完整第一个 story(agent-loop)—— 三幕用 <Sequence> 串成一条时间轴:
//   conversation(step 0-1) → turn-io / Agent Loop(step 2-5) → recap(step 6)
// 每幕在自己的 Sequence 里用局部帧 + 自己的 act clock 驱动;旁白音轨贯穿全程,
// 因为各幕 Sequence 时长 == 对应旁白 step 时长,音画严格对齐。

const STORY_ID = "agent-loop";
const CONV_STEPS = [0, 1];
const LOOP_STEPS = [2, 3, 4, 5];
const RECAP_STEPS = [6];
const ALL_STEPS = [0, 1, 2, 3, 4, 5, 6];
// step6 拆成两幕:前 RECAP_CONTENT_LINES 句 = while 回顾;之后 = 「下一章」过渡(独立一幕,
// 占据那两句旁白的帧区间,字幕自动对齐)。改了 recap 句数就改这个。
const RECAP_CONTENT_LINES = 8;
const TEASER_HOLD_S = 0.8; // 过渡幕最后一句字幕完后,多停一下再结束

// step6 每句的帧长(durMs + gapMs → 帧),用来把 recap / next-chapter 切开。
function recapLineFrames(m: ReturnType<typeof getManifest>, fps: number): number[] {
  const step = m?.steps.find((s) => s.stepIdx === 6);
  const fr = (ms: number) => Math.round((ms / 1000) * fps);
  return step ? step.lines.map((l) => fr(l.durMs) + fr(l.gapMs)) : [];
}

// 给 Root 算总时长用。
export function agentLoopStoryDuration(lang: string, fps: number): number {
  const m = getManifest(lang);
  if (!m) return fps; // 没 manifest 兜底 1s
  return (
    buildNarrationClips(m, CONV_STEPS, fps).totalFrames +
    buildNarrationClips(m, LOOP_STEPS, fps).totalFrames +
    buildNarrationClips(m, RECAP_STEPS, fps).totalFrames +
    Math.round(fps * TEASER_HOLD_S)
  );
}

// caption:字幕图层开关。预览默认开(便于按文本分析);出片要干净母带传 caption:false
// (字幕走 SRT,见之前的字幕方案)。
export const AgentLoopStory = ({ lang, caption = true }: { lang: string; caption?: boolean }) => {
  const { fps } = useVideoConfig();
  const m = getManifest(lang);
  if (!m) return <AbsoluteFill style={{ background: "#fff" }} />;

  const convLen = buildNarrationClips(m, CONV_STEPS, fps).totalFrames;
  const loopLen = buildNarrationClips(m, LOOP_STEPS, fps).totalFrames;
  // recap 拆两幕:前 8 句 = while 回顾,之后 = 下一章过渡。
  const rlf = recapLineFrames(m, fps);
  const recapLen = rlf.slice(0, RECAP_CONTENT_LINES).reduce((a, b) => a + b, 0);
  const teaserLen = rlf.slice(RECAP_CONTENT_LINES).reduce((a, b) => a + b, 0);

  const loopClock = buildActClock(STORY_ID, m, LOOP_STEPS, fps);
  const recapClock = buildActClock(STORY_ID, m, RECAP_STEPS, fps);
  // conversation 的焦点切换点 = 旁白 step 0 长度(局部帧)。
  const overviewEndFrame = buildNarrationClips(m, [0], fps).totalFrames;
  // 「拿出来的那一轮」= 下一幕(Agent Loop)展开的同一轮 —— 按 userInput 对齐,保证连贯。
  const focusTurnIdx = conversationFixture.findIndex((t) => t.user === turnFixture.userInput);

  return (
    <AbsoluteFill style={{ background: "#fff" }}>
      <Sequence from={0} durationInFrames={convLen} name="conversation">
        <ConversationScene turns={conversationFixture} overviewEndFrame={overviewEndFrame} focusTurnIdx={focusTurnIdx} />
      </Sequence>
      <Sequence from={convLen} durationInFrames={loopLen} name="agent-loop">
        <AgentLoopScene turn={turnFixture} clock={loopClock} />
      </Sequence>
      <Sequence from={convLen + loopLen} durationInFrames={recapLen} name="recap">
        <RecapScene clock={recapClock} />
      </Sequence>
      <Sequence from={convLen + loopLen + recapLen} durationInFrames={teaserLen + Math.round(fps * TEASER_HOLD_S)} name="next-chapter">
        <NextChapterScene />
      </Sequence>
      <NarrationTrack lang={lang} stepIdxs={ALL_STEPS} />
      {caption && <NarrationCaption lang={lang} />}
    </AbsoluteFill>
  );
};

// 字幕图层:读当前帧的旁白行,底部居中显示。覆盖在场景之上(预览/分析用)。
function NarrationCaption({ lang }: { lang: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const text = frameToLine(lang, frame, fps);
  if (!text) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", padding: "0 80px 52px", pointerEvents: "none" }}>
      <div style={{
        maxWidth: 1560,
        background: "rgba(15,23,42,0.84)",
        color: "#fff",
        fontSize: 38,
        lineHeight: 1.5,
        fontWeight: 500,
        padding: "18px 36px",
        borderRadius: 16,
        textAlign: "center",
        boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
      }}>{text}</div>
    </AbsoluteFill>
  );
}
