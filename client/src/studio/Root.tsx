import { Composition } from "remotion";
import { HelloProbe } from "./HelloProbe";
import { RealContextProbe } from "./scenes/RealContextProbe";
import { ConversationScene } from "./scenes/ConversationScene";
import { NarrationTrack } from "./scenes/NarrationTrack";
import { AgentLoopStory, agentLoopStoryDuration } from "./scenes/AgentLoopStory";
import { RealContextStory, realContextStoryDuration } from "./scenes/RealContextStory";
import { buildConversationTimeline, type SceneTurn } from "./scenes/timeline";
import { getManifest, buildNarrationClips } from "./scenes/narration";
import { getConversationFixture } from "./fixtures";

// Remotion 的 composition 注册表。1920×1080 / 60fps —— 各幕统一画布规格。
// 60fps:打字 / 流动连线 / 淡入等逐帧动画更顺滑;时长按 ms 算,与 fps 无关。
const FPS = 60;

// 第一幕「会话」对应的旁白 = story 的前两个 conversation step(overview + turn)。
const CONV_STEPS = [0, 1];
// 出片语言:中文 + 英文两条,各注册一个 composition。
const LANGS = ["zh", "en"] as const;
// 独立 Conversation 预览幕用 zh 兜底(仅 studio dev 预览,非出片主轴)。
const CONV_LANG = "zh";
const convFixtureZh = getConversationFixture(CONV_LANG);

// 时长取「旁白」与「视觉」的较大者 —— 旁白是讲解主轴,视觉(打字)在其下并行。
// 注:Phase 2 是「最快跑通 + 有声」,旁白(~47s)比对话视觉(~17s)长,视觉播完后定格;
//     精确音画同步留作下一步(让对话节拍跟旁白走),这里先不调样式。
const convVisual = buildConversationTimeline(convFixtureZh, FPS).total;
const convManifest = getManifest("agent-loop", CONV_LANG);
// 焦点切换点 = 旁白 step 0(overview)结束的帧;此后进入 turn 焦点态(框住 Turn 1)。
const overviewEndFrame = convManifest ? buildNarrationClips(convManifest, [0], FPS).totalFrames : convVisual;
const convNarr = convManifest ? buildNarrationClips(convManifest, CONV_STEPS, FPS).totalFrames : 0;
const convDuration = Math.max(convVisual, convNarr, 1);

// 第一幕 = 对话视觉 + 旁白音轨(同一条 Remotion 帧时间轴)。
const Conversation = ({ turns }: { turns: SceneTurn[] }) => {
  return (
    <>
      <ConversationScene turns={turns} overviewEndFrame={overviewEndFrame} />
      <NarrationTrack storyId="agent-loop" lang={CONV_LANG} stepIdxs={CONV_STEPS} />
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
      {/* 单轨(Decision C)落地探针:真实 AttributionTreeLensPanel + 静态 fixture,验证无头出片可行性。 */}
      <Composition
        id="RealContextProbe"
        component={RealContextProbe}
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
        defaultProps={{ turns: convFixtureZh }}
      />
      {/* 完整第一个 story:三幕串成一条。每种语言一个 composition —— 双语双视频的出片产物。
          id:AgentLoopStory(zh)/ AgentLoopStoryEn(en)。时长按各自语言的旁白 manifest 算。 */}
      {LANGS.map((lang) => (
        <Composition
          key={lang}
          id={lang === "zh" ? "AgentLoopStory" : "AgentLoopStoryEn"}
          component={AgentLoopStory}
          durationInFrames={Math.max(1, agentLoopStoryDuration(lang, FPS))}
          fps={FPS}
          width={1920}
          height={1080}
          defaultProps={{ lang, caption: true }}
        />
      ))}
      {/* 第二个 story:看见真实的 Context —— 单轨 Remotion(Decision C),渲染真实 attribution 面板。
          目前只有中文 manifest;focusSection 跟旁白拍子切换(focus 取自 real-context.ts)。 */}
      <Composition
        id="RealContextStory"
        component={RealContextStory}
        durationInFrames={Math.max(1, realContextStoryDuration("zh", FPS))}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{ lang: "zh", caption: true }}
      />
    </>
  );
};
