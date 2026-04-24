import { useState, useRef, useCallback } from "react";
import type { ContextSnapshot } from "./types";
import { ALL_CATEGORIES, ALL_CATEGORIES_WITH_OVERHEAD, CATEGORY_COLORS, CATEGORY_LABELS } from "./types";

interface Props {
  snapshots: ContextSnapshot[];
  contextLimit: number;
  onTurnClick?: (turnIndex: number) => void;
  onCompactionClick?: (snapshot: ContextSnapshot) => void;
  highlightedTurnIndex?: number | null;
}

const MARGIN = { top: 16, right: 24, bottom: 32, left: 60 };
const HEIGHT = 240;

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// SVG hatching pattern id
const HATCH_ID = "overhead-hatch";

export function StackedAreaChart({
  snapshots,
  contextLimit,
  onTurnClick,
  onCompactionClick,
  highlightedTurnIndex,
}: Props) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [svgWidth, setSvgWidth] = useState(800);

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setSvgWidth(w);
    });
    ro.observe(node);
  }, []);

  if (snapshots.length === 0) {
    return <div className="flex items-center justify-center h-32 text-xs text-gray-400">No context data</div>;
  }

  const chartW = svgWidth - MARGIN.left - MARGIN.right;
  const chartH = HEIGHT - MARGIN.top - MARGIN.bottom;

  // Y axis uses measuredTotal when available, else estimatedTotal
  const maxY = Math.max(
    contextLimit,
    ...snapshots.map((s) => s.measuredTotal || s.estimatedTotal),
  );

  const xScale = (i: number) =>
    snapshots.length <= 1 ? chartW / 2 : (i / (snapshots.length - 1)) * chartW;
  const yScale = (v: number) => chartH - (v / maxY) * chartH;

  // Build stacked area for estimated categories (bottom stack)
  type StackPoint = { x: number; y0: number; y1: number };
  const stackedPaths: Array<{ category: string; color: string; points: StackPoint[] }> = [];

  for (let ci = 0; ci < ALL_CATEGORIES.length; ci++) {
    const cat = ALL_CATEGORIES[ci];
    const points: StackPoint[] = snapshots.map((snap, i) => {
      const x = xScale(i);
      const base = ALL_CATEGORIES.slice(0, ci).reduce(
        (sum, c) => sum + (snap.tokensByCategory[c] ?? 0), 0,
      );
      const top = base + (snap.tokensByCategory[cat] ?? 0);
      return { x, y0: yScale(base), y1: yScale(top) };
    });
    stackedPaths.push({ category: cat, color: CATEGORY_COLORS[cat], points });
  }

  // Overhead area: from estimatedTotal to measuredTotal
  const overheadPoints: StackPoint[] = snapshots.map((snap, i) => {
    const x = xScale(i);
    const estTop = snap.estimatedTotal;
    const measTop = snap.measuredTotal || estTop;
    return { x, y0: yScale(estTop), y1: yScale(measTop) };
  });

  function areaPath(points: StackPoint[]): string {
    if (points.length === 0) return "";
    const top = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y1.toFixed(1)}`).join(" ");
    const bottom = [...points].reverse().map((p) => `L${p.x.toFixed(1)},${p.y0.toFixed(1)}`).join(" ");
    return `${top} ${bottom} Z`;
  }

  const yTicks = [0, 0.25, 0.5, 0.75, 1.0].map((f) => ({
    value: Math.round(maxY * f),
    y: yScale(maxY * f),
  }));

  const compactionIndices = snapshots
    .map((s, i) => (s.isCompactionBoundary ? i : -1))
    .filter((i) => i >= 0);

  const limitY = yScale(contextLimit);
  const hoverSnap = hoverIdx !== null ? snapshots[hoverIdx] : null;

  return (
    <div ref={containerRef} className="w-full select-none">
      <svg width={svgWidth} height={HEIGHT} className="overflow-visible" onMouseLeave={() => setHoverIdx(null)}>
        <defs>
          {/* Diagonal hatch for system_overhead */}
          <pattern id={HATCH_ID} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="#9ca3af" strokeWidth="1.5" opacity="0.5" />
          </pattern>
        </defs>

        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* Y grid + labels */}
          {yTicks.map((t) => (
            <g key={t.value}>
              <line x1={0} y1={t.y} x2={chartW} y2={t.y} stroke="#e5e7eb" strokeWidth={1} />
              <text x={-6} y={t.y} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="#9ca3af">
                {fmtK(t.value)}
              </text>
            </g>
          ))}

          {/* Context limit line */}
          {contextLimit <= maxY && (
            <g>
              <line x1={0} y1={limitY} x2={chartW} y2={limitY} stroke="#ef4444" strokeWidth={1} strokeDasharray="4 3" opacity={0.5} />
              <text x={chartW - 2} y={limitY - 4} textAnchor="end" fontSize={9} fill="#ef4444" opacity={0.7}>200k limit</text>
            </g>
          )}

          {/* Stacked estimated areas */}
          {stackedPaths.map(({ category, color, points }) => (
            <path key={category} d={areaPath(points)} fill={color} opacity={0.78} />
          ))}

          {/* System overhead — hatched gray on top of estimated stack */}
          <path d={areaPath(overheadPoints)} fill={`url(#${HATCH_ID})`} opacity={0.9} />
          <path d={areaPath(overheadPoints)} fill="#9ca3af" opacity={0.15} />

          {/* Compaction lines */}
          {compactionIndices.map((i) => {
            const x = xScale(i);
            const snap = snapshots[i];
            return (
              <g key={i}>
                <line x1={x} y1={0} x2={x} y2={chartH} stroke="#ef4444" strokeWidth={2} />
                <rect x={x - 8} y={chartH / 2 - 8} width={16} height={16} rx={3}
                  fill="#ef4444" opacity={0.9} className="cursor-pointer"
                  onClick={() => onCompactionClick?.(snap)} />
                <text x={x} y={chartH / 2 + 1} textAnchor="middle" dominantBaseline="middle"
                  fontSize={9} fill="white" className="pointer-events-none">C</text>
              </g>
            );
          })}

          {/* External highlight line */}
          {highlightedTurnIndex != null && (() => {
            const idx = snapshots.findIndex((s) => s.turnIndex === highlightedTurnIndex);
            if (idx < 0) return null;
            return <line x1={xScale(idx)} y1={0} x2={xScale(idx)} y2={chartH}
              stroke="#6366f1" strokeWidth={2} pointerEvents="none" />;
          })()}

          {/* Hover line */}
          {hoverIdx !== null && (
            <line x1={xScale(hoverIdx)} y1={0} x2={xScale(hoverIdx)} y2={chartH}
              stroke="#374151" strokeWidth={1} strokeDasharray="3 2" pointerEvents="none" />
          )}

          {/* Hover hit areas */}
          {snapshots.map((snap, i) => {
            const x = xScale(i);
            const halfW = snapshots.length > 1 ? (xScale(1) - xScale(0)) / 2 : chartW / 2;
            return (
              <rect key={i} x={x - halfW} y={0} width={halfW * 2} height={chartH}
                fill="transparent" className="cursor-pointer"
                onMouseEnter={() => setHoverIdx(i)}
                onClick={() => onTurnClick?.(snap.turnIndex)} />
            );
          })}

          {/* X axis */}
          <line x1={0} y1={chartH} x2={chartW} y2={chartH} stroke="#d1d5db" strokeWidth={1} />
          {snapshots
            .filter((_, i) => {
              const step = Math.max(1, Math.floor(snapshots.length / 6));
              return i % step === 0 || i === snapshots.length - 1;
            })
            .map((snap) => {
              const idx = snapshots.indexOf(snap);
              return (
                <text key={snap.turnIndex} x={xScale(idx)} y={chartH + 14}
                  textAnchor="middle" fontSize={10} fill="#9ca3af">{snap.turnIndex}</text>
              );
            })}
          <text x={chartW / 2} y={chartH + 28} textAnchor="middle" fontSize={10} fill="#9ca3af">turn</text>
        </g>
      </svg>

      {/* Hover tooltip */}
      {hoverSnap && (
        <div className="mt-2 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200 text-xs space-y-1.5">
          {/* Header row */}
          <div className="flex items-center gap-3 font-medium text-gray-700 flex-wrap">
            <span>Turn {hoverSnap.turnIndex}</span>
            <span className="text-gray-400">Phase {hoverSnap.phase}</span>
            {hoverSnap.measuredTotal > 0 ? (
              <>
                <span className="text-indigo-600 font-semibold">{fmtK(hoverSnap.measuredTotal)} measured</span>
                <span className="text-gray-400">(~{fmtK(hoverSnap.estimatedTotal)} estimated)</span>
              </>
            ) : (
              <span>~{fmtK(hoverSnap.estimatedTotal)} tokens</span>
            )}
          </div>

          {/* Per-category breakdown */}
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            {ALL_CATEGORIES_WITH_OVERHEAD
              .filter((c) => (hoverSnap.tokensByCategory[c] ?? 0) > 0)
              .map((c) => (
                <span key={c} className="flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-sm flex-shrink-0"
                    style={{ background: CATEGORY_COLORS[c] }} />
                  <span className="text-gray-500">{CATEGORY_LABELS[c]}</span>
                  <span className="text-gray-700 font-mono">{fmtK(hoverSnap.tokensByCategory[c])}</span>
                </span>
              ))}
          </div>

          {/* Tool output per-tool breakdown */}
          {hoverSnap.toolOutputByTool.length > 0 && (
            <div className="text-gray-500 pl-1 border-l-2 border-amber-300">
              {hoverSnap.toolOutputByTool.slice(0, 5).map((t) => (
                <span key={t.toolName} className="mr-3">
                  <span className="font-mono text-amber-700">{t.toolName}</span>
                  {" "}{fmtK(t.tokens)}
                </span>
              ))}
              {hoverSnap.toolOutputByTool.length > 5 && <span>+{hoverSnap.toolOutputByTool.length - 5} more</span>}
            </div>
          )}

          {/* New injections this turn */}
          {hoverSnap.newInjections.length > 0 && (
            <div className="text-gray-500">
              +{hoverSnap.newInjections.length} new:{" "}
              {hoverSnap.newInjections.slice(0, 4).map((inj, i) => (
                <span key={i} className="mr-2">
                  <span style={{ color: CATEGORY_COLORS[inj.category] }}>{CATEGORY_LABELS[inj.category]}</span>
                  {" "}({fmtK(inj.tokens)})
                </span>
              ))}
              {hoverSnap.newInjections.length > 4 && <span>…</span>}
            </div>
          )}

          {/* Overhead explanation */}
          {hoverSnap.systemOverhead > 0 && (
            <div className="flex items-center gap-1.5 text-gray-400 text-xs border-t border-gray-200 pt-1">
              <span className="w-3 h-2 rounded-sm opacity-60"
                style={{ background: `repeating-linear-gradient(45deg, #9ca3af, #9ca3af 1px, transparent 1px, transparent 4px)` }} />
              <span>
                System overhead ~{fmtK(hoverSnap.systemOverhead)} tokens
                <span className="ml-1 text-gray-300">(tool schemas + base instructions, not in JSONL)</span>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
