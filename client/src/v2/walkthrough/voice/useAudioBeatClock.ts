// 音轨驱动的节拍时钟。把现在 DemoStage 里的"BEAT_MS 固定时长"换成"按本句实际音轨时长推进"。
//
// 设计:
//   - 每一拍 = lines[beat] 的一句话;timeline:[ play(audio[beat]) | wait gapMs ] → beat++
//   - 没有 audio 字段 / 音频 404 → 退回 setTimeout(durMs) —— 等效升级版的 BEAT_MS,每拍按字数估算
//   - playing=false → audio.pause()。restartNonce → 回到 beat 0
//   - instantReveal → 直接快进到末态(回看时用)
//
// 返回 { beat } —— 和 useTimerBeatClock 接口一致,DemoStage 切换毫无负担。

import { useEffect, useRef, useState } from "react";
import type { Manifest } from "./types";

interface Opts {
  /** 当前 step 在 story 中的下标 */
  stepIdx: number;
  /** 音轨清单,加载完后传入;为 null 时直接返回(由调用方走 timer 时钟) */
  manifest: Manifest | null;
  playing: boolean;
  restartNonce: number;
  instantReveal: boolean;
}

interface State {
  /** 当前播报到第几拍 */
  beat: number;
  /** 这一拍的进度(0..1),做进度条用 */
  progress: number;
}

export function useAudioBeatClock({ stepIdx, manifest, playing, restartNonce, instantReveal }: Opts): State {
  const stepManifest = manifest?.steps.find((s) => s.stepIdx === stepIdx) ?? null;
  const lineCount = stepManifest?.lines.length ?? 0;

  const [beat, setBeat] = useState(() => (instantReveal && lineCount > 0 ? lineCount - 1 : 0));
  const [progress, setProgress] = useState(0);

  // R 键重启
  useEffect(() => { setBeat(0); setProgress(0); }, [restartNonce]);

  // 回看 → 快进
  useEffect(() => {
    if (!instantReveal) return;
    setBeat(Math.max(0, lineCount - 1));
    setProgress(1);
  }, [instantReveal, lineCount, stepIdx]);

  // 切 step 时回到 0
  useEffect(() => { if (!instantReveal) { setBeat(0); setProgress(0); } }, [stepIdx]);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 主推进逻辑 —— 单源,严格状态驱动
  useEffect(() => {
    if (!stepManifest) return;
    if (!playing) { audioRef.current?.pause(); return; }
    if (beat >= lineCount) return;          // 跑完本 step

    const line = stepManifest.lines[beat];
    const audioPath = line.audio ? `/voice/${manifest?.storyId}/${line.audio}` : null;

    let cancelled = false;
    let rafId = 0;
    let gapTimer: number | undefined;
    let durationTimer: number | undefined;

    const advanceAfterGap = () => {
      gapTimer = window.setTimeout(() => {
        if (cancelled) return;
        setBeat((b) => Math.min(b + 1, lineCount));
        setProgress(0);
      }, line.gapMs);
    };

    if (audioPath) {
      const audio = new Audio(audioPath);
      audioRef.current = audio;
      const tick = () => {
        if (cancelled) return;
        if (audio.duration > 0) setProgress(Math.min(1, audio.currentTime / audio.duration));
        rafId = window.requestAnimationFrame(tick);
      };
      audio.addEventListener("ended", advanceAfterGap, { once: true });
      audio.addEventListener("error", () => {
        // mp3 缺失或解码错 → 退回纯计时,保证体验不中断
        durationTimer = window.setTimeout(advanceAfterGap, line.durMs);
      }, { once: true });
      audio.play().catch(() => {
        // autoplay 被浏览器拦下来(用户没交互)—— 退回纯计时
        durationTimer = window.setTimeout(advanceAfterGap, line.durMs);
      });
      rafId = window.requestAnimationFrame(tick);
    } else {
      // 无音频:setTimeout(durMs) + 模拟进度
      const start = performance.now();
      const tick = () => {
        if (cancelled) return;
        setProgress(Math.min(1, (performance.now() - start) / line.durMs));
        rafId = window.requestAnimationFrame(tick);
      };
      durationTimer = window.setTimeout(advanceAfterGap, line.durMs);
      rafId = window.requestAnimationFrame(tick);
    }

    return () => {
      cancelled = true;
      audioRef.current?.pause();
      audioRef.current = null;
      if (gapTimer !== undefined) clearTimeout(gapTimer);
      if (durationTimer !== undefined) clearTimeout(durationTimer);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [stepManifest, manifest?.storyId, beat, playing, lineCount]);

  return { beat, progress };
}
