// 全 story 一次合成 + ffmpeg 静音切回逐句 —— 全程上下文,音色 / 语气一致。
//
// 为什么:Gemini TTS 是生成式,逐句独立合成会让相邻句语气 / 能量微漂。一次把整篇喂进去
//   合成,全程是同一条气口 → 不变音色。代价是出来一整条音频、没有逐句时间戳,所以这里用
//   ffmpeg 检测句间静音、再按静音把这条母带切回逐句 wav + 逐句时长,写成和逐句合成一样的
//   manifest(NarrationTrack / 字幕 / 时钟都不用改)。
//
// 用法:
//   npx tsx scripts/voice/synth-context.ts agent-loop --lang zh [--voice Kore]
//   切点不对时调静音检测:[--noise -38] [--minsil 0.25]
//
// 产物:
//   client/public/voice/<story>/<lang>.json          ← manifest(逐句)
//   client/public/voice/<story>/<lang>/<step>-<line>.wav
//   client/public/voice/<story>/<lang>/_master.wav   ← 整条母带(给你直接试听音色一致性)
//
// 兜底:检测到的句间静音 < 句数-1 → 不强切,保留母带 + 告警(让你调 --noise/--minsil 重试)。

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { STORIES } from "../../client/src/v2/walkthrough/stories";
import { pickLines } from "../../client/src/v2/walkthrough/i18n";
import type { Lang, Manifest, StepManifest, LineCue } from "../../client/src/v2/walkthrough/voice/types";
import { GeminiTTSProvider } from "./providers/gemini";

try { process.loadEnvFile(".env"); } catch { /* 走环境变量本身 */ }

// 整篇上下文的风格指令:同一把声、平稳一致,**句间停顿**(给静音切留出可检测的间隙),逐行逐字。
const CONTEXT_PREFIX: Record<Lang, string> = {
  zh: "你是一位中文女性教学老师。请从头到尾用同一把声音、完全一致而平稳的语气,朗读下面这一整段讲解。每两行之间明显停顿大约半秒再继续。逐行逐字朗读,不要解释、不要回答、不要加任何序号或多余的字:",
  en: "You are a female teacher. Read the whole passage below aloud in one and the same voice with a completely uniform, steady tone from start to finish. Pause clearly for about half a second between each line. Read every line verbatim; do not explain, answer, or add any numbering:",
};

function wrapPcmAsWav(pcm: Buffer, sampleRate: number): Buffer {
  const byteRate = (sampleRate * 16) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(byteRate, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// 解析 WAV → { sampleRate, pcm(16-bit mono) }。扫 chunk 找 data,稳妥。
function parseWav(wav: Buffer): { sampleRate: number; pcm: Buffer } {
  const sampleRate = wav.readUInt32LE(24);
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") return { sampleRate, pcm: wav.subarray(off + 8, off + 8 + size) };
    off += 8 + size;
  }
  return { sampleRate, pcm: wav.subarray(44) };
}

type Silence = { start: number; end: number; dur: number };
function detectSilences(wavPath: string, noiseDb: number, minSilS: number): Silence[] {
  // ffmpeg 把 silencedetect 结果写到 stderr,且 `-f null -` 成功(exit 0)。用 spawnSync
  // 直接读 stderr(成功 / 失败都拿得到),不能只在异常里读 —— 那样成功时 stderr 会丢。
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", wavPath, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilS}`, "-f", "null", "-"], { encoding: "utf8" });
  const stderr = (r.stderr ?? "") + (r.stdout ?? "");
  const sil: Silence[] = [];
  let curStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const ms = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const me = /silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/.exec(line);
    if (ms) curStart = Math.max(0, parseFloat(ms[1]));
    if (me) { const end = parseFloat(me[1]); const dur = parseFloat(me[2]); sil.push({ start: curStart ?? end - dur, end, dur }); curStart = null; }
  }
  return sil;
}

function arg(flag: string, def?: string): string | undefined {
  const a = process.argv.slice(2); const i = a.indexOf(flag); return i >= 0 && a[i + 1] ? a[i + 1] : def;
}

// 文本对齐切点:从候选静音时间 cand[] 里挑 |expect| 个,严格递增,使 Σ(选中 - 期望)² 最小。
// DP:dp[k] = 把候选 k 作为「当前这个边界」的最小代价;逐个边界推进,前缀最小值 O(B·M)。
function alignCuts(cand: number[], expect: number[]): number[] {
  const B = expect.length, M = cand.length;
  const INF = Infinity;
  const cost = Array.from({ length: B }, () => new Array<number>(M).fill(INF));
  const prev = Array.from({ length: B }, () => new Array<number>(M).fill(-1));
  for (let k = 0; k < M; k++) { const d = cand[k] - expect[0]; cost[0][k] = d * d; }
  for (let i = 1; i < B; i++) {
    let bestPrev = INF, bestIdx = -1;
    for (let k = 0; k < M; k++) {
      // 边界 i 必须用比 i-1 更靠后的候选 → 维护「k 之前的 dp[i-1] 最小值」
      if (cost[i - 1][k - 1] !== undefined && k - 1 >= 0 && cost[i - 1][k - 1] < bestPrev) { bestPrev = cost[i - 1][k - 1]; bestIdx = k - 1; }
      if (bestPrev === INF) continue;
      const d = cand[k] - expect[i];
      cost[i][k] = bestPrev + d * d;
      prev[i][k] = bestIdx;
    }
  }
  // 末行取最小,回溯
  let endK = -1, best = INF;
  for (let k = 0; k < M; k++) if (cost[B - 1][k] < best) { best = cost[B - 1][k]; endK = k; }
  const idx = new Array<number>(B);
  for (let i = B - 1, k = endK; i >= 0; i--) { idx[i] = k; k = prev[i][k]; }
  return idx.map((k) => cand[k]);
}

async function main() {
  const storyId = process.argv[2];
  const story = STORIES[storyId];
  if (!story) { console.error(`unknown storyId: ${storyId}`); process.exit(2); }
  const lang = (arg("--lang", "zh") as Lang);
  const voiceName = arg("--voice");
  const noiseDb = parseFloat(arg("--noise", "-30")!);
  const minSilS = parseFloat(arg("--minsil", "0.4")!);
  const reuse = process.argv.includes("--reuse"); // 复用已有母带,不重新调 API

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error("GEMINI_API_KEY required in .env"); process.exit(2); }

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "../..");
  const outDir = resolve(repoRoot, arg("--out", "client/public/voice")!);
  const storyOutDir = join(outDir, story.id);
  const audioOutDir = join(storyOutDir, lang);
  await mkdir(audioOutDir, { recursive: true });

  // 1) 拍平所有行(带 step/line 下标),拼成整篇(行间换行,诱导停顿)。
  const flat: { stepIdx: number; lineIdx: number; text: string }[] = [];
  story.steps.forEach((step, stepIdx) => pickLines(step, lang).forEach((text, lineIdx) => flat.push({ stepIdx, lineIdx, text })));
  const N = flat.length;
  const joined = flat.map((l) => l.text).join("\n");
  console.log(`⟳ ${story.id}/${lang} · 整篇一次合成 · ${N} 行 · voice=${voiceName ?? "Kore"}`);

  // 2) 母带:--reuse 复用已存在的 _master.wav(调切点时不重复烧 API),否则 Gemini 一次合成。
  const masterPath = join(audioOutDir, "_master.wav");
  let masterWav: Buffer;
  if (reuse && existsSync(masterPath)) {
    masterWav = await readFile(masterPath);
    console.log(`  复用母带:${masterPath}`);
  } else {
    const provider = new GeminiTTSProvider({ apiKey, voiceName, stylePrefix: CONTEXT_PREFIX[lang] });
    const master = await provider.synth({ text: joined, lang });
    masterWav = master.audio;
    await writeFile(masterPath, masterWav);
  }
  const { sampleRate, pcm } = parseWav(masterWav);
  const masterSec = pcm.length / (sampleRate * 2);
  console.log(`  母带:${masterSec.toFixed(1)}s · ${sampleRate}Hz`);

  // 3) ffmpeg 检测静音(阈值放宽,宁可多检 —— 多余的句内停顿由下一步按文本对齐自动跳过)。
  const silences = detectSilences(masterPath, noiseDb, minSilS);
  console.log(`  silencedetect(noise=${noiseDb}dB d=${minSilS}s):候选静音 ${silences.length} 段,需 ${N - 1} 个切点`);
  if (silences.length < N - 1) {
    console.warn(`  ⚠️ 候选(${silences.length}) < 切点(${N - 1}):整篇没断够。保留母带,不强切。\n` +
      `     调小 --minsil(如 0.3)或调高 --noise(如 -28)再跑 --reuse。`);
    await writeFallbackManifest(story, lang, flat, masterSec, storyOutDir, voiceName);
    return;
  }

  // 4) 按文本对齐选切点:候选静音里挑 N-1 个,使每个边界尽量贴近「按字数比例的期望累计时间」。
  //    DP 保证切点严格递增,且把多余的句内停顿(——/……/冒号)自动跳过 —— 比「取最长 N-1 段」稳。
  const cand = silences.map((s) => (s.start + s.end) / 2); // 切在静音中点:每句保留前后一点呼吸
  const charLens = flat.map((l) => Math.max(1, l.text.replace(/\s/g, "").length));
  const totalChars = charLens.reduce((a, b) => a + b, 0);
  let cum = 0;
  const expect: number[] = []; // expect[i] = 第 i 句之后边界的期望时间(i=0..N-2)
  for (let i = 0; i < N - 1; i++) { cum += charLens[i]; expect.push((cum / totalChars) * masterSec); }
  const cutMid = alignCuts(cand, expect);
  const bounds = [0, ...cutMid, masterSec];

  // 5) 按边界在 Node 里切 PCM(采样精确),写逐句 wav + 逐句时长(durMs=整段含尾随静音,gapMs=0)。
  const stepsMap = new Map<number, LineCue[]>();
  let totalMs = 0;
  for (let i = 0; i < N; i++) {
    const segS = bounds[i], segE = bounds[i + 1];
    const a = Math.round(segS * sampleRate) * 2, b = Math.round(segE * sampleRate) * 2;
    const segPcm = pcm.subarray(a, Math.min(b, pcm.length));
    const fileName = `${flat[i].stepIdx}-${flat[i].lineIdx}.wav`;
    await writeFile(join(audioOutDir, fileName), wrapPcmAsWav(segPcm, sampleRate));
    const durMs = Math.round((segE - segS) * 1000);
    totalMs += durMs;
    if (!stepsMap.has(flat[i].stepIdx)) stepsMap.set(flat[i].stepIdx, []);
    stepsMap.get(flat[i].stepIdx)!.push({ idx: flat[i].lineIdx, text: flat[i].text, audio: `${lang}/${fileName}`, durMs, gapMs: 0 });
    console.log(`  [${String(i + 1).padStart(2)}/${N}] s${flat[i].stepIdx}:${flat[i].lineIdx}  ${String(durMs).padStart(5)}ms  "${flat[i].text.slice(0, 22)}…"`);
  }

  const steps: StepManifest[] = [...stepsMap.entries()].sort((a, b) => a[0] - b[0]).map(([stepIdx, lines]) => ({ stepIdx, lines }));
  const manifest: Manifest = {
    storyId: story.id, lang, voice: `gemini-context:${voiceName ?? "Kore"}`,
    builtAt: new Date().toISOString(), totalMs, steps,
  };
  const manifestPath = join(storyOutDir, `${lang}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n✓ 切回 ${N} 句 · 总 ${(totalMs / 1000).toFixed(1)}s · 母带 ${masterSec.toFixed(1)}s\n  → ${manifestPath}`);
}

// 兜底:切点不够时,仍产出 manifest(逐句无独立音频、durMs 按字数估算),不卡流程。
async function writeFallbackManifest(
  story: typeof STORIES[string], lang: Lang, flat: { stepIdx: number; lineIdx: number; text: string }[],
  _masterSec: number, storyOutDir: string, voiceName?: string,
) {
  const stepsMap = new Map<number, LineCue[]>();
  let totalMs = 0;
  for (const l of flat) {
    const durMs = Math.max(700, Math.round(l.text.length * 180)); // 粗估
    totalMs += durMs + 200;
    if (!stepsMap.has(l.stepIdx)) stepsMap.set(l.stepIdx, []);
    stepsMap.get(l.stepIdx)!.push({ idx: l.lineIdx, text: l.text, durMs, gapMs: 200 });
  }
  const steps = [...stepsMap.entries()].sort((a, b) => a[0] - b[0]).map(([stepIdx, lines]) => ({ stepIdx, lines }));
  const manifest: Manifest = { storyId: story.id, lang, voice: `gemini-context:${voiceName ?? "Kore"}:FALLBACK`, builtAt: new Date().toISOString(), totalMs, steps };
  await writeFile(join(storyOutDir, `${lang}.json`), JSON.stringify(manifest, null, 2));
  console.log(`  → 已写兜底 manifest(无逐句音频)。母带在 <lang>/_master.wav,可先听音色。`);
}

main().catch((e) => { console.error(e); process.exit(1); });
