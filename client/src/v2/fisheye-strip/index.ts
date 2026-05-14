// fisheye-strip 模块的公开入口。
//
// 使用：
//   import { FisheyeStrip } from "./fisheye-strip";
//   import type { FisheyeItem } from "./fisheye-strip";
//
// 高级用法（直接消费数学函数）：
//   import { fisheye, computeCollapsedPositions, decideFisheyeAuto } from "./fisheye-strip";

export { FisheyeStrip } from "./FisheyeStrip";
export { ZigzagBreak } from "./ZigzagBreak";
export {
  fisheye,
  computeLinearPositions,
  computeCollapsedPositions,
  computeMinBarPx,
  decideFisheyeAuto,
} from "./fisheye-math";
export type {
  FisheyeItem,
  FisheyeMode,
  FisheyeAutoConfig,
  FisheyeCollapseConfig,
  FisheyeStatus,
  FisheyeStripProps,
} from "./types";
