// 纯函数模块：鱼眼数学 + 折叠位置计算。无 React / 无 state。
//
// 抽离这一层的目的：
//   - 可单测（不依赖 DOM）
//   - 可被业务方独立调用（如：业务想自己算 minBar 做 auto 判定提示）

import type { FisheyeItem, FisheyeCollapseConfig } from "./types";

/**
 * Bostock 经典 fisheye distortion。
 * 端点 min/max 不动，焦点处局部放大 ~(distortion+1) 倍。
 */
export function fisheye(
  x: number,
  focus: number,
  distortion: number,
  min: number,
  max: number,
): number {
  if (x === focus) return focus;
  const left = x < focus;
  const m = left ? focus - min : max - focus;
  if (m <= 0) return x;
  const sign = left ? -1 : 1;
  const dist = Math.abs(x - focus);
  return focus + sign * m * (distortion + 1) / (distortion + m / dist);
}

/**
 * 计算原始线性位置（无鱼眼、无折叠）。
 * 返回 length = items.length + 1 的位置数组（末尾 sentinel）。
 */
export function computeLinearPositions(
  items: FisheyeItem[],
  containerWidth: number,
): { positions: number[]; totalSize: number } {
  const totalSize = items.reduce((s, e) => s + e.size, 0);
  const positions: number[] = [];
  if (totalSize === 0 || containerWidth === 0) {
    for (let i = 0; i <= items.length; i++) positions.push(0);
    return { positions, totalSize };
  }
  let cursor = 0;
  for (const e of items) {
    positions.push(cursor);
    cursor += (e.size / totalSize) * containerWidth;
  }
  positions.push(cursor);
  return { positions, totalSize };
}

/**
 * 折叠后位置：
 *   - giant（由 collapse.isGiant 判定 + 未展开） → 固定 collapsedWidthPx 占位
 *   - 其他段在剩余像素中按 size 比例分配
 *
 * 如果 collapse 为 undefined，等价于 computeLinearPositions。
 */
export function computeCollapsedPositions<T extends FisheyeItem>(
  items: T[],
  containerWidth: number,
  collapse: FisheyeCollapseConfig<T> | undefined,
): {
  positions: number[];
  giantFlags: boolean[];
  collapsedCount: number;
  totalSize: number;
} {
  const totalSize = items.reduce((s, e) => s + e.size, 0);
  const n = items.length;
  const giantFlags = new Array<boolean>(n).fill(false);

  if (!collapse || totalSize === 0 || containerWidth === 0) {
    const { positions } = computeLinearPositions(items, containerWidth);
    return { positions, giantFlags, collapsedCount: 0, totalSize };
  }

  const collapsedWidth = collapse.collapsedWidthPx ?? 28;
  let collapsedCount = 0;
  let normalSizeSum = 0;

  for (let i = 0; i < n; i++) {
    if (collapse.isGiant(items[i], { totalSize, index: i }) && !collapse.expandedIds.has(items[i].id)) {
      giantFlags[i] = true;
      collapsedCount += 1;
    } else {
      normalSizeSum += items[i].size;
    }
  }

  const giantPxTotal = collapsedCount * collapsedWidth;
  const remainingPx = Math.max(containerWidth - giantPxTotal, 0);

  const positions: number[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    positions.push(cursor);
    if (giantFlags[i]) {
      cursor += collapsedWidth;
    } else {
      const w = normalSizeSum > 0 ? (items[i].size / normalSizeSum) * remainingPx : 0;
      cursor += w;
    }
  }
  positions.push(cursor);
  return { positions, giantFlags, collapsedCount, totalSize };
}

/** 从位置数组计算最窄段像素宽度（折叠占位也算入）。 */
export function computeMinBarPx(positions: number[]): number {
  if (positions.length < 2) return 0;
  let m = Infinity;
  for (let i = 0; i < positions.length - 1; i++) {
    const w = positions[i + 1] - positions[i];
    if (w > 0) m = Math.min(m, w);
  }
  return m === Infinity ? 0 : m;
}

/** Auto 决策：元素数足够 + 最窄段太窄 → 开。 */
export function decideFisheyeAuto(
  itemCount: number,
  minBarPx: number,
  minCount: number,
  clickableThresholdPx: number,
): boolean {
  return itemCount >= minCount && minBarPx < clickableThresholdPx;
}
