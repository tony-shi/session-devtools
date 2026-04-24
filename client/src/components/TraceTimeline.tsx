// Swimlane timeline view: complements agent-prism's waterfall TreeView.
//
// Why a second view: waterfall shows each span's time bar individually but
// can't visually answer "were these 8 subagents running in parallel?" — the
// tree structure dominates the layout. A swimlane with one row per agent and
// a shared horizontal time axis makes parallelism obvious at a glance.

import { useMemo, useState } from "react";
import type { AgentSpan } from "@session-dashboard/agent-viz";

interface Props {
  spans: AgentSpan[];
  selectedSpanId?: string | null;
  onSpanSelect?: (spanId: string) => void;
}

interface Lane {
  id: string;         // agent id ("main" or subagent id)
  label: string;      // display name
  kind: "main" | "subagent";
  spans: AgentSpan[]; // spans in this lane (excluding session/subagent roots)
}

const KIND_COLORS: Record<AgentSpan["kind"], string> = {
  session: "bg-gray-400",
  turn: "bg-violet-500",
  tool_call: "bg-amber-500",
  tool_result: "bg-emerald-500",
  message: "bg-indigo-400",
};

function laneKey(s: AgentSpan): { id: string; label: string; kind: "main" | "subagent" } {
  const subId = s.attributes?.["claude.subagent.id"];
  const subName = s.attributes?.["claude.subagent.name"];
  if (typeof subId === "string") {
    return {
      id: subId,
      label:
        typeof subName === "string" && subName
          ? subName
          : `sub:${subId.slice(0, 8)}`,
      kind: "subagent",
    };
  }
  return { id: "main", label: "main", kind: "main" };
}

export function TraceTimeline({ spans, selectedSpanId, onSpanSelect }: Props) {
  const [hover, setHover] = useState<AgentSpan | null>(null);

  const { lanes, tMin, tMax } = useMemo(() => {
    let tMin = Infinity;
    let tMax = -Infinity;
    const byLane = new Map<string, Lane>();
    // Stable order: discover lanes by first-occurrence time.
    for (const s of spans) {
      if (s.kind === "session") continue;
      const end = s.endTime ?? s.startTime;
      if (s.startTime && s.startTime < tMin) tMin = s.startTime;
      if (end && end > tMax) tMax = end;
      const { id, label, kind } = laneKey(s);
      // Only include tool_call and turn spans in lane content; subagent root
      // (kind="turn" named "invoke_agent ...") goes under its own lane too.
      let lane = byLane.get(id);
      if (!lane) {
        lane = { id, label, kind, spans: [] };
        byLane.set(id, lane);
      }
      lane.spans.push(s);
    }
    const lanes = Array.from(byLane.values()).sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "main" ? -1 : 1;
      const aStart = Math.min(...a.spans.map((s) => s.startTime || Infinity));
      const bStart = Math.min(...b.spans.map((s) => s.startTime || Infinity));
      return aStart - bStart;
    });
    if (!isFinite(tMin)) tMin = 0;
    if (!isFinite(tMax)) tMax = tMin + 1;
    return { lanes, tMin, tMax };
  }, [spans]);

  const total = Math.max(1, tMax - tMin);
  const LANE_HEIGHT = 28;
  const LANE_LABEL_W = 160;
  const MIN_BAR_PX = 2;

  function fmtDur(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return `${m}m${s}s`;
  }

  // Axis ticks — 5 evenly spaced.
  const ticks = Array.from({ length: 6 }, (_, i) => ({
    pct: (i / 5) * 100,
    label: fmtDur(Math.round((i / 5) * total)),
  }));

  return (
    <div className="h-full flex flex-col bg-white">
      {/* Header / legend */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-200 text-xs text-gray-500 flex-shrink-0">
        <span className="font-medium text-gray-700">
          {lanes.length} lanes · {spans.length} spans · {fmtDur(total)}
        </span>
        <div className="flex items-center gap-3 ml-auto">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-sm bg-violet-500" /> turn
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-sm bg-amber-500" /> tool
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-sm bg-red-500" /> error
          </span>
        </div>
      </div>

      {/* Time axis */}
      <div
        className="relative flex-shrink-0 border-b border-gray-200 h-6"
        style={{ paddingLeft: LANE_LABEL_W }}
      >
        {ticks.map((t, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 border-l border-gray-200 pl-1 text-xs text-gray-400"
            style={{ left: `calc(${LANE_LABEL_W}px + ${t.pct}%)` }}
          >
            {t.label}
          </div>
        ))}
      </div>

      {/* Lanes */}
      <div className="flex-1 overflow-y-auto relative">
        {lanes.map((lane) => (
          <div
            key={lane.id}
            className="relative border-b border-gray-100 hover:bg-gray-50"
            style={{ height: LANE_HEIGHT }}
          >
            {/* Lane label */}
            <div
              className="absolute left-0 top-0 bottom-0 flex items-center px-3 text-xs font-mono text-gray-600 border-r border-gray-200 truncate bg-inherit"
              style={{ width: LANE_LABEL_W }}
              title={lane.label}
            >
              {lane.kind === "subagent" && (
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 mr-1.5 flex-shrink-0" />
              )}
              <span className="truncate">{lane.label}</span>
            </div>

            {/* Span bars */}
            <div
              className="absolute top-0 bottom-0 right-0"
              style={{ left: LANE_LABEL_W }}
            >
              {lane.spans.map((s) => {
                const end = s.endTime ?? s.startTime;
                const leftPct = ((s.startTime - tMin) / total) * 100;
                const widthPct = Math.max(
                  0,
                  ((end - s.startTime) / total) * 100,
                );
                const isSelected = selectedSpanId === s.id;
                const color =
                  s.status === "error"
                    ? "bg-red-500"
                    : s.kind === "tool_call"
                    ? "bg-amber-500"
                    : s.kind === "turn"
                    ? "bg-violet-500"
                    : KIND_COLORS[s.kind];
                return (
                  <div
                    key={s.id}
                    className={`absolute top-1.5 bottom-1.5 rounded-sm ${color} cursor-pointer transition-opacity ${
                      isSelected
                        ? "opacity-100 ring-2 ring-white ring-offset-1 ring-offset-indigo-500 z-10"
                        : "opacity-70 hover:opacity-100"
                    }`}
                    style={{
                      left: `${leftPct}%`,
                      width: `max(${MIN_BAR_PX}px, ${widthPct}%)`,
                    }}
                    onMouseEnter={() => setHover(s)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onSpanSelect?.(s.id)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Hover card */}
      {hover && (
        <div className="flex-shrink-0 border-t border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-700">
          <div className="flex items-center gap-3">
            <span className="font-mono font-medium">{hover.name}</span>
            <span className="text-gray-400">
              {fmtDur((hover.endTime ?? hover.startTime) - hover.startTime)}
            </span>
            {hover.attributes?.["gen_ai.tool.name"] && (
              <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-mono">
                {String(hover.attributes["gen_ai.tool.name"])}
              </span>
            )}
            {hover.status === "error" && (
              <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-700">error</span>
            )}
            {typeof hover.attributes?.["gen_ai.usage.total_tokens"] === "number" && (
              <span className="text-gray-500">
                {hover.attributes["gen_ai.usage.total_tokens"]} tokens
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
