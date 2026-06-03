import { AbsoluteFill, useCurrentFrame } from "remotion";
import "../../i18n"; // 初始化 react-i18next(真实面板用 useTranslation),headless 渲染必须
import { Episode, episodeDuration, type Episode as EpisodeSpec } from "../episode";
import { AttributionGraphProvider } from "../../v2/attribution-graph-context";
import { AttributionTreeLensPanel } from "../../v2/AttributionTreeLensPanel";
import { TooltipProvider } from "@/components/ui/tooltip"; // 真实面板用 Radix Tooltip,需 Provider 祖先
import type { AttributionTreeResult } from "../../v2/attribution-tree-types";
import type { Focus } from "../../v2/walkthrough/types";
import type { ActClock } from "./storyClock";
import fixture from "../fixtures/attribution-real-context.json";

// 故事二「看见真实的 Context」的 storyboard —— 单轨 Remotion(Decision C):
// 复用真实产品组件 AttributionTreeLensPanel + 静态 fixture(无后端),focusSection 跟旁白拍子切换。
// 旁白文案 / 时间轴单一来源 = walkthrough/stories/real-context.ts → synth.ts 产出的 manifest;
// 每拍高亮哪一段(focus)也取自 real-context.ts(storyClock 读它),所以这里零硬编。

const STORY_ID = "real-context";
const RC = fixture as unknown as AttributionTreeResult;

// walkthrough 的 focus → 面板 focusSection(与 DemoStage 同一套映射)。
function focusToSection(focus: Focus): "tools" | "system" | "messages" | null {
  return focus === "sec-tools" ? "tools"
    : focus === "sec-system" ? "system"
    : focus === "sec-messages" ? "messages"
    : null;
}

// 常驻的真实归因面板:focusSection = 当前拍子的 focus(clock.at(帧).focus)。
// 面板常驻不重挂 —— injected 引用稳定,不会逐帧 refetch;只有 focusSection 随拍子变。
function RealContextPanelShot({ clock }: { clock: ActClock }) {
  const frame = useCurrentFrame();
  const focusSection = focusToSection(clock.at(frame).focus);
  return (
    <AbsoluteFill
      style={{
        background: "#fff",
        fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ height: "100%", overflow: "hidden", padding: 40 }}>
        <TooltipProvider>
          <AttributionGraphProvider sessionId={RC.sessionId} onJumpToCall={null}>
            <AttributionTreeLensPanel
              sessionId={RC.sessionId}
              callId={RC.callId}
              hideDiff
              focusSection={focusSection}
              injected={RC}
            />
          </AttributionGraphProvider>
        </TooltipProvider>
      </div>
    </AbsoluteFill>
  );
}

// 单镜头贯穿全 10 拍:面板常驻,只切 focusSection(不重挂、无闪烁)。
export const realContextEpisode: EpisodeSpec = {
  storyId: STORY_ID,
  shots: [
    {
      id: "rc-panel",
      steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      render: ({ clock }) => <RealContextPanelShot clock={clock} />,
    },
  ],
};

// caption:字幕图层开关。预览默认开;出片要干净母带传 caption:false(字幕走 SRT)。
export const RealContextStory = ({ lang, caption = true }: { lang: string; caption?: boolean }) => (
  <Episode spec={realContextEpisode} lang={lang} caption={caption} />
);

// 给 Root 注册 composition 算总时长用。
export function realContextStoryDuration(lang: string, fps: number): number {
  return episodeDuration(realContextEpisode, lang, fps);
}
