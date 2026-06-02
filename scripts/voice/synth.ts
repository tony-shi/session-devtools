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
import type { Lang, LineCue, Manifest, StepManifest } from "../../client/src/v2/walkthrough/voice/types";
import type { TTSProvider } from "./providers/types";
import { MockProvider } from "./providers/mock";

interface Cli {
  storyId: string;
  lang: Lang;
  providerName: "mock" | "minimax" | "elevenlabs";
  gapMs: number;
  outDir: string;
  cacheDir: string;
}

function parseArgs(): Cli {
  const args = process.argv.slice(2);
  const storyId = args[0];
  if (!storyId) {
    console.error("usage: synth.ts <storyId> [--lang zh|en] [--provider mock|minimax|elevenlabs] [--gap 300] [--out <dir>]");
    process.exit(2);
  }
  const get = (flag: string, def: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const lang = get("--lang", "zh") as Lang;
  if (lang !== "zh" && lang !== "en") { console.error("--lang must be zh or en"); process.exit(2); }
  const providerName = get("--provider", "mock") as Cli["providerName"];
  if (!["mock", "minimax", "elevenlabs"].includes(providerName)) {
    console.error("--provider must be mock | minimax | elevenlabs");
    process.exit(2);
  }
  const gapMs = parseInt(get("--gap", "300"), 10);

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const outDir = resolve(repoRoot, get("--out", "client/public/voice"));
  const cacheDir = resolve(repoRoot, ".cache/voice");
  return { storyId, lang, providerName, gapMs, outDir, cacheDir };
}

function buildProvider(name: Cli["providerName"]): TTSProvider {
  if (name === "mock") return new MockProvider();
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

  const provider = buildProvider(cli.providerName);
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
    for (const [lineIdx, text] of lines.entries()) {
      const key = hashKey(text, `${cli.providerName}:${cli.lang}`, cli.lang);
      const fileName = `${stepIdx}-${lineIdx}.mp3`;
      const audioRel = `${cli.lang}/${fileName}`;
      const audioAbs = join(audioOutDir, fileName);

      let durMs = 0;
      let haveAudio = false;
      try {
        const hit = await readCache(cli.cacheDir, key);
        if (hit) {
          if (hit.audio.length > 0) await writeFile(audioAbs, hit.audio);
          durMs = hit.durMs;
          haveAudio = hit.audio.length > 0;
          cached += 1;
        } else {
          const res = await provider.synth({ text, lang: cli.lang });
          durMs = res.durMs;
          if (res.audio.length > 0) {
            await writeFile(audioAbs, res.audio);
            haveAudio = true;
          }
          await writeCache(cli.cacheDir, key, res.audio, durMs);
          synthed += 1;
        }
      } catch (e) {
        // 单句失败:回退到 mock 估算,manifest 仍产出
        failed += 1;
        const mockRes = await new MockProvider().synth({ text, lang: cli.lang });
        durMs = mockRes.durMs;
        if (mockRes.audio.length > 0) {
          await writeFile(audioAbs, mockRes.audio);
          haveAudio = true;
        }
        console.warn(`  [${stepIdx}-${lineIdx}] synth failed, fell back to mock: ${(e as Error).message}`);
      }

      cues.push({
        idx: lineIdx,
        text,
        ...(haveAudio ? { audio: audioRel } : {}),
        durMs,
        gapMs: cli.gapMs,
      });
      totalMs += durMs + cli.gapMs;
    }
    stepsOut.push({ stepIdx, lines: cues });
  }

  const manifest: Manifest = {
    storyId: story.id,
    lang: cli.lang,
    voice: `${cli.providerName}:default`,
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
