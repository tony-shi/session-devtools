import { AbsoluteFill, useCurrentFrame } from "remotion";
import "../../i18n"; // 初始化 react-i18next(真实面板用 useTranslation),headless 渲染必须
import { Episode, episodeDuration, type Episode as EpisodeSpec } from "../episode";
import { AttributionGraphProvider } from "../../v2/attribution-graph-context";
import { AttributionApiProvider } from "../../v2/attribution-api-context"; // main 的取数依赖注入(不改组件喂数据)
import { AttributionTreeLensPanel } from "../../v2/AttributionTreeLensPanel";
import { TooltipProvider } from "@/components/ui/tooltip"; // 真实面板用 Radix Tooltip,需 Provider 祖先
import type { AttributionTreeResult } from "../../v2/attribution-tree-types";
import type { SessionAttributionGraph } from "../../v2/attribution-graph-types";
import type { Focus } from "../../v2/walkthrough/types";
import type { ActClock } from "./storyClock";
import { RealContextJsonScene } from "./RealContextJsonScene";
import fixture from "../fixtures/attribution-real-context.json";
import graphFixture from "../fixtures/attribution-graph-real-context.json";

// 故事二「看见真实的 Context」storyboard —— 单轨 Remotion(Decision C)。
//
// 重要约束:对真实产品组件(AttributionTreeLensPanel)的适配**只在本 studio 包装层做样式**,
//   不改组件源码 —— 这样以后还能从主干 fork 复用。放大、提饱和都靠外层 CSS。
//
// 字号放大逻辑(纯样式):产品面板是给 web 调试的密集排版,最小字 ~11px;
//   1080p 视频可读目标 ~24-28px → 放大系数 ≈ 2.2。把面板渲进固定基准宽度的盒子(PANEL_BASE_W),
//   再 transform: scale(PANEL_ZOOM):字号 + 色条同比放大,组件零改动。
//   宽度预算:1920 − 边距 ≈ 1820;PANEL_BASE_W × PANEL_ZOOM ≈ 800 × 2.2 = 1760 ≤ 1820 ✓。
const STORY_ID = "real-context";
const RC = fixture as unknown as AttributionTreeResult;
const GRAPH = graphFixture as unknown as SessionAttributionGraph;

// 注入真实数据(不改组件,用 main 的 AttributionApiProvider)。核心数据 = 真实 dump;
// diffTree reject —— 本片单 call、hideDiff,无需 diff,让组件走容错(不编造假 diff)。
const STUDIO_API = {
  attributionTree: async () => RC,
  attributionGraph: async () => GRAPH,
  diffTree: () => Promise.reject(new Error("studio: diff not needed")),
};

const PANEL_BASE_W = 800;   // 面板先按这个窄宽度排版(段自适应回流)
const PANEL_ZOOM = 2.2;     // 再整体放大 ——「合理字号」的来源
const CHROME_CLIP = -152;   // 放大后像素:上移面板,把顶部 "图层叠加 / 请求组成" chrome 推出顶边裁掉(纯样式,不改组件)

// walkthrough 的 focus → 面板 focusSection(与 DemoStage 同一套映射)。
function focusToSection(focus: Focus): "tools" | "system" | "messages" | null {
  return focus === "sec-tools" ? "tools"
    : focus === "sec-system" ? "system"
    : focus === "sec-messages" ? "messages"
    : null;
}

// 常驻真实面板:focusSection 跟旁白拍子切换;放大 + 提饱和全在外层(组件不动)。
function RealContextPanelShot({ clock }: { clock: ActClock }) {
  const frame = useCurrentFrame();
  const focusSection = focusToSection(clock.at(frame).focus);
  return (
    <AbsoluteFill
      style={{
        background: "#fff",
        overflow: "hidden",
        fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* 纯样式层(不改组件):放大 + 提饱和 + 上移裁掉顶部 chrome("图层叠加 / 请求组成")。
          顶部 chrome 被推到画面顶边之上,由 overflow:hidden 裁掉;只留三段 section 条 + 图例。 */}
      <div
        style={{
          position: "absolute",
          top: CHROME_CLIP,
          left: "50%",
          width: PANEL_BASE_W,
          transform: `translateX(-50%) scale(${PANEL_ZOOM})`,
          transformOrigin: "top center",
          filter: "saturate(1.45) contrast(1.04)",
        }}
      >
        {/* AttributionApiProvider 必须包在 AttributionGraphProvider 外层(后者内部消费此 context)。 */}
        <TooltipProvider>
          <AttributionApiProvider value={STUDIO_API}>
            <AttributionGraphProvider sessionId={RC.sessionId} onJumpToCall={null}>
              <AttributionTreeLensPanel
                sessionId={RC.sessionId}
                callId={RC.callId}
                hideDiff
                focusSection={focusSection}
              />
            </AttributionGraphProvider>
          </AttributionApiProvider>
        </TooltipProvider>
      </div>
    </AbsoluteFill>
  );
}

// 时间轴:开场 json 幕(吃旁白 step 0-1)→ 面板幕(step 2-9,focusSection 跟拍子)。
export const realContextEpisode: EpisodeSpec = {
  storyId: STORY_ID,
  shots: [
    { id: "rc-json", steps: [0, 1], render: ({ clock }) => <RealContextJsonScene clock={clock} /> },
    { id: "rc-panel", steps: [2, 3, 4, 5, 6, 7, 8, 9], render: ({ clock }) => <RealContextPanelShot clock={clock} /> },
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
