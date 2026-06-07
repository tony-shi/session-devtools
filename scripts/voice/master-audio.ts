// 终态母带音轨 —— 把逐句 mp3 按 manifest 时间轴精确拼装成「一条完整音频」,整条响度归一后外挂。
//
//   npx tsx scripts/voice/master-audio.ts <storyId> --lang zh
//   输出:client/public/voice/<storyId>/<lang>-master.m4a
//
// 设计(两层音频架构的"出片层"):
//   - 预览/调试 = 逐句 <Audio>(秒级增量迭代,见 NarrationTrack);
//   - 出片 = 本脚本产物单轨外挂(Episode 的 audioMaster prop)。
//   - 每句用 adelay 钉在 manifest 的累计起点上(不是首尾相接!)—— mp3 实际时长普遍比
//     durMs 短 ~70ms(编码头部),首尾相接会逐句累积漂移;按绝对位置摆放与 Remotion
//     <Sequence> 行为完全一致,字幕/分镜零漂移。
//   - 整条 loudnorm(EBU R128):消除逐句合成的响度波动 —— 这是单轨相对分段挂载的实际增益。
//   - 时长校验:产物时长必须 ≈ manifest totalMs(±0.2s),不对就 fail-fast。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../../client/src/v2/walkthrough/voice/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

function arg(flag: string, def: string): string {
  const a = process.argv.slice(2); const i = a.indexOf(flag); return i >= 0 && a[i + 1] ? a[i + 1] : def;
}

async function main() {
  const storyId = process.argv[2];
  if (!storyId) { console.error("usage: master-audio.ts <storyId> [--lang zh] [--chunks]"); process.exit(2); }
  const lang = arg("--lang", "zh");
  const useChunks = process.argv.includes("--chunks");
  const voiceDir = resolve(repoRoot, `client/public/voice/${storyId}`);
  const m = JSON.parse(readFileSync(join(voiceDir, `${lang}.json`), "utf8")) as Manifest;

  // 音源的绝对起点(ms)= durMs+gapMs 累计 —— 与 narration.ts buildNarrationClips 同口径。
  // --chunks:对齐成功的 step 整块挂载(整段韵律,出片首选);失败步回退逐句。
  const clips: { path: string; startMs: number }[] = [];
  let cursor = 0;
  let missing = 0;
  const chunkByStep = new Map<number, { file: string; aligned: boolean }>();
  if (useChunks) {
    const sidecar = JSON.parse(readFileSync(join(voiceDir, `${lang}-chunks.json`), "utf8"));
    for (const c of sidecar.chunks) chunkByStep.set(c.stepIdx, { file: c.file, aligned: !!c.aligned });
  }
  for (const step of m.steps) {
    const chunk = useChunks ? chunkByStep.get(step.stepIdx) : undefined;
    if (chunk?.aligned) {
      clips.push({ path: join(voiceDir, chunk.file), startMs: cursor });
      for (const line of step.lines) cursor += line.durMs + line.gapMs;
      continue;
    }
    for (const line of step.lines) {
      if (line.audio) clips.push({ path: join(voiceDir, line.audio), startMs: cursor });
      else missing++;
      cursor += line.durMs + line.gapMs;
    }
  }
  if (missing > 0) throw new Error(`manifest 有 ${missing} 句缺音频(mock/fallback?)—— 先跑真 TTS 再出母带`);
  // fallback 句也会写出占位 mp3(数 KB 静音),manifest 看不出来 —— 按文件大小兜底拦截。
  // 实测最短真句(~2s MiniMax 128kbps)≈ 30KB,占位 stub ≤ 9KB,阈值 12KB 安全。
  const stubs = clips.filter((c) => statSync(c.path).size < 12 * 1024);
  if (stubs.length > 0) {
    throw new Error(`检测到 ${stubs.length} 个疑似占位音频(<12KB,如 ${stubs[0].path.split("/").pop()})—— 多半是合成 fallback(余额/限流),重跑 synth 后再出母带`);
  }
  const totalMs = cursor;

  // filter_complex 写临时文件(67 路输入,命令行长度稳妥)。
  // 每路:重采样到 44.1k 立体声 → adelay 钉位;amix 不归一(normalize=0)再整条 loudnorm。
  const lines: string[] = [];
  const mixIns: string[] = [];
  clips.forEach((c, i) => {
    lines.push(`[${i}:a]aresample=44100,aformat=channel_layouts=stereo,adelay=${c.startMs}|${c.startMs}[a${i}]`);
    mixIns.push(`[a${i}]`);
  });
  lines.push(`${mixIns.join("")}amix=inputs=${clips.length}:normalize=0,apad,atrim=duration=${(totalMs / 1000).toFixed(3)},loudnorm=I=-16:TP=-1.5:LRA=11[out]`);
  const tmp = mkdtempSync(join(tmpdir(), "master-audio-"));
  const filterFile = join(tmp, "filter.txt");
  writeFileSync(filterFile, lines.join(";\n"));

  const outPath = join(voiceDir, `${lang}-master.m4a`);
  const args = [
    "-y",
    ...clips.flatMap((c) => ["-i", c.path]),
    "-filter_complex_script", filterFile,
    "-map", "[out]",
    "-c:a", "aac", "-b:a", "192k",
    outPath,
  ];
  console.log(`⟳ ${storyId}/${lang} · ${clips.length} clips${useChunks ? "(chunked)" : ""} → master(${(totalMs / 1000).toFixed(1)}s)…`);
  execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  rmSync(tmp, { recursive: true, force: true });

  // fail-fast 校验:母带时长 ≈ manifest 总长。
  const probed = parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outPath]).toString(),
  );
  const diff = Math.abs(probed * 1000 - totalMs);
  if (diff > 200) throw new Error(`母带时长偏差 ${diff.toFixed(0)}ms(>200ms):${probed.toFixed(2)}s vs manifest ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`✓ ${outPath}`);
  console.log(`  时长 ${probed.toFixed(2)}s(manifest ${(totalMs / 1000).toFixed(2)}s,偏差 ${diff.toFixed(0)}ms)· loudnorm I=-16`);
}

main().catch((e) => { console.error(e); process.exit(1); });
