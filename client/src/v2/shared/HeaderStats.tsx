// Shared header building blocks for detail pages.
// Used by SessionOverview / UserTurnDetail / LlmCallDetail to keep the
// "label column row + token ledger row" pattern visually identical.

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

  const rows = [
    { id: "fresh_input", value: freshIn },
    { id: "cache_read",  value: cacheRead },
    { id: "cache_write", value: cacheWrite },
    { id: "output",      value: output },
  ];
  const total = rows.reduce((s, r) => s + r.value, 0);

  return (
    <div style={{ paddingTop: noTopPadding ? 0 : 10 }}>
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
        {rows.map(({ id, value }) => {
          const m = M[id];
          const hasVal = value > 0;
          return (
            <div key={id} title={m.description}>
              <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, marginBottom: 2, whiteSpace: "nowrap" }}>{m.label}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: hasVal ? m.color : "#d1d5db", lineHeight: 1 }}>
                {hasVal ? fmtK(value) : "—"}
              </div>
            </div>
          );
        })}
      </div>

      {total > 0 && (
        <div style={{ height: 3, borderRadius: 2, overflow: "hidden", display: "flex", background: "#f3f4f6" }}>
          {rows.filter(r => r.value > 0).map(({ id, value }) => (
            <div key={id} style={{ flex: value, background: M[id].color }} />
          ))}
        </div>
      )}
    </div>
  );
}
