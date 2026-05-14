// ZigzagBreak — "中间断开"视觉。
//
// 一对对向锯齿，左侧齿尖朝右、右侧齿尖朝左，两线之间留白。配合透明背景使容器底色透出，
// 形成"strip 在此被撕开"的视觉。

import type { CSSProperties } from "react";

interface Props {
  width: number;
  height: number;
  /** 齿深（默认 4px） */
  tooth?: number;
  /** 齿间距（默认 5px） */
  period?: number;
  /** 描边颜色（默认紫） */
  stroke?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}

export function ZigzagBreak({
  width, height,
  tooth = 4, period = 5,
  stroke = "#6366f1", strokeWidth = 1.2,
  style,
}: Props) {
  if (width <= 0 || height <= 0) return null;
  const n = Math.max(2, Math.ceil(height / period));
  const leftPts: string[] = [];
  const rightPts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const y = (i / n) * height;
    const off = i % 2 === 0 ? 0 : tooth;
    leftPts.push(`${off},${y}`);
    rightPts.push(`${width - off},${y}`);
  }
  return (
    <svg
      width={width} height={height}
      style={{ position: "absolute", inset: 0, pointerEvents: "none", display: "block", ...style }}
    >
      <polyline points={leftPts.join(" ")}  fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      <polyline points={rightPts.join(" ")} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
    </svg>
  );
}
