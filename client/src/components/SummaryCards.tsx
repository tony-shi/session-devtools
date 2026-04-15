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

const cardStyle: React.CSSProperties = {
  background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb",
  padding: "16px 20px", flex: 1,
};

function Skeleton() {
  return (
    <div style={{ height: 32, background: "#e5e7eb", borderRadius: 6, animation: "pulse 1.5s ease-in-out infinite" }} />
  );
}

export function SummaryCards({ data, loading }: Props) {
  const tools = data ? Object.keys(data.by_tool) : [];

  return (
    <div style={{ display: "flex", gap: 16 }}>
      <div style={cardStyle}>
        <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>总会话数</p>
        {loading ? <Skeleton /> : (
          <p style={{ fontSize: 28, fontWeight: 700, color: "#111827", lineHeight: 1 }}>
            {data?.total_sessions ?? 0}
          </p>
        )}
      </div>

      <div style={cardStyle}>
        <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>总轮次</p>
        {loading ? <Skeleton /> : (
          <p style={{ fontSize: 28, fontWeight: 700, color: "#111827", lineHeight: 1 }}>
            {data?.total_turns ?? 0}
          </p>
        )}
      </div>

      <div style={cardStyle}>
        <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>活跃工具</p>
        {loading ? <Skeleton /> : tools.length === 0 ? (
          <p style={{ fontSize: 14, color: "#9ca3af" }}>—</p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {tools.map((tool) => {
              const c = TOOL_COLORS[tool] ?? { bg: "#f3f4f6", color: "#374151" };
              return (
                <span key={tool} style={{
                  fontSize: 13, padding: "3px 10px", borderRadius: 20,
                  background: c.bg, color: c.color, fontWeight: 500,
                }}>
                  {tool} · {data!.by_tool[tool].sessions}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`}</style>
    </div>
  );
}
