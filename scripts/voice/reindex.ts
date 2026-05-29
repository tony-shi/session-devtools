// 从已有音频文件重建 manifest —— 不调任何 API。
//
// 用途:audio 文件已就绪(比如之前 gemini 合成过),但 manifest 丢了/被覆盖。
// 扫描 client/public/voice/<story>/<lang>/<step>-<line>.{wav,mp3},读真实时长,
// 配上 story 的文案 + pauseAfter,写回 manifest。
//
//   npx tsx scripts/voice/reindex.ts agent-loop --lang zh
//
// WAV 时长从 canonical 44-byte header 精确算;MP3 从字节数估算(~5%)。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STORIES } from "../../client/src/v2/walkthrough/stories";
import { pickLines } from "../../client/src/v2/walkthrough/i18n";
import { PACE } from "../../client/src/v2/walkthrough/pace";
import type { Lang, LineCue, Manifest, StepManifest } from "../../client/src/v2/walkthrough/voice/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function parse() {
  const args = process.argv.slice(2);
  const storyId = args[0];
  if (!storyId) { console.error("usage: reindex.ts <storyId> [--lang zh|en]"); process.exit(2); }
  const li = args.indexOf("--lang");
  const lang = (li >= 0 ? args[li + 1] : "zh") as Lang;
  return { storyId, lang };
}

// canonical PCM WAV:byteRate@28,dataSize@40 → duration = dataSize / byteRate
function wavDurationMs(buf: Buffer): number {
  const byteRate = buf.readUInt32LE(28);
  const dataSize = buf.readUInt32LE(40);
  if (!byteRate) return 0;
  return Math.round((dataSize / byteRate) * 1000);
}
// mp3 ~24kbps 估算
function mp3DurationMs(buf: Buffer): number {
  return Math.round((Math.max(0, buf.length - 256) * 8) / 24000 * 1000);
}

async function main() {
  const { storyId, lang } = parse();
  const story = STORIES[storyId];
  if (!story) { console.error(`unknown storyId: ${storyId}`); process.exit(2); }

  const storyDir = resolve(repoRoot, "client/public/voice", story.id);
  const audioDir = join(storyDir, lang);
  await mkdir(storyDir, { recursive: true });

  const steps: StepManifest[] = [];
  let totalMs = 0;
  let found = 0, missing = 0;

  for (const [stepIdx, step] of story.steps.entries()) {
    const lines = pickLines(step, lang);
    const pauseAfter = step.pauseAfter ?? [];
    const cues: LineCue[] = [];
    for (const [lineIdx, text] of lines.entries()) {
      const wav = join(audioDir, `${stepIdx}-${lineIdx}.wav`);
      const mp3 = join(audioDir, `${stepIdx}-${lineIdx}.mp3`);
      let durMs = 0;
      let audio: string | undefined;
      if (existsSync(wav)) {
        durMs = wavDurationMs(await readFile(wav));
        audio = `${lang}/${stepIdx}-${lineIdx}.wav`;
        found++;
      } else if (existsSync(mp3)) {
        durMs = mp3DurationMs(await readFile(mp3));
        audio = `${lang}/${stepIdx}-${lineIdx}.mp3`;
        found++;
      } else {
        // 没找到音频:给个保守估算,manifest 仍可用(播放器会走纯计时)
        durMs = Math.max(800, Math.round([...text].length * 180));
        missing++;
        console.warn(`  s${stepIdx}:${lineIdx} no audio file → estimated ${durMs}ms`);
      }
      const gap = pauseAfter[lineIdx] ?? PACE.beat;
      cues.push({ idx: lineIdx, text, ...(audio ? { audio } : {}), durMs, gapMs: gap });
      totalMs += durMs + gap;
    }
    steps.push({ stepIdx, lines: cues });
  }

  const manifest: Manifest = {
    storyId: story.id,
    lang,
    voice: "reindexed:from-existing-audio",
    builtAt: new Date().toISOString(),
    totalMs,
    steps,
  };
  const out = join(storyDir, `${lang}.json`);
  await writeFile(out, JSON.stringify(manifest, null, 2));
  console.log(`✓ reindex ${story.id}/${lang} · ${found} audio · ${missing} missing · ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  → ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
