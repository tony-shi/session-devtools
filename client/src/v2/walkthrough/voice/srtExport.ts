// 从音轨清单生成 SRT 字幕文件。
//
// 用途:
//   - 录屏者:把字幕做成单独轨道传到 YouTube / B 站,不烧死在视频里
//   - 配音师:打印纸质提词时也是 SRT(很多软件都支持)
//   - 校对:对照看每一句的时间分配是否合理
//
// 时间戳逻辑:每一拍 (durMs + gapMs) 累加。gapMs 计入"上一句还未离开的余音",
// 字幕的下沿落在 durMs 结束、gap 之前 —— 观众读完同时音也停。

import type { Manifest } from "./types";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function ms2srt(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(r, 3)}`;
}

export function manifestToSrt(m: Manifest): string {
  const out: string[] = [];
  let cursor = 0;
  let idx = 1;
  for (const step of m.steps) {
    for (const line of step.lines) {
      const start = cursor;
      const end = cursor + line.durMs;       // 字幕在 durMs 结束时退场
      out.push(`${idx}`);
      out.push(`${ms2srt(start)} --> ${ms2srt(end)}`);
      out.push(line.text);
      out.push("");
      idx += 1;
      cursor = end + line.gapMs;             // gap 后下一句开始
    }
  }
  return out.join("\n");
}
