// 甘特断轴（broken axis）—— 纯函数，无 React。
//
// 背景：resume 后的 run 含上一轮（cached/superseded 来源）与本轮的 agent，
// 两簇墙钟之间隔着小时级空窗。设计决策（05 文档 §9/§10）：忠实墙钟全量绘制，
// gap 本身就是事实；超阈值空窗用断轴压缩并标注真实时长——断轴是标准手法，
// 不是篡改事实。
//
// 规则：所有 agent 区间并集之外、长度 > BREAK_THRESHOLD_MS 的空窗压缩为
// 固定显示宽度。阈值 5 分钟：单次执行内 agent 并行/串行衔接是秒级，5 分钟
// 全静默只会出现在跨物理执行的 gap（实测 4.4h）。

export const BREAK_THRESHOLD_MS = 5 * 60_000;
// 每个断轴在显示轴上的宽度 = 非空窗时长的 5%（窄带，可见但不喧宾夺主）
const BREAK_DISPLAY_RATIO = 0.05;

export interface AxisBreak {
  /** 断轴带在显示轴上的起点（显示单位，与 mapMs 同坐标系）。 */
  atDisplay: number;
  /** 断轴带在显示轴上的宽度。 */
  displayLen: number;
  /** 被压缩的真实空窗时长（ms），用于标注。 */
  gapMs: number;
}

export interface BrokenAxis {
  /** 真实 epoch ms → 显示坐标（0 起）。仅对 [minStart, maxEnd] 内的值有意义。 */
  mapMs: (t: number) => number;
  /** 显示轴总长（显示单位）。恒 > 0。 */
  displayTotal: number;
  breaks: AxisBreak[];
}

/**
 * intervals: 各 agent 的 [startMs, endMs]（无序、可重叠）。空数组非法（调用方守卫）。
 * 返回分段线性映射：大空窗压缩为 breakLen，其余按真实时间等比。
 */
export function buildBrokenAxis(intervals: Array<[number, number]>): BrokenAxis {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  // 区间并集 → coverage 段
  const coverage: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = coverage[coverage.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else coverage.push([s, e]);
  }

  const minStart = coverage[0][0];
  const maxEnd = coverage[coverage.length - 1][1];

  // coverage 段之间超阈值的空窗 = 断轴；小空窗保留为真实时间（phase 衔接的
  // 秒级间隙本身有信息量，不压缩）。
  const gaps: Array<{ start: number; end: number }> = [];
  for (let i = 1; i < coverage.length; i++) {
    const gap = coverage[i][0] - coverage[i - 1][1];
    if (gap > BREAK_THRESHOLD_MS) gaps.push({ start: coverage[i - 1][1], end: coverage[i][0] });
  }

  const totalGapMs = gaps.reduce((s, g) => s + (g.end - g.start), 0);
  const keptSpan = (maxEnd - minStart) - totalGapMs;
  const breakLen = Math.max(1, keptSpan * BREAK_DISPLAY_RATIO);

  const mapMs = (t: number): number => {
    let display = t - minStart;
    for (const g of gaps) {
      if (t >= g.end) display -= (g.end - g.start) - breakLen;
      else if (t > g.start) {
        // 落在空窗内部的值（理论上条不会跨断轴——空窗在 coverage 之外；
        // 防御：钉在断轴带起点）
        display -= t - g.start;
      }
    }
    return display;
  };

  return {
    mapMs,
    displayTotal: keptSpan + gaps.length * breakLen,
    breaks: gaps.map((g) => ({
      atDisplay: mapMs(g.start),
      displayLen: breakLen,
      gapMs: g.end - g.start,
    })),
  };
}
