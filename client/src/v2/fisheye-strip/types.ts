// fisheye-strip 模块的对外类型。
//
// 设计原则：
//   - 模块只关心通用的 "id + size"，业务可以在 item 上挂任意 meta，模块不解读
//   - 视觉装饰（颜色 / label）由调用方注入函数
//   - selection / expand state 都是 controlled（调用方持有）

export interface FisheyeItem {
  id: string;
  size: number;
}

export type FisheyeMode = "auto" | "on" | "off";

export interface FisheyeAutoConfig {
  /** 元素数少于此值，鱼眼自动关闭 */
  minCount?: number;
  /** 最窄段 ≥ 此像素值，鱼眼自动关闭 */
  clickableThresholdPx?: number;
}

export interface FisheyeCollapseConfig<T extends FisheyeItem> {
  /** 判定一个 item 是否为巨型（由业务决定标准） */
  isGiant: (item: T, ctx: { totalSize: number; index: number }) => boolean;
  /** 当前被用户展开的 giant id 集合（调用方持有 state） */
  expandedIds: Set<string>;
  /** 用户点击折叠占位时回调（调用方负责更新 expandedIds） */
  onToggleExpand: (item: T) => void;
  /** 折叠后占位段固定像素宽度 */
  collapsedWidthPx?: number;
}

export interface FisheyeStatus {
  /** 最终是否激活鱼眼（综合 mode + auto 决策） */
  fisheyeActive: boolean;
  /** auto 模式下会判定为开/关 */
  fisheyeAutoEnabled: boolean;
  /** 折叠后的最窄段像素宽度 */
  minBarPx: number;
  /** 当前被折叠的 giant 数量 */
  collapsedCount: number;
  /** strip 容器实测宽度 */
  containerWidth: number;
}

export interface FisheyeStripProps<T extends FisheyeItem> {
  items: T[];

  // ─── 视觉装饰（业务注入） ────────────────────────────
  /** 必传：每个 item 的颜色 */
  getColor: (item: T) => string;
  /** 可选：bar 内部 label 文本（容得下时显示） */
  getLabel?: (item: T) => string;
  /** 可选：tooltip 文本 */
  getTitle?: (item: T) => string;
  /** 可选：对应 item 上叠加的特殊标记色（如 cache_control pin → 红框）。
   *  返回 null 不画。用 boxShadow inset 渲染，不影响 layout / 鱼眼计算。 */
  getMarker?: (item: T) => string | null;
  /** 可选：返回 item 下方"下划色条"的颜色（diff lens 用：add 绿 / modify 黄 /
   *  remove 红）。返回 null 表示该 item 无 underline。
   *
   *  视觉位置：bar 本体下方 1px gap + 3px 实色色条。bar 本体不动、底色不污染。
   *  仅当 getUnderlineColor 返回过非 null 值时，容器才会额外多出 4px 高度。 */
  getUnderlineColor?: (item: T) => string | null;
  /** 可选：返回该 item 是否被"外部 filter 灰化"（如 bucket pill 选中后，
   *  非命中 leaf 应灰掉）。true 时强制 opacity≈0.18，覆盖默认 hover/select
   *  联动；点击仍可用。 */
  getDimmed?: (item: T) => boolean;

  // ─── 容器外观 ─────────────────────────────────────
  height?: number;
  background?: string;
  gapPx?: number;

  // ─── Selection (controlled) ───────────────────────
  selectedId?: string | null;
  onSelect?: (item: T) => void;
  onHover?: (item: T | null) => void;

  // ─── Fisheye 行为 ────────────────────────────────
  fisheyeMode?: FisheyeMode;
  distortion?: number;
  autoConfig?: FisheyeAutoConfig;

  // ─── Collapse（opt-in） ──────────────────────────
  collapse?: FisheyeCollapseConfig<T>;

  // ─── Status pipe（供 demo / 调试展示内部状态） ───────
  onStatusChange?: (status: FisheyeStatus) => void;
}
