// ElevenLabs TTS provider —— 英文首选。
//
// 接入步骤:
//   1) 在 https://elevenlabs.io/ 申请 API key,放 .env.local 的 ELEVENLABS_API_KEY
//   2) 选 voice:推荐 Multilingual v2 模型 + 一个自然的女声(Rachel / Bella)或
//      Voice Cloning 出来的统一声线
//   3) 接 https://api.elevenlabs.io/v1/text-to-speech/{voice_id} —— 直接返回 mp3
//   4) 用 mp3-duration / ffprobe 取真实 durMs
//
// 设计要点:
//   - 自然度业界第一,情绪 / 停顿 / 强调最强 —— 教学语气尤其重要
//   - SSML 支持完整;`<break time="400ms"/>`、`<emphasis level="strong">` 用得上
//   - 计费:按字符;一整集英文 ~25k chars,Creator plan($22/月 100k chars)能跑 3-4 次

import type { SynthRequest, SynthResult, TTSProvider } from "./types";

export class ElevenLabsProvider implements TTSProvider {
  readonly id = "elevenlabs";
  constructor(_opts: { apiKey: string; voiceId: string; modelId?: string }) {}

  async synth(_req: SynthRequest): Promise<SynthResult> {
    // TODO: POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
    //   - headers: xi-api-key, accept: audio/mpeg
    //   - body: { text, model_id: "eleven_multilingual_v2", voice_settings: {...} }
    //   - response.arrayBuffer() → Buffer
    //   - probe duration
    throw new Error(
      "ElevenLabsProvider not implemented yet — drop in API call in scripts/voice/providers/elevenlabs.ts",
    );
  }
}
