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
    // offsetWidth 而非 getBoundingClientRect().width：后者是视口坐标（含祖先
    // CSS zoom / transform: scale），用它分配局部布局像素会在缩放环境下按系数
    // 平方溢出，条带被 overflow:hidden 裁掉右侧。offsetWidth 是未缩放的局部
    // 布局宽，与子元素 left/width 同坐标系。
    const update = () => setWidth(el.offsetWidth);
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

// Underline 色条参数（diff lens 用，bar 下方）
const UNDERLINE_GAP_PX = 1;        // bar 底部到色条之间的留白
const UNDERLINE_THICKNESS_PX = 5;  // 色条本身的厚度（加粗以提升 diff 信号识别度）
const UNDERLINE_RESERVE_PX = UNDERLINE_GAP_PX + UNDERLINE_THICKNESS_PX;

function getContrastColor(hexColor: string): string {
  let hex = hexColor.replace(/^#/, "");
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (hex.length !== 6) return "#1f2937";
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? "#1f2937" : "#ffffff";
}

// ─── 主组件 ───────────────────────────────────────────────────────────────────

export function FisheyeStrip<T extends FisheyeItem>(props: FisheyeStripProps<T>) {
  const {
    items,
    getColor,
    getBorderStyle,
    getIndicatorLine,
    getIndicatorColor,
    getTextureType,
    getLabel,
    getTitle,
    getMarker,
    getUnderlineColor,
    getDimmed,
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

  // 是否有任意 item 需要 underline 色条 → 决定容器是否预留底部空间
  const hasUnderline = useMemo(
    () => !!getUnderlineColor && items.some((it) => !!getUnderlineColor(it)),
    [items, getUnderlineColor],
  );
  const containerHeight = height + (hasUnderline ? UNDERLINE_RESERVE_PX : 0);
  // bar 实际占用高度（不含 underline 区域）。原逻辑 top:2 bottom:2 → height-4。
  const barInnerHeight = Math.max(height - 4, 0);

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
        // clientX/rect 是视口坐标，focus 要的是局部布局坐标 —— 除以缩放系数
        // （rect.width / offsetWidth）换算，与 useContainerWidth 的 offsetWidth 同系。
        const el = e.currentTarget;
        const rect = el.getBoundingClientRect();
        const scale = el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1;
        setFocus((e.clientX - rect.left) / scale);
      }}
      onMouseLeave={() => { setFocus(null); setHoveredIdx(null); onHover?.(null); }}
      style={{
        position: "relative",
        width: "100%", height: containerHeight,
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
        const externalDim = getDimmed ? getDimmed(item) : false;
        const isDimmed = externalDim || (intensity === 0);
        const opacity = isDimmed ? 0.35 : 1;
        const filter = isDimmed ? "grayscale(100%)" : "none";
        const fontWeight =
          intensity === 0 ? 400 :
          intensity === 1 ? 500 :
          intensity === 2 ? 600 :
          700;
        const label = getLabel ? getLabel(item) : "";
        const color = getColor(item);
        const labelColor = getContrastColor(color);
        const title = getTitle
          ? getTitle(item)
          : `${label || item.id} · size ${item.size}${isCollapsed ? " · BROKEN (click to expand)" : ""}`;

        const borderStyle = getBorderStyle ? getBorderStyle(item) : null;
        const indicatorLine = getIndicatorLine ? getIndicatorLine(item) : null;
        const indicatorColor = getIndicatorColor ? getIndicatorColor(item) : null;
        const textureType = getTextureType ? getTextureType(item) : null;

        const showTexture = textureType && textureType !== "none" && w >= 8;
        const showBorder = borderStyle && w >= 6;
        const showIndicator = indicatorLine && w >= 4;

        const stripeColor = (indicatorColor || color).startsWith("#")
          ? `${(indicatorColor || color)}1e`
          : "rgba(0,0,0,0.06)";
        const backgroundImage = showTexture && textureType === "stripes"
          ? `repeating-linear-gradient(45deg, transparent, transparent 4px, ${stripeColor} 4px, ${stripeColor} 8px)`
          : "none";

        const innerHeight = barInnerHeight;
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
              top: 2, height: barInnerHeight,
              backgroundColor: isCollapsed ? "transparent" : color,
              backgroundImage,
              opacity,
              filter,
              boxSizing: "border-box",
              border: showBorder && borderStyle ? borderStyle : "none",
              borderRadius: isCollapsed ? 0 : 3,
              outline: isSelected ? "2px solid #4338ca" : "none",
              outlineOffset: -2,
              boxShadow: (() => {
                const marker = getMarker ? getMarker(item) : null;
                const hoverShadow = intensity === 2 && !isSelected
                  ? "0 0 0 1px rgba(67,56,202,0.45) inset" : "";
                
                const shadows: string[] = [];
                if (showIndicator && indicatorLine === "left") {
                  shadows.push(`inset 3px 0 0 0 ${indicatorColor || color}`);
                } else if (showIndicator && indicatorLine === "top") {
                  shadows.push(`inset 0 2px 0 0 ${indicatorColor || color}`);
                }

                if (marker) {
                  shadows.push(`inset -4px 0 0 0 ${marker}`);
                }

                if (hoverShadow) {
                  shadows.push(hoverShadow);
                }

                return shadows.length > 0 ? shadows.join(", ") : "none";
              })(),
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 10, color: labelColor, fontWeight,
              whiteSpace: "nowrap", overflow: "hidden",
              cursor: "pointer",
              transition: focus !== null && fisheyeActive
                ? "left 40ms linear, width 40ms linear, opacity 120ms ease-out, filter 120ms ease-out"
                : "left 220ms ease-out, width 220ms ease-out, opacity 120ms ease-out, filter 120ms ease-out",
              willChange: "left, width",
            }}
          >
            {(() => {
              const marker = getMarker ? getMarker(item) : null;
              return marker ? (
                <span
                  style={{
                    position: "absolute",
                    top: 0, right: 0,
                    background: marker,
                    color: "#fff",
                    fontSize: 8,
                    lineHeight: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    padding: "1px 3px",
                    borderRadius: "0 3px 0 3px",
                    pointerEvents: "none",
                  }}
                >PIN</span>
              ) : null;
            })()}
            {isCollapsed ? (
              <ZigzagBreak width={w} height={innerHeight} />
            ) : (
              labelFits ? label : ""
            )}
          </div>
        );
      })}

      {/* Underline 色条（diff lens：add 绿 / modify 黄 / remove 红）。
          单独一遍 map 渲染，方便和 bar 用相同 left/width 但独立定位在容器底部。
          underline 自身不响应点击，吸收到下方的 bar 元素上由 onClick 处理。 */}
      {hasUnderline && items.map((item, i) => {
        const ul = getUnderlineColor ? getUnderlineColor(item) : null;
        if (!ul) return null;
        const left = positions[i];
        const right = positions[i + 1];
        const gapPx =
          minBarPx < DENSITY_GAP_HARD_PX ? 0 :
          minBarPx < DENSITY_GAP_THRESHOLD_PX ? 1 :
          DENSITY_GAP_NORMAL_PX;
        const w = Math.max(right - left - gapPx, 0);
        // hover/select dim 联动主 bar 的强度
        const isSelected = selectedId === item.id;
        const isHovered = hoveredIdx === i;
        const hasSelection = selectedIdx >= 0;
        const ulDimmed = (getDimmed && getDimmed(item)) || (hasSelection && !isSelected && !isHovered);
        const ulOpacity = ulDimmed ? 0.35 : 1;
        const ulFilter = ulDimmed ? "grayscale(100%)" : "none";
        return (
          <div
            key={`underline-${item.id}`}
            style={{
              position: "absolute",
              left,
              width: w,
              top: 2 + barInnerHeight + UNDERLINE_GAP_PX,
              height: UNDERLINE_THICKNESS_PX,
              backgroundColor: ul,
              opacity: ulOpacity,
              filter: ulFilter,
              borderRadius: 1,
              pointerEvents: "none",
              transition: focus !== null && fisheyeActive
                ? "left 40ms linear, width 40ms linear, opacity 120ms ease-out, filter 120ms ease-out"
                : "left 220ms ease-out, width 220ms ease-out, opacity 120ms ease-out, filter 120ms ease-out",
            }}
          />
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
