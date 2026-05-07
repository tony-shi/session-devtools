import type { SummaryData } from "../types";

const TOOL_COLORS: Record<string, { bg: string; color: string }> = {
  claude: { bg: "#f3e8ff", color: "#7c3aed" },
  codex:  { bg: "#dbeafe", color: "#1d4ed8" },
  gemini: { bg: "#d1fae5", color: "#065f46" },
};

interface Props {
  data: SummaryData | null;
  loading: boolean;
}

const card: React.CSSProperties = {
  background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb",
  padding: "14px 18px", flex: 1, minWidth: 0,
};

const label: React.CSSProperties = {
  fontSize: 11, color: "#9ca3af", marginBottom: 6, fontWeight: 500, letterSpacing: "0.02em",
};

const value: React.CSSProperties = {
  fontSize: 26, fontWeight: 700, color: "#111827", lineHeight: 1,
};

function Skeleton() {
  return (
    <div style={{ height: 28, background: "#e5e7eb", borderRadius: 5, animation: "pulse 1.5s ease-in-out infinite" }} />
  );
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function TokenRow({ label: l, value: v, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
      <span style={{ fontSize: 11, color: "#9ca3af" }}>{l}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color }}>{fmt(v)}</span>
    </div>
  );
}

export function SummaryCards({ data, loading }: Props) {
  const tools = data ? Object.keys(data.by_tool) : [];
  const tok = data?.tokens;

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {/* 今日会话 */}
      <div style={card}>
        <p style={label}>今日会话</p>
        {loading ? <Skeleton /> : (
          <p style={value}>{data?.total_sessions ?? 0}</p>
        )}
      </div>

      {/* 人工交互次数 */}
      <div style={card}>
        <p style={label}>人工交互</p>
        {loading ? <Skeleton /> : (
          <p style={value}>{data?.total_human_turns ?? 0}</p>
        )}
      </div>

      {/* 活跃工具 */}
      <div style={card}>
        <p style={label}>活跃工具</p>
        {loading ? <Skeleton /> : tools.length === 0 ? (
          <p style={{ fontSize: 14, color: "#9ca3af" }}>—</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 2 }}>
            {tools.map((tool) => {
              const c = TOOL_COLORS[tool] ?? { bg: "#f3f4f6", color: "#374151" };
              return (
                <span key={tool} style={{
                  fontSize: 12, padding: "2px 9px", borderRadius: 20,
                  background: c.bg, color: c.color, fontWeight: 500,
                }}>
                  {tool} · {data!.by_tool[tool].sessions}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Cache tokens */}
      <div style={card}>
        <p style={label}>Cache Tokens</p>
        {loading ? <Skeleton /> : !tok ? (
          <p style={{ fontSize: 14, color: "#9ca3af" }}>—</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2 }}>
            <TokenRow label="cache write" value={tok.cache_creation} color="#d97706" />
            <TokenRow label="cache read"  value={tok.cache_read}     color="#059669" />
          </div>
        )}
      </div>

      {/* All tokens */}
      <div style={card}>
        <p style={label}>All Tokens</p>
        {loading ? <Skeleton /> : !tok ? (
          <p style={{ fontSize: 14, color: "#9ca3af" }}>—</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2 }}>
            <TokenRow label="read (input)"  value={tok.input}  color="#6366f1" />
            <TokenRow label="write (output)" value={tok.output} color="#7c3aed" />
          </div>
        )}
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`}</style>
    </div>
  );
}
