import { useTranslation } from "react-i18next";
import type { SummaryV2 } from "./types";
import { HeaderStatRow } from "./shared/HeaderStats";
import { AggregateLedger } from "./shared/AggregateLedger";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
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

// ─── Root ─────────────────────────────────────────────────────────────────────

interface Props {
  data: SummaryV2 | null;
  loading: boolean;
}

export function SummaryCardsV2({ data, loading }: Props) {
  const { t } = useTranslation();

  // Dashboard summary uses the aggregate ledger (Σ semantics): the four
  // billing buckets here are sums across every session under the current
  // filter, so the Σ prefix in INPUT / OUTPUT / CACHE RATIO is the
  // user-facing signal that "these are aggregated, not single-call".
  //
  //   • freshIn    = Σ input_tokens          (uncached fresh prompt, 1.0×)
  //   • cacheRead  = Σ cache_read_tokens     (replayed from cache, ~0.1×)
  //   • cacheWrite = Σ cache_creation        (newly cached this call, ~1.25×)
  //   • output     = Σ output_tokens         (model generated)
  // Cache ratio = Σcache_read / (Σfresh + Σcache_read + Σcache_write).
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

          {/* Right: aggregate ledger */}
          <div style={{ flex: "1 1 50%", minWidth: 0 }}>
            <AggregateLedger
              size="full"
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

// MiniTokenLedger has been removed — list rows now use AggregateLedger
// (size="compact") directly, and per-call thumbnails use CallLedger
// (size="compact"). The MiniLedgerSession field mapping is now done at the
// call-site (one extra line) instead of inside this file.
