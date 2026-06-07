// 旁白音轨的「帧布局」—— 从 voice manifest 算出每条旁白音频该从第几帧起、占几帧。
//
// manifest 由 scripts/voice/{synth,reindex}.ts 产出在 public/voice/<story>/<lang>.json,
// 这里直接 import(打包进 bundle)拿时间数据;音频文件本身走 staticFile 运行时加载。
//
// 多 story:按 storyId × lang 索引。新增一集 = import 它的 manifest + 进 MANIFESTS。

import agentLoopZh from "../../../public/voice/agent-loop/zh.json";
import agentLoopEn from "../../../public/voice/agent-loop/en.json";
import realContextZh from "../../../public/voice/real-context/zh.json";
import realContextEn from "../../../public/voice/real-context/en.json";
import { toDisplayText } from "./displayText";
import contextGrowthZh from "../../../public/voice/context-growth/zh.json";
import contextGrowthEn from "../../../public/voice/context-growth/en.json";
import type { Manifest } from "../../v2/walkthrough/voice/types";

// 用规范 Manifest 类型,而不是从 JSON 推断 —— JSON 里 audio 字段有无(mock 无 / 真 TTS 有)
// 不应影响类型;Manifest.LineCue.audio 本就是可选。
export type VoiceManifest = Manifest;

// storyId → lang → manifest。缺某语言就不列(getManifest 返回 null,调用方走兜底)。
const MANIFESTS: Record<string, Record<string, Manifest>> = {
  "agent-loop": {
    zh: agentLoopZh as unknown as Manifest,
    en: agentLoopEn as unknown as Manifest,
  },
  "real-context": {
    zh: realContextZh as unknown as Manifest,
    en: realContextEn as unknown as Manifest,
  },
  "context-growth": {
    zh: contextGrowthZh as unknown as Manifest,
    en: contextGrowthEn as unknown as Manifest,
  },
};

export function getManifest(storyId: string, lang: string): VoiceManifest | null {
  return MANIFESTS[storyId]?.[lang] ?? null;
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

// 给定全局帧 → 当前旁白行(从 manifest 累加 durMs + gapMs)。字幕图层 / 预览用。
// 出口过 toDisplayText:源文案是 TTS 读法(如「Claude 点 M D」),字幕显示书面形式(CLAUDE.md)。
export function frameToLine(storyId: string, lang: string, frame: number, fps: number): string {
  const m = getManifest(storyId, lang);
  if (!m) return "";
  const f = (ms: number) => Math.round((ms / 1000) * fps);
  let cursor = 0;
  for (const step of m.steps) {
    for (const line of step.lines) {
      const dur = f(line.durMs);
      if (frame < cursor + dur) return toDisplayText(line.text);
      cursor += dur + f(line.gapMs);
    }
  }
  return "";
}
