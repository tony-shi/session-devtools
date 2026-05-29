// 把「全局帧」翻译成「第几 step、step 内第几 beat、什么 focus」—— 各幕统一用它驱动。
//
// 一幕(act)= 若干连续 step;每个 step 的 beat = 它旁白的行(line)。每个 beat 的帧长
// 取自 voice manifest 的 durMs + gapMs。这样画面揭示与旁白逐句对齐(audio 是节奏主轴)。
//
// 用在 <Sequence> 里时传入「局部帧」(Sequence 已把帧重基到 0)。

import { STORIES } from "../../v2/walkthrough/stories";
import type { Focus } from "../../v2/walkthrough/types";
import type { VoiceManifest } from "./narration";

export type BeatLoc = { stepIdx: number; focus: Focus; beat: number; beatCount: number };

export type ActClock = {
  total: number;                            // 这一幕总帧数
  at: (localFrame: number) => BeatLoc;      // 局部帧 → 当前拍
  stepStartFrame: (stepIdx: number) => number;
};

export function buildActClock(storyId: string, manifest: VoiceManifest, stepIdxs: number[], fps: number): ActClock {
  const story = STORIES[storyId];
  const f = (ms: number) => Math.round((ms / 1000) * fps);
  type Seg = BeatLoc & { start: number; end: number };
  const segs: Seg[] = [];
  const stepStart = new Map<number, number>();
  let cursor = 0;
  for (const stepIdx of stepIdxs) {
    const mStep = manifest.steps.find((s) => s.stepIdx === stepIdx);
    const sStep = story?.steps[stepIdx];
    if (!mStep || !sStep) continue;
    stepStart.set(stepIdx, cursor);
    const beatCount = mStep.lines.length;
    mStep.lines.forEach((line, beat) => {
      const dur = f(line.durMs) + f(line.gapMs);
      segs.push({ stepIdx, focus: sStep.focus, beat, beatCount, start: cursor, end: cursor + dur });
      cursor += dur;
    });
  }
  return {
    total: cursor,
    stepStartFrame: (s) => stepStart.get(s) ?? 0,
    at: (localFrame) => {
      const seg = segs.find((s) => localFrame < s.end) ?? segs[segs.length - 1];
      return seg
        ? { stepIdx: seg.stepIdx, focus: seg.focus, beat: seg.beat, beatCount: seg.beatCount }
        : { stepIdx: stepIdxs[0] ?? 0, focus: "overview", beat: 0, beatCount: 1 };
    },
  };
}
