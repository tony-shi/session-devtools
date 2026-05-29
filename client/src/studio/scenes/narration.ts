// 旁白音轨的「帧布局」—— 从 voice manifest 算出每条旁白音频该从第几帧起、占几帧。
//
// manifest 由 scripts/voice/{synth,reindex}.ts 产出在 public/voice/<story>/<lang>.json,
// 这里直接 import(打包进 bundle)拿时间数据;音频文件本身走 staticFile 运行时加载。
//
// Phase 2:只接 zh。en 之后加一行 import + 进 MANIFESTS 即可(或改 calculateMetadata 异步加载)。

import zhManifest from "../../../public/voice/agent-loop/zh.json";

export type VoiceManifest = typeof zhManifest;

const MANIFESTS: Record<string, VoiceManifest> = {
  zh: zhManifest as VoiceManifest,
};

export function getManifest(lang: string): VoiceManifest | null {
  return MANIFESTS[lang] ?? null;
}

export type NarrationClip = { src: string; fromFrame: number; durFrames: number };

// 给定要纳入的 step 下标(某一幕的旁白),按 durMs + gapMs 累加排出每条音频的帧位置。
export function buildNarrationClips(
  manifest: VoiceManifest,
  stepIdxs: number[],
  fps: number,
): { clips: NarrationClip[]; totalFrames: number } {
  const f = (ms: number) => Math.round((ms / 1000) * fps);
  const clips: NarrationClip[] = [];
  let cursor = 0;
  for (const step of manifest.steps) {
    if (!stepIdxs.includes(step.stepIdx)) continue;
    for (const line of step.lines) {
      const durFrames = f(line.durMs);
      if (line.audio) {
        clips.push({ src: `voice/${manifest.storyId}/${line.audio}`, fromFrame: cursor, durFrames });
      }
      cursor += durFrames + f(line.gapMs);
    }
  }
  return { clips, totalFrames: cursor };
}
