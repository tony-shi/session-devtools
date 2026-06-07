// 通用「剧集播放器」—— 一集 = 一份 storyboard 数据(shots 列表),由这里统一排到时间轴上。
//
// 设计目标(声明式编排):
//   - 一集的结构 = 数据(`Episode.shots`),不再把"第几幕从第几帧到第几帧"硬编在某个组件里。
//   - 每个 shot 声明它吃哪些旁白(steps / 可选 lineRange);player 用 voice manifest 的
//     durMs+gapMs 自动算出它的帧区间并顺序排布 —— 加一拍 / 换顺序 / 改文案,帧自动重排,永不错位。
//   - shot 怎么渲染由它自己的 render(ctx) 决定(适配各场景不同的 props),场景组件保持不变。
//   - 旁白音轨 + 字幕图层贯穿全程,时间轴与 shot 严格同源(都来自同一份 manifest)。
//
// 草稿/终稿通用:manifest 来自 mock(草稿时钟)还是 MiniMax(终稿)都走同一套排布逻辑。

import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import type { ReactNode } from "react";
import { LangProvider } from "./i18n";
import { NarrationTrack } from "./scenes/NarrationTrack";
import { getManifest, frameToLine, type VoiceManifest } from "./scenes/narration";
import { buildActClock, type ActClock } from "./scenes/storyClock";

const fr = (ms: number, fps: number) => Math.round((ms / 1000) * fps);

/** render(ctx) 拿到的上下文:语言、fps、manifest、本 shot 的 act clock、本 shot 帧长。 */
export type ShotCtx = { lang: string; fps: number; manifest: VoiceManifest; clock: ActClock; frames: number };

/** 一个镜头 = 吃哪些旁白 + 怎么渲染。 */
export type Shot = {
  id: string;
  /** 这个 shot 对应的旁白 step(驱动它的 act clock,并计入帧长)。 */
  steps: number[];
  /** 可选:把单个 step 的旁白按 [start, end) 行切片给这个 shot(用于一个 step 拆成两幕,如 recap/下一章)。 */
  lineRange?: [number, number];
  /** 可选:旁白结束后额外停留秒数(如过渡幕末尾多停一下)。 */
  holdAfterS?: number;
  render: (ctx: ShotCtx) => ReactNode;
};

export type Episode = { storyId: string; shots: Shot[] };

/** 这个 shot 占有的旁白行(用于算帧长):它的 steps 的行,可选按 lineRange 切片。 */
function shotLines(m: VoiceManifest, shot: Shot) {
  const out: { durMs: number; gapMs: number }[] = [];
  for (const stepIdx of shot.steps) {
    const step = m.steps.find((s) => s.stepIdx === stepIdx);
    if (!step) continue;
    const ls = shot.lineRange && shot.steps.length === 1
      ? step.lines.slice(shot.lineRange[0], shot.lineRange[1])
      : step.lines;
    out.push(...ls);
  }
  return out;
}

/** 这个 shot 的帧长 = 旁白(durMs+gapMs)累加 + 可选 hold。 */
function shotFrames(m: VoiceManifest, shot: Shot, fps: number): number {
  const body = shotLines(m, shot).reduce((t, l) => t + fr(l.durMs, fps) + fr(l.gapMs, fps), 0);
  return body + (shot.holdAfterS ? Math.round(fps * shot.holdAfterS) : 0);
}

/** 整集总帧数(给 Root 注册 composition 用)。 */
export function episodeDuration(spec: Episode, lang: string, fps: number): number {
  const m = getManifest(spec.storyId, lang);
  if (!m) return fps;
  return Math.max(1, spec.shots.reduce((t, sh) => t + shotFrames(m, sh, fps), 0));
}

// audioMaster:出片时挂单条母带音轨(master-audio.ts 产物,整条 loudnorm);预览默认逐句。
export const Episode = ({ spec, lang, caption = true, audioMaster = false }: { spec: Episode; lang: string; caption?: boolean; audioMaster?: boolean }) => {
  const { fps } = useVideoConfig();
  const m = getManifest(spec.storyId, lang);
  if (!m) return <AbsoluteFill style={{ background: "#fff" }} />;

  const allSteps = [...new Set(spec.shots.flatMap((s) => s.steps))].sort((a, b) => a - b);

  // 顺序把每个 shot 排到时间轴:from = 累计游标,帧长 = shotFrames。
  let cursor = 0;
  const placed = spec.shots.map((shot) => {
    const frames = shotFrames(m, shot, fps);
    const clock = buildActClock(spec.storyId, m, shot.steps, fps);
    const from = cursor;
    cursor += frames;
    return { shot, from, frames, clock };
  });

  // LangProvider:子场景通过 useT() 拿当前语言字典(UI 零硬编中文)。
  return (
    <LangProvider lang={lang}>
      <AbsoluteFill style={{ background: "#fff" }}>
        {placed.map((p, i) => (
          <Sequence key={p.shot.id} from={p.from} durationInFrames={p.frames} name={p.shot.id}>
            <ShotFade skip={i === 0}>{p.shot.render({ lang, fps, manifest: m, clock: p.clock, frames: p.frames })}</ShotFade>
          </Sequence>
        ))}
        <NarrationTrack storyId={spec.storyId} lang={lang} stepIdxs={allSteps} master={audioMaster} />
        {caption && <NarrationCaption storyId={spec.storyId} lang={lang} />}
      </AbsoluteFill>
    </LangProvider>
  );
};

// shot 入场软化:每个 shot 首 10 帧从白底淡入(全片底色都是近白,等效轻叠化),消除边界硬切。
// 首个 shot 不淡(避免片头闪一下)。对所有用 <Episode> 的 story 生效。
function ShotFade({ skip, children }: { skip: boolean; children: ReactNode }) {
  const f = useCurrentFrame();
  const opacity = skip ? 1 : interpolate(f, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
}

// 字幕图层:读当前帧的旁白行,底部居中显示。覆盖在场景之上(预览/分析用;出片可关)。
//
// 项目约束(见根目录 CLAUDE.md):字幕永远单行,不允许折行。
//   实现 = nowrap 强制单行 + 按估宽自动缩字号兜底;但兜底缩到 MIN 仍超宽说明文案过长,
//   正解是回 stories/*.ts 拆句(中文每行 ≤ ~46 个汉字当量;ASCII 约算半个)。
const CAPTION_FONT = 33;       // 基准字号(≤ ~46 汉字当量的行用满)
const CAPTION_MIN_FONT = 22;   // 兜底下限(再长也不折行,但该回源拆句了)
const CAPTION_TEXT_MAX_W = 1648; // 1920 − 2×56(安全边)− 2×36(气泡内边距)
// 估宽:CJK(含全角标点)≈ 1em,其余 ≈ 0.55em。Remotion 端无需 canvas 实测,近似足够。
function captionFontSize(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += /[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch) ? 1 : 0.55;
  }
  return Math.max(CAPTION_MIN_FONT, Math.min(CAPTION_FONT, Math.floor(CAPTION_TEXT_MAX_W / units)));
}

function NarrationCaption({ storyId, lang }: { storyId: string; lang: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const text = frameToLine(storyId, lang, frame, fps);
  if (!text) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", padding: "0 56px 52px", pointerEvents: "none" }}>
      <div style={{
        background: "rgba(15,23,42,0.84)",
        color: "#fff",
        fontSize: captionFontSize(text),
        lineHeight: 1.45,
        fontWeight: 500,
        whiteSpace: "nowrap",
        padding: "18px 36px",
        borderRadius: 16,
        textAlign: "center",
        boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
      }}>{text}</div>
    </AbsoluteFill>
  );
}
