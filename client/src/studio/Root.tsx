import { Composition } from "remotion";
import { HelloProbe } from "./HelloProbe";
import { ConversationScene } from "./scenes/ConversationScene";
import { NarrationTrack } from "./scenes/NarrationTrack";
import { AgentLoopStory, agentLoopStoryDuration } from "./scenes/AgentLoopStory";
import { buildConversationTimeline, type SceneTurn } from "./scenes/timeline";
import { getManifest, buildNarrationClips } from "./scenes/narration";
import { conversationFixture } from "./fixtures/conversation";

// Remotion 的 composition 注册表。1920×1080 / 30fps —— 各幕统一画布规格。
const FPS = 30;

// 第一幕「会话」对应的旁白 = story 的前两个 conversation step(overview + turn)。
const CONV_STEPS = [0, 1];
const CONV_LANG = "zh";

// 时长取「旁白」与「视觉」的较大者 —— 旁白是讲解主轴,视觉(打字)在其下并行。
// 注:Phase 2 是「最快跑通 + 有声」,旁白(~47s)比对话视觉(~17s)长,视觉播完后定格;
//     精确音画同步留作下一步(让对话节拍跟旁白走),这里先不调样式。
const convVisual = buildConversationTimeline(conversationFixture, FPS).total;
const convManifest = getManifest(CONV_LANG);
// 焦点切换点 = 旁白 step 0(overview)结束的帧;此后进入 turn 焦点态(框住 Turn 1)。
const overviewEndFrame = convManifest ? buildNarrationClips(convManifest, [0], FPS).totalFrames : convVisual;
const convNarr = convManifest ? buildNarrationClips(convManifest, CONV_STEPS, FPS).totalFrames : 0;
const convDuration = Math.max(convVisual, convNarr, 1);

// 第一幕 = 对话视觉 + 旁白音轨(同一条 Remotion 帧时间轴)。
const Conversation = ({ turns }: { turns: SceneTurn[] }) => {
  return (
    <>
      <ConversationScene turns={turns} overviewEndFrame={overviewEndFrame} />
      <NarrationTrack lang={CONV_LANG} stepIdxs={CONV_STEPS} />
    </>
  );
};

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="HelloProbe"
        component={HelloProbe}
        durationInFrames={90}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="Conversation"
        component={Conversation}
        durationInFrames={convDuration}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ turns: conversationFixture }}
      />
      {/* 完整第一个 story:三幕串成一条 —— 这是核心 review 产物 */}
      <Composition
        id="AgentLoopStory"
        component={AgentLoopStory}
        durationInFrames={Math.max(1, agentLoopStoryDuration(CONV_LANG, FPS))}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ lang: CONV_LANG, caption: true }}
      />
    </>
  );
};
