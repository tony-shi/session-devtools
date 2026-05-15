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

// 间隔自适应：最窄段足够宽时给 2px 间隔（更显著），过小时退化到 1 / 0
const DENSITY_GAP_NORMAL_PX = 2;
const DENSITY_GAP_THRESHOLD_PX = 4;
const DENSITY_GAP_HARD_PX = 1.5;

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
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const selectedIdx = useMemo(
    () => selectedId === null ? -1 : items.findIndex((it) => it.id === selectedId),
    [items, selectedId],
  );

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
      onMouseLeave={() => { setFocus(null); setHoveredIdx(null); onHover?.(null); }}
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
        // 自适应间隔：常态 2px，过密时降到 1px，超密则取消
        const gapPx =
          minBarPx < DENSITY_GAP_HARD_PX ? 0 :
          minBarPx < DENSITY_GAP_THRESHOLD_PX ? 1 :
          DENSITY_GAP_NORMAL_PX;
        const w = Math.max(right - left - gapPx, 0);
        const isCollapsed = giantFlags[i];
        const isSelected = selectedId === item.id;
        const isHovered = hoveredIdx === i;
        const hasSelection = selectedIdx >= 0;
        // 三档强度：0 dim / 1 normal / 2 hover / 3 selected
        let intensity: 0 | 1 | 2 | 3 = 1;
        if (hasSelection) {
          if (isSelected) intensity = 3;
          else if (isHovered) intensity = 2;
          else intensity = 0;
        } else if (hoveredIdx !== null) {
          intensity = isHovered ? 2 : 1;
        }
        const opacity =
          intensity === 0 ? 0.18 :
          intensity === 1 ? 1 :
          intensity === 2 ? 1 :
          1;
        const fontWeight =
          intensity === 0 ? 400 :
          intensity === 1 ? 500 :
          intensity === 2 ? 600 :
          700;
        const labelColor =
          intensity === 3 ? "#0b1220" :
          intensity === 2 ? "#111827" :
          "#1f2937";
        const label = getLabel ? getLabel(item) : "";
        const color = getColor(item);
        const title = getTitle
          ? getTitle(item)
          : `${label || item.id} · size ${item.size}${isCollapsed ? " · BROKEN (click to expand)" : ""}`;

        const innerHeight = Math.max(height - 4, 0);
        // label 按实时段宽决定显示 — 鱼眼 / 等宽下，宽段都能显示 label
        // dim 状态下不渲染文字（intensity 0），避免视觉噪声
        const labelFits =
          intensity > 0 &&
          label.length > 0 &&
          w >= Math.max(LABEL_MIN_VISIBLE_PX, label.length * LABEL_CHAR_PX + LABEL_PAD_PX);

        return (
          <div
            key={item.id}
            title={title}
            onClick={(ev) => { ev.stopPropagation(); handleClick(item, isCollapsed); }}
            onMouseEnter={() => { setHoveredIdx(i); onHover?.(item); }}
            style={{
              position: "absolute",
              left, width: w,
              top: 2, bottom: 2,
              background: isCollapsed ? "transparent" : color,
              opacity,
              border: "none",
              borderRadius: isCollapsed ? 0 : 3,
              outline: isSelected ? "2px solid #4338ca" : "none",
              outlineOffset: -2,
              boxShadow: intensity === 2 && !isSelected ? "0 0 0 1px rgba(67,56,202,0.45) inset" : "none",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, color: labelColor, fontWeight,
              whiteSpace: "nowrap", overflow: "hidden",
              cursor: "pointer",
              transition: focus !== null && fisheyeActive
                ? "left 40ms linear, width 40ms linear, opacity 120ms ease-out"
                : "left 220ms ease-out, width 220ms ease-out, opacity 120ms ease-out",
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
