// Shared header building blocks for detail pages.
// Used by SessionOverview / UserTurnDetail / LlmCallDetail to keep the
// "label column row + token ledger row" pattern visually identical.
//
// UnifiedHeader composes the three header zones (stats · ledger · badges)
// into a single horizontal row so Session, Turn and Call pages share the
// same visual rhythm as the Dashboard SummaryCardsV2.

import React from "react";
import { useTranslation } from "react-i18next";
import { TOKEN_METRICS } from "../metricRegistry";

function fmtK(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (abs >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}

function fmtPct(n: number): string {
  return n.toFixed(1) + "%";
}

export interface HeaderStat {
  label: string;
  value: string;
  color?: string;
  tooltip?: string;
}

export interface HeaderStatRowProps {
  stats: HeaderStat[];
  /** Rendered flush-right on the same row (e.g. model chip, badge cluster). */
  rightSlot?: React.ReactNode;
  /** Optional small label before the first stat (e.g. "Turn 1"). */
  leadingLabel?: { label: string; value: string };
  /** Drop the bottom divider/padding when used inside a horizontal layout. */
  noDivider?: boolean;
}

export function HeaderStatRow({ stats, rightSlot, leadingLabel, noDivider }: HeaderStatRowProps) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-end", gap: 24,
      paddingBottom: noDivider ? 0 : 10,
      borderBottom: noDivider ? "none" : "1px solid #f3f4f6",
      flexWrap: "wrap",
    }}>
      {leadingLabel && (
        <div>
          <div style={statLabelStyle}>{leadingLabel.label}</div>
          <div style={{ ...statValueStyle, color: "#111827" }}>{leadingLabel.value}</div>
        </div>
      )}
      {stats.map(({ label, value, color, tooltip }) => (
        <div key={label} title={tooltip}>
          <div style={statLabelStyle}>{label}</div>
          <div style={{ ...statValueStyle, color: color ?? "#111827" }}>{value}</div>
        </div>
      ))}
      {rightSlot && (
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          {rightSlot}
        </div>
      )}
    </div>
  );
}

const statLabelStyle: React.CSSProperties = {
  fontSize: 9, color: "#9ca3af", fontWeight: 600,
  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 3,
};

const statValueStyle: React.CSSProperties = {
  fontSize: 14, fontWeight: 700, lineHeight: 1,
};

export interface TokenLedgerInlineProps {
  freshIn: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Pre-computed cache hit ratio in 0-100 range, or null to omit the chip. */
  cacheRatio?: number | null;
  /** Drop the top padding when used inside a horizontal layout. */
  noTopPadding?: boolean;
}

export function TokenLedgerInline({ freshIn, cacheRead, cacheWrite, output, cacheRatio, noTopPadding }: TokenLedgerInlineProps) {
  const { t } = useTranslation();
  const M = TOKEN_METRICS;

  // Display semantics — Fresh In here is the *broad-sense* "what was newly
  // sent this round". Callers pass `freshIn = ctx − cacheRead − cacheWrite`
  // (= API input_tokens, the strictly uncached part); we add cacheWrite back
  // because that content is still new this round, it just happens to also be
  // written to cache for the next call. This matches the user's intuition
  // ("我这一轮给了多少") rather than the narrow billing-bucket definition.
  //
  // Bar segments stay non-overlapping (input / cacheRead / cacheWrite /
  // output) so widths add up to actual total tokens — Fresh In column shows
  // the combined number for readability while the bar still gives an
  // accurate at-a-glance proportional view.
  const freshInDisplay = freshIn + cacheWrite;
  // Column / bar order reads as a timeline:
  //   Fresh In + Cache Write  →  Cache Read  →  Output
  //   (new content this round) → (replayed) → (model produced)
  // Fresh In and Cache Write sit adjacent so the visual relationship — Cache
  // Write is the portion of Fresh In that got cached for next call — is easy
  // to see side-by-side.
  const columns = [
    { id: "fresh_input", value: freshInDisplay },
    { id: "cache_write", value: cacheWrite },
    { id: "cache_read",  value: cacheRead },
    { id: "output",      value: output },
  ];
  const barSegments = [
    { id: "fresh_input", value: freshIn },
    { id: "cache_write", value: cacheWrite },
    { id: "cache_read",  value: cacheRead },
    { id: "output",      value: output },
  ];
  const barTotal = barSegments.reduce((s, r) => s + r.value, 0);

  // Whole-ledger hover interpretation — plain-language explainer so users
  // don't have to mentally reconstruct the breakdown from four columns.
  const interpretation = t("terms.ledgerInterpretation", {
    freshIn: fmtK(freshInDisplay),
    cacheWrite: fmtK(cacheWrite),
    cacheRead: fmtK(cacheRead),
    output: fmtK(output),
    ratio: cacheRatio != null
      ? t("terms.ledgerInterpretationRatio", { pct: fmtPct(cacheRatio) })
      : "",
  });

  return (
    <div style={{ paddingTop: noTopPadding ? 0 : 10 }} title={interpretation}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {t("dashboard.tokenLedger")}
        </span>
        {cacheRatio != null && (
          <>
            <div style={{ width: 1, height: 10, background: "#e5e7eb" }} />
            <span style={{ fontSize: 9, fontWeight: 700, color: M.cache_ratio.color }}>
              {t("metrics.cacheRatio.label", M.cache_ratio.label)} {fmtPct(cacheRatio)}
            </span>
          </>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-end", marginBottom: 5 }}>
        {columns.map(({ id, value }) => {
          const m = M[id];
          const hasVal = value > 0;
          return (
            <div key={id}>
              <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, marginBottom: 2, whiteSpace: "nowrap" }}>{m.label}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: hasVal ? m.color : "#d1d5db", lineHeight: 1 }}>
                {hasVal ? fmtK(value) : "—"}
              </div>
            </div>
          );
        })}
      </div>

      {barTotal > 0 && (
        <div style={{ height: 3, borderRadius: 2, overflow: "hidden", display: "flex", background: "#f3f4f6" }}>
          {barSegments.filter(r => r.value > 0).map(({ id, value }) => (
            <div key={id} style={{ flex: value, background: M[id].color }} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Status Badge (shared, icon + count) ─────────────────────────────────────
//
// Used everywhere we show compaction/error/sub-agent/command/unknown counts:
// the right slot of Session / Turn / Call headers, and the left nav items.
// The format is unified to "icon + number" — boolean-flavored events
// (command, unknown) carry their event-instance count so the row always reads
// as a quantity. Tooltip exposes the full label for accessibility.

export type StatusBadgeKind = "compaction" | "error" | "subAgent" | "command" | "unknown";

export interface StatusBadge {
  kind: StatusBadgeKind;
  count: number;
  /** Full descriptive label for the tooltip (e.g. "Compaction"). */
  tooltip: string;
}

const STATUS_BADGE_COLORS: Record<StatusBadgeKind, { fg: string; bg: string; border: string }> = {
  compaction: { fg: "#ef4444", bg: "#fef2f2", border: "#fecaca" },
  error:      { fg: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
  subAgent:   { fg: "#7c3aed", bg: "#faf5ff", border: "#e9d5ff" },
  command:    { fg: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  unknown:    { fg: "#9ca3af", bg: "#f9fafb", border: "#e5e7eb" },
};

export interface StatusBadgeStripProps {
  badges: StatusBadge[];
  /**
   * "compact" — used in left-nav rows (smaller font, tighter padding).
   * "default" — used in detail page right-slots.
   */
  size?: "compact" | "default";
  /** Icon renderer keyed by kind. Caller passes in to keep this file free of
   *  the BADGE_ICONS dependency that lives in SessionDetailV2. */
  renderIcon: (kind: StatusBadgeKind, px: number, color: string) => React.ReactNode;
}

export function StatusBadgeStrip({ badges, size = "default", renderIcon }: StatusBadgeStripProps) {
  if (badges.length === 0) return null;
  const iconPx = size === "compact" ? 8 : 9;
  const fontPx = size === "compact" ? 9 : 10;
  const pad = size === "compact" ? "1px 4px" : "2px 5px";
  const gap = size === "compact" ? 2 : 3;
  const stripGap = size === "compact" ? 3 : 4;
  // Compact strips live in narrow nav rows where wrapping would push the row
  // onto two lines and break the column rhythm. Force single-line + overflow
  // clip so the row height stays uniform. The default size keeps wrap so
  // detail-page right slots can spill across multiple lines on narrow widths.
  const wrap: React.CSSProperties["flexWrap"] = size === "compact" ? "nowrap" : "wrap";
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: stripGap, flexWrap: wrap, overflow: size === "compact" ? "hidden" : "visible" }}>
      {badges.map(b => {
        const c = STATUS_BADGE_COLORS[b.kind];
        return (
          <span
            key={b.kind}
            title={`${b.tooltip} · ${b.count}`}
            style={{
              display: "inline-flex", alignItems: "center", gap,
              fontSize: fontPx, fontWeight: 600,
              color: c.fg, background: c.bg,
              border: `1px solid ${c.border}`, borderRadius: 4,
              padding: pad, lineHeight: 1,
            }}
          >
            {renderIcon(b.kind, iconPx, c.fg)}
            {b.count}
          </span>
        );
      })}
    </div>
  );
}

// ─── UnifiedHeader (stats · ledger · badges, one row) ────────────────────────

export interface UnifiedHeaderProps {
  leadingLabel?: HeaderStatRowProps["leadingLabel"];
  stats: HeaderStat[];
  ledger: TokenLedgerInlineProps;
  /** Right column: status badges (and/or model chip). */
  rightSlot?: React.ReactNode;
}

export function UnifiedHeader({ leadingLabel, stats, ledger, rightSlot }: UnifiedHeaderProps) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 20, flexWrap: "wrap",
      paddingBottom: 10, marginBottom: 14,
      borderBottom: "1px solid #f3f4f6",
    }}>
      {/* Left: counters */}
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        <HeaderStatRow noDivider leadingLabel={leadingLabel} stats={stats} />
      </div>

      {/* Vertical separator hides itself when the right blocks wrap below */}
      <div style={{ width: 1, background: "#f3f4f6", alignSelf: "stretch" }} />

      {/* Middle: token ledger */}
      <div style={{ flex: "1 1 360px", minWidth: 0 }}>
        <TokenLedgerInline noTopPadding {...ledger} />
      </div>

      {/* Right: badges + model chip */}
      {rightSlot && (
        <>
          <div style={{ width: 1, background: "#f3f4f6", alignSelf: "stretch" }} />
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            flex: "0 0 auto", alignSelf: "flex-start",
            paddingTop: 14,  // align with stat values row
          }}>
            {rightSlot}
          </div>
        </>
      )}
    </div>
  );
}
