import { useTranslation } from "react-i18next";

export interface TokenMetric {
  id: string;
  canonical: string;
  color: string;
  category: "input" | "cache" | "output" | "context" | "derived";
  i18nKey: string;
  tooltipKey: string;
  unit: "tokens";
}

export const TOKEN_METRICS: Record<string, TokenMetric> = {
  fresh_input: {
    id: "fresh_input",
    canonical: "Fresh In",
    color: "#6366f1",
    category: "input",
    i18nKey: "metrics.freshInput.shortLabel",
    tooltipKey: "metrics.freshInput.tooltip",
    unit: "tokens",
  },
  cache_read: {
    id: "cache_read",
    canonical: "Cache Read",
    color: "#059669",
    category: "cache",
    i18nKey: "metrics.cacheRead.shortLabel",
    tooltipKey: "metrics.cacheRead.tooltip",
    unit: "tokens",
  },
  cache_write: {
    id: "cache_write",
    canonical: "Cache Write",
    color: "#d97706",
    category: "cache",
    i18nKey: "metrics.cacheWrite.shortLabel",
    tooltipKey: "metrics.cacheWrite.tooltip",
    unit: "tokens",
  },
  output: {
    id: "output",
    canonical: "Output",
    color: "#7c3aed",
    category: "output",
    i18nKey: "metrics.output.shortLabel",
    tooltipKey: "metrics.output.tooltip",
    unit: "tokens",
  },
  context_used: {
    id: "context_used",
    canonical: "Context",
    color: "#6366f1",
    category: "context",
    i18nKey: "metrics.contextUsed.shortLabel",
    tooltipKey: "metrics.contextUsed.tooltip",
    unit: "tokens",
  },
  context_delta: {
    id: "context_delta",
    canonical: "Context Δ",
    color: "#6366f1",
    category: "context",
    i18nKey: "metrics.contextDelta.shortLabel",
    tooltipKey: "metrics.contextDelta.tooltip",
    unit: "tokens",
  },
  peak_context: {
    id: "peak_context",
    canonical: "Peak Context",
    color: "#6366f1",
    category: "context",
    i18nKey: "metrics.peakContext.shortLabel",
    tooltipKey: "metrics.peakContext.tooltip",
    unit: "tokens",
  },
  cache_ratio: {
    id: "cache_ratio",
    canonical: "Cache Ratio",
    color: "#059669",
    category: "derived",
    i18nKey: "metrics.cacheRatio.shortLabel",
    tooltipKey: "metrics.cacheRatio.tooltip",
    unit: "tokens",
  },
};

export function getMetric(id: string): TokenMetric {
  const m = TOKEN_METRICS[id];
  if (!m) throw new Error(`Unknown metric id: ${id}`);
  return m;
}

export function useMetricLabel(id: string): { label: string; tooltip: string; color: string } {
  const { t } = useTranslation();
  const m = TOKEN_METRICS[id];
  if (!m) return { label: id, tooltip: "", color: "#6b7280" };
  return {
    label: t(m.i18nKey, m.canonical),
    tooltip: t(m.tooltipKey, ""),
    color: m.color,
  };
}
