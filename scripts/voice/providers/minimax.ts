// MiniMax (海螺) TTS provider —— 中文首选。
//
// 接入步骤(给未来的你):
//   1) 在 https://platform.minimax.io/ 申请 API key,放到 .env.local 的 MINIMAX_API_KEY
//   2) 选 voice:推荐 speech-02-hd + "moss_audio_xxxx"(知识科普女声);可在控制台试听
//   3) 把下面 throw 那段换成真请求(已留 TODO 行)
//   4) 用 ffprobe / mp3-duration 抽 SynthResult.durMs(实测,不要再估)
//
// 设计要点:
//   - 中英文混排:speech-02-hd 自动识别英文(SSML 也不必特别标),tool_use / LLM 这类术语
//     发音通常稳定;若个别词不对,在 synth.ts 里维护 pronunciation-overrides.json,
//     用 <sub alias="..."> 替换
//   - 停顿:用 <break time="400ms"/>,关键转折处插入
//   - 计费:按字符,标点不计;一整集中文 ~5000 字字符,~¥1 一次

import type { SynthRequest, SynthResult, TTSProvider } from "./types";

export class MiniMaxProvider implements TTSProvider {
  readonly id = "minimax";
  constructor(_opts: { apiKey: string; voiceId: string; model?: string }) {}

  async synth(_req: SynthRequest): Promise<SynthResult> {
    // TODO: POST https://api.minimaxi.com/v1/t2a_v2
    //   - body: { model: "speech-02-hd", voice_id, text, ... }
    //   - decode base64 audio → Buffer
    //   - probe duration with mp3-duration / ffprobe
    throw new Error(
      "MiniMaxProvider not implemented yet — drop in API call in scripts/voice/providers/minimax.ts",
    );
  }
}
