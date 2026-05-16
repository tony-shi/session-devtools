import { useTranslation } from "react-i18next";
import type { SummaryV2 } from "./types";
import { TOKEN_METRICS } from "./metricRegistry";
import { HeaderStatRow, TokenLedgerInline } from "./shared/HeaderStats";
import { CacheFormulaBox } from "./shared/CacheFormulaBox";

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
  //
  // Token ledger semantics — the four columns are *non-overlapping* billing
  // buckets (matches Anthropic API usage breakdown):
  //   • freshIn    = input_tokens         (uncached fresh prompt, full rate)
  //   • cacheRead  = cache_read_tokens    (loaded from cache, ~10% rate)
  //   • cacheWrite = cache_creation       (newly cached this call, ~125% rate)
  //   • output     = output_tokens        (model generated)
  // Cache ratio is the standard hit rate = cacheRead / (in + cacheRead + cacheWrite).
  const cacheRead  = data?.cache_read_tokens     ?? 0;
  const cacheWrite = data?.cache_creation_tokens ?? 0;
  const freshIn    = data?.input_tokens          ?? 0;
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
          {/* Left: hero counters — claim at least half of the row so the right
              ledger doesn't visually swamp the headline numbers */}
          <div style={{ flex: "1 1 50%", minWidth: 0 }}>
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

          {/* Right: token ledger — also flex:1 so the row balances 50/50 with
              room for the bar to breathe; shrinks naturally on narrow widths.
              Formula toggle sits below the ledger; folded by default so the
              dashboard's compact rhythm is preserved. */}
          <div style={{
            flex: "1 1 50%", minWidth: 0,
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            <TokenLedgerInline
              noTopPadding
              freshIn={freshIn}
              cacheRead={cacheRead}
              cacheWrite={cacheWrite}
              output={output}
              cacheRatio={cacheRatio}
            />
            <CacheFormulaBox
              freshIn={freshIn}
              cacheRead={cacheRead}
              cacheWrite={cacheWrite}
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
  // Display semantics — Fresh In is broad-sense "what was newly sent this
  // round": API input_tokens + cache_creation. Bar segments stay
  // non-overlapping so widths still represent actual token volume.
  const apiInput = session.input_tokens;
  const cacheWrite = session.cache_creation_tokens;
  const cacheRead = session.cache_read_tokens;
  const output = session.output_tokens;
  const freshInDisplay = apiInput + cacheWrite;
  // Column / bar order reads as a timeline: Fresh In + Cache Write (new
  // this round) → Cache Read (replayed) → Output (model produced). Fresh In
  // and Cache Write are adjacent so the subset relationship reads at a
  // glance.
  const columns = [
    { id: "fresh_input", value: freshInDisplay },
    { id: "cache_write", value: cacheWrite },
    { id: "cache_read",  value: cacheRead },
    { id: "output",      value: output },
  ];
  const barSegments = [
    { id: "fresh_input", value: apiInput },
    { id: "cache_write", value: cacheWrite },
    { id: "cache_read",  value: cacheRead },
    { id: "output",      value: output },
  ];

  // Cache hit ratio = cache_read / (input + cache_read + cache_creation).
  // Same denominator as the Turn / Session headers so values agree.
  const inputTotal = apiInput + cacheRead + cacheWrite;
  const cacheRatio = inputTotal > 0 ? (cacheRead / inputTotal) * 100 : null;
  const total = barSegments.reduce((s, e) => s + e.value, 0);
  const barWidthPct = maxTotal > 0 ? (total / maxTotal) * 100 : 0;

  // Whole-row hover — plain language summary of the four numbers.
  const interpretation = t("terms.ledgerInterpretation", {
    freshIn: fmt(freshInDisplay),
    cacheWrite: fmt(cacheWrite),
    cacheRead: fmt(cacheRead),
    output: fmt(output),
    ratio: cacheRatio != null
      ? t("terms.ledgerInterpretationRatio", { pct: fmtPct(cacheRatio) })
      : "",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }} title={interpretation}>
      {/* label + value row — fixed-width columns to keep alignment across rows */}
      {/* Column widths track the new order: Fresh In · Cache Write · Cache
          Read · Output · | · Cache Ratio. Sized to fit each label without
          wrapping. */}
      <div style={{ display: "grid", gridTemplateColumns: "56px 64px 60px 52px 1px 52px", alignItems: "end" }}>
        {columns.map(({ id, value }) => {
          const m = TOKEN_METRICS[id];
          const hasVal = value > 0;
          return (
            <div key={id} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontSize: 9, color: "#9ca3af", fontWeight: 500, whiteSpace: "nowrap" }}>
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

      {/* stacked bar, width scaled to maxTotal — uses non-overlapping
          segments (apiInput / cacheRead / cacheWrite / output) so widths
          reflect actual token volume. Column display above shows broad-sense
          Fresh In; bar shows the underlying breakdown. */}
      {total > 0 && (
        <div style={{ width: "100%", height: 3, borderRadius: 2, background: "#f3f4f6", overflow: "hidden" }}>
          <div style={{ width: `${barWidthPct}%`, height: "100%", display: "flex", overflow: "hidden", borderRadius: 2 }}>
            {barSegments.filter(e => e.value > 0).map(({ id, value }) => (
              <div
                key={id}
                style={{ flex: value, background: TOKEN_METRICS[id].color }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
