// Walkthrough 音轨清单 —— TTS 合成产物的"单一真源"。
//
// 同一份清单被三处共用:
//   1) 浏览器播放器(useAudioBeatClock)—— 按 durMs 推进节拍、按 audio 路径播声
//   2) 字幕导出(srtExport)—— 累加 durMs+gapMs 算时间戳
//   3) 录屏 / 后期 —— 看清单就知道每一拍的时长,动画曲线和音轨自然对齐
//
// 由 scripts/voice/synth.ts 离线产出到 client/public/voice/<storyId>/<lang>.json。
// 当目标 mp3 文件不存在时,audio 字段可省略 —— 播放器会回退到纯计时模式,
// 仍然按 durMs 推进节拍(只是没声),开发 / 试跑时省事。

export type Lang = "zh" | "en";

export interface LineCue {
  /** 在 step.lines 中的下标,与字幕脚本一一对应 */
  idx: number;
  /** 这一拍的台词(冗余存一份,方便人工核对 / 直接生成 SRT) */
  text: string;
  /** 相对 /public/voice/<storyId>/ 的 mp3 路径;无音频时省略,播放器走纯计时 */
  audio?: string;
  /** TTS 实测时长(ms)。无音频时 = 估算值(synth 用字符数 × ms/char) */
  durMs: number;
  /** 句末停顿(ms)。给画面一点呼吸,默认 300 */
  gapMs: number;
}

export interface StepManifest {
  /** Story.steps 里的下标 */
  stepIdx: number;
  /** 该 step 内的每一拍 */
  lines: LineCue[];
}

export interface Manifest {
  storyId: string;
  lang: Lang;
  /** 合成时用的 voice 标识,例如 "mock:silent" / "minimax:speech-02-hd:zh-female-1" */
  voice: string;
  /** 合成完成时间,ISO string,用于缓存 / 排查 */
  builtAt: string;
  /** 整集累计音轨长度(ms)= sum(durMs + gapMs)。便于一眼看整集时长 */
  totalMs: number;
  steps: StepManifest[];
}
