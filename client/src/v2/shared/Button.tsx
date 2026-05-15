// Shared <Button>. Three variants cover every CTA shape in the app:
//   - primary  → filled brand indigo, used for the page-of-the-grid active state
//   - ghost    → white surface with neutral border, the default chrome look
//   - soft     → tinted indigo background with indigo text (Show in turn etc.)
//   - text     → no chrome (▲ hide, ▼ show, search clear)
//
// Sizes pick paddings that line up with the SegmentedToggle equivalents so a
// row of mixed buttons stays visually flush.

import React from "react";

type Variant = "primary" | "ghost" | "soft" | "text";
type Size = "sm" | "md";

const BRAND        = "#6366f1";
const BRAND_WEAK   = "#eef2ff";
const BRAND_BORDER = "#c7d2fe";

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: Variant;
  size?: Size;
  active?: boolean;
  children: React.ReactNode;
}

export function Button({
  variant = "ghost",
  size = "md",
  active = false,
  disabled,
  style,
  children,
  ...rest
}: ButtonProps) {
  const sizeCfg = size === "md"
    ? { font: 12, padX: 10, padY: 4, radius: 6 }
    : { font: 11, padX: 8,  padY: 3, radius: 6 };

  const palette: Record<Variant, React.CSSProperties> = {
    primary: { background: BRAND,        color: "#fff",    border: `1px solid ${BRAND}` },
    soft:    { background: BRAND_WEAK,   color: BRAND,     border: `1px solid ${BRAND_BORDER}` },
    ghost:   { background: "#fff",       color: "#374151", border: "1px solid #e5e7eb" },
    text:    { background: "transparent", color: "#9ca3af", border: "1px solid transparent" },
  };

  const base: React.CSSProperties = {
    fontSize: sizeCfg.font,
    padding: `${sizeCfg.padY}px ${sizeCfg.padX}px`,
    borderRadius: sizeCfg.radius,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
    fontWeight: 500,
    lineHeight: 1.5,
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    transition: "background 0.1s, color 0.1s",
    whiteSpace: "nowrap",
  };

  return (
    <button
      type="button"
      disabled={disabled}
      style={{ ...base, ...palette[active ? "primary" : variant], ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}
