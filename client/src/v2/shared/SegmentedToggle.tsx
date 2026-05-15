// Shared segmented toggle for binary/n-ary chart options and section selectors.
// Two sizes: `sm` for inline chart options, `md` for primary content section
// pickers. Always uses brand indigo (`#6366f1`) for the active segment so the
// control reads as part of one design system across pages.

import React from "react";

export interface SegmentedOption<T extends string> {
  id: T;
  label: React.ReactNode;
  title?: string;
}

export interface SegmentedToggleProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (id: T) => void;
  size?: "sm" | "md";
  /** Solid: active segment filled with brand color. Soft: active uses tinted background. */
  variant?: "solid" | "soft";
  align?: "start" | "end";
  className?: string;
  style?: React.CSSProperties;
}

const BRAND = "#6366f1";
const BRAND_WEAK_BG = "#eef2ff";
const BRAND_WEAK_BORDER = "#c7d2fe";

export function SegmentedToggle<T extends string>({
  options, value, onChange,
  size = "sm",
  variant = "solid",
  align = "end",
  style,
}: SegmentedToggleProps<T>) {
  const cfg = size === "md"
    ? { font: 11, padX: 14, padY: 5, radius: 5, gap: 4 }
    : { font: 10, padX: 8,  padY: 2, radius: 4, gap: 4 };

  return (
    <div style={{
      display: "flex",
      justifyContent: align === "end" ? "flex-end" : "flex-start",
      gap: cfg.gap,
      ...style,
    }}>
      {options.map((o) => {
        const active = o.id === value;
        const styleActive = variant === "solid"
          ? { background: BRAND,        color: "#fff",   border: `1px solid ${BRAND}` }
          : { background: BRAND_WEAK_BG, color: BRAND,    border: `1px solid ${BRAND_WEAK_BORDER}` };
        const styleIdle = { background: "transparent", color: "#9ca3af", border: "1px solid #e5e7eb" };
        return (
          <button
            key={o.id}
            type="button"
            title={o.title}
            onClick={() => onChange(o.id)}
            style={{
              fontSize: cfg.font,
              padding: `${cfg.padY}px ${cfg.padX}px`,
              borderRadius: cfg.radius,
              cursor: "pointer",
              fontWeight: active ? 600 : 400,
              whiteSpace: "nowrap",
              ...(active ? styleActive : styleIdle),
            }}
          >{o.label}</button>
        );
      })}
    </div>
  );
}
