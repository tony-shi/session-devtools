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

import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
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
  const m = getManifest(lang);
  if (!m) return fps;
  return Math.max(1, spec.shots.reduce((t, sh) => t + shotFrames(m, sh, fps), 0));
}

export const Episode = ({ spec, lang, caption = true }: { spec: Episode; lang: string; caption?: boolean }) => {
  const { fps } = useVideoConfig();
  const m = getManifest(lang);
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
        {placed.map((p) => (
          <Sequence key={p.shot.id} from={p.from} durationInFrames={p.frames} name={p.shot.id}>
            {p.shot.render({ lang, fps, manifest: m, clock: p.clock, frames: p.frames })}
          </Sequence>
        ))}
        <NarrationTrack lang={lang} stepIdxs={allSteps} />
        {caption && <NarrationCaption lang={lang} />}
      </AbsoluteFill>
    </LangProvider>
  );
};

// 字幕图层:读当前帧的旁白行,底部居中显示。覆盖在场景之上(预览/分析用;出片可关)。
function NarrationCaption({ lang }: { lang: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const text = frameToLine(lang, frame, fps);
  if (!text) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", padding: "0 56px 52px", pointerEvents: "none" }}>
      <div style={{
        maxWidth: 1720,
        // 长英文句易折两行;缩小字号 + 加宽,大多数单行;真正长句折两行时 balance 让两行均衡(无孤字尾巴)。
        background: "rgba(15,23,42,0.84)",
        color: "#fff",
        fontSize: 33,
        lineHeight: 1.45,
        fontWeight: 500,
        textWrap: "balance",
        padding: "18px 36px",
        borderRadius: 16,
        textAlign: "center",
        boxShadow: "0 12px 40px rgba(0,0,0,0.35)",
      }}>{text}</div>
    </AbsoluteFill>
  );
}
