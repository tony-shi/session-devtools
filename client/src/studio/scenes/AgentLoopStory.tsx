import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { ConversationScene } from "./ConversationScene";
import { AgentLoopScene } from "./AgentLoopScene";
import { RecapScene } from "./RecapScene";
import { NarrationTrack } from "./NarrationTrack";
import { getManifest, buildNarrationClips } from "./narration";
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

// 给 Root 算总时长用。
export function agentLoopStoryDuration(lang: string, fps: number): number {
  const m = getManifest(lang);
  if (!m) return fps; // 没 manifest 兜底 1s
  return (
    buildNarrationClips(m, CONV_STEPS, fps).totalFrames +
    buildNarrationClips(m, LOOP_STEPS, fps).totalFrames +
    buildNarrationClips(m, RECAP_STEPS, fps).totalFrames
  );
}

export const AgentLoopStory = ({ lang }: { lang: string }) => {
  const { fps } = useVideoConfig();
  const m = getManifest(lang);
  if (!m) return <AbsoluteFill style={{ background: "#fff" }} />;

  const convLen = buildNarrationClips(m, CONV_STEPS, fps).totalFrames;
  const loopLen = buildNarrationClips(m, LOOP_STEPS, fps).totalFrames;
  const recapLen = buildNarrationClips(m, RECAP_STEPS, fps).totalFrames;

  const loopClock = buildActClock(STORY_ID, m, LOOP_STEPS, fps);
  const recapClock = buildActClock(STORY_ID, m, RECAP_STEPS, fps);
  // conversation 的焦点切换点 = 旁白 step 0 长度(局部帧)。
  const overviewEndFrame = buildNarrationClips(m, [0], fps).totalFrames;

  return (
    <AbsoluteFill style={{ background: "#fff" }}>
      <Sequence from={0} durationInFrames={convLen} name="conversation">
        <ConversationScene turns={conversationFixture} overviewEndFrame={overviewEndFrame} />
      </Sequence>
      <Sequence from={convLen} durationInFrames={loopLen} name="agent-loop">
        <AgentLoopScene turn={turnFixture} clock={loopClock} />
      </Sequence>
      <Sequence from={convLen + loopLen} durationInFrames={recapLen} name="recap">
        <RecapScene clock={recapClock} />
      </Sequence>
      <NarrationTrack lang={lang} stepIdxs={ALL_STEPS} />
    </AbsoluteFill>
  );
};
