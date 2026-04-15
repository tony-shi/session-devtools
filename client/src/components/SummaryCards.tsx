import type { SummaryData } from "../types";

const TOOL_COLORS: Record<string, string> = {
  claude: "bg-violet-100 text-violet-700",
  codex: "bg-blue-100 text-blue-700",
  gemini: "bg-emerald-100 text-emerald-700",
};

interface Props {
  data: SummaryData | null;
  loading: boolean;
}

function Skeleton() {
  return <div className="h-5 bg-gray-200 rounded animate-pulse" />;
}

export function SummaryCards({ data, loading }: Props) {
  const tools = data ? Object.keys(data.by_tool) : [];

  return (
    <div className="grid grid-cols-3 gap-4">
      {/* Total sessions */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <p className="text-xs text-gray-500 mb-1">总会话数</p>
        {loading ? (
          <Skeleton />
        ) : (
          <p className="text-2xl font-semibold text-gray-900">{data?.total_sessions ?? 0}</p>
        )}
      </div>

      {/* Total turns */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <p className="text-xs text-gray-500 mb-1">总轮次</p>
        {loading ? (
          <Skeleton />
        ) : (
          <p className="text-2xl font-semibold text-gray-900">{data?.total_turns ?? 0}</p>
        )}
      </div>

      {/* Active tools */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <p className="text-xs text-gray-500 mb-2">活跃工具</p>
        {loading ? (
          <Skeleton />
        ) : tools.length === 0 ? (
          <p className="text-sm text-gray-400">—</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tools.map((tool) => (
              <span
                key={tool}
                className={`text-xs px-2 py-0.5 rounded-full font-medium ${TOOL_COLORS[tool] ?? "bg-gray-100 text-gray-700"}`}
              >
                {tool} {data!.by_tool[tool].sessions}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
