// Shared ECharts style tokens for in-app charts (ContextTimelineChart, TurnMinimap, …).
//
// Charts compose their own option objects, but they pull axis / tooltip / line
// presets from here so colors, font sizes and grid lines stay aligned across pages.

export const CHART_COLORS = {
  /** Brand indigo — main line / dot / "+Δ" label. */
  brand:      "#6366f1",
  /** Soft brand tint, used for the line area gradient bottom stop. */
  brandSoft:  "#6366f11f",
  brandFaint: "#6366f103",

  /** Compaction marker (diamond). Same red across all charts. */
  compaction: "#ef4444",
  /** Sub-agent trigger marker (triangle) and savings label. */
  subAgent:       "#a855f7",
  subAgentDark:   "#7e22ce",
  subAgentWeakBg: "#faf5ff",
  subAgentWeakBd: "#d8b4fe",

  /** Axis / grid neutrals. */
  axisLabel:  "#9ca3af",
  splitLine:  "#f1f5f9",
  borderLine: "#e5e7eb",

  /** Delta label colors, applied to "+/−" tooltip values. */
  deltaUp:     "#d97706", // growth — amber
  deltaDown:   "#16a34a", // shrink — green
  deltaDanger: "#dc2626", // outlier growth
} as const;

/** Dark tooltip preset — same across all charts.
 *  `pointer-events: none` is critical: without it, the tooltip DOM element
 *  sits above the canvas and swallows clicks that should reach the chart's
 *  zrender click handler (e.g., "click a Call column to jump to that Call").
 *  Tooltip is purely informational here — no interactive elements live inside. */
export const TOOLTIP_PRESET = {
  backgroundColor: "#111827",
  borderColor: "#374151",
  borderWidth: 1,
  textStyle: { color: "#f9fafb", fontSize: 11 },
  extraCssText: "max-width: 520px; white-space: normal; pointer-events: none;",
} as const;

/** Build the linear gradient used as area fill under brand line series. */
export function brandAreaGradient() {
  return {
    type: "linear" as const, x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [
      { offset: 0, color: CHART_COLORS.brandSoft },
      { offset: 1, color: CHART_COLORS.brandFaint },
    ],
  };
}

/** Common axis-label style — keep call sites tiny. */
export const AXIS_LABEL_STYLE = {
  fontSize: 9,
  color: CHART_COLORS.axisLabel,
} as const;

/** Common value-axis preset (no axis line, no tick, splitLine = #f1f5f9). */
export const VALUE_AXIS_BASE = {
  axisLine: { show: false },
  axisTick: { show: false },
  splitLine: { lineStyle: { color: CHART_COLORS.splitLine } },
} as const;

/** Common category-axis preset (no axis line, no tick, no splitLine by default). */
export const CATEGORY_AXIS_BASE = {
  axisLine: { show: false },
  axisTick: { show: false },
  splitLine: { show: false },
} as const;
