// Mock TTS provider —— 不连任何外部 API。
//
// 用途:
//   - 跑通 synth → manifest → audio-driven beat 的完整链路,不花钱、不等网
//   - 让"录屏走 audio clock"在接 TTS 之前就先 work,日后真 provider 是替换数据源
//
// 时长估算:
//   - 中文:每字 ~180ms(基于 4.5 字/秒的平均口播速度,科普语速)
//   - 英文:每词 ~280ms(基于 ~3.5 词/秒);拉丁字符约每 5 个一词
//   - 实测会有 ±30% 偏差,接真 TTS 后会被覆盖,先用于设计动画节奏没问题
//
// 静音 mp3:用 ffmpeg 生成对应时长的纯静音;若环境无 ffmpeg,产出 audio = undefined,
//          客户端 useAudioBeatClock 会自动退回 setTimeout(durMs)。

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SynthRequest, SynthResult, TTSProvider } from "./types";

const run = promisify(exec);

function estimateMs(text: string, lang: "zh" | "en"): number {
  const t = text.trim();
  if (!t) return 600;
  if (lang === "en") {
    const words = t.split(/\s+/).filter(Boolean).length;
    return Math.max(800, Math.round(words * 280));
  }
  // 中文:按非空白字符计数(标点也算,会被 TTS 念出停顿)
  const chars = [...t].filter((c) => !/\s/.test(c)).length;
  return Math.max(800, Math.round(chars * 180));
}

async function hasFfmpeg(): Promise<boolean> {
  try { await run("ffmpeg -version"); return true; } catch { return false; }
}

async function silentMp3(durMs: number): Promise<Buffer | null> {
  if (!(await hasFfmpeg())) return null;
  const dir = await mkdtemp(join(tmpdir(), "voice-mock-"));
  const out = join(dir, "s.mp3");
  const sec = (durMs / 1000).toFixed(3);
  try {
    await run(`ffmpeg -y -loglevel error -f lavfi -i anullsrc=r=22050:cl=mono -t ${sec} -q:a 9 ${out}`);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export class MockProvider implements TTSProvider {
  readonly id = "mock";
  async synth(req: SynthRequest): Promise<SynthResult> {
    const durMs = estimateMs(req.text, req.lang);
    const audio = await silentMp3(durMs);
    return {
      audio: audio ?? Buffer.alloc(0),
      durMs,
      voice: audio ? "mock:silent-mp3" : "mock:no-audio",
    };
  }
}
