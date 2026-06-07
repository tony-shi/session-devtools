import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import "../../i18n"; // 初始化 react-i18next(真实面板用 useTranslation),headless 渲染必须
import appI18n from "../../i18n";
import { Episode, episodeDuration, type Episode as EpisodeSpec } from "../episode";
import { PanelShot, apiFor } from "./RealContextStory";
import { GrowthCurveScene } from "./GrowthCurveScene";
import { useT } from "../i18n";
import type { AttributionTreeResult } from "../../v2/attribution-tree-types";
import type { SessionAttributionGraph } from "../../v2/attribution-graph-types";
import type { ActClock } from "./storyClock";
// —— 幕A 增长机制:问时间会话的 call 2(zh c8d1c726 / en 64cebb6e;graph 与 Story 2 同 session 复用)
import growthC2Zh from "../fixtures/attribution-growth-call2.json";
import growthGraphZh from "../fixtures/attribution-graph-real-context.json";
import growthC2En from "../fixtures/attribution-growth-call2-en.json";
import growthGraphEn from "../fixtures/attribution-graph-real-context-en.json";
// —— 幕B 渐进式披露:ToolSearch 演示会话(zh 4c6f321d / en 90545302)
import tsC1Zh from "../fixtures/attribution-toolsearch-call1.json";
import tsC2Zh from "../fixtures/attribution-toolsearch-call2.json";
import tsGraphZh from "../fixtures/attribution-graph-toolsearch.json";
import tsC1En from "../fixtures/attribution-toolsearch-call1-en.json";
import tsC2En from "../fixtures/attribution-toolsearch-call2-en.json";
import tsGraphEn from "../fixtures/attribution-graph-toolsearch-en.json";
// —— 幕D 满载解剖:8a9637a5 / call 190(仅 zh dump;en 轨复用,两语数字一致)
import fullFixture from "../fixtures/attribution-full-context.json";
import fullGraphFixture from "../fixtures/attribution-graph-full-context.json";

// 故事三「Context 的增长」storyboard —— 单轨 Remotion(Decision C)。
//
// 结构(粗版,效果逐步微调):
//   cg-curve-open [0,1]   GrowthCurveScene(open)   真实增长曲线开场(止步峰值)
//   cg-mech       [2..6]  PanelShot(问时间 call 2)  tool_use → schema 对账 → tool_result → append-only
//   cg-defer1     [7,8]   PanelShot(ToolSearch c1)  Tools 区没有 WebFetch + 延迟加载清单
//   cg-defer2     [9..11] PanelShot(ToolSearch c2)  26 字符 tool_reference → WebFetch 长出来
//   cg-full-*     [12..14] PanelShot(满载 c190)     286 万全景 + 四类大块逐拍 + 收束
//   cg-compact    [15,16] GrowthCurveScene(full)   逼近上限 → 真实 compact 悬崖
//   cg-recap      [17]    RecapTeaserShot           四条回顾 chip + cache 钩子
//
// 约束沿用 Story 2:对真实产品组件零改动,样式/数据注入都在 studio 包装层。

type PanelData = { api: ReturnType<typeof apiFor>; sessionId: string; callId: number };
type PanelSet = { zh: PanelData; en: PanelData };

function panelData(treeJson: unknown, graphJson: unknown): PanelData {
  const tree = treeJson as AttributionTreeResult;
  const graph = graphJson as SessionAttributionGraph;
  return { api: apiFor(tree, graph), sessionId: tree.sessionId, callId: tree.callId };
}

const MECH: PanelSet = { zh: panelData(growthC2Zh, growthGraphZh), en: panelData(growthC2En, growthGraphEn) };
const TS1: PanelSet = { zh: panelData(tsC1Zh, tsGraphZh), en: panelData(tsC1En, tsGraphEn) };
const TS2: PanelSet = { zh: panelData(tsC2Zh, tsGraphZh), en: panelData(tsC2En, tsGraphEn) };
const FULL: PanelData = panelData(fullFixture, fullGraphFixture);
const pick = (s: PanelSet, lang: string): PanelData => (lang === "en" ? s.en : s.zh);

// 「点击进去」:stepIdx → focusSlotType(各 shot 自带,互不串台)。
const MECH_FOCUS: Record<number, string> = {
  2: "messages.tool_use",      // Bash date 的动作请求
  3: "tools.builtin.Bash",     // 声明↔调用对账:回看 input schema
  4: "messages.tool_result",   // 34 字符:日期本身
};
const DEFER1_FOCUS: Record<number, string> = {
  8: "messages.system-message", // 延迟加载工具清单(首条=deferred,Story 2 同款)
};
const DEFER2_FOCUS: Record<number, string> = {
  9: "messages.tool_result",      // 26 字符 [tool_reference: WebFetch]
  10: "tools.builtin.WebFetch",   // 795 字符完整声明,这一刻才进 context
};
// 满载拍(step 13)内 beat → 四类大块(与 Story 2 step 15 同款手法)。
const FULL_FOCUS_BEATS: Record<number, string> = {
  0: "messages.thinking",
  1: "messages.block.image",
  2: "messages.tool_result",
  3: "messages.tool_use",
};

// 回顾 + 下一章预告幕:四条 chip 按拍浮现,beat 4 起亮出 cache 钩子。
function RecapTeaserShot({ clock }: { clock: ActClock }) {
  const frame = useCurrentFrame();
  const t = useT();
  // 本 shot 只含 step 17,直接按 beat 找段首帧做淡入。
  const segStart = (beat: number) => clock.segments.find((s) => s.beat === beat)?.start ?? 0;
  const fade = (beat: number) =>
    interpolate(frame, [segStart(beat), segStart(beat) + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{
      background: "#fff", alignItems: "center", justifyContent: "center",
      fontFamily: "'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui, -apple-system, sans-serif",
    }}>
      <div style={{ width: 1280 }}>
        <div style={{ fontSize: 44, fontWeight: 800, color: "#0f172a", marginBottom: 48 }}>{t.cgRecapTitle}</div>
        {t.cgRecapItems.map((item, i) => (
          <div key={i} style={{
            opacity: fade(i),
            display: "flex", alignItems: "center", gap: 22, marginBottom: 26,
            background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 16, padding: "20px 30px",
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: 12, background: "#eef2ff", color: "#4338ca",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, fontWeight: 800, flexShrink: 0,
            }}>{i + 1}</div>
            <div style={{ fontSize: 32, color: "#334155", fontWeight: 500 }}>{item}</div>
          </div>
        ))}
        <div style={{
          opacity: fade(4),
          marginTop: 52, padding: "28px 34px", borderRadius: 18,
          background: "#eef2ff", border: "2px solid #c7d2fe",
        }}>
          <div style={{ fontSize: 26, color: "#6366f1", fontWeight: 700, marginBottom: 8 }}>{t.nextKicker}</div>
          <div style={{ fontSize: 38, color: "#312e81", fontWeight: 800 }}>{t.cgNextTitle}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
}

// 时间轴:曲线开场 → 机制 → 披露(两连拍)→ 满载(三连拍)→ compact 曲线 → 回顾。
export const contextGrowthEpisode: EpisodeSpec = {
  storyId: "context-growth",
  shots: [
    { id: "cg-curve-open", steps: [0, 1], render: ({ clock }) => <GrowthCurveScene clock={clock} mode="open" /> },
    {
      id: "cg-mech",
      steps: [2, 3, 4, 5, 6],
      render: ({ clock, lang }) => {
        const d = pick(MECH, lang);
        return <PanelShot clock={clock} api={d.api} sessionId={d.sessionId} callId={d.callId} leafByStep={MECH_FOCUS} />;
      },
    },
    {
      id: "cg-defer1",
      steps: [7, 8],
      render: ({ clock, lang }) => {
        const d = pick(TS1, lang);
        return <PanelShot clock={clock} api={d.api} sessionId={d.sessionId} callId={d.callId} leafByStep={DEFER1_FOCUS} />;
      },
    },
    {
      id: "cg-defer2",
      steps: [9, 10, 11],
      render: ({ clock, lang }) => {
        const d = pick(TS2, lang);
        return <PanelShot clock={clock} api={d.api} sessionId={d.sessionId} callId={d.callId} leafByStep={DEFER2_FOCUS} />;
      },
    },
    {
      id: "cg-full-a",
      steps: [12],
      render: ({ clock }) => <PanelShot clock={clock} api={FULL.api} sessionId={FULL.sessionId} callId={FULL.callId} />,
    },
    {
      id: "cg-full-b",
      steps: [13],
      render: ({ clock }) => <PanelShot clock={clock} api={FULL.api} sessionId={FULL.sessionId} callId={FULL.callId} leafByBeat={FULL_FOCUS_BEATS} />,
    },
    {
      id: "cg-full-c",
      steps: [14],
      render: ({ clock }) => <PanelShot clock={clock} api={FULL.api} sessionId={FULL.sessionId} callId={FULL.callId} />,
    },
    { id: "cg-compact", steps: [15, 16], render: ({ clock }) => <GrowthCurveScene clock={clock} mode="full" /> },
    { id: "cg-recap", steps: [17], holdAfterS: 1.5, render: ({ clock }) => <RecapTeaserShot clock={clock} /> },
  ],
};

// caption:字幕图层开关(预览开;出片干净母带传 false,字幕走 SRT)。
export const ContextGrowthStory = ({ lang, caption = true }: { lang: string; caption?: boolean }) => {
  // 真实面板的产品 i18n(react-i18next)跟出片语言走 —— 仅 studio 层副作用,组件零改动。
  // 资源已静态打包,changeLanguage 同步生效;zh 轨用产品默认 zh-CN。
  const target = lang === "en" ? "en" : "zh-CN";
  if (appI18n.language !== target) void appI18n.changeLanguage(target);
  return <Episode spec={contextGrowthEpisode} lang={lang} caption={caption} />;
};

// 给 Root 注册 composition 算总时长用。
export function contextGrowthStoryDuration(lang: string, fps: number): number {
  return episodeDuration(contextGrowthEpisode, lang, fps);
}
