// MiniMax T2A (Text-to-Audio) v2 provider —— 中文表现力 SOTA 档,教学口吻自然。
//
// 为什么走逐句(不像 Gemini 要整篇 + ffmpeg 切):
//   - 固定 voice_id = 确定性音色,逐句合成不漂(Gemini 是生成式,逐句会漂语气)
//     → MiniMax 直接走现有 synth.ts 的逐句管线 + 缓存即可
//   - 响应里带 extra_info.audio_length(精确 ms)→ durMs 直接用,不靠估算 / 切割
//   - 中文原生 + 中英混读自然(tool_use / LLM Call 不会被读崩;language_boost 进一步稳)
//
// 凭据(放仓库根 .env):
//   MINIMAX_API_KEY   = 控制台 API Key(Bearer token)
//   MINIMAX_GROUP_ID  = 控制台 GroupId(拼到 URL query)
//   MINIMAX_API_HOST  = 可选。国内平台 api.minimax.chat(默认);国际平台 api.minimaxi.chat
//                       两个平台 key / GroupId 不通用,按你注册的那个填
//
// voice_id / model 用 --voice / --model 覆盖;具体可用 id 以控制台「音色」列表为准。

import type { SynthRequest, SynthResult, TTSProvider } from "./types";

interface MinimaxOpts {
  apiKey: string;
  groupId: string;
  host?: string;
  model?: string;
  voiceId?: string;
  /** 语速 0.5~2.0(教学略慢更清晰,默认 1.0) */
  speed?: number;
  /** 情绪:happy/neutral/… —— 教学常用 neutral / happy */
  emotion?: string;
  /**
   * 音色混合(MiniMax timber_weights):按权重调和多个音色,取中间感觉。
   * 例:[{ voiceId: "presenter_female", weight: 60 }, { voiceId: "audiobook_female_1", weight: 40 }]
   * 给了这个就忽略单一 voiceId;最多 4 个,weight 取 1~100(按比例归一)。
   */
  timberWeights?: Array<{ voiceId: string; weight: number }>;
}

const DEFAULT_HOST = "api.minimax.chat";
const DEFAULT_MODEL = "speech-02-hd";
// 注:voice_id 命名随版本演进,这个默认若控制台不存在,请用 --voice 指定你账号里的 id。
const DEFAULT_VOICE = "female-chengshu";

interface MinimaxResponse {
  data?: { audio?: string; status?: number };
  extra_info?: { audio_length?: number; audio_sample_rate?: number; audio_size?: number };
  base_resp?: { status_code: number; status_msg: string };
}

export class MiniMaxProvider implements TTSProvider {
  readonly id = "minimax";
  constructor(private opts: MinimaxOpts) {}

  async synth(req: SynthRequest): Promise<SynthResult> {
    // 限流(code 1002 / HTTP 429)自动退避重试 —— 账号 RPM 有限,逐句合成会撞限流。
    // 指数退避:2s, 4s, 8s, 16s, 32s;最多 5 次。非限流错误立即抛出,不浪费时间。
    let attempt = 0;
    for (;;) {
      try {
        return await this.synthOnce(req);
      } catch (e) {
        const msg = (e as Error).message;
        const rateLimited = msg.includes("code 1002") || msg.includes("HTTP 429") || msg.includes("rate limit");
        if (!rateLimited || attempt >= 5) throw e;
        const waitMs = 2000 * 2 ** attempt;
        attempt += 1;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  private async synthOnce(req: SynthRequest): Promise<SynthResult> {
    const host = this.opts.host ?? DEFAULT_HOST;
    const model = this.opts.model ?? DEFAULT_MODEL;
    const voiceId = this.opts.voiceId ?? DEFAULT_VOICE;
    const url = `https://${host}/v1/t2a_v2?GroupId=${encodeURIComponent(this.opts.groupId)}`;

    const mix = this.opts.timberWeights;
    const body = {
      model,
      text: req.text,
      stream: false,
      // language_boost:让中英混读更稳(英文术语读对,而不是逐字母)
      language_boost: req.lang === "zh" ? "Chinese" : "English",
      voice_setting: {
        // voice_id 始终必填;混音时取权重最高的音色当基底,再叠 timber_weights 调和
        voice_id: mix ? [...mix].sort((a, b) => b.weight - a.weight)[0].voiceId : voiceId,
        speed: this.opts.speed ?? 1.0,
        vol: 1.0,
        pitch: 0,
        ...(this.opts.emotion ? { emotion: this.opts.emotion } : {}),
      },
      ...(mix ? { timber_weights: mix.map((w) => ({ voice_id: w.voiceId, weight: w.weight })) } : {}),
      audio_setting: { sample_rate: 24000, bitrate: 128000, format: "mp3", channel: 1 },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await r.json()) as MinimaxResponse;
    if (!r.ok) throw new Error(`MiniMax T2A: HTTP ${r.status}`);
    if (json.base_resp && json.base_resp.status_code !== 0) {
      throw new Error(`MiniMax T2A: ${json.base_resp.status_msg} (code ${json.base_resp.status_code})`);
    }
    const hex = json.data?.audio;
    if (!hex) throw new Error("MiniMax T2A: no audio in response");
    // 非流式返回是 hex 编码的音频字节(不是 base64)
    const audio = Buffer.from(hex, "hex");
    // 精确时长直接来自响应;缺失则粗估兜底
    const durMs = json.extra_info?.audio_length ?? Math.max(700, Math.round(req.text.length * 180));
    const voiceLabel = mix ? mix.map((w) => `${w.voiceId}:${w.weight}`).join("+") : voiceId;
    return { audio, durMs, voice: `minimax:${model}:${voiceLabel}` };
  }
}
