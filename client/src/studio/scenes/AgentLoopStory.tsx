// 故事一(agent-loop)的 storyboard —— 用声明式数据描述这一集由哪些镜头、按什么顺序、各吃哪些旁白组成。
// 通用 <Episode> player(../episode)负责把这些 shot 排到时间轴、对齐旁白、挂字幕音轨。
//
// 时间轴 = shots 的顺序;每个 shot 吃的旁白 step(可选 lineRange)决定它的帧长 —— 全自动,无硬编帧号。
//   conversation: step 0-1   →  ConversationScene
//   agent-loop:   step 2-5   →  AgentLoopScene
//   recap:        step 6 的前 RECAP_CONTENT_LINES 句  →  RecapScene
//   next-chapter: step 6 的其余句 + 末尾 hold        →  NextChapterScene
// 改 recap 引子/句数,只改下面的 RECAP_CONTENT_LINES(recap/下一章 的切分点,现在是数据)。

import { Episode, episodeDuration, type Episode as EpisodeSpec } from "../episode";
import { ConversationScene } from "./ConversationScene";
import { AgentLoopScene } from "./AgentLoopScene";
import { RecapScene } from "./RecapScene";
import { NextChapterScene } from "./NextChapterScene";
import { buildNarrationClips } from "./narration";
import { getConversationFixture, getTurnFixture } from "../fixtures";

const STORY_ID = "agent-loop";
// recap step(6)拆成「while 回顾」+「下一章」两幕的切分点:前 N 句进 recap,其余进下一章。
const RECAP_CONTENT_LINES = 9;
const RECAP_STEP = 6;
const TEASER_HOLD_S = 0.8;

export const agentLoopEpisode: EpisodeSpec = {
  storyId: STORY_ID,
  shots: [
    {
      id: "conversation",
      steps: [0, 1],
      render: ({ lang, fps, manifest }) => {
        // 按语言取屏幕素材(zh 手工本地化 / en 来自真实英文 session)。
        const conversationFixture = getConversationFixture(lang);
        const turnFixture = getTurnFixture(lang);
        // 焦点切换点 = 旁白 step 0 长度;「拿出来的那一轮」按 userInput 对齐下一幕展开的同一轮。
        const overviewEndFrame = buildNarrationClips(manifest, [0], fps).totalFrames;
        const focusTurnIdx = conversationFixture.findIndex((t) => t.user === turnFixture.userInput);
        return <ConversationScene turns={conversationFixture} overviewEndFrame={overviewEndFrame} focusTurnIdx={focusTurnIdx} />;
      },
    },
    {
      id: "agent-loop",
      steps: [2, 3, 4, 5],
      render: ({ lang, clock }) => <AgentLoopScene turn={getTurnFixture(lang)} clock={clock} />,
    },
    {
      id: "recap",
      steps: [RECAP_STEP],
      lineRange: [0, RECAP_CONTENT_LINES],
      render: ({ clock }) => <RecapScene clock={clock} />,
    },
    {
      id: "next-chapter",
      steps: [RECAP_STEP],
      lineRange: [RECAP_CONTENT_LINES, Infinity],
      holdAfterS: TEASER_HOLD_S,
      render: () => <NextChapterScene />,
    },
  ],
};

// caption:字幕图层开关。预览默认开;出片要干净母带传 caption:false(字幕走 SRT)。
export const AgentLoopStory = ({ lang, caption = true }: { lang: string; caption?: boolean }) => (
  <Episode spec={agentLoopEpisode} lang={lang} caption={caption} />
);

// 给 Root 注册 composition 算总时长用。
export function agentLoopStoryDuration(lang: string, fps: number): number {
  return episodeDuration(agentLoopEpisode, lang, fps);
}
