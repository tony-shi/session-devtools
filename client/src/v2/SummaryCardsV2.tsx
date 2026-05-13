import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SummaryV2 } from "./types";
import { TOKEN_METRICS } from "./metricRegistry";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function fmtPct(n: number): string {
  return n.toFixed(1) + "%";
}

function Skeleton({ w = "100%", h = 20 }: { w?: string | number; h?: number }) {
  return (
    <div style={{
      width: w, height: h, background: "#e5e7eb", borderRadius: 4,
      animation: "pulse 1.5s ease-in-out infinite", flexShrink: 0,
    }} />
  );
}

// ─── Tool colors ──────────────────────────────────────────────────────────────

const TOOL_COLORS: Record<string, { bg: string; color: string }> = {
  claude: { bg: "#f3e8ff", color: "#7c3aed" },
  codex:  { bg: "#dbeafe", color: "#1d4ed8" },
  gemini: { bg: "#d1fae5", color: "#065f46" },
};

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, loading }: {
  label: string; value: string | number; sub?: string; loading: boolean;
}) {
  return (
    <div style={{
      flex: 1, background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb",
      padding: "10px 16px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 3,
    }}>
      <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase" }}>
        {label}
      </span>
      {loading
        ? <Skeleton h={18} w={40} />
        : <span style={{ fontSize: 20, fontWeight: 700, color: "#111827", lineHeight: 1 }}>{value}</span>
      }
      {sub && !loading && (
        <span style={{ fontSize: 10, color: "#d1d5db" }}>{sub}</span>
      )}
    </div>
  );
}

// ─── Right: Token Ledger ──────────────────────────────────────────────────────

const M = TOKEN_METRICS;

function StackedBar({ freshIn, cacheRead, cacheWrite }: {
  freshIn: number; cacheRead: number; cacheWrite: number;
}) {
  const total = freshIn + cacheRead + cacheWrite;
  if (total === 0) return null;
  const pFresh = (freshIn   / total) * 100;
  const pRead  = (cacheRead  / total) * 100;
  const pWrite = (cacheWrite / total) * 100;

  return (
    <div style={{ display: "flex", height: 5, borderRadius: 3, overflow: "hidden", gap: 1 }}>
      {pFresh > 0.2 && (
        <div title={`Fresh In ${fmtPct(pFresh)}`}
          style={{ flex: pFresh, background: M.fresh_input.color }} />
      )}
      {pRead > 0.2 && (
        <div title={`Cache Read ${fmtPct(pRead)}`}
          style={{ flex: pRead, background: M.cache_read.color }} />
      )}
      {pWrite > 0.2 && (
        <div title={`Cache Write ${fmtPct(pWrite)}`}
          style={{ flex: pWrite, background: M.cache_write.color }} />
      )}
    </div>
  );
}

function LedgerCol({ metricId, value }: { metricId: string; value: number }) {
  const m = M[metricId];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 }}>
      <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 500, whiteSpace: "nowrap" }} title={m.description}>
        {m.label}
      </span>
      <span style={{ fontSize: 15, fontWeight: 700, color: m.color, lineHeight: 1 }}>
        {fmt(value)}
      </span>
    </div>
  );
}

function TokenLedgerCard({ data, loading }: { data: SummaryV2 | null; loading: boolean }) {
  const { t } = useTranslation();
  const [showFormula, setShowFormula] = useState(false);

  const cacheRead  = data?.cache_read_tokens     ?? 0;
  const cacheWrite = data?.cache_creation_tokens ?? 0;
  // Fresh In = non-cached input + cache_write (both are freshly processed this call)
  const freshIn    = (data?.input_tokens ?? 0) + cacheWrite;
  const output     = data?.output_tokens         ?? 0;
  const inputTotal = freshIn + cacheRead + cacheWrite;
  const cacheRatio = inputTotal > 0 ? (cacheRead / inputTotal) * 100 : 0;

  return (
    <div
      style={{
        background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb",
        padding: "10px 16px", flex: 2, minWidth: 0,
        position: "relative", display: "flex", flexDirection: "column", gap: 6,
        justifyContent: "center",
      }}
      onMouseEnter={() => setShowFormula(true)}
      onMouseLeave={() => setShowFormula(false)}
    >
      {/* header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 10, color: "#9ca3af", fontWeight: 500, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          {t("dashboard.tokenLedger")}
        </span>
        {!loading && data && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
            <span style={{ fontSize: 10, color: "#9ca3af" }}>{t("dashboard.cacheRatio")}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: M.cache_ratio.color }}>
              {fmtPct(cacheRatio)}
            </span>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ display: "flex", gap: 12 }}>
          {[1,2,3,4].map((i) => (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <Skeleton h={10} />
              <Skeleton h={18} />
            </div>
          ))}
        </div>
      ) : !data ? (
        <span style={{ fontSize: 11, color: "#9ca3af" }}>—</span>
      ) : (
        <>
          {/* stacked bar */}
          <StackedBar freshIn={freshIn} cacheRead={cacheRead} cacheWrite={cacheWrite} />

          {/* two-row metric grid: label row then value row */}
          <div style={{ display: "flex", gap: 12 }}>
            <LedgerCol metricId="fresh_input"  value={freshIn} />
            <LedgerCol metricId="cache_read"   value={cacheRead} />
            <LedgerCol metricId="cache_write"  value={cacheWrite} />
            <LedgerCol metricId="output"       value={output} />
          </div>

          {/* formula tooltip on hover */}
          {showFormula && (
            <div style={{
              position: "absolute", bottom: "calc(100% + 6px)", right: 0,
              background: "#1f2937", color: "#e5e7eb",
              borderRadius: 7, padding: "7px 11px",
              fontSize: 10, lineHeight: 1.8, fontFamily: "monospace",
              whiteSpace: "nowrap", zIndex: 20,
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              pointerEvents: "none",
            }}>
              Input work = Fresh In + Cache Read + Cache Write
              <br />
              Generated = Output
              <br />
              Cache Ratio = Cache Read / Input work
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

interface Props {
  data: SummaryV2 | null;
  loading: boolean;
}

export function SummaryCardsV2({ data, loading }: Props) {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
      <StatCard label={t("dashboard.sessions")}  value={data?.total_sessions ?? "—"}              loading={loading} />
      <StatCard label={t("dashboard.userTurns")} value={data ? fmt(data.human_input_count) : "—"} loading={loading} />
      <StatCard label={t("dashboard.llmCalls")}  value="—" sub={t("dashboard.comingSoon")}        loading={loading} />
      <TokenLedgerCard data={data} loading={loading} />
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>
    </div>
  );
}

// ─── Exported mini ledger for table rows ──────────────────────────────────────

interface MiniLedgerSession {
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
}

export function MiniTokenLedger({ session, maxTotal }: { session: MiniLedgerSession; maxTotal: number }) {
  const { t } = useTranslation();
  const freshIn = session.input_tokens + session.cache_creation_tokens;
  const entries = [
    { id: "fresh_input", value: freshIn },
    { id: "cache_read",  value: session.cache_read_tokens },
    { id: "cache_write", value: session.cache_creation_tokens },
    { id: "output",      value: session.output_tokens },
  ];

  const inputTotal = freshIn + session.cache_read_tokens;
  const cacheRatio = inputTotal > 0 ? (session.cache_read_tokens / inputTotal) * 100 : null;
  const total = entries.reduce((s, e) => s + e.value, 0);
  const barWidthPct = maxTotal > 0 ? (total / maxTotal) * 100 : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {/* label + value row — fixed-width columns to keep alignment across rows */}
      <div style={{ display: "grid", gridTemplateColumns: "56px 60px 64px 52px 1px 52px", alignItems: "end" }}>
        {entries.map(({ id, value }) => {
          const m = TOKEN_METRICS[id];
          const hasVal = value > 0;
          return (
            <div key={id} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, whiteSpace: "nowrap" }} title={m.description}>
                {m.label}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: hasVal ? m.color : "#d1d5db", lineHeight: 1 }}>
                {hasVal ? fmt(value) : "—"}
              </span>
            </div>
          );
        })}
        {/* divider */}
        <div style={{ width: 1, height: 20, background: "#f3f4f6", justifySelf: "center" }} />
        {/* Cache Ratio */}
        {cacheRatio !== null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, whiteSpace: "nowrap" }}>
              {t("dashboard.cacheRatio")}
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, color: TOKEN_METRICS.cache_ratio.color, lineHeight: 1 }}>
              {fmtPct(cacheRatio)}
            </span>
          </div>
        )}
      </div>

      {/* stacked bar, width scaled to maxTotal */}
      {total > 0 && (
        <div style={{ width: "100%", height: 3, borderRadius: 2, background: "#f3f4f6", overflow: "hidden" }}>
          <div style={{ width: `${barWidthPct}%`, height: "100%", display: "flex", overflow: "hidden", borderRadius: 2 }}>
            {entries.filter(e => e.value > 0).map(({ id, value }) => (
              <div
                key={id}
                title={`${TOKEN_METRICS[id].label}: ${fmt(value)}`}
                style={{ flex: value, background: TOKEN_METRICS[id].color }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
