import { Composition } from "remotion";
import { HelloProbe } from "./HelloProbe";
import { ConversationScene } from "./scenes/ConversationScene";
import { NarrationTrack } from "./scenes/NarrationTrack";
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
const convNarr = getManifest(CONV_LANG)
  ? buildNarrationClips(getManifest(CONV_LANG)!, CONV_STEPS, FPS).totalFrames
  : 0;
const convDuration = Math.max(convVisual, convNarr, 1);

// 第一幕 = 对话视觉 + 旁白音轨(同一条 Remotion 帧时间轴)。
const Conversation = ({ turns }: { turns: SceneTurn[] }) => {
  return (
    <>
      <ConversationScene turns={turns} />
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
    </>
  );
};
