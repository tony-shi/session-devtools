// 整段成块合成 —— 出片音质层(用户 A/B 定稿 2026-06-07:整段方式)。
//
// 架构:一个 step(语义段落)= 一次 MiniMax 调用,句间 PACE 节拍以 <#秒#> 停顿标记编入
//   → 块内韵律一条弧(整段感的来源);步与步之间在母带拼装时按末句 pauseAfter 留间隔
//   (步界=话题切换,韵律重置自然)。逐句层(synth.ts)保留:studio 预览 + 对齐先验。
//
//   npx tsx scripts/voice/synth-chunked.ts <storyId> --lang zh [--speed 1.242]
//   产物:client/public/voice/<storyId>/<lang>-chunks/step-<i>.mp3
//        client/public/voice/<storyId>/<lang>-chunks.json(sidecar:块时长/文本哈希)
//
// 缓存:hash(块全文+音色签名+"chunk")→ .cache/voice;改一个 step 只重合成该块。

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { STORIES } from "../../client/src/v2/walkthrough/stories";
import { pickLines } from "../../client/src/v2/walkthrough/i18n";
import { PACE } from "../../client/src/v2/walkthrough/pace";
import type { Lang } from "../../client/src/v2/walkthrough/voice/types";
import { MiniMaxProvider } from "./providers/minimax";
import { resolveMinimaxVoice } from "./synth";

try { process.loadEnvFile(".env"); } catch { /* env 直读 */ }

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function arg(flag: string): string | undefined {
  const a = process.argv.slice(2); const i = a.indexOf(flag); return i >= 0 && a[i + 1] ? a[i + 1] : undefined;
}

export type ChunkInfo = {
  stepIdx: number;
  file: string;        // 相对 voice/<storyId>/ 的路径
  durMs: number;       // ffprobe 实测
  lines: number;       // 句数(对齐校验用)
  gapsMs: number[];    // 句间标记秒数(ms;长度 = lines-1,对齐时的预期静默)
  textHash: string;    // 块文本指纹(漂移检测)
};

async function main() {
  const storyId = process.argv[2];
  if (!storyId) { console.error("usage: synth-chunked.ts <storyId> [--lang zh] [--speed N]"); process.exit(2); }
  const lang = (arg("--lang") ?? "zh") as Lang;
  const speed = arg("--speed") ? parseFloat(arg("--speed")!) : undefined;
  const story = STORIES[storyId];
  if (!story) { console.error(`unknown storyId: ${storyId}`); process.exit(2); }

  const v = resolveMinimaxVoice(lang, undefined, speed);
  const provider = new MiniMaxProvider({
    apiKey: process.env.MINIMAX_API_KEY!,
    groupId: process.env.MINIMAX_GROUP_ID!,
    host: process.env.MINIMAX_API_HOST,
    model: process.env.MINIMAX_MODEL,
    voiceId: v.voiceId,
    speed: v.speed,
    emotion: process.env.MINIMAX_EMOTION,
    timberWeights: v.timberWeights,
  });

  const voiceDir = resolve(repoRoot, `client/public/voice/${storyId}`);
  const chunkDir = join(voiceDir, `${lang}-chunks`);
  const cacheDir = resolve(repoRoot, ".cache/voice");
  await mkdir(chunkDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  const chunks: ChunkInfo[] = [];
  let synthed = 0, cached = 0;
  for (const [stepIdx, step] of story.steps.entries()) {
    const lines = pickLines(step, lang);
    const pauses = step.pauseAfter ?? [];
    // 句间标记 = 该句 pauseAfter(末句的 pauseAfter 不进块,留给母带步间拼装)。
    const gapsMs = lines.slice(0, -1).map((_, i) => pauses[i] ?? PACE.beat);
    const text = lines
      .map((l, i) => (i < lines.length - 1 ? `${l} <#${(gapsMs[i] / 1000).toFixed(2)}#>` : l))
      .join(" ");
    const textHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const key = createHash("sha256").update(`chunk|${v.sig}|${lang}|${text}`).digest("hex").slice(0, 16);
    const fileName = `step-${stepIdx}.mp3`;
    const fileAbs = join(chunkDir, fileName);

    const cacheMp3 = join(cacheDir, `${key}.mp3`);
    let audio: Buffer;
    if (existsSync(cacheMp3)) {
      audio = await readFile(cacheMp3);
      cached++;
      console.log(`  [s${stepIdx}] ● cached  ${lines.length} 句`);
    } else {
      const res = await provider.synth({ text, lang });
      audio = res.audio;
      await writeFile(cacheMp3, audio);
      synthed++;
      console.log(`  [s${stepIdx}] → synth   ${lines.length} 句 · ${(res.durMs / 1000).toFixed(1)}s`);
    }
    await writeFile(fileAbs, audio);
    const durMs = Math.round(parseFloat(
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", fileAbs]).toString(),
    ) * 1000);
    chunks.push({ stepIdx, file: `${lang}-chunks/${fileName}`, durMs, lines: lines.length, gapsMs, textHash });
  }

  const sidecar = { storyId, lang, voice: v.sig, builtAt: new Date().toISOString(), chunks };
  await writeFile(join(voiceDir, `${lang}-chunks.json`), JSON.stringify(sidecar, null, 2));
  const total = chunks.reduce((s, c) => s + c.durMs, 0);
  console.log(`✓ ${chunks.length} chunks · ${(total / 1000).toFixed(1)}s 语音 · ${synthed} synthed · ${cached} cached`);
  console.log(`  → ${join(voiceDir, `${lang}-chunks.json`)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
