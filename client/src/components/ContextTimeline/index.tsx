import { useState } from "react";
import type { AgentContextTrace } from "./types";
import { AgentContextPanel } from "./AgentContextPanel";

interface Props {
  traces: AgentContextTrace[];
  onTurnClick?: (agentId: string, turnIndex: number) => void;
  /** IR span id currently selected in other views — highlights the matching turn */
  selectedSpanId?: string | null;
  /** Map from spanId → {agentId, turnIndex} built by SessionDetail */
  spanTurnMap?: Map<string, { agentId: string; turnIndex: number }>;
}

export function ContextTimeline({ traces, onTurnClick, selectedSpanId, spanTurnMap }: Props) {
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    traces[0]?.agentId ?? "main",
  );

  // When an external span is selected, switch to its agent tab
  const externalSelection = selectedSpanId && spanTurnMap
    ? spanTurnMap.get(selectedSpanId)
    : null;

  const effectiveAgentId = externalSelection?.agentId ?? selectedAgentId;
  const highlightedTurnIndex = externalSelection?.turnIndex ?? null;

  if (traces.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-gray-400">
        No context data available
      </div>
    );
  }

  const activeTrace =
    traces.find((t) => t.agentId === effectiveAgentId) ?? traces[0];

  // Sort: main first, then by agentId
  const sorted = [...traces].sort((a, b) => {
    if (a.agentId === "main") return -1;
    if (b.agentId === "main") return 1;
    return a.agentId.localeCompare(b.agentId);
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Agent tab bar */}
      {sorted.length > 1 && (
        <div className="flex-shrink-0 flex items-center gap-1 px-4 py-2 border-b border-gray-200 overflow-x-auto">
          {sorted.map((trace) => {
            const isActive = trace.agentId === selectedAgentId;
            const hasCompaction = trace.snapshots.some((s) => s.isCompactionBoundary);
            return (
              <button
                key={trace.agentId}
                onClick={() => { setSelectedAgentId(trace.agentId); }}
                className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                    : "text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                }`}
              >
                <span className="truncate max-w-[120px]">{trace.agentName}</span>
                <span className={`text-xs ${isActive ? "text-indigo-400" : "text-gray-400"}`}>
                  {trace.snapshots.length}t
                </span>
                {hasCompaction && (
                  <span className="w-1.5 h-1.5 rounded-full bg-red-400 flex-shrink-0" title="Has compaction" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Active agent panel */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <AgentContextPanel
          trace={activeTrace}
          onTurnClick={(turnIndex) => onTurnClick?.(activeTrace.agentId, turnIndex)}
          highlightedTurnIndex={highlightedTurnIndex}
        />
      </div>
    </div>
  );
}
