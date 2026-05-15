import { useTranslation } from "react-i18next";
import type { SummaryV2 } from "./types";
import { TOKEN_METRICS } from "./metricRegistry";
import { HeaderStatRow, TokenLedgerInline } from "./shared/HeaderStats";

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
  claude: { bg: "#eef2ff", color: "#6366f1" },
  codex:  { bg: "#dbeafe", color: "#1d4ed8" },
  gemini: { bg: "#d1fae5", color: "#065f46" },
};

// ─── Stat card ────────────────────────────────────────────────────────────────

// ─── Root ─────────────────────────────────────────────────────────────────────

interface Props {
  data: SummaryV2 | null;
  loading: boolean;
}

export function SummaryCardsV2({ data, loading }: Props) {
  const { t } = useTranslation();

  // Treat dashboard hero stats with the same flat header layout used in detail
  // pages so visual rhythm stays identical when navigating in & out of a session.
  const cacheRead  = data?.cache_read_tokens     ?? 0;
  const cacheWrite = data?.cache_creation_tokens ?? 0;
  const freshIn    = (data?.input_tokens ?? 0) + cacheWrite;
  const output     = data?.output_tokens         ?? 0;
  const inputTotal = freshIn + cacheRead + cacheWrite;
  const cacheRatio = inputTotal > 0 ? (cacheRead / inputTotal) * 100 : null;

  return (
    <div style={{
      background: "#fff", borderRadius: 8, border: "1px solid #e5e7eb",
      padding: "12px 16px",
    }}>
      {loading || !data ? (
        <div style={{ display: "flex", gap: 24 }}>
          {[1, 2, 3, 4].map(i => <Skeleton key={i} h={28} w={60} />)}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "stretch", gap: 24 }}>
          {/* Left: hero counters */}
          <div style={{ flex: "0 0 auto" }}>
            <HeaderStatRow
              noDivider
              stats={[
                { label: t("dashboard.sessions"),  value: String(data.total_sessions) },
                { label: t("dashboard.userTurns"), value: fmt(data.human_input_count) },
                { label: t("dashboard.llmCalls"),  value: fmt(data.llm_call_count) },
              ]}
            />
          </div>

          {/* Vertical separator */}
          <div style={{ width: 1, background: "#f3f4f6" }} />

          {/* Right: token ledger occupies remaining space */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <TokenLedgerInline
              noTopPadding
              freshIn={freshIn}
              cacheRead={cacheRead}
              cacheWrite={cacheWrite}
              output={output}
              cacheRatio={cacheRatio}
            />
          </div>
        </div>
      )}
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
              {TOKEN_METRICS.cache_ratio.label}
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
