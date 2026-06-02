// TTS Provider 抽象 —— 上层(synth.ts)与具体 provider(mock / minimax / elevenlabs)解耦。
// 增加新 provider 只实现这个接口;manifest 结构、缓存、SRT 全部不变。

export interface SynthRequest {
  text: string;
  lang: "zh" | "en";
  /** 可选:SSML 片段(<break time="..."> 等)。provider 不支持就忽略 */
  ssml?: string;
}

export interface SynthResult {
  /** mp3 内容(可能为静音,如 mock provider) */
  audio: Buffer;
  /** 实测时长(ms)。mock provider 返回估算值 */
  durMs: number;
  /** provider 自报的 voice 标识,例如 "minimax:speech-02-hd:zh-female-1" */
  voice: string;
}

export interface TTSProvider {
  /** 用于 manifest / 缓存命名空间。例:"mock" / "minimax" / "elevenlabs" */
  readonly id: string;
  synth(req: SynthRequest): Promise<SynthResult>;
}
