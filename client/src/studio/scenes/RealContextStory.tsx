import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import "../../i18n"; // 初始化 react-i18next(真实面板用 useTranslation),headless 渲染必须
import appI18n from "../../i18n";
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
import fixtureEn from "../fixtures/attribution-real-context-en.json";
import graphFixtureEn from "../fixtures/attribution-graph-real-context-en.json";
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
const RC_EN = fixtureEn as unknown as AttributionTreeResult;           // en 首次请求:64cebb6e / call 1(64,977 字符)
const GRAPH_EN = graphFixtureEn as unknown as SessionAttributionGraph;
const RC_FULL = fullFixture as unknown as AttributionTreeResult;       // 满载:8a9637a5 / call 190(286 万字符;en 轨复用)
const GRAPH_FULL = fullGraphFixture as unknown as SessionAttributionGraph;

// 注入真实数据(不改组件)。diffTree reject:单 call、hideDiff,组件容错,不编造假 diff。
// export:Story 3(ContextGrowthStory)复用同一套面板镜头,只换 fixture。
export const apiFor = (tree: AttributionTreeResult, graph: SessionAttributionGraph) => ({
  attributionTree: async () => tree,
  attributionGraph: async () => graph,
  diffTree: () => Promise.reject(new Error("studio: diff not needed")),
});
const STUDIO_API = apiFor(RC, GRAPH);
const STUDIO_API_EN = apiFor(RC_EN, GRAPH_EN);
const STUDIO_API_FULL = apiFor(RC_FULL, GRAPH_FULL);
// 首次请求面板按语言选(en fixture 已验证:8 个 LEAF_FOCUS slotType 全兼容、首位匹配身份相同)。
const pickRC = (lang: string) =>
  lang === "en"
    ? { api: STUDIO_API_EN, sessionId: RC_EN.sessionId, callId: RC_EN.callId }
    : { api: STUDIO_API, sessionId: RC.sessionId, callId: RC.callId };

const PANEL_BASE_W = 800;   // 面板按窄基准宽排版(段自适应回流)
const PANEL_ZOOM = 2.2;     // 整体放大(CSS zoom,见上)
const CHROME_CLIP = -152;   // 上移裁掉顶部 "图层叠加 / 请求组成" chrome(屏幕像素,zoom 后可微调)

// 「点击进去」:stepIdx → focusSlotType(首次请求面板,fixture=c8d1c726/c1)。
// step2 = 桥接拍(上一章横条 ↔ 眼前三段,overview 总览,无 leaf)。
const LEAF_FOCUS: Record<number, string> = {
  4: "tools.builtin.Bash",                                    // 需求5:点入 Bash
  6: "system.main-prompt.section.memory",                     // 需求6:记忆管理
  7: "system.main-prompt.section.environment",                // 需求6:环境
  8: "system.main-prompt.section.context",                    // 需求6:git 状态
  11: "messages.inline.system-reminder.project-instructions", // 需求7:全局提示词(首条=全局 CLAUDE.md)
  12: "messages.inline.system-reminder.memory",               // 需求8:留意记忆
  13: "messages.inline.free-text",                            // 你的 7 个字
  14: "messages.system-message",                              // defer tool 清单(首条=deferred,对比"只报名称")
};

// 「下滑看结构」:step → beat → 面板上滑像素(屏幕 px)。拍切时 ~36 帧缓动到位。
// step4(Bash):beat0 停在条带看选中 → beat1 滚到「描述」段首 → beat2 滚到「参数」表头。
// step6/11/12:聚焦叶子的详情卡(2114/1673/2376 字符)超出 ~300 CSS px 可视折叠区,
//   按拍下滑把被裁的正文滚进画面(起步值,studio 目检后微调)。
const PANEL_SCROLL: Record<number, Record<number, number>> = {
  4: { 0: 0, 1: 260, 2: 1270, 3: 1270 },
  6: { 0: 0, 1: 450 },
  11: { 0: 0, 1: 0, 2: 400, 3: 800 },
  12: { 0: 0, 1: 300, 2: 600 },
};
// 满载拍(step16)leaf 级点入:只留 image(首位匹配恰是 39 万的大图,ImageLeafContent 渲染真实截图)。
// thinking/tool_result/tool_use 三拍不选 leaf —— 选中会让 LeafTable unmount(AttributionTreePanel:506),
// 吞掉 bucket 类筛选的「N 段 · 占上下文 X%」汇总条;且首位匹配是病态样本
// (thinking 首位 = 1.6k redacted 签名 0.1%,tool_result 首位 = 200 字符 0.0%)。
// 类占比叙事 → 类视角证据(FULL_BUCKET);单样本叙事(单张大图)→ leaf 点入。
const FULL_FOCUS: Record<number, string> = {
  5: "messages.block.image",
};
// 满载拍 beat → structure lens 桶筛选(main ae69fa1 的受控 prop focusBucket):
// 讲某一类占比时整类点亮(pill 激活 + 非命中 dim),配合 chromeClip=0 露出的筛选区。
// 注意桶 id 是 lens-framework 的 ROLE_BUCKETS(tool-use/tool-result 连字符,非下划线)。
const FULL_BUCKET: Record<number, string> = {
  4: "messages.thinking",
  5: "messages.image",
  6: "messages.tool-result",
  7: "messages.tool-use",
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
  const ease36 = (start: number) =>
    interpolate(frame, [start, start + 36], [0, 1], {
      easing: Easing.inOut(Easing.quad), extrapolateLeft: "clamp", extrapolateRight: "clamp",
    });
  if (keys) {
    const target = keys[loc.beat] ?? 0;
    const prev = loc.beat > 0 ? (keys[loc.beat - 1] ?? 0) : 0;
    const seg = clock.segments.find((s) => s.stepIdx === loc.stepIdx && s.beat === loc.beat);
    scroll = prev + (target - prev) * (seg ? ease36(seg.start) : 1);
  } else if (scrollByStep) {
    // 本步无滚动键、上一步滚出去了 → 步首 36 帧缓动回 0(修 step3→4 的 1270px 一帧回弹)。
    const prevKeys = scrollByStep[loc.stepIdx - 1];
    if (prevKeys) {
      const beats = Object.keys(prevKeys).map(Number);
      const prevLast = beats.length ? prevKeys[Math.max(...beats)] ?? 0 : 0;
      if (prevLast !== 0) scroll = prevLast * (1 - ease36(clock.stepStartFrame(loc.stepIdx)));
    }
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
      steps: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      render: ({ clock, lang }) => {
        const d = pickRC(lang);
        return (
          <PanelShot clock={clock} api={d.api} sessionId={d.sessionId} callId={d.callId} leafByStep={LEAF_FOCUS} scrollByStep={PANEL_SCROLL} />
        );
      },
    },
    {
      id: "rc-full",
      steps: [16],
      render: ({ clock }) => (
        <PanelShot clock={clock} api={STUDIO_API_FULL} sessionId={RC_FULL.sessionId} callId={RC_FULL.callId} leafByBeat={FULL_FOCUS} bucketByBeat={FULL_BUCKET} chromeClip={0} />
      ),
    },
    {
      id: "rc-recap",
      steps: [17, 18],
      holdAfterS: 1, // 片尾停留(S1 0.8 / S3 1.5 同款),不再只靠末句 gap
      render: ({ clock }) => <RealContextRecapScene clock={clock} />,
    },
  ],
};

// caption:字幕图层开关。预览默认开;出片要干净母带传 caption:false(字幕走 SRT)。
// audioMaster:出片传 true 挂单条母带音轨(先跑 scripts/voice/master-audio.ts)。
export const RealContextStory = ({ lang, caption = true, audioMaster = false }: { lang: string; caption?: boolean; audioMaster?: boolean }) => {
  // 真实面板的产品 i18n(react-i18next)跟出片语言走 —— 仅 studio 层副作用,组件零改动(同 Story 3)。
  const target = lang === "en" ? "en" : "zh-CN";
  if (appI18n.language !== target) void appI18n.changeLanguage(target);
  return <Episode spec={realContextEpisode} lang={lang} caption={caption} audioMaster={audioMaster} />;
};

// 给 Root 注册 composition 算总时长用。
export function realContextStoryDuration(lang: string, fps: number): number {
  return episodeDuration(realContextEpisode, lang, fps);
}
