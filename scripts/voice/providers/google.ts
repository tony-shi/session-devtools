// Google Cloud Text-to-Speech provider。
//
// 为什么选它(对当前项目而言):
//   - 5-10 分钟集成 —— 单端点 REST,API key 直接放 query string,response 是 base64 mp3
//   - 每月免费额度:1M chars Standard + 1M chars WaveNet/Neural2 —— 整集 ~5k 字,够你跑 200 次
//   - 中文质量梯度全:Standard(机器感)→ WaveNet(自然)→ Neural2(更自然)→ Chirp HD(顶级)
//   - 无 SDK 强制依赖,全靠 fetch,Node 22 原生支持
//
// 接入:
//   1. 控制台启用 Cloud Text-to-Speech API,Credentials 里 Create API key
//   2. .env 写 GOOGLE_TTS_API_KEY=...
//   3. npm run voice:agent-loop:zh -- --provider google
//
// Voice 选择(中文教学口语场景):
//   cmn-CN-Wavenet-A (女,清亮,本默认)  ← 起步推荐
//   cmn-CN-Wavenet-B (男)
//   cmn-CN-Wavenet-C (男,沉稳)
//   cmn-CN-Wavenet-D (女,温柔)
//   cmn-CN-Neural2-A/B/C/D            ← 想再上一档
//   cmn-CN-Chirp3-HD-*                 ← 顶级,但不在免费额度里,谨慎
//
// 想试别的 voice:
//   npx tsx scripts/voice/synth.ts agent-loop --lang zh --provider google --voice cmn-CN-Neural2-A
//
// 时长估算:Google 返回纯 mp3,默认 ~24kbps 编码。从字节数反推 duration 误差 ~5%,
// 对动画节拍的容差(PACE 五档跨 200/500/900/1500)足够。想要精确秒级:加 music-metadata。

import type { SynthRequest, SynthResult, TTSProvider } from "./types";

interface GoogleOpts {
  apiKey: string;
  /** 显式指定 voice 名;不填则按 lang 用默认 */
  voiceName?: string;
  /** 0.25 ~ 4.0,1.0 = 正常。改这个不会改 manifest 的 pauseAfter,只是 TTS 出声更快/慢 */
  speakingRate?: number;
}

const DEFAULT_VOICE: Record<"zh" | "en", string> = {
  zh: "cmn-CN-Wavenet-A",
  en: "en-US-Wavenet-F",
};

const LANG_CODE: Record<"zh" | "en", string> = {
  zh: "cmn-CN",
  en: "en-US",
};

interface GoogleResponse {
  audioContent?: string;
  error?: { code: number; message: string; status: string };
}

/**
 * 从 mp3 字节数估算时长。Google 默认编码 ~24kbps,所以 bytes×8/24000 ≈ seconds。
 * 误差由 ID3 头 / VBR / 编码档位带来,~5% 范围 —— 动画节拍容差远大于此。
 */
function estimateMp3DurationMs(audio: Buffer, bitrateBps = 24000): number {
  const effectiveBytes = Math.max(0, audio.length - 256);  // 减去大致的 ID3 + 元数据
  const seconds = (effectiveBytes * 8) / bitrateBps;
  return Math.round(Math.max(0.6, seconds) * 1000);  // 下限 600ms,避免极短句给出近 0
}

export class GoogleTTSProvider implements TTSProvider {
  readonly id = "google";
  constructor(private opts: GoogleOpts) {}

  async synth(req: SynthRequest): Promise<SynthResult> {
    const langCode = LANG_CODE[req.lang];
    const voiceName = this.opts.voiceName ?? DEFAULT_VOICE[req.lang];

    const body = {
      input: { text: req.text },
      voice: { languageCode: langCode, name: voiceName },
      audioConfig: {
        audioEncoding: "MP3",
        ...(this.opts.speakingRate ? { speakingRate: this.opts.speakingRate } : {}),
      },
    };

    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(this.opts.apiKey)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = (await r.json()) as GoogleResponse;
    if (!r.ok || json.error) {
      const msg = json.error?.message ?? `HTTP ${r.status}`;
      throw new Error(`Google TTS: ${msg}`);
    }
    if (!json.audioContent) {
      throw new Error("Google TTS: empty audioContent");
    }
    const audio = Buffer.from(json.audioContent, "base64");
    return {
      audio,
      durMs: estimateMp3DurationMs(audio),
      voice: `google:${voiceName}`,
    };
  }
}
