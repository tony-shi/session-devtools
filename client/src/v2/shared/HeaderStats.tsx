// Shared header building blocks for detail pages.
// Used by SessionOverview / UserTurnDetail / LlmCallDetail to keep the
// "label column row + token ledger row" pattern visually identical.
//
// UnifiedHeader composes the three header zones (stats · ledger · badges)
// into a single horizontal row so Session, Turn and Call pages share the
// same visual rhythm as the Dashboard SummaryCardsV2.

import React from "react";
import { useTranslation } from "react-i18next";
import { AggregateLedger, type AggregateLedgerFullProps } from "./AggregateLedger";
import { CallLedger, type CallLedgerFullProps } from "./CallLedger";
import { BRAND } from "./brand";
import { SummaryStat, CacheSummaryStat } from "../session-detail/call/CallSummaryStats";
import { fmtK } from "../lib/format";

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

// TokenLedgerInline has been removed. Use AggregateLedger / CallLedger via
// UnifiedHeader's `ledger` discriminated union instead — see UnifiedHeaderProps
// below. Standalone (non-header) usage should import AggregateLedger or
// CallLedger directly.

// ─── Status Badge (shared, icon + count) ─────────────────────────────────────
//
// Used everywhere we show compaction/error/sub-agent/command/unknown counts:
// the right slot of Session / Turn / Call headers, and the left nav items.
// The format is unified to "icon + number" — boolean-flavored events
// (command, unknown) carry their event-instance count so the row always reads
// as a quantity. Tooltip exposes the full label for accessibility.

export type StatusBadgeKind = "compaction" | "error" | "subAgent" | "command" | "unknown" | "noProxy";

export interface StatusBadge {
  kind: StatusBadgeKind;
  count: number;
  /** Full descriptive label for the tooltip (e.g. "Compaction"). */
  tooltip: string;
}

const STATUS_BADGE_COLORS: Record<StatusBadgeKind, { fg: string; bg: string; border: string }> = {
  compaction: { fg: "#ef4444", bg: "#fef2f2", border: "#fecaca" },
  error:      { fg: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
  subAgent:   { fg: BRAND.violet600, bg: BRAND.violetGradient50, border: "#e9d5ff" },
  command:    { fg: "#d97706", bg: "#fffbeb", border: "#fde68a" },
  unknown:    { fg: "#9ca3af", bg: "#f9fafb", border: "#e5e7eb" },
  noProxy:    { fg: "#d97706", bg: "#fffbeb", border: "#fde68a" },
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

/** Discriminated union: aggregate header (Σ semantics) vs single-call header
 *  (two-group "历史复用 / 本轮新处理" semantics). `mode` is required at every
 *  call-site so the visual contract is impossible to mix up by accident. */
export type UnifiedHeaderLedger =
  | ({ mode: "aggregate" } & Omit<AggregateLedgerFullProps, "size">)
  | ({ mode: "call"      } & Omit<CallLedgerFullProps,      "size">);

export interface UnifiedHeaderProps {
  leadingLabel?: HeaderStatRowProps["leadingLabel"];
  stats: HeaderStat[];
  ledger: UnifiedHeaderLedger;
  /** Right column: status badges (and/or model chip). */
  rightSlot?: React.ReactNode;
}

export function UnifiedHeader({ leadingLabel, stats, ledger, rightSlot }: UnifiedHeaderProps) {
  const { t } = useTranslation();

  const freshIn = ledger.freshIn;
  const cacheRead = ledger.cacheRead;
  const cacheWrite = ledger.cacheWrite;
  const output = ledger.output;

  const inputTotal = freshIn + cacheRead + cacheWrite;
  const cacheRatio = ledger.cacheRatio ?? (inputTotal > 0 ? (cacheRead / inputTotal) * 100 : null);

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingBottom: 10,
      marginBottom: 14,
      borderBottom: "1px solid #f3f4f6",
      flexWrap: "wrap",
      width: "100%",
    }}>
      {/* Left zone: Metadata stats + Ledger metrics */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: "1 1 auto", minWidth: 0 }}>
        {leadingLabel && (
          <SummaryStat
            label={leadingLabel.label}
            tooltip={`${leadingLabel.label}: ${leadingLabel.value}`}
            minWidth={60}
          >
            {leadingLabel.value}
          </SummaryStat>
        )}

        {stats.map(({ label, value, color, tooltip }) => (
          <SummaryStat
            key={label}
            label={label}
            tooltip={tooltip || label}
            valueColor={color}
          >
            {value}
          </SummaryStat>
        ))}

        {/* Divider before Ledger */}
        <div style={{ alignSelf: "center", width: 1, height: 16, background: "#e5e7eb", margin: "2px 6px" }} />

        {/* Compact Ledger Stats */}
        <SummaryStat
          label={t("callSummary.context.label", { defaultValue: "总输入" })}
          tooltip={t("ledgerExplainer.inputSection", { defaultValue: "输入" }).replace("{{sigma}}", "∑ ")}
          valueColor="#334155"
        >
          {fmtK(inputTotal)}
        </SummaryStat>

        <SummaryStat
          label={t("callSummary.output.label", { defaultValue: "总输出" })}
          tooltip={t("ledgerExplainer.outputSection", { defaultValue: "输出" }).replace("{{sigma}}", "∑ ")}
          valueColor="#6366f1"
        >
          {fmtK(output)}
        </SummaryStat>

        <CacheSummaryStat
          label={t("callSummary.cache.label", { defaultValue: "缓存" })}
          tooltip={t("callSummary.cache.tooltip", { defaultValue: "缓存比例" })}
          ratio={cacheRatio}
          freshIn={freshIn}
          cacheRead={cacheRead}
          cacheWrite={cacheWrite}
          output={output}
          minWidth={52}
        />
      </div>

      {/* Right zone: Badges + Action buttons */}
      {rightSlot && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {rightSlot}
        </div>
      )}
    </div>
  );
}
