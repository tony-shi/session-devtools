// 从 voice manifest 导出 SRT 外挂字幕 —— 时间轴与视频内的 NarrationCaption 完全一致
// (复用 client 的 manifestToSrt,durMs+gapMs 累加)。
//
//   npx tsx scripts/voice/export-srt.ts [storyId] [langs]
//   例:npx tsx scripts/voice/export-srt.ts agent-loop zh,en
//   输出:out/<storyId>-<lang>.srt

import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestToSrt } from "../../client/src/v2/walkthrough/voice/srtExport";
import type { Manifest } from "../../client/src/v2/walkthrough/voice/types";
import { toDisplayText } from "../../client/src/studio/scenes/displayText";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

async function main() {
  const storyId = process.argv[2] ?? "agent-loop";
  const langs = (process.argv[3] ?? "zh,en").split(",").map((s) => s.trim()).filter(Boolean);
  await mkdir(resolve(repoRoot, "out"), { recursive: true });
  for (const lang of langs) {
    const manifestPath = resolve(repoRoot, `client/public/voice/${storyId}/${lang}.json`);
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    // 显示替换:manifest 文本是 TTS 读法(「Claude 点 M D」),SRT 显示书面形式(CLAUDE.md)。
    for (const step of m.steps) for (const line of step.lines) line.text = toDisplayText(line.text);
    const srt = manifestToSrt(m);
    const outPath = resolve(repoRoot, `out/${storyId}-${lang}.srt`);
    await writeFile(outPath, srt);
    const cues = srt.split("\n\n").filter(Boolean).length;
    console.log(`✓ ${lang}: ${cues} cues → out/${storyId}-${lang}.srt`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
