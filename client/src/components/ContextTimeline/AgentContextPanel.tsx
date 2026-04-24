import { useState } from "react";
import type { AgentContextTrace, ContextSnapshot } from "./types";
import { ALL_CATEGORIES, ALL_CATEGORIES_WITH_OVERHEAD, CATEGORY_COLORS, CATEGORY_LABELS } from "./types";
import { StackedAreaChart } from "./StackedAreaChart";
import { CompactionDiff } from "./CompactionDiff";
import { TurnProvenanceView } from "./TurnProvenanceView";

interface Props {
  trace: AgentContextTrace;
  onTurnClick?: (turnIndex: number) => void;
  highlightedTurnIndex?: number | null;
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function AgentContextPanel({ trace, onTurnClick, highlightedTurnIndex }: Props) {
  const [compactionSnap, setCompactionSnap] = useState<ContextSnapshot | null>(null);
  const [provenanceTurnIndex, setProvenanceTurnIndex] = useState<number | null>(null);

  const lastSnap = trace.snapshots[trace.snapshots.length - 1];
  const displayTotal = lastSnap
    ? (lastSnap.measuredTotal || lastSnap.estimatedTotal)
    : 0;
  const fillPct = Math.min(100, (displayTotal / trace.contextLimit) * 100);
  const overheadPct = lastSnap
    ? Math.min(100, (lastSnap.systemOverhead / trace.contextLimit) * 100)
    : 0;

  return (
    <div className="space-y-4">
      {/* Current fill bar */}
      {lastSnap && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-gray-600">
              {lastSnap.measuredTotal > 0 ? (
                <>
                  <span className="text-indigo-600 font-semibold">{fmtK(lastSnap.measuredTotal)}</span>
                  <span className="text-gray-400 ml-1">measured</span>
                  <span className="text-gray-400 ml-1">(~{fmtK(lastSnap.estimatedTotal)} estimated)</span>
                </>
              ) : (
                <span>~{fmtK(lastSnap.estimatedTotal)}</span>
              )}
              {" / "}{fmtK(trace.contextLimit)}
            </span>
            <span className="text-xs text-gray-400">{fillPct.toFixed(1)}%</span>
          </div>

          {/* Segmented fill bar — estimated categories + overhead hatched */}
          <div className="h-3 rounded-full overflow-hidden bg-gray-100 flex">
            {ALL_CATEGORIES.map((cat) => {
              const tokens = lastSnap.tokensByCategory[cat] ?? 0;
              const pct = (tokens / trace.contextLimit) * 100;
              if (pct < 0.1) return null;
              return (
                <div key={cat} title={`${CATEGORY_LABELS[cat]}: ${fmtK(tokens)}`}
                  style={{ width: `${pct}%`, background: CATEGORY_COLORS[cat] }} />
              );
            })}
            {/* Overhead segment */}
            {overheadPct > 0.1 && (
              <div
                title={`System overhead: ${fmtK(lastSnap.systemOverhead)} (tool schemas + base instructions)`}
                style={{
                  width: `${overheadPct}%`,
                  background: "repeating-linear-gradient(45deg, #9ca3af, #9ca3af 2px, #e5e7eb 2px, #e5e7eb 6px)",
                }}
              />
            )}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2">
            {ALL_CATEGORIES_WITH_OVERHEAD
              .filter((c) => (lastSnap.tokensByCategory[c] ?? 0) > 0)
              .map((c) => (
                <span key={c} className="flex items-center gap-1 text-xs text-gray-500">
                  <span className="w-2 h-2 rounded-sm" style={{ background: CATEGORY_COLORS[c] }} />
                  {CATEGORY_LABELS[c]} {fmtK(lastSnap.tokensByCategory[c])}
                </span>
              ))}
          </div>
        </div>
      )}

      {/* Stats row */}
      <div className="flex gap-4 text-xs text-gray-400">
        <span><strong className="text-gray-600">{trace.snapshots.length}</strong> turns</span>
        <span><strong className="text-gray-600">{trace.totalPhases}</strong> phases</span>
        {trace.snapshots.filter((s) => s.isCompactionBoundary).length > 0 && (
          <span className="text-red-500">
            <strong>{trace.snapshots.filter((s) => s.isCompactionBoundary).length}</strong> compaction{trace.snapshots.filter((s) => s.isCompactionBoundary).length > 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Stacked area chart — click a turn to open TurnProvenanceView */}
      <div className="relative">
        {provenanceTurnIndex === null && (
          <div className="absolute -top-5 right-0 text-xs text-gray-400 pointer-events-none">
            点击任意 turn 查看溯源
          </div>
        )}
        <StackedAreaChart
          snapshots={trace.snapshots}
          contextLimit={trace.contextLimit}
          onTurnClick={(idx) => {
            setProvenanceTurnIndex(idx);
            onTurnClick?.(idx);
          }}
          onCompactionClick={setCompactionSnap}
          highlightedTurnIndex={provenanceTurnIndex ?? highlightedTurnIndex}
        />
      </div>

      {/* Compaction diff modal */}
      {compactionSnap && (
        <CompactionDiff
          snapshot={compactionSnap}
          onClose={() => setCompactionSnap(null)}
        />
      )}

      {/* Turn provenance panel — slides in from right on turn click */}
      {provenanceTurnIndex !== null && (() => {
        const snap = trace.snapshots.find((s) => s.turnIndex === provenanceTurnIndex);
        const prevSnap = trace.snapshots.find((s) => s.turnIndex === provenanceTurnIndex - 1) ?? null;
        return snap ? (
          <TurnProvenanceView
            snapshot={snap}
            prevSnapshot={prevSnap}
            contextLimit={trace.contextLimit}
            onClose={() => setProvenanceTurnIndex(null)}
          />
        ) : null;
      })()}
    </div>
  );
}
