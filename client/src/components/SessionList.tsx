import { useState } from "react";
import type { Session, SessionsResponse } from "../types";
import { SessionDetail } from "./SessionDetail";

const TOOL_BADGE: Record<string, string> = {
  claude: "bg-violet-100 text-violet-700",
  codex: "bg-blue-100 text-blue-700",
  gemini: "bg-emerald-100 text-emerald-700",
};

function fmt(ts: string) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function SessionRow({
  session,
  onClick,
}: {
  session: Session;
  onClick: () => void;
}) {
  const badge = TOOL_BADGE[session.tool] ?? "bg-gray-100 text-gray-600";
  const totalTokens = (session.input_tokens ?? 0) + (session.output_tokens ?? 0);

  return (
    <div
      onClick={onClick}
      className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors group"
    >
      <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${badge}`}>
        {session.tool}
      </span>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">
          {session.project || session.cwd?.split("/").pop() || session.id.slice(0, 8)}
        </p>
        {session.cwd && (
          <p className="text-xs text-gray-400 truncate">{session.cwd}</p>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-gray-400 flex-shrink-0">
        {session.human_turn_count > 0 && (
          <span className="flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            {session.human_turn_count}
          </span>
        )}
        {totalTokens > 0 && (
          <span>{(totalTokens / 1000).toFixed(1)}k tok</span>
        )}
        {session.tool_call_count > 0 && (
          <span className="flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {session.tool_call_count}
          </span>
        )}
        <span>{fmt(session.started_at)}</span>
      </div>

      <svg
        className="w-4 h-4 text-gray-300 group-hover:text-gray-500 flex-shrink-0 transition-colors"
        fill="none" stroke="currentColor" viewBox="0 0 24 24"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </div>
  );
}

interface Props {
  data: SessionsResponse | null;
  loading: boolean;
  date: string;
}

export function SessionList({ data, loading, date }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900">会话列表</h2>
        {data && (
          <span className="text-xs text-gray-400">{data.total} 条</span>
        )}
      </div>

      {loading ? (
        <div className="divide-y divide-gray-100">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="px-4 py-3 flex items-center gap-3">
              <div className="w-14 h-5 bg-gray-200 rounded-full animate-pulse" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 bg-gray-200 rounded animate-pulse w-1/2" />
                <div className="h-3 bg-gray-100 rounded animate-pulse w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : !data || data.sessions.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-10">当天无会话数据</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {data.sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              onClick={() => setSelectedId(s.id)}
            />
          ))}
        </div>
      )}

      {selectedId && (
        <SessionDetail
          sessionId={selectedId}
          date={date}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
