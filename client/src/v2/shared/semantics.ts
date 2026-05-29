// ─── Color-semantics contract (设计契约 · 颜色职责) ──────────────────────────
//
// Single source of truth for "what does this hue MEAN". Before this file the
// same color carried different meanings in different views, so users couldn't
// tell whether green meant "cache" or "success". This module does NOT invent
// new colors — it re-exports the canonical value from wherever it's defined
// (BRAND / TOKEN_METRICS / CATEGORY_COLORS / selection) and documents the ONE
// role each hue plays, plus the few deliberate context-separated overlaps so
// future code doesn't "fix" them as bugs.
//
// THE CONTRACT — one role per hue-in-context:
//   · indigo  → 导航 / 选中 / 跨视图跳转（链路动作）            [chrome]
//   · emerald → cache read / cache ratio                       [ledger only]
//   · amber   → cache write                                    [ledger only]
//   · violet  → output tokens / sub-agent / assistant          [content]
//   · red     → error / risk                                   [status]
//   · amber*  → warning / no-proxy                             [status badge]
//   · category palette → 归因来源色                            [attribution only]
//
// DELIBERATE OVERLAPS (context-separated, NOT bugs):
//   · indigo `#6366f1` is BOTH the nav/selection accent AND the `fresh_input`
//     ledger bar. They never co-occur in the same surface (chrome vs. a token
//     bar), so the shared hue is acceptable.
//   · amber `#d97706` is cache-write (ledger) AND command-input / warning
//     (events/badges). Same note — ledger bars vs. inline event rows.
//   · violet `#7c3aed` is output (ledger) AND sub-agent/assistant (content).
//
// RESOLVED by the selection-token work: selection no longer paints violet/
// orange BACKGROUNDS, so violet now reads cleanly as "model output / sub-agent"
// and orange as "cache-write / compact" — the old "violet/orange = selected"
// ambiguity is gone (only the 3px left BAR keeps a semantic hue).

import { BRAND } from "./brand";
import { TOKEN_METRICS } from "../metricRegistry";
import { CATEGORY_COLORS } from "../lib/palettes";
import { SELECTION_BAR, SELECTION_BG, SELECTION_FG } from "./selection";

/** Chrome: navigation, selection, cross-view jump links. The only role indigo
 *  plays outside a token ledger. */
export const ROLE_NAV = {
  /** Cross-reference / jump link text + icon. */
  link: BRAND.indigo600,
  /** Selected-row accent bar (default tone) + selected surface + text. */
  selectionBar: SELECTION_BAR.indigo,
  selectionBg: SELECTION_BG,
  selectionFg: SELECTION_FG,
} as const;

/** Token ledger hues — RESERVED for the AggregateLedger / CallLedger bars and
 *  their metric values. Do not reuse these exact values to signal status or
 *  selection. Sourced from the metric registry so there is exactly one value. */
export const ROLE_LEDGER = {
  freshInput: TOKEN_METRICS.fresh_input.color, // indigo  #6366f1
  cacheRead:  TOKEN_METRICS.cache_read.color,  // emerald #059669
  cacheWrite: TOKEN_METRICS.cache_write.color, // amber   #d97706
  output:     TOKEN_METRICS.output.color,      // violet  #7c3aed
  cacheRatio: TOKEN_METRICS.cache_ratio.color, // emerald #059669
} as const;

/** Risk / status. Red = hard error; amber = soft warning (e.g. no-proxy). */
export const ROLE_RISK = {
  error:   "#dc2626",
  warning: "#d97706",
  errorBg:   "#fef2f2",
  errorBorder: "#fecaca",
} as const;

/** Content semantics that legitimately reuse violet (model-side output). */
export const ROLE_CONTENT = {
  subAgent:  BRAND.violet600,
  assistant: BRAND.violet600,
} as const;

/** Attribution-only: source/category coloring of request segments. Confined
 *  to the attribution tree + payload map; never used as chrome or status. */
export const ROLE_SOURCE = CATEGORY_COLORS;
