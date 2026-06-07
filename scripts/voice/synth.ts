// 音轨合成 CLI —— story × lang → manifest + mp3 集。
//
// 用法:
//   npx tsx scripts/voice/synth.ts <storyId> --lang zh --provider mock [--gap 300] [--out client/public/voice]
//
// 例:
//   npx tsx scripts/voice/synth.ts agent-loop --lang zh --provider mock
//   → 写出 client/public/voice/agent-loop/zh.json + zh/*.mp3
//
// 设计要点:
//   - 增量缓存:hash(text + voice + lang) → 命中 .cache/voice/<hash>.mp3 跳过 API
//     改一句重跑只重合成那一句;批量改文案也只产生增量调用
//   - 失败兜底:provider 抛错 → 该句 audio 字段省略 + durMs 走 mock 估算,
//     这样 manifest 仍能产出,播放器走计时回退,不让一句卡住整集
//   - 文件结构:
//       client/public/voice/<storyId>/<lang>.json           ← manifest
//       client/public/voice/<storyId>/<lang>/<step>-<line>.mp3
//
// 注:tsx 直接导入 Story TS 文件,无需预编译。Story 是纯数据,无 React 副作用。

import { writeFile, mkdir, stat, readFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STORIES } from "../../client/src/v2/walkthrough/stories";
import { pickLines } from "../../client/src/v2/walkthrough/i18n";
import { PACE } from "../../client/src/v2/walkthrough/pace";
import type { Lang, LineCue, Manifest, StepManifest } from "../../client/src/v2/walkthrough/voice/types";
import type { TTSProvider } from "./providers/types";
import { MockProvider } from "./providers/mock";
import { GoogleTTSProvider } from "./providers/google";
import { GeminiTTSProvider } from "./providers/gemini";
import { MiniMaxProvider } from "./providers/minimax";

// 加载 .env(Node 22 原生 API,无需 dotenv)。仓库根目录的 .env 在 cwd 下。
try { process.loadEnvFile(".env"); } catch { /* 没 .env,走环境变量本身 */ }

/** 嗅探音频字节流的格式 —— mp3 / wav,决定写盘扩展名 */
function sniffExt(buf: Buffer): "mp3" | "wav" {
  if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return "wav";
  return "mp3";
}

interface Cli {
  storyId: string;
  lang: Lang;
  providerName: "mock" | "google" | "gemini" | "minimax" | "elevenlabs";
  /** 显式指定 voice 名(各 provider 自己解释);不填用 provider 默认 */
  voiceName?: string;
  /** 按 story 覆盖语速(如 S2 全局 +20% = 1.242);不填走 MINIMAX_SPEED */
  speed?: number;
  /** 默认留白(ms),仅当 step.pauseAfter[idx] 没填时用。语义上是 PACE.beat */
  defaultGapMs: number;
  outDir: string;
  cacheDir: string;
}

function parseArgs(): Cli {
  const args = process.argv.slice(2);
  const storyId = args[0];
  if (!storyId) {
    console.error("usage: synth.ts <storyId> [--lang zh|en] [--provider mock|google|gemini|minimax|elevenlabs] [--voice <name>] [--gap 300] [--out <dir>]");
    process.exit(2);
  }
  const get = (flag: string, def: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const getOptional = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
  };
  const lang = get("--lang", "zh") as Lang;
  if (lang !== "zh" && lang !== "en") { console.error("--lang must be zh or en"); process.exit(2); }
  const providerName = get("--provider", "mock") as Cli["providerName"];
  if (!["mock", "google", "gemini", "minimax", "elevenlabs"].includes(providerName)) {
    console.error("--provider must be mock | google | gemini | minimax | elevenlabs");
    process.exit(2);
  }
  const voiceName = getOptional("--voice");
  const speedRaw = getOptional("--speed");
  const speed = speedRaw ? parseFloat(speedRaw) : undefined;
  // 命令行 --gap 仅在 step.pauseAfter[i] 缺省时生效。默认走 PACE.beat,语义对齐 pace.ts。
  const defaultGapMs = parseInt(get("--gap", String(PACE.beat)), 10);

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const outDir = resolve(repoRoot, get("--out", "client/public/voice"));
  const cacheDir = resolve(repoRoot, ".cache/voice");
  return { storyId, lang, providerName, voiceName, speed, defaultGapMs, outDir, cacheDir };
}

// MiniMax 音色按语言解析:MINIMAX_VOICE_EN / MINIMAX_TIMBER_WEIGHTS_EN 存在时覆盖通用值
// (空字符串 = 显式关闭混音,走单一 voice)。zh 沿用通用键,互不干扰。
// buildProvider 与 voiceSig(缓存签名)都必须用同一份解析结果,否则换音色不换缓存会放错音。
export function resolveMinimaxVoice(lang: Lang, voiceName?: string, speedOverride?: number): {
  timberWeights: Array<{ voiceId: string; weight: number }> | undefined;
  voiceId: string | undefined;
  speed: number | undefined;
  sig: string;
} {
  const L = lang.toUpperCase();
  const rawWeights = process.env[`MINIMAX_TIMBER_WEIGHTS_${L}`] ?? process.env.MINIMAX_TIMBER_WEIGHTS;
  const timberWeights = parseTimberWeights(rawWeights);
  const voiceId = voiceName ?? process.env[`MINIMAX_VOICE_${L}`] ?? process.env.MINIMAX_VOICE;
  // 语速:CLI --speed(按 story 提速,如 S2 1.242)> env。参与缓存签名,改速必重合成。
  const speed = speedOverride ?? (process.env.MINIMAX_SPEED ? parseFloat(process.env.MINIMAX_SPEED) : undefined);
  const sig = [
    "minimax",
    process.env.MINIMAX_MODEL ?? "speech-02-hd",
    timberWeights ? rawWeights : (voiceId ?? "default"),
    `sp${speed ?? "1"}`,
    `em${process.env.MINIMAX_EMOTION ?? "none"}`,
  ].join(":");
  return { timberWeights, voiceId, speed, sig };
}

function buildProvider(name: Cli["providerName"], lang: Lang, voiceName?: string, speedOverride?: number): TTSProvider {
  if (name === "mock") return new MockProvider();
  if (name === "google") {
    const apiKey = process.env.GOOGLE_TTS_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_TTS_API_KEY env var required. Set it in .env at repo root. See .env.example.");
    }
    return new GoogleTTSProvider({ apiKey, voiceName });
  }
  if (name === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY env var required. Set it in .env at repo root. See .env.example.");
    }
    return new GeminiTTSProvider({ apiKey, voiceName });
  }
  if (name === "minimax") {
    const apiKey = process.env.MINIMAX_API_KEY;
    const groupId = process.env.MINIMAX_GROUP_ID;
    if (!apiKey || !groupId) {
      throw new Error("MINIMAX_API_KEY 和 MINIMAX_GROUP_ID 需在仓库根 .env 设置。见 providers/minimax.ts 顶部。");
    }
    // 音色按语言解析(见 resolveMinimaxVoice):en 单声 audiobook_male_1,zh 三混。
    const v = resolveMinimaxVoice(lang, voiceName, speedOverride);
    return new MiniMaxProvider({
      apiKey, groupId,
      host: process.env.MINIMAX_API_HOST,
      model: process.env.MINIMAX_MODEL,
      voiceId: v.voiceId,
      speed: v.speed,
      emotion: process.env.MINIMAX_EMOTION,
      timberWeights: v.timberWeights,
    });
  }
  if (name === "elevenlabs") {
    throw new Error("elevenlabs provider stub — see scripts/voice/providers/elevenlabs.ts");
  }
  throw new Error("unknown provider: " + name);
}

/** 解析 MINIMAX_TIMBER_WEIGHTS="voiceA:40,voiceB:60" → 混音权重数组(空/非法返回 undefined) */
function parseTimberWeights(raw?: string): Array<{ voiceId: string; weight: number }> | undefined {
  if (!raw || !raw.trim()) return undefined;
  const weights = raw.split(",").map((pair) => {
    const [voiceId, w] = pair.split(":").map((s) => s.trim());
    return { voiceId, weight: parseInt(w, 10) };
  }).filter((x) => x.voiceId && !Number.isNaN(x.weight));
  return weights.length > 0 ? weights : undefined;
}

function hashKey(text: string, voiceHint: string, lang: Lang): string {
  return createHash("sha256").update(`${voiceHint}|${lang}|${text}`).digest("hex").slice(0, 16);
}

async function ensureDir(p: string) { await mkdir(p, { recursive: true }); }

async function readCache(cacheDir: string, key: string): Promise<{ audio: Buffer; durMs: number } | null> {
  const mp3 = join(cacheDir, `${key}.mp3`);
  const meta = join(cacheDir, `${key}.json`);
  if (!existsSync(mp3) || !existsSync(meta)) return null;
  const [audio, m] = await Promise.all([readFile(mp3), readFile(meta, "utf8")]);
  return { audio, durMs: JSON.parse(m).durMs };
}

async function writeCache(cacheDir: string, key: string, audio: Buffer, durMs: number) {
  await ensureDir(cacheDir);
  await writeFile(join(cacheDir, `${key}.mp3`), audio);
  await writeFile(join(cacheDir, `${key}.json`), JSON.stringify({ durMs }));
}

async function main() {
  const cli = parseArgs();
  const story = STORIES[cli.storyId];
  if (!story) { console.error(`unknown storyId: ${cli.storyId}`); process.exit(2); }

  const provider = buildProvider(cli.providerName, cli.lang, cli.voiceName, cli.speed);
  // 缓存签名:参与 hash 的"音色身份"。与 buildProvider 共用 resolveMinimaxVoice,
  // 换音色/混音/语速/情绪 → key 变 → 自动重合成,不会命中旧音。
  const voiceSig = cli.providerName === "minimax"
    ? resolveMinimaxVoice(cli.lang, cli.voiceName, cli.speed).sig
    : `${cli.providerName}:${cli.voiceName ?? "default"}`;
  const storyOutDir = join(cli.outDir, story.id);
  const audioOutDir = join(storyOutDir, cli.lang);
  await ensureDir(storyOutDir);
  await ensureDir(audioOutDir);

  const stepsOut: StepManifest[] = [];
  let totalMs = 0;
  let synthed = 0;
  let cached = 0;
  let failed = 0;
  const builtAt = new Date().toISOString();
  const t0 = Date.now();
  const totalLines = story.steps.reduce((n, s) => n + pickLines(s, cli.lang).length, 0);
  let seq = 0;
  console.log(`⟳ ${story.id} / ${cli.lang} / ${cli.providerName}${cli.voiceName ? ":" + cli.voiceName : ""} · ${totalLines} lines`);

  for (const [stepIdx, step] of story.steps.entries()) {
    const lines = pickLines(step, cli.lang);
    const cues: LineCue[] = [];
    // 节奏:每一行的"句末留白"。优先级 step.pauseAfter[i] → --gap → PACE.beat。
    // pauseAfter 跨语言共用 —— 节拍点是语义,不该因为中英换译就改。
    const pauseAfter = step.pauseAfter ?? [];
    for (const [lineIdx, text] of lines.entries()) {
      seq += 1;
      const lineT0 = Date.now();
      // voiceSig 参与 hash —— 换 voice / 调混音/语速/情绪都必须重合成,否则放错音
      const key = hashKey(text, `${voiceSig}:${cli.lang}`, cli.lang);

      let durMs = 0;
      let haveAudio = false;
      let ext: "mp3" | "wav" = "mp3";
      let audioBytes: Buffer | null = null;
      let status: "synth" | "cached" | "fail" = "synth";
      try {
        const hit = await readCache(cli.cacheDir, key);
        if (hit) {
          audioBytes = hit.audio;
          durMs = hit.durMs;
          cached += 1;
          status = "cached";
        } else {
          const res = await provider.synth({ text, lang: cli.lang });
          audioBytes = res.audio;
          durMs = res.durMs;
          await writeCache(cli.cacheDir, key, res.audio, durMs);
          synthed += 1;
          status = "synth";
        }
      } catch (e) {
        // 单句失败:回退到 mock 估算,manifest 仍产出
        failed += 1;
        status = "fail";
        const mockRes = await new MockProvider().synth({ text, lang: cli.lang });
        audioBytes = mockRes.audio;
        durMs = mockRes.durMs;
        console.warn(`  [${String(seq).padStart(3)}/${totalLines}] s${stepIdx}:${lineIdx} ✗ synth failed → mock fallback: ${(e as Error).message}`);
      }
      const elapsed = Date.now() - lineT0;
      const sym = status === "cached" ? "●" : status === "synth" ? "→" : "✗";
      const tag = status === "cached" ? "cached" : status === "synth" ? `synth ${elapsed}ms` : "fallback";
      const preview = text.length > 28 ? text.slice(0, 28) + "…" : text;
      // 颜色码:cache 灰 / 新合成 青 / 失败 红;不支持颜色的终端依然清晰
      const color = status === "cached" ? "\x1b[90m" : status === "synth" ? "\x1b[36m" : "\x1b[31m";
      console.log(`  ${color}[${String(seq).padStart(3)}/${totalLines}] s${stepIdx}:${lineIdx} ${sym} ${tag.padEnd(13)} ${String(durMs).padStart(5)}ms  "${preview}"\x1b[0m`);

      // 写盘:扩展名由内容嗅探(google → mp3,gemini → wav,mock 无音频)
      if (audioBytes && audioBytes.length > 0) {
        ext = sniffExt(audioBytes);
        const fileName = `${stepIdx}-${lineIdx}.${ext}`;
        const audioAbs = join(audioOutDir, fileName);
        await writeFile(audioAbs, audioBytes);
        haveAudio = true;
      }

      const gap = pauseAfter[lineIdx] ?? cli.defaultGapMs;
      cues.push({
        idx: lineIdx,
        text,
        ...(haveAudio ? { audio: `${cli.lang}/${stepIdx}-${lineIdx}.${ext}` } : {}),
        durMs,
        gapMs: gap,
      });
      totalMs += durMs + gap;
    }
    stepsOut.push({ stepIdx, lines: cues });
  }

  const manifest: Manifest = {
    storyId: story.id,
    lang: cli.lang,
    voice: `${cli.providerName}:${cli.voiceName ?? "default"}`,
    builtAt,
    totalMs,
    steps: stepsOut,
  };
  const manifestPath = join(storyOutDir, `${cli.lang}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  // 总结(per-line 日志在上面已经一条条打过了,这里只是收尾)
  const totalSec = (totalMs / 1000).toFixed(1);
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✓ done in ${wall}s · ${totalSec}s narration · ${synthed} synthed · ${cached} cached · ${failed} fallback`);
  console.log(`  → ${manifestPath}`);
}

// shim for tsx without `--allowJs`: copyFile re-export only to silence unused warn
void copyFile; void stat;

main().catch((e) => { console.error(e); process.exit(1); });
