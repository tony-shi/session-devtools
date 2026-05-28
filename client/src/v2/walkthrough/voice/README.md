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

## 调节奏:作者只有两个旋钮

设计原则:**节奏的真正语义 = 文字本身有多长 + 你决定在哪儿留白**。其它都是衍生。

| 旋钮 | 调什么 | 改哪里 |
|---|---|---|
| **文字本身** | 这一句的"播放时长"(mock 估算字数;真 TTS 实测语音) | `stories/<id>.ts` 的 `lines[]` |
| **句末留白 `pauseAfter`** | 这一句完了之后停几毫秒,给观众消化 | `stories/<id>.ts` 的 `pauseAfter: []`,用 `PACE.*` |

manifest 里的 `durMs` 是**机器算的中间产物**,作者不该看也不该改 —— 改了下次合成被覆盖。

### `pauseAfter` 用法

```ts
import { PACE } from "../pace";

{
  act: "conversation",
  focus: "overview",
  lines: [
    "Claude Code 第一眼看上去,像终端里的编程聊天框。",
    "你输入一句需求,它回你一段解释。",
    "但如果它只是聊天,它就不能修 bug、跑测试、改代码。",
    "在这个框里面,它正在观察、行动、再观察。",
    "这段连续的工作记录,就是 Session。",
  ],
  pauseAfter: [
    PACE.breath,   // 500ms — 第一次提到 Claude Code,呼吸一下
    PACE.breath,   // 500ms — 自然断句
    PACE.pause,    // 900ms — "如果它只是聊天" 是转折,让观众停一下
    PACE.breath,   // 500ms
    PACE.dwell,    // 1500ms — punchline "就是 Session",留白让概念落地
  ],
}
```

**五档语义,够用**(见 `pace.ts`):

| 常量 | ms | 用场景 |
|---|---|---|
| `PACE.none` | 0 | 把多句焊死成一团,慎用 |
| `PACE.beat` | 200 | 默认,正常断句呼吸(可省略整个 pauseAfter) |
| `PACE.breath` | 500 | 段落小转折 |
| `PACE.pause` | 900 | 关键定义之后 / 话题切换 |
| `PACE.dwell` | 1500 | punchline 之后 / 让观众脑补 |

`pauseAfter` **跨语言共享** —— 节奏点是语义,不该因为换译就改。

### 工作流(主线)

1. **写文案**(`stories/<id>.ts`):写 `lines[]` + `linesEn[]`。一句话别太长(超 20 字考虑断句)
2. **标节拍**:在 `pauseAfter` 里挑关键的 3-5 句标 `PACE.breath / pause / dwell`,其它省略走默认
3. **合成**:`npm run voice:agent-loop:zh`
4. **试听**:打开 `/demo/agent-loop`,听整集节奏感
5. 不顺 → 改 `pauseAfter` 或拆/合并 `lines[]` 的句子,**重跑第 3 步**

### 辅助工具(诊断 / 试探,不是日常)

底部那条 3px 进度条**始终在线**,显示整集已播 + 当前拍内进度。

| URL 参数 | 作用 | 适用场景 |
|---|---|---|
| `?speed=0.7` 或 `?speed=1.3` | 整体节奏放缩(不动 manifest) | "如果配音整体再慢一点感觉如何" —— 找到舒服的倍率后,**不要烧进 manifest**;改 PACE.beat 默认值或者重写 mock 估算公式才是正路 |
| `?dev=1` | 右下角 HUD 显示当前拍 durMs / gapMs / 数据源 | 排查 "这一拍为什么这么短/长" |

`?speed=` 是**试探**工具,不是设置工具。如果你发现整集系统性偏快/偏慢:
- 偏快 → 在 `pace.ts` 把 `PACE.beat` 从 200 调到 300
- 单句偏快 → 把那一句 `pauseAfter` 升一档(beat → breath)
- 单句偏慢 → 把那一句文案改短

绝对不要"全集烧 ?speed=0.85"那种做法 —— 那是把作者的精修变成机器化处理,反方向。

### 单句精修的极端情况

如果你**真的**需要修某个具体毫秒数(比如文案不能短了,但 PACE 五档都不合适),**改 `pauseAfter[i]` 用裸数字**:

```ts
pauseAfter: [PACE.breath, 720, PACE.breath]   // 中间这句要 720ms,不在 PACE 五档里
```

不要去碰 manifest 的 `durMs`。

### 接真 TTS 之后

`durMs` 自动变实测值 —— 你之前用 `pauseAfter` 标的节拍点全部继续生效。如果接 TTS 后某一句"听起来比 mock 慢/快很多",微调那一拍的 `pauseAfter` 即可。

---

## 已知未做(留给下一轮)

- Teleprompter 模式(配音师专用界面)
- 真 provider 接入 + voice 试听 / 选型 dev tool
- 单句重合成 UI(目前需要改 cache + 重跑 CLI)
- 录屏键位 cheat sheet 屏内显示(开 `?cheat=1` 时弹一张)
