// Gemini TTS provider —— Google AI Studio 的语音模型(预览版)。
//
// 和 Cloud Text-to-Speech 的差异(你应该知道):
//   - Gemini TTS 用 generativelanguage.googleapis.com,key 是 AIzaSy... 风格
//     的 Google AI Studio key,在 https://aistudio.google.com/apikey 拿
//   - Cloud TTS 用 texttospeech.googleapis.com,要在 GCP 项目里启用 Cloud TTS API
//     才能用同一把 key(很多 AI Studio key 没开 Cloud TTS)
//   - 因此对"刚拿到 Gemini key、还没碰 GCP"的人,这个 provider 是 1 步上路
//
// 特性:
//   - 30 个 prebuilt voice(多语言通用,不分中英);Chinese 教学女声常用 Kore / Aoede / Leda
//   - 支持自然语言风格控制:在 text 前加 "Say warmly:" / "Read like a textbook:" 之类
//   - 输出格式:PCM(L16, 24kHz mono)—— 我们包成 WAV 写盘,浏览器原生播
//   - 时长可精确算(WAV 头里有,不再像 mp3 估算)
//
// 价格 / 额度:Gemini 2.5 Flash Preview TTS 在 AI Studio 免费层有较慷慨额度
//   (但是 preview 模型,SLA 不保证;真要商用稳定再切 Cloud TTS Wavenet/Neural2)

import type { SynthRequest, SynthResult, TTSProvider } from "./types";

interface GeminiOpts {
  apiKey: string;
  /** 30 个 prebuilt voice 之一;默认 Kore(中文教学场景表现稳) */
  voiceName?: string;
  /** 模型名;默认 gemini-2.5-flash-preview-tts。换 Pro 版改这里 */
  model?: string;
  /** 在文本前加一句风格指令,如 "Read like a teacher explaining concepts: " */
  stylePrefix?: string;
}

const DEFAULT_VOICE = "Kore";
const DEFAULT_MODEL = "gemini-2.5-flash-preview-tts";

// Gemini TTS 的官方用法:在朗读文本前加一句"指令"。
// 没有这个 wrapper 时,模型可能把"tool_use —— 不是答案"误读为"问我什么是 tool_use",
// 然后试图回答 → 报 "Model tried to generate text" 错。
// 这个前缀本身**不会**被朗读 —— 它只告诉模型"只朗读冒号后面的内容,用 XX 语气"。
const DEFAULT_STYLE_PREFIX: Record<"zh" | "en", string> = {
  zh: "请用自然清晰的中文教学语气朗读下面这段文字,只朗读文字本身,不要解释或回答其中提到的术语:",
  en: "Read the following text aloud in a natural educational tone. Read it verbatim; do not interpret or respond to terms mentioned:",
};

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] };
  }[];
  error?: { code: number; message: string; status: string };
}

/**
 * 把 Gemini 返回的纯 PCM 数据封成 WAV(44-byte header)。
 * mime 头里能拿到 sampleRate;Gemini TTS 当前固定 24000Hz mono 16-bit。
 */
function wrapPcmAsWav(pcm: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);             // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}

/** 从 mime "audio/L16;codec=pcm;rate=24000" 中抠 rate;失败时退回 24000 */
function parseSampleRate(mime: string): number {
  const m = /rate=(\d+)/.exec(mime ?? "");
  return m ? parseInt(m[1], 10) : 24000;
}

export class GeminiTTSProvider implements TTSProvider {
  readonly id = "gemini";
  constructor(private opts: GeminiOpts) {}

  async synth(req: SynthRequest): Promise<SynthResult> {
    const voiceName = this.opts.voiceName ?? DEFAULT_VOICE;
    const model = this.opts.model ?? DEFAULT_MODEL;
    // 永远加 wrapper(默认走 lang-aware 前缀,显式 stylePrefix 覆盖)。
    // 拼接形式:`<指令>\n\n<朗读内容>` —— 空行让模型更清楚边界,不要把指令也念出来。
    const prefix = this.opts.stylePrefix ?? DEFAULT_STYLE_PREFIX[req.lang];
    const text = `${prefix}\n\n${req.text}`;

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.opts.apiKey)}`;

    const body = {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName } },
        },
      },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await r.json()) as GeminiResponse;
    if (!r.ok || json.error) {
      throw new Error(`Gemini TTS: ${json.error?.message ?? `HTTP ${r.status}`}`);
    }
    const inline = json.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!inline?.data) {
      throw new Error("Gemini TTS: no audio in response (model may not be enabled for your account)");
    }
    const sampleRate = parseSampleRate(inline.mimeType);
    const pcm = Buffer.from(inline.data, "base64");
    const wav = wrapPcmAsWav(pcm, sampleRate);
    // WAV 的精确时长:数据字节数 / (sampleRate × bytesPerSample × channels)
    const durMs = Math.round((pcm.length / (sampleRate * 2 * 1)) * 1000);
    return {
      audio: wav,
      durMs,
      voice: `gemini:${model}:${voiceName}`,
    };
  }
}
