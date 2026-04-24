import type { ContextSnapshot } from "./types";
import { ALL_CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS } from "./types";

interface Props {
  snapshot: ContextSnapshot;
  onClose: () => void;
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="text-xs font-mono text-gray-600 w-10 text-right">{fmtK(value)}</span>
    </div>
  );
}

export function CompactionDiff({ snapshot, onClose }: Props) {
  const { compactionDelta, tokensByCategory, compactionSummary } = snapshot;
  const pre = compactionDelta?.pre ?? 0;
  const post = compactionDelta?.post ?? snapshot.estimatedTotal;
  const freed = pre - post;
  const pctFreed = pre > 0 ? Math.round((freed / pre) * 100) : 0;

  // Pre-compaction breakdown — we only have the post-compaction snapshot here.
  // Show what we know: post breakdown + delta summary.
  const maxVal = Math.max(pre, post, 1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Compaction Event</h3>
            <p className="text-xs text-gray-400">Turn {snapshot.turnIndex} · Phase {snapshot.phase - 1} → {snapshot.phase}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-gray-100 text-gray-400"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Pre / Post summary */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-red-50 rounded-xl p-3">
              <p className="text-xs text-red-500 font-medium mb-1">Pre-compaction</p>
              <p className="text-xl font-bold text-red-700">{fmtK(pre)}</p>
              <p className="text-xs text-red-400">tokens</p>
            </div>
            <div className="bg-green-50 rounded-xl p-3">
              <p className="text-xs text-green-500 font-medium mb-1">Post-compaction</p>
              <p className="text-xl font-bold text-green-700">{fmtK(post)}</p>
              <p className="text-xs text-green-400">tokens</p>
            </div>
          </div>

          {/* Delta */}
          <div className="flex items-center gap-3 px-3 py-2 bg-gray-50 rounded-lg">
            <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-400 rounded-full"
                style={{ width: `${pctFreed}%` }}
              />
            </div>
            <span className="text-sm font-semibold text-emerald-600">
              -{fmtK(freed)} freed ({pctFreed}%)
            </span>
          </div>

          {/* Post-compaction breakdown */}
          <div>
            <p className="text-xs font-medium text-gray-500 mb-2">Post-compaction context</p>
            <div className="space-y-1.5">
              {ALL_CATEGORIES
                .filter((c) => (tokensByCategory[c] ?? 0) > 0)
                .map((c) => (
                  <div key={c} className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-sm flex-shrink-0"
                      style={{ background: CATEGORY_COLORS[c] }}
                    />
                    <span className="text-xs text-gray-500 w-24 truncate">{CATEGORY_LABELS[c]}</span>
                    <Bar value={tokensByCategory[c]} max={maxVal} color={CATEGORY_COLORS[c]} />
                  </div>
                ))}
            </div>
          </div>

          {/* Compaction summary preview */}
          {compactionSummary && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Summary preview</p>
              <pre className="text-xs text-gray-600 bg-gray-50 rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">
                {compactionSummary}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
