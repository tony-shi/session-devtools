/**
 * Centralized brand palette — replaces the ~235 inline hex literals that were
 * sprinkled across the codebase. Each token maps 1:1 to a Tailwind palette
 * step (indigo/violet/blue) so a future "swap brand color" is one find/replace
 * here instead of dozens of files.
 *
 * 命名约定：{tone}{step} — tone 是色调（indigo / violet / blue / 中性灰）,
 * step 是 Tailwind 1-900 阶（与 `text-indigo-500` 等 class 对应）。
 */
export const BRAND = {
  // Primary indigo（主品牌色，链接、CTA、选中态、链路徽标）
  indigo50:  "#eef2ff",
  indigo100: "#e0e7ff",
  indigo200: "#c7d2fe",
  indigo300: "#a5b4fc",
  indigo400: "#818cf8",
  indigo500: "#6366f1",
  indigo600: "#4f46e5",
  indigo700: "#4338ca",

  // Violet（sub-agent / fork 语义，区分主链路）
  violet50:  "#f5f3ff",
  violet100: "#ede9fe",
  violet200: "#ddd6fe",
  violet400: "#a78bfa",
  violet500: "#8b5cf6",
  violet600: "#7c3aed",
  violet700: "#6d28d9",
  violet800: "#5b21b6",
  violetGradient50: "#faf5ff",

  // Blue（跨视图跳转、proxy 高亮）
  blue500: "#3b82f6",
  blue600: "#2563eb",
  blue700: "#1d4ed8",
} as const;
