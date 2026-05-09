import type { DashboardV2 } from "./types";

const TOOL_COLORS: Record<string, { bg: string; color: string }> = {
  claude: { bg: "#f3e8ff", color: "#7c3aed" },
  codex:  { bg: "#dbeafe", color: "#1d4ed8" },
  gemini: { bg: "#d1fae5", color: "#065f46" },
};

const card: React.CSSProperties = {
  background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb",
  padding: "14px 18px", flex: 1, minWidth: 0,
};
const labelStyle: React.CSSProperties = {
  fontSize: 11, color: "#9ca3af", marginBottom: 6, fontWeight: 500, letterSpacing: "0.02em",
};
const bigNum: React.CSSProperties = {
  fontSize: 26, fontWeight: 700, color: "#111827", lineHeight: 1,
};

function Skeleton() {
  return <div style={{ height: 28, background: "#e5e7eb", borderRadius: 5, animation: "pulse 1.5s ease-in-out infinite" }} />;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function TokenRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
      <span style={{ fontSize: 11, color: "#9ca3af" }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color }}>{fmt(value)}</span>
    </div>
  );
}

interface Props {
  data: DashboardV2 | null;
  loading: boolean;
}

export function SummaryCardsV2({ data, loading }: Props) {
  const tools = data ? Object.keys(data.by_tool) : [];

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {/* 今日会话 */}
      <div style={card}>
        <p style={labelStyle}>今日会话</p>
        {loading ? <Skeleton /> : <p style={bigNum}>{data?.session_count ?? 0}</p>}
      </div>

      {/* 人工交互 */}
      <div style={card}>
        <p style={labelStyle}>人工交互</p>
        {loading ? <Skeleton /> : <p style={bigNum}>{data?.human_input_count ?? 0}</p>}
      </div>

      {/* 活跃工具 + proxy 请求数 */}
      <div style={card}>
        <p style={labelStyle}>活跃工具</p>
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
                  {tool} · {data!.by_tool[tool]}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Cache Tokens (day-slice) */}
      <div style={card}>
        <p style={labelStyle}>Cache Tokens <span style={{ color: "#d1d5db", fontWeight: 400 }}>(今日)</span></p>
        {loading ? <Skeleton /> : !data ? (
          <p style={{ fontSize: 14, color: "#9ca3af" }}>—</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2 }}>
            <TokenRow label="cache write" value={data.cache_creation_tokens} color="#d97706" />
            <TokenRow label="cache read"  value={data.cache_read_tokens}     color="#059669" />
          </div>
        )}
      </div>

      {/* All Tokens (day-slice) */}
      <div style={card}>
        <p style={labelStyle}>All Tokens <span style={{ color: "#d1d5db", fontWeight: 400 }}>(今日)</span></p>
        {loading ? <Skeleton /> : !data ? (
          <p style={{ fontSize: 14, color: "#9ca3af" }}>—</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2 }}>
            <TokenRow label="read (input)"   value={data.input_tokens}  color="#6366f1" />
            <TokenRow label="write (output)" value={data.output_tokens} color="#7c3aed" />
          </div>
        )}
      </div>

      {/* 工具调用 + Events */}
      <div style={card}>
        <p style={labelStyle}>工具调用 / 事件</p>
        {loading ? <Skeleton /> : !data ? (
          <p style={{ fontSize: 14, color: "#9ca3af" }}>—</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2 }}>
            <TokenRow label="tool calls" value={data.tool_call_count} color="#0891b2" />
            <TokenRow label="events"     value={data.events}          color="#6b7280" />
          </div>
        )}
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`}</style>
    </div>
  );
}
