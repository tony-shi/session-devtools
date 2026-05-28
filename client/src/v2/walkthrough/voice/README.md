# Walkthrough Voice + Recording Scaffold

录视频用的完整工作流脚手架。**仅存在于本地 studio 分支(`feature/refine-walkthrough` / `local/walkthrough-studio`)**,不进 main。

---

## 三种"呈现模式"

由 URL `?mode=` 切换。同一份 story / view,不同壳子:

| 模式 | URL | 字幕条 | 语言切换 | 节拍 | 用途 |
|---|---|---|---|---|---|
| **live** | `/demo/agent-loop` | 显示(底部黑框) | 显示(右上角) | 自动(BEAT_MS 或音轨时长) | 在线演示 / 排练 |
| **record** | `/demo/agent-loop?mode=record&lang=zh` | **隐藏** | **隐藏** | **手动**(← / →) | 录画面 |
| **tele** | `/demo/agent-loop?mode=tele` | (预留) | (预留) | (预留) | 配音师用,本次未实现 |

**录屏者操作**:`?mode=record&lang=zh` 进入,← / → 一帧一帧推进,左下角微型角标(`agent-loop · zh · step 3/7 · beat 2/4 · timer`)给录屏者核对位置,后期裁掉。

---

## 音轨流水线(从字幕脚本到 mp3 + 时长清单)

```
client/src/v2/walkthrough/stories/agent-loop.ts        ← 字幕来源(lines + linesEn)
                            │
                            ↓
npm run voice -- agent-loop --lang zh --provider mock  ← 合成 CLI(scripts/voice/synth.ts)
                            │
                            ↓
client/public/voice/agent-loop/zh.json + zh/*.mp3      ← manifest + 音频产物
                            │
                            ↓
useAudioBeatClock / 主 DemoStage 节拍 effect            ← 浏览器消费
                            │
                            ↓
        手动录画面(record 模式)             SRT 导出(srtExport.ts)
```

### 命令速记

```bash
# 用 mock provider 跑通(不需要 API key,生成静音 mp3 + 估算时长)
npm run voice:agent-loop:zh
npm run voice:agent-loop:en

# 或直接调,带参数
npx tsx scripts/voice/synth.ts agent-loop --lang zh --provider mock --gap 350

# 切换 provider(实现后)
npx tsx scripts/voice/synth.ts agent-loop --lang zh --provider minimax
npx tsx scripts/voice/synth.ts agent-loop --lang en --provider elevenlabs
```

### Manifest 结构

```jsonc
{
  "storyId": "agent-loop",
  "lang": "zh",
  "voice": "mock:default",
  "builtAt": "2026-05-28T13:45:00.000Z",
  "totalMs": 145320,
  "steps": [
    {
      "stepIdx": 0,
      "lines": [
        {
          "idx": 0,
          "text": "Claude Code 第一眼看上去……",
          "audio": "zh/0-0.mp3",   // 缺省 → 走纯计时
          "durMs": 4180,            // TTS 实测;mock 时为字数估算
          "gapMs": 300              // 句末停顿
        }
      ]
    }
  ]
}
```

---

## TTS Provider 抽象

`scripts/voice/providers/types.ts` 是合约:

```ts
interface TTSProvider {
  id: string;                                    // "mock" / "minimax" / "elevenlabs"
  synth(req: SynthRequest): Promise<SynthResult>;
}
```

### 已有实现

- **mock** ✅ —— 不连任何 API。字数 × ms/char 估算时长 + ffmpeg 生成静音 mp3。无 ffmpeg 时跳过音频,manifest 仍生成,客户端自动退回纯计时
- **minimax** 🔧 stub —— 中文首选,文件里留了接入 checklist
- **elevenlabs** 🔧 stub —— 英文首选,同上

### 接入真实 provider 的步骤

参见 `scripts/voice/providers/minimax.ts` / `elevenlabs.ts` 文件头注释。共同的工程要点:

1. **缓存**:`synth.ts` 已经按 `hash(text + voice + lang)` 走 `.cache/voice/<hash>.mp3`。改一句重跑只重合成那句,日常不烧钱
2. **失败兜底**:provider 抛错 → 单句回退 mock 估算,manifest 仍可产出
3. **发音词典**:如需为术语(`tool_use` / `LLM Call` 等)统一发音,在 synth.ts 调用前做 `<sub alias="…">` 替换
4. **环境变量**:`.env.local` 放 `MINIMAX_API_KEY` / `ELEVENLABS_API_KEY`,不进 git

---

## 节拍系统:三档优先级(DemoStage 已实现)

```
record 模式?  yes → 完全手动,← / → 推进
              no  ↓
manifest 这一拍有 cue? yes → durMs + gapMs 推进 + 播 mp3(若 audio 字段存在)
                       no  ↓
                  fallback BEAT_MS = 2600ms(向后兼容,无音轨也能 demo)
```

任意一档失败(音频 404 / autoplay 被拦)→ 自动退到下一档,不让一句卡住整集。

---

## SRT 字幕导出

```ts
import { manifestToSrt } from "./voice/srtExport";
const srt = manifestToSrt(manifest);
// 写到 client/public/voice/<storyId>/<lang>.srt 即可
```

时间戳逻辑:每一拍累加 `durMs + gapMs`;字幕显示窗口 = `[cursor, cursor + durMs]`(gap 之前退场)。

---

## 录屏 → 配音 → 后期 的工作流

1. **作者**:写完 `lines[]` + `linesEn[]`
2. **合成**(mock 或真 TTS):`npm run voice:agent-loop:zh` → 拿到 manifest + mp3
3. **排练**:`/demo/agent-loop` 打开,checked manifest 工作(节拍跟 mp3 时长走)
4. **录画面**:`/demo/agent-loop?mode=record&lang=zh` —— 字幕条 / LangToggle 全部隐藏,用 ← / → 手动推进,OBS / Loom 录。可以重录单拍
5. **后期**:
   - 视频:左下角 24px 裁掉角标
   - 音频:直接拼接 `client/public/voice/agent-loop/zh/*.mp3`(顺序按 step / line idx)
   - 字幕:`manifestToSrt(manifest)` 出 SRT,YouTube / B 站直接传字幕轨道
6. **换语种**:重复 4-5,URL 改 `?lang=en`,manifest 换成 en.json

---

## 调节奏:不接 TTS 也能"听"出快慢

合成出来的 manifest 给每一拍一个 `durMs`(mock 是字数估算,真 TTS 是实测)。你不需要等真 TTS 就能在浏览器里**直接试整集节奏**。

### URL 工具箱

| URL 参数 | 作用 | 试用例 |
|---|---|---|
| `?speed=0.7` | **全局**慢到 70%(durMs × 1.43) | 觉得 mock 估算偏快、想看"配合慢一点的口播"时 |
| `?speed=1.3` | 加速 30% | 想看"如果有人语速偏快" |
| `?dev=1` | 右下角 dev HUD,显示当前拍的 durMs / gapMs / speed / 总时长 | 边播边盯当前句的具体毫秒数 |
| 组合 | `?speed=0.85&dev=1&lang=zh` | 边慢一点边看数据 |

底部那条 3px 进度条**始终在线**,显示整集已播 + 当前拍内进度,给你"节奏感"的直观反馈。

### 三种快慢调节,选适合的力度

#### 力度 1:整集统一调(秒)
URL 加 `?speed=0.8`,回车,立刻生效。**不改任何文件**。  
找到舒服的整体倍率(假设是 0.85)后:把它"烧进" manifest —— 跑 `npm run voice:agent-loop:zh -- --gap 350` 或直接编辑 zh.json,把所有 durMs 乘 1.18(= 1/0.85)。这样 `?speed=1` 默认就是你想要的节奏。

#### 力度 2:某一段拖太久 / 闪太快(分钟)
打开 `?dev=1`,记下"觉得不对劲那一拍"的 `step / beat / durMs`。直接编辑 `client/public/voice/agent-loop/zh.json`:

```jsonc
{
  "stepIdx": 5,
  "lines": [
    { "idx": 2, "text": "现在把它们串起来 ……", "durMs": 4200, "gapMs": 300 }
                                       //   ↑ 改它,从 3800 → 4200 慢 400ms
  ]
}
```

保存。Vite 监听到 `public/` 改动会**热刷新**;浏览器自动重载,新值立刻生效。试听,不行再改。

#### 力度 3:文案改了 / 加了新拍(几分钟)
改了 `agent-loop.ts` 里的 `lines[]`、要重新合成:

```bash
npm run voice:agent-loop:zh
```

Hash 缓存只会重合成你改动的那几句,其它走 cache。manifest 重写,浏览器刷新即可。如果想强制全合成(比如换了倍率公式):删 `.cache/voice/` 重跑。

### 配合接真 TTS 时

接 MiniMax / ElevenLabs 后,`durMs` 变成**实测**值,你之前调的 `?speed` 仍然有效 —— 视觉节拍照常被倍率放缩,但**音频本身不变速**(变速会改音调)。所以接真 TTS 前的 `?speed` 调整,本质上是在告诉你"实际配音应该比 mock 估算的快/慢多少",可以告诉配音师 / TTS provider 用对应的语速参数。

---

## 已知未做(留给下一轮)

- Teleprompter 模式(配音师专用界面)
- 真 provider 接入 + voice 试听 / 选型 dev tool
- 单句重合成 UI(目前需要改 cache + 重跑 CLI)
- 录屏键位 cheat sheet 屏内显示(开 `?cheat=1` 时弹一张)
