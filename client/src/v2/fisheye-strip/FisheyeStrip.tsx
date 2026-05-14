// FisheyeStrip — 通用鱼眼条带组件。
//
// 模块边界：
//   - 输入：items: { id, size, ...meta }[]，调用方通过 getColor/getLabel 注入视觉
//   - 输出：onSelect / onHover / onToggleExpand
//   - 内部状态：仅 focus（鼠标位置）。selection / expand 都 controlled
//
// 不内置语义：颜色、label、过滤、标题、类别 legend 等都是调用方责任。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  computeCollapsedPositions,
  computeMinBarPx,
  decideFisheyeAuto,
  fisheye,
} from "./fisheye-math";
import { ZigzagBreak } from "./ZigzagBreak";
import type { FisheyeItem, FisheyeStripProps, FisheyeStatus } from "./types";

// ─── 容器宽度 hook ───────────────────────────────────────────────────────────

function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

// ─── 默认值 ─────────────────────────────────────────────────────────────────

const DEFAULT_HEIGHT = 56;
const DEFAULT_BG = "#f3f4f6";
const DEFAULT_DISTORTION = 5;
const DEFAULT_AUTO_MIN_COUNT = 20;
const DEFAULT_AUTO_THRESHOLD_PX = 12;

// label 显示判定：实测段宽 ≥ labelText × CHAR_PX + PAD 才放下
const LABEL_CHAR_PX = 5.4;
const LABEL_PAD_PX = 8;
const LABEL_MIN_VISIBLE_PX = 16;   // 不论 label 多短，至少 16px 才显示（避免单字符孤儿）

// 间隔自适应：最窄段过小（极端密度）时把 1px 间隔降到 0，避免空白比块大
const DENSITY_GAP_THRESHOLD_PX = 4;

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export function FisheyeStrip<T extends FisheyeItem>(props: FisheyeStripProps<T>) {
  const {
    items,
    getColor,
    getLabel,
    getTitle,
    height = DEFAULT_HEIGHT,
    background = DEFAULT_BG,
    selectedId = null,
    onSelect,
    onHover,
    fisheyeMode = "auto",
    distortion = DEFAULT_DISTORTION,
    autoConfig,
    collapse,
    onStatusChange,
  } = props;

  const minCount = autoConfig?.minCount ?? DEFAULT_AUTO_MIN_COUNT;
  const clickableThresholdPx = autoConfig?.clickableThresholdPx ?? DEFAULT_AUTO_THRESHOLD_PX;

  const { ref, width: containerWidth } = useContainerWidth<HTMLDivElement>();
  const [focus, setFocus] = useState<number | null>(null);

  // 折叠后基底位置（仍未鱼眼）
  const { positions: basePositions, giantFlags, collapsedCount, totalSize } = useMemo(
    () => computeCollapsedPositions(items, containerWidth, collapse),
    [items, containerWidth, collapse],
  );

  // minBar + auto 决策
  const minBarPx = useMemo(() => computeMinBarPx(basePositions), [basePositions]);
  const fisheyeAutoEnabled = decideFisheyeAuto(items.length, minBarPx, minCount, clickableThresholdPx);
  const fisheyeActive =
    fisheyeMode === "on" ? true :
    fisheyeMode === "off" ? false :
    fisheyeAutoEnabled;

  // 应用鱼眼
  const positions = useMemo(() => {
    if (focus === null || !fisheyeActive) return basePositions;
    return basePositions.map((x) => fisheye(x, focus, distortion, 0, containerWidth));
  }, [basePositions, focus, fisheyeActive, distortion, containerWidth]);

  // Status 回调
  useEffect(() => {
    if (!onStatusChange) return;
    const status: FisheyeStatus = {
      fisheyeActive, fisheyeAutoEnabled, minBarPx,
      collapsedCount, containerWidth,
    };
    onStatusChange(status);
  }, [onStatusChange, fisheyeActive, fisheyeAutoEnabled, minBarPx, collapsedCount, containerWidth]);

  void totalSize; // 当前不需要直接用，但保留 hook 防止未来误删

  const handleClick = (item: T, isCollapsed: boolean) => {
    if (isCollapsed && collapse) {
      collapse.onToggleExpand(item);
    } else if (!isCollapsed) {
      onSelect?.(item);
    }
  };

  return (
    <div
      ref={ref}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setFocus(e.clientX - rect.left);
      }}
      onMouseLeave={() => { setFocus(null); onHover?.(null); }}
      style={{
        position: "relative",
        width: "100%", height,
        background,
        borderRadius: 6,
        overflow: "hidden",
        cursor: "crosshair",
      }}
    >
      {items.map((item, i) => {
        const left = positions[i];
        const right = positions[i + 1];
        // 自适应间隔：基线 minBar 过窄时不留 1px gap，避免空白盖过块本身
        const gapPx = minBarPx < DENSITY_GAP_THRESHOLD_PX ? 0 : 1;
        const w = Math.max(right - left - gapPx, 0);
        const isCollapsed = giantFlags[i];
        const isSelected = selectedId === item.id;
        const label = getLabel ? getLabel(item) : "";
        const color = getColor(item);
        const title = getTitle
          ? getTitle(item)
          : `${label || item.id} · size ${item.size}${isCollapsed ? " · BROKEN (click to expand)" : ""}`;

        const innerHeight = Math.max(height - 4, 0);
        // label 按实时段宽决定显示 — 鱼眼 / 等宽下，宽段都能显示 label
        const labelFits =
          label.length > 0 &&
          w >= Math.max(LABEL_MIN_VISIBLE_PX, label.length * LABEL_CHAR_PX + LABEL_PAD_PX);

        return (
          <div
            key={item.id}
            title={title}
            onClick={(ev) => { ev.stopPropagation(); handleClick(item, isCollapsed); }}
            onMouseEnter={() => onHover?.(item)}
            style={{
              position: "absolute",
              left, width: w,
              top: 2, bottom: 2,
              background: isCollapsed ? "transparent" : color,
              border: "none",
              borderRadius: isCollapsed ? 0 : 3,
              outline: isSelected ? "2px solid #4338ca" : "none",
              outlineOffset: -2,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, color: "#1f2937", fontWeight: 500,
              whiteSpace: "nowrap", overflow: "hidden",
              cursor: "pointer",
              transition: focus !== null && fisheyeActive
                ? "left 40ms linear, width 40ms linear"
                : "left 220ms ease-out, width 220ms ease-out",
              willChange: "left, width",
            }}
          >
            {isCollapsed ? (
              <ZigzagBreak width={w} height={innerHeight} />
            ) : (
              labelFits ? label : ""
            )}
          </div>
        );
      })}

      {/* Focus indicator */}
      {focus !== null && (
        <div style={{
          position: "absolute",
          left: focus - 0.5, top: 0, bottom: 0,
          width: 1, background: "rgba(17,24,39,0.35)",
          pointerEvents: "none",
        }} />
      )}
    </div>
  );
}
