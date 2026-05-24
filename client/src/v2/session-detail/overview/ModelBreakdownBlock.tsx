// ModelBreakdownBlock —— 多模型 session 的 per-model token 拆解块（展开时显示）。
// 抽自 SessionOverviewPanel.tsx，逻辑零改动。

import React from "react";
import { useTranslation } from "react-i18next";
import type { ModelStats } from "../../drilldown-types";
import { fmtK, fmtPct, shortModelName, modelColor } from "../../lib/format";
import { TOKEN_METRICS } from "../../metricRegistry";

export function ModelBreakdownBlock({
  breakdown,
}: { breakdown: Record<string, ModelStats> }) {
  const { t } = useTranslation();
  const M = TOKEN_METRICS;
  const entries = Object.entries(breakdown).sort((a, b) => b[1].calls - a[1].calls);
  const totalCalls = entries.reduce((s, [, v]) => s + v.calls, 0);

  const COL = "44px"; // Calls only — Output already in token ledger

  // Pre-compute per-row ledgers and the global max for proportional bar widths
  const rowData = entries.map(([model, stats]) => {
    const ledger = [
      { id: "fresh_input", value: stats.freshIn ?? 0 },
      { id: "cache_read",  value: stats.cacheRead },
      { id: "cache_write", value: stats.cacheWrite },
      { id: "output",      value: stats.outputTokens },
    ];
    const cacheInputTotal = (stats.freshIn ?? 0) + stats.cacheRead + stats.cacheWrite;
    const cacheRatio = cacheInputTotal > 0 ? stats.cacheRead / cacheInputTotal * 100 : null;
    return { model, stats, ledger, ledgerTotal: ledger.reduce((s, r) => s + r.value, 0), cacheRatio };
  });
  const maxLedgerTotal = Math.max(...rowData.map(r => r.ledgerTotal), 1);

  return (
    <div>
      {/* header */}
      <div style={{ display: "grid", gridTemplateColumns: `1fr ${COL} 1fr`, alignItems: "end", paddingBottom: 4, borderBottom: "1px solid #f3f4f6" }}>
        <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em" }}>Model</span>
        <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textAlign: "right", textTransform: "uppercase", letterSpacing: "0.05em" }}>{t("sessionOverview.models.calls")}</span>
        <span style={{ fontSize: 9, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.05em", paddingLeft: 16 }}>{t("dashboard.tokenLedger")}</span>
      </div>

      {rowData.map(({ model, stats, ledger, ledgerTotal, cacheRatio }, i) => {
        const pct = totalCalls > 0 ? Math.round((stats.calls / totalCalls) * 100) : 0;
        const color = modelColor(model);
        // Bar width is proportional to global max — allows visual comparison across rows
        const barWidthPct = maxLedgerTotal > 0 ? (ledgerTotal / maxLedgerTotal) * 100 : 0;

        return (
          <div key={model} style={{
            display: "grid", gridTemplateColumns: `1fr ${COL} 1fr`,
            alignItems: "center", padding: "7px 0",
            borderBottom: i < rowData.length - 1 ? "1px solid #f3f4f6" : "none",
          }}>
            {/* model name + call-share bar */}
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: "#374151" }}>{shortModelName(model)}</span>
                <span style={{ fontSize: 10, color: "#9ca3af" }}>{pct}%</span>
              </div>
              <div style={{ height: 3, background: "#f3f4f6", borderRadius: 2, overflow: "hidden", width: 80 }}>
                <div style={{ width: `${pct}%`, height: "100%", background: color }} />
              </div>
            </div>

            {/* Calls */}
            <span style={{ fontSize: 11, color: "#374151", textAlign: "right" }}>{stats.calls}</span>

            {/* Token Ledger mini */}
            <div style={{ paddingLeft: 16, display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
                {ledger.map(({ id, value }) => {
                  const m = M[id];
                  return (
                    <div key={id} title={m.description}>
                      <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, marginBottom: 1, whiteSpace: "nowrap" }}>{m.label}</div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: value > 0 ? m.color : "#d1d5db", lineHeight: 1 }}>
                        {value > 0 ? fmtK(value) : "—"}
                      </div>
                    </div>
                  );
                })}
                {cacheRatio !== null && (
                  <div style={{ marginLeft: 4 }}>
                    <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, marginBottom: 1, whiteSpace: "nowrap" }}>{t("metrics.cacheRatio.label", M.cache_ratio.label)}</div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: M.cache_ratio.color, lineHeight: 1 }}>{fmtPct(cacheRatio)}</div>
                  </div>
                )}
              </div>
              {/* Bar: outer track = full width, inner fill = proportion of max */}
              <div style={{ height: 3, borderRadius: 2, background: "#f3f4f6", overflow: "hidden" }}>
                <div style={{ width: `${barWidthPct}%`, height: "100%", display: "flex", borderRadius: 2, overflow: "hidden" }}>
                  {ledger.filter(r => r.value > 0).map(({ id, value }) => (
                    <div key={id} style={{ flex: value, background: M[id].color }} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
