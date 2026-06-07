// 块内对齐 —— 把整段块(synth-chunked)的句界找出来,回填 manifest 的 durMs/gapMs,
// 让字幕/分镜/SRT 的时间轴跟随真实整段音频。无 ML 依赖:静默检测 + 逐句先验约束搜索。
//
//   npx tsx scripts/voice/align-chunks.ts <storyId> --lang zh
//
// 原理:
//   - 块内句间是我们插入的 <#x#> 停顿标记(≥0.2s 纯静默),ffmpeg silencedetect 可见;
//   - 逐句层(synth.ts,同语速)给出每句时长的强先验(同模型同音色,偏差通常 <15%);
//   - 在先验位置 ±WINDOW 内找最近的检测静默 → 句界。任一句找不到 → 该 step 标记
//     fallback(母带改用逐句拼装),manifest 该步保持逐句时长 —— 视频永远能出。
//
// 产物:
//   - 覆写 client/public/voice/<storyId>/<lang>.json 的 durMs/gapMs(对齐后);
//   - <lang>-chunks.json 增补每块的 aligned/fallback 状态(master-audio --chunks 消费)。

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../../client/src/v2/walkthrough/voice/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const WINDOW_MS = 900;        // 先验句界 ± 搜索窗(逐界重锚后漂移不累积,窗可适度放宽)
const MIN_SIL_S = 0.15;       // silencedetect 最小静默时长(标记最短 0.2s)
const NOISE_DB = "-34dB";     // 静默阈值
const MAX_DRIFT_PCT = 35;     // 对齐句长 vs 先验的最大偏差(重锚后句界来自有序静默,误挑风险低;
                              // 整段在清单句会自加停顿,单句 30% 上下的伸缩是真实韵律,放行)

function arg(flag: string): string | undefined {
  const a = process.argv.slice(2); const i = a.indexOf(flag); return i >= 0 && a[i + 1] ? a[i + 1] : undefined;
}

type Silence = { start: number; end: number };

function detectSilences(file: string): Silence[] {
  // silencedetect 写 stderr;grep 无命中时 exit 1,`|| true` 兜住(无静默=空数组,上层自会回退)。
  const err = execFileSync(
    "sh", ["-c", `ffmpeg -i "${file}" -af silencedetect=noise=${NOISE_DB}:d=${MIN_SIL_S} -f null - 2>&1 | grep silence_ || true`],
  ).toString();
  const sil: Silence[] = [];
  let cur: Partial<Silence> = {};
  for (const line of err.split("\n")) {
    const ms = /silence_start: ([\d.]+)/.exec(line);
    const me = /silence_end: ([\d.]+)/.exec(line);
    if (ms) cur.start = parseFloat(ms[1]) * 1000;
    if (me && cur.start != null) { sil.push({ start: cur.start, end: parseFloat(me[1]) * 1000 }); cur = {}; }
  }
  return sil;
}

async function main() {
  const storyId = process.argv[2];
  if (!storyId) { console.error("usage: align-chunks.ts <storyId> [--lang zh]"); process.exit(2); }
  const lang = arg("--lang") ?? "zh";
  const voiceDir = resolve(repoRoot, `client/public/voice/${storyId}`);
  const manifest = JSON.parse(readFileSync(join(voiceDir, `${lang}.json`), "utf8")) as Manifest;
  const sidecarPath = join(voiceDir, `${lang}-chunks.json`);
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));

  let alignedSteps = 0, fallbackSteps = 0;
  for (const chunk of sidecar.chunks) {
    const step = manifest.steps.find((s: { stepIdx: number }) => s.stepIdx === chunk.stepIdx);
    if (!step) throw new Error(`manifest 缺 step ${chunk.stepIdx}`);
    if (step.lines.length !== chunk.lines) throw new Error(`step ${chunk.stepIdx} 句数不一致:manifest ${step.lines.length} vs chunk ${chunk.lines} —— 文案改了,先重跑 synth + synth-chunked`);

    if (chunk.lines === 1) {
      // 单句块:无需对齐,块时长即句长(gapMs 保留原 pauseAfter,步间距由母带拼装承担)。
      step.lines[0].durMs = chunk.durMs;
      chunk.aligned = true;
      alignedSteps++;
      continue;
    }

    const file = join(voiceDir, chunk.file);
    const silences = detectSilences(file);
    // 先验句界:逐句层 durMs 累加,但先按块整体速率缩放 —— 整段朗读速率 ≠ 逐句
    // (整段普遍更快),不缩放则长块尾部累积漂移必然出窗。
    // scale = (块实际语音时长) / (逐句先验语音时长);标记静默是绝对秒数,不参与缩放。
    const gapsSum = chunk.gapsMs.reduce((a: number, b: number) => a + b, 0);
    const priorSpeech = step.lines.reduce((a: number, l: { durMs: number }) => a + l.durMs, 0);
    const scale = (chunk.durMs - gapsSum) / priorSpeech;
    // 逐界寻找 + 逐界重锚:第 k+1 界的先验从「第 k 界实测终点」起算,而不是从块首
    // 全程累加 —— 整段朗读在清单型句子里会自加停顿,全局缩放压不住块内不均匀漂移,
    // 重锚后每界只需吸收"上一句自身"的预测误差(典型 <400ms)。
    const picked: Silence[] = [];
    let ok = true;
    let failWhy = "";
    let lastEnd = 0;
    let anchor = 0; // 当前句起点(上一界实测终点)
    for (let k = 0; k < chunk.lines - 1; k++) {
      const p = anchor + step.lines[k].durMs * scale + chunk.gapsMs[k] / 2; // 本界预期中点
      const cands = silences.filter((s) => {
        const mid = (s.start + s.end) / 2;
        return mid > lastEnd && Math.abs(mid - p) <= WINDOW_MS;
      });
      if (!cands.length) {
        ok = false;
        const near = silences.map((s) => Math.round((s.start + s.end) / 2 - p)).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
        failWhy = `句界${k + 1}/${chunk.lines - 1} 无候选(预期@${Math.round(p)}ms,最近静默偏 ${near ?? "∅"}ms,scale=${scale.toFixed(3)})`;
        break;
      }
      const best = cands.reduce((a, b) => (Math.abs((a.start + a.end) / 2 - p) <= Math.abs((b.start + b.end) / 2 - p) ? a : b));
      picked.push(best);
      lastEnd = best.end;
      anchor = best.end; // 重锚
    }
    if (ok) {
      // 回填:句 k 时长 = 静默 k 起点 − 上一静默终点;静默本身 = gap。
      let cursor = 0;
      const newDur: number[] = [];
      const newGap: number[] = [];
      for (let k = 0; k < picked.length; k++) {
        newDur.push(Math.round(picked[k].start - cursor));
        newGap.push(Math.round(picked[k].end - picked[k].start));
        cursor = picked[k].end;
      }
      newDur.push(Math.round(chunk.durMs - cursor)); // 末句到块尾
      // 漂移校验:对齐句长 vs 缩放后先验(速率差已归零,残差应是局部小波动)。
      for (let k = 0; k < newDur.length; k++) {
        const prior = step.lines[k].durMs * scale;
        const driftPct = Math.abs(newDur[k] - prior) / prior * 100;
        if (driftPct > MAX_DRIFT_PCT || newDur[k] < 300) {
          ok = false;
          failWhy = `句${k + 1} 时长漂移 ${driftPct.toFixed(0)}%(对齐 ${newDur[k]}ms vs 先验 ${Math.round(prior)}ms)`;
          break;
        }
      }
      if (ok) {
        step.lines.forEach((l: { durMs: number; gapMs: number }, k: number) => {
          l.durMs = newDur[k];
          if (k < newGap.length) l.gapMs = newGap[k]; // 末句 gapMs 保留(步间距)
        });
      }
    }
    chunk.aligned = ok;
    if (ok) alignedSteps++;
    else { fallbackSteps++; console.warn(`  ⚠ step ${chunk.stepIdx} 对齐失败 → 回退逐句拼装 · ${failWhy}`); }
  }

  manifest.builtAt = new Date().toISOString();
  (manifest as Manifest & { aligned?: string }).aligned = `chunks:${alignedSteps}/${sidecar.chunks.length}`;
  writeFileSync(join(voiceDir, `${lang}.json`), JSON.stringify(manifest, null, 2));
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
  const totalMs = manifest.steps.flatMap((s) => s.lines).reduce((t, l) => t + l.durMs + l.gapMs, 0);
  manifest.totalMs = totalMs;
  writeFileSync(join(voiceDir, `${lang}.json`), JSON.stringify(manifest, null, 2));
  console.log(`✓ 对齐 ${alignedSteps}/${sidecar.chunks.length} 步(回退 ${fallbackSteps})· 新总长 ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  manifest 已回填:${join(voiceDir, `${lang}.json`)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
