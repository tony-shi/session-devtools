// Unified "selected / active" visual contract.
//
// Before this file there were ~5 hand-rolled selection styles (NavItem indigo,
// CompactEventNavItem orange, InterTurnNavItem violet, SessionList row light
// blue, tab underline) — each with its own geometry, so jumping between the
// four view levels meant re-learning "what does selected look like here".
//
// Contract (设计契约 · 选中态):
//   · GEOMETRY is uniform everywhere — 3px left bar + #eef2ff bg + 600 weight.
//   · Only the 3px LEFT BAR carries a semantic hue, so compact / inter-turn
//     rows stay scannable at a glance while still reading as "the same kind of
//     selected" as a turn row. (色相策略 A：统一语法 + 语义左条)
//
// Use `selectionStyle()` on the row/item CONTAINER. For table rows that can't
// take a real left border without disturbing cell layout, use
// `selectionRowShadow()` which paints the same 3px bar via an inset shadow.

import type { CSSProperties } from "react";
import { BRAND } from "./brand";

/** Semantic hue of the left accent bar. Geometry is identical across all. */
export type SelectionTone = "indigo" | "compact" | "interturn";

/** 3px left-bar color per node type (the only place hue varies). */
export const SELECTION_BAR: Record<SelectionTone, string> = {
  indigo:    BRAND.indigo500, // #6366f1 — turn / call / list row (default)
  compact:   "#f97316",       // compact events (orange family)
  interturn: BRAND.violet400, // #a78bfa — inter-turn system blocks
};

/** Unified selected surface — same everywhere regardless of tone. */
export const SELECTION_BG = BRAND.indigo50;  // #eef2ff
export const SELECTION_FG = BRAND.indigo700; // #4338ca

/**
 * Container style for a selectable row/item.
 * @param active   whether the row is currently selected
 * @param tone     semantic hue of the left bar (default "indigo")
 *
 * The idle state keeps a transparent 3px border so text never shifts on
 * select/deselect. Returns only the universally-safe pieces (bg + bar);
 * callers layer their own text color via SELECTION_FG where appropriate.
 */
export function selectionStyle(active: boolean, tone: SelectionTone = "indigo"): CSSProperties {
  return {
    background: active ? SELECTION_BG : "transparent",
    borderLeft: `3px solid ${active ? SELECTION_BAR[tone] : "transparent"}`,
  };
}

/**
 * Same 3px bar + bg as `selectionStyle`, but painted via inset box-shadow so
 * it works on `<tr>`/`<td>` where a real border-left would break cell metrics
 * or get clipped by border-collapse. Pair with a normal `background`.
 */
export function selectionRowShadow(active: boolean, tone: SelectionTone = "indigo"): CSSProperties {
  return active
    ? { background: SELECTION_BG, boxShadow: `inset 3px 0 0 0 ${SELECTION_BAR[tone]}` }
    : {};
}
