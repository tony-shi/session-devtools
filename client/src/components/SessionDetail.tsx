import { useEffect, useState } from "react";
import { api } from "../api";
import type { StatsResponse, Turn, TurnsResponse } from "../types";

interface Props {
  sessionId: string;
  date: string;
  onClose: () => void;
}

interface TracePair {
  user: Turn | null;
  loop: Turn[];
  final: Turn | null;
}

function groupIntoPairs(turns: Turn[]): TracePair[] {
  const pairs: TracePair[] = [];
  let currentUser: Turn | null = null;
  let loopTurns: Turn[] = [];

  function flush() {
    if (!currentUser && loopTurns.length === 0) return;
    // Find final: last assistant turn
    let final: Turn | null = null;
    const loop: Turn[] = [];
    for (let i = loopTurns.length - 1; i >= 0; i--) {
      if (!final && loopTurns[i].role === "assistant" && loopTurns[i].turn_kind !== "assistant_tool") {
        final = loopTurns[i];
      } else {
        loop.unshift(loopTurns[i]);
      }
    }
    // If we only have assistant_tool turns, last one is final
    if (!final && loopTurns.length > 0) {
      final = loopTurns[loopTurns.length - 1];
      loopTurns.slice(0, -1).forEach((t) => loop.push(t));
    }
    pairs.push({ user: currentUser, loop, final });
  }

  for (const turn of turns) {
    if (turn.turn_kind === "human_input") {
      flush();
      currentUser = turn;
      loopTurns = [];
    } else {
      loopTurns.push(turn);
    }
  }
  flush();

  return pairs;
}

const KIND_COLORS: Record<string, string> = {
  human_input: "bg-indigo-500",
  assistant: "bg-violet-500",
  assistant_tool: "bg-amber-500",
  tool_result: "bg-emerald-500",
};

const KIND_LABELS: Record<string, string> = {
  human_input: "User",
  assistant: "AI",
  assistant_tool: "AI (tools)",
  tool_result: "Tool result",
};

function LoopStep({ turn }: { turn: Turn }) {
  const [expanded, setExpanded] = useState(false);
  const dotColor = KIND_COLORS[turn.turn_kind] ?? "bg-gray-400";
  const label = KIND_LABELS[turn.turn_kind] ?? turn.turn_kind;
  const preview = turn.content?.slice(0, 120) ?? "";

  return (
    <div className="relative pl-6">
      {/* Vertical connector */}
      <div className="absolute left-2 top-0 bottom-0 w-px bg-gray-200" />
      {/* Dot */}
      <div className={`absolute left-0.5 top-2 w-3 h-3 rounded-full ${dotColor} ring-2 ring-white`} />

      <div className="pb-3">
        <div
          className="flex items-center gap-2 cursor-pointer group"
          onClick={() => setExpanded(!expanded)}
        >
          <span className="text-xs font-medium text-gray-500">{label}</span>
          {turn.tool_names?.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {turn.tool_names.map((n, i) => (
                <span key={i} className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-mono">
                  {n}
                </span>
              ))}
            </div>
          )}
          {(turn.input_tokens > 0 || turn.output_tokens > 0) && (
            <span className="text-xs text-gray-400 ml-auto">
              {turn.input_tokens > 0 && `in:${turn.input_tokens}`}
              {turn.output_tokens > 0 && ` out:${turn.output_tokens}`}
            </span>
          )}
          <svg
            className={`w-3 h-3 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>

        {!expanded && preview && (
          <p className="text-xs text-gray-500 mt-0.5 truncate">{preview}</p>
        )}
        {expanded && turn.content && (
          <pre className="mt-1 text-xs text-gray-700 whitespace-pre-wrap break-words bg-gray-50 rounded-md p-2 max-h-64 overflow-y-auto">
            {turn.content}
          </pre>
        )}
      </div>
    </div>
  );
}

function TracePairView({ pair, index }: { pair: TracePair; index: number }) {
  const [loopOpen, setLoopOpen] = useState(false);

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      {/* User input header */}
      {pair.user && (
        <div className="flex items-start gap-3 p-4 bg-indigo-50 border-b border-indigo-100">
          <div className="w-5 h-5 rounded-full bg-indigo-500 flex items-center justify-center flex-shrink-0 mt-0.5">
            <span className="text-white text-xs font-bold">{index + 1}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-indigo-900 font-medium leading-relaxed">
              {pair.user.content || "(empty)"}
            </p>
            <p className="text-xs text-indigo-500 mt-1">
              {pair.user.timestamp ? new Date(pair.user.timestamp).toLocaleTimeString("zh-CN") : ""}
            </p>
          </div>
        </div>
      )}

      {/* Loop (collapsible) */}
      {pair.loop.length > 0 && (
        <div className="border-b border-gray-100">
          <button
            onClick={() => setLoopOpen(!loopOpen)}
            className="w-full flex items-center gap-2 px-4 py-2 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
          >
            <svg
              className={`w-3 h-3 transition-transform ${loopOpen ? "rotate-90" : ""}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <span>{pair.loop.length} 步工具调用</span>
            <div className="flex gap-1 ml-1">
              {Array.from(new Set(pair.loop.flatMap((t) => t.tool_names ?? []))).slice(0, 5).map((n) => (
                <span key={n} className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 font-mono">
                  {n}
                </span>
              ))}
            </div>
          </button>
          {loopOpen && (
            <div className="px-4 py-2">
              {pair.loop.map((t) => (
                <LoopStep key={t.id} turn={t} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Final response (always visible) */}
      {pair.final && (
        <div className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-4 h-4 rounded-full bg-violet-500 flex-shrink-0" />
            <span className="text-xs font-medium text-gray-500">AI 最终回复</span>
            {pair.final.output_tokens > 0 && (
              <span className="text-xs text-gray-400 ml-auto">
                {pair.final.output_tokens} tokens
              </span>
            )}
          </div>
          <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
            {pair.final.content || "(empty)"}
          </p>
        </div>
      )}
    </div>
  );
}

export function SessionDetail({ sessionId, date, onClose }: Props) {
  const [turnsData, setTurnsData] = useState<TurnsResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    Promise.all([api.stats(sessionId, date), api.turns(sessionId, date)])
      .then(([s, t]) => {
        setStats(s);
        setTurnsData(t);
      })
      .catch((e) => setError(String(e?.message)))
      .finally(() => setLoading(false));
  }, [sessionId, date]);

  const pairs = turnsData ? groupIntoPairs(turnsData.turns) : [];

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="relative ml-auto w-full max-w-2xl bg-white shadow-2xl flex flex-col h-full">
        {/* Panel header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {turnsData?.session.project ?? sessionId.slice(0, 8)}
            </p>
            <p className="text-xs text-gray-400 truncate">{sessionId}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-600 flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Token stats */}
        {stats && (
          <div className="flex gap-4 px-5 py-3 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 flex-shrink-0">
            <span>输入 <strong className="text-gray-700">{stats.tokens.input.toLocaleString()}</strong></span>
            <span>输出 <strong className="text-gray-700">{stats.tokens.output.toLocaleString()}</strong></span>
            {stats.tokens.cache_read > 0 && (
              <span>缓存读 <strong className="text-gray-700">{stats.tokens.cache_read.toLocaleString()}</strong></span>
            )}
            {stats.tool_calls.total > 0 && (
              <span>工具调用 <strong className="text-gray-700">{stats.tool_calls.total}</strong></span>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading && (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-24 bg-gray-100 rounded-xl animate-pulse" />
              ))}
            </div>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
          {!loading && pairs.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">当天无对话数据</p>
          )}
          {pairs.map((pair, i) => (
            <TracePairView key={i} pair={pair} index={i} />
          ))}
        </div>
      </div>
    </div>
  );
}
