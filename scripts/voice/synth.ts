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
  // 命令行 --gap 仅在 step.pauseAfter[i] 缺省时生效。默认走 PACE.beat,语义对齐 pace.ts。
  const defaultGapMs = parseInt(get("--gap", String(PACE.beat)), 10);

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const outDir = resolve(repoRoot, get("--out", "client/public/voice"));
  const cacheDir = resolve(repoRoot, ".cache/voice");
  return { storyId, lang, providerName, voiceName, defaultGapMs, outDir, cacheDir };
}

function buildProvider(name: Cli["providerName"], voiceName?: string): TTSProvider {
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
    throw new Error("minimax provider stub — see scripts/voice/providers/minimax.ts");
  }
  if (name === "elevenlabs") {
    throw new Error("elevenlabs provider stub — see scripts/voice/providers/elevenlabs.ts");
  }
  throw new Error("unknown provider: " + name);
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

  const provider = buildProvider(cli.providerName, cli.voiceName);
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

  for (const [stepIdx, step] of story.steps.entries()) {
    const lines = pickLines(step, cli.lang);
    const cues: LineCue[] = [];
    // 节奏:每一行的"句末留白"。优先级 step.pauseAfter[i] → --gap → PACE.beat。
    // pauseAfter 跨语言共用 —— 节拍点是语义,不该因为中英换译就改。
    const pauseAfter = step.pauseAfter ?? [];
    for (const [lineIdx, text] of lines.entries()) {
      // voice 也参与 hash —— 换 voice 必须重合成,否则放错音
      const key = hashKey(text, `${cli.providerName}:${cli.voiceName ?? "default"}:${cli.lang}`, cli.lang);

      let durMs = 0;
      let haveAudio = false;
      let ext: "mp3" | "wav" = "mp3";
      let audioBytes: Buffer | null = null;
      try {
        const hit = await readCache(cli.cacheDir, key);
        if (hit) {
          audioBytes = hit.audio;
          durMs = hit.durMs;
          cached += 1;
        } else {
          const res = await provider.synth({ text, lang: cli.lang });
          audioBytes = res.audio;
          durMs = res.durMs;
          await writeCache(cli.cacheDir, key, res.audio, durMs);
          synthed += 1;
        }
      } catch (e) {
        // 单句失败:回退到 mock 估算,manifest 仍产出
        failed += 1;
        const mockRes = await new MockProvider().synth({ text, lang: cli.lang });
        audioBytes = mockRes.audio;
        durMs = mockRes.durMs;
        console.warn(`  [${stepIdx}-${lineIdx}] synth failed, fell back to mock: ${(e as Error).message}`);
      }

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

  // 友好报表
  const totalSec = (totalMs / 1000).toFixed(1);
  console.log(`✓ ${story.id} / ${cli.lang}`);
  console.log(`  ${stepsOut.reduce((n, s) => n + s.lines.length, 0)} lines · ${totalSec}s total`);
  console.log(`  ${synthed} synthed · ${cached} cached · ${failed} fallback`);
  console.log(`  → ${manifestPath}`);
}

// shim for tsx without `--allowJs`: copyFile re-export only to silence unused warn
void copyFile; void stat;

main().catch((e) => { console.error(e); process.exit(1); });
