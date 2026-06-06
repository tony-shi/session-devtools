import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
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
import { RealContextRecapScene } from "./RealContextRecapScene";
import fixture from "../fixtures/attribution-real-context.json";
import graphFixture from "../fixtures/attribution-graph-real-context.json";
import fullFixture from "../fixtures/attribution-full-context.json";
import fullGraphFixture from "../fixtures/attribution-graph-full-context.json";

// 故事二「看见真实的 Context」storyboard —— 单轨 Remotion(Decision C)。
//
// 约束:对真实产品组件只在本 studio 包装层做样式/受控驱动,不改组件源码(可从主干 fork 复用)。
//
// 放大:用 CSS zoom(不是 transform: scale)。原因(需求4 根因):FisheyeStrip 用
//   getBoundingClientRect().width 测容器宽;transform:scale 下 rect 返回缩放后的宽,条带按它
//   布局后又被 scale 再放大一次(zoom²)→ 右半溢出被裁、居中 label 看似贴右截断。
//   CSS zoom 参与布局,测宽与渲染同坐标系,无 double-scale。
//
// 「点击进去」(需求5/6/7/10):main 998495e 的受控 prop focusSlotType —— 按 step(或满载拍
//   内按 beat)映射要聚焦的 leaf;组件自动切段、选中、出 detail,等价用户手点。
const RC = fixture as unknown as AttributionTreeResult;
const GRAPH = graphFixture as unknown as SessionAttributionGraph;
const RC_FULL = fullFixture as unknown as AttributionTreeResult;       // 满载:8a9637a5 / call 190(286 万字符)
const GRAPH_FULL = fullGraphFixture as unknown as SessionAttributionGraph;

// 注入真实数据(不改组件)。diffTree reject:单 call、hideDiff,组件容错,不编造假 diff。
// export:Story 3(ContextGrowthStory)复用同一套面板镜头,只换 fixture。
export const apiFor = (tree: AttributionTreeResult, graph: SessionAttributionGraph) => ({
  attributionTree: async () => tree,
  attributionGraph: async () => graph,
  diffTree: () => Promise.reject(new Error("studio: diff not needed")),
});
const STUDIO_API = apiFor(RC, GRAPH);
const STUDIO_API_FULL = apiFor(RC_FULL, GRAPH_FULL);

const PANEL_BASE_W = 800;   // 面板按窄基准宽排版(段自适应回流)
const PANEL_ZOOM = 2.2;     // 整体放大(CSS zoom,见上)
const CHROME_CLIP = -152;   // 上移裁掉顶部 "图层叠加 / 请求组成" chrome(屏幕像素,zoom 后可微调)

// 「点击进去」:stepIdx → focusSlotType(首次请求面板,fixture=c8d1c726/c1)。
const LEAF_FOCUS: Record<number, string> = {
  3: "tools.builtin.Bash",                                    // 需求5:点入 tool.Bash
  5: "system.main-prompt.section.environment",                // 需求6:环境
  6: "system.main-prompt.section.memory",                     // 需求6:记忆管理
  7: "system.main-prompt.section.context",                    // 需求6:git 状态
  10: "messages.inline.system-reminder.project-instructions", // 需求7:全局提示词(首条=全局 CLAUDE.md)
  11: "messages.inline.system-reminder.memory",               // 需求8:留意记忆
  12: "messages.inline.free-text",                            // 你的 7 个字
  13: "messages.system-message",                              // defer tool 清单(首条=deferred,对比"只报名称")
};

// 「下滑看结构」:step → beat → 面板上滑像素(屏幕 px)。拍切时 ~36 帧缓动到位。
// step3(tool.Bash):beat0 停在条带看选中 → beat1 滚到「描述」段首 → beat2 滚到「参数」表头。
const PANEL_SCROLL: Record<number, Record<number, number>> = {
  3: { 0: 0, 1: 260, 2: 1270, 3: 1270 },
};
// 满载拍(step15)内 beat → 四类大块(需求10:图片/思考/工具结果/工具调用)。
const FULL_FOCUS: Record<number, string> = {
  2: "messages.thinking",
  3: "messages.block.image",
  4: "messages.tool_result",
  5: "messages.tool_use",
};
// 满载拍 beat → structure lens 桶筛选(main ae69fa1 的受控 prop focusBucket):
// 讲某一类占比时整类点亮(pill 激活 + 非命中 dim),配合 chromeClip=0 露出的筛选区。
// 注意桶 id 是 lens-framework 的 ROLE_BUCKETS(tool-use/tool-result 连字符,非下划线)。
const FULL_BUCKET: Record<number, string> = {
  2: "messages.thinking",
  3: "messages.image",
  4: "messages.tool-result",
  5: "messages.tool-use",
};

// walkthrough 的 focus → 面板 focusSection(与 DemoStage 同一套映射)。
function focusToSection(focus: Focus): "tools" | "system" | "messages" | null {
  return focus === "sec-tools" ? "tools"
    : focus === "sec-system" ? "system"
    : focus === "sec-messages" ? "messages"
    : null;
}

// 通用面板镜头:focusSection 跟 step 的 focus;focusSlotType 按 step / beat 映射「点进去」。
// export + scrollByStep 参数化:滚动键按 story 自带(Story 2 传 PANEL_SCROLL,Story 3 不滚)。
export function PanelShot({
  clock, api, sessionId, callId, leafByStep, leafByBeat, scrollByStep, chromeClip = CHROME_CLIP, bucketByBeat,
}: {
  clock: ActClock;
  api: ReturnType<typeof apiFor>;
  sessionId: string;
  callId: number;
  leafByStep?: Record<number, string>;
  leafByBeat?: Record<number, string>;
  scrollByStep?: Record<number, Record<number, number>>;
  /** 顶部 chrome 裁切量。默认裁掉「图层叠加/请求组成」;满载拍传 0 露出筛选区(讲占比要看到筛选机制)。 */
  chromeClip?: number;
  /** beat → structure lens 桶 id(main ae69fa1 focusBucket):整类点亮讲占比。 */
  bucketByBeat?: Record<number, string>;
}) {
  const frame = useCurrentFrame();
  const loc = clock.at(frame);
  const focusSection = focusToSection(loc.focus);
  const focusSlotType = leafByBeat?.[loc.beat] ?? leafByStep?.[loc.stepIdx] ?? null;
  const focusBucket = bucketByBeat ? (bucketByBeat[loc.beat] ?? null) : undefined;
  // 拍级滚动:取本拍目标滚距,从上一拍的值在拍首 36 帧内缓动过去。
  const keys = scrollByStep?.[loc.stepIdx];
  let scroll = 0;
  if (keys) {
    const target = keys[loc.beat] ?? 0;
    const prev = loc.beat > 0 ? (keys[loc.beat - 1] ?? 0) : 0;
    const seg = clock.segments.find((s) => s.stepIdx === loc.stepIdx && s.beat === loc.beat);
    const t = seg
      ? interpolate(frame, [seg.start, seg.start + 36], [0, 1], {
          easing: Easing.inOut(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp",
        })
      : 1;
    scroll = prev + (target - prev) * t;
  }
  return (
    <AbsoluteFill
      style={{
        background: "#fff",
        overflow: "hidden",
        alignItems: "center",
        fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* 外层负 margin 做顶部 chrome 裁切 + 拍级下滑(不受 zoom 缩放);内层 zoom 放大。 */}
      <div style={{ marginTop: chromeClip - scroll }}>
        <div style={{ width: PANEL_BASE_W, zoom: PANEL_ZOOM, filter: "saturate(1.45) contrast(1.04)" }}>
          {/* AttributionApiProvider 必须包在 AttributionGraphProvider 外层(后者内部消费此 context)。 */}
          <TooltipProvider>
            <AttributionApiProvider value={api}>
              <AttributionGraphProvider sessionId={sessionId} onJumpToCall={null}>
                <AttributionTreeLensPanel
                  sessionId={sessionId}
                  callId={callId}
                  hideDiff
                  focusSection={focusSection}
                  focusSlotType={focusSlotType}
                  focusBucket={focusBucket}
                />
              </AttributionGraphProvider>
            </AttributionApiProvider>
          </TooltipProvider>
        </div>
      </div>
    </AbsoluteFill>
  );
}

// 时间轴:JSON 开场(step 0-1)→ 首次请求面板(step 2-14,含逐字段点入)→ 满载面板(step 15-16)。
export const realContextEpisode: EpisodeSpec = {
  storyId: "real-context",
  shots: [
    { id: "rc-json", steps: [0, 1], render: ({ clock }) => <RealContextJsonScene clock={clock} /> },
    {
      id: "rc-panel",
      steps: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
      render: ({ clock }) => (
        <PanelShot clock={clock} api={STUDIO_API} sessionId={RC.sessionId} callId={RC.callId} leafByStep={LEAF_FOCUS} scrollByStep={PANEL_SCROLL} />
      ),
    },
    {
      id: "rc-full",
      steps: [15],
      render: ({ clock }) => (
        <PanelShot clock={clock} api={STUDIO_API_FULL} sessionId={RC_FULL.sessionId} callId={RC_FULL.callId} leafByBeat={FULL_FOCUS} bucketByBeat={FULL_BUCKET} chromeClip={0} />
      ),
    },
    {
      id: "rc-recap",
      steps: [16, 17],
      render: ({ clock }) => <RealContextRecapScene clock={clock} />,
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
