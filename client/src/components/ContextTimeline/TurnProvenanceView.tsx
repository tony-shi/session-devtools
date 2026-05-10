/**
 * TurnProvenanceView — per-turn context provenance panel.
 *
 * Shows WHERE every token in a given LLM call came from:
 *   system prompt / tools schema / tool outputs / user messages /
 *   injections / prior context
 *
 * Three sections:
 *   1. Header  — turn index, measured total, delta vs prev
 *   2. Cache bar — cache_read / cache_creation / fresh breakdown
 *   3. Provenance flow — sankey-style: source → category → proportion bar
 *   4. Delta panel — what was NEW in this turn vs the previous one
 *
 * TODO-3 (proxy integration): When snapshot.proxyData is present, upgrade:
 *   - system_overhead row → split into tools schema (precise) + other
 *   - System prompt row → show expandable full text from proxyData.systemBlocks
 *   - Tools row → show exact tool names from proxyData.tools.names
 *   - Confidence badges: ⚠️ estimated → ✅ precise
 * See token_tracking.md §TODO-3 for full spec.
 */

import { useState } from "react";
import type { ContextSnapshot } from "./types";
import { CATEGORY_COLORS, CATEGORY_LABELS } from "./types";

interface Props {
  snapshot: ContextSnapshot;
  prevSnapshot?: ContextSnapshot | null;
  contextLimit: number;
  onClose: () => void;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function pct(part: number, total: number): string {
  if (!total) return "0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CacheBar({ snapshot }: { snapshot: ContextSnapshot }) {
  const total = snapshot.measuredTotal;
  const read = snapshot.measuredCacheRead ?? 0;
  const write = snapshot.measuredCacheCreation ?? 0;
  const fresh = snapshot.measuredInputTokens ?? 0;
  const unknown = Math.max(0, total - read - write - fresh);

  const readPct = total ? (read / total) * 100 : 0;
  const writePct = total ? (write / total) * 100 : 0;
  const freshPct = total ? (fresh / total) * 100 : 0;
  const unknownPct = total ? (unknown / total) * 100 : 0;

  return (
    <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-gray-600">缓存状态</span>
        <span className="text-xs text-gray-400">
          {readPct.toFixed(1)}% cached
        </span>
      </div>
      <div className="h-2.5 rounded-full overflow-hidden bg-gray-200 flex">
        {readPct > 0 && (
          <div
            className="h-full bg-emerald-400"
            style={{ width: `${readPct}%` }}
            title={`cache_read: ${fmtK(read)} tokens`}
          />
        )}
        {writePct > 0 && (
          <div
            className="h-full bg-blue-400"
            style={{ width: `${writePct}%` }}
            title={`cache_creation: ${fmtK(write)} tokens`}
          />
        )}
        {freshPct > 0 && (
          <div
            className="h-full bg-amber-400"
            style={{ width: `${Math.max(freshPct, 0.3)}%` }}
            title={`fresh: ${fmtK(fresh)} tokens`}
          />
        )}
        {unknownPct > 0.5 && (
          <div className="h-full bg-gray-300" style={{ width: `${unknownPct}%` }} />
        )}
      </div>
      <div className="flex gap-4 mt-1.5 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          cache_read {fmtK(read)}
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-blue-400" />
          cache_write {fmtK(write)}
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-amber-400" />
          fresh {fmtK(fresh)}
        </span>
      </div>
    </div>
  );
}

// ── Provenance row definition ─────────────────────────────────────────────────

interface ProvenanceRow {
  id: string;
  // Left column: source labels
  sources: Array<{ label: string; detail?: string }>;
  // Middle: category name + color
  category: string;
  color: string;
  // Right: tokens + confidence
  tokens: number;
  estimated: boolean; // true = show ⚠️ and gray pattern
  // Expandable sub-rows (tool breakdown)
  children?: Array<{ label: string; tokens: number; count?: number }>;
}

function buildProvenanceRows(snapshot: ContextSnapshot): ProvenanceRow[] {
  const cats = snapshot.tokensByCategory;
  const total = snapshot.measuredTotal || snapshot.estimatedTotal;
  const rows: ProvenanceRow[] = [];

  // 1. System prompt (from CLAUDE.md reads + system blocks in JSONL)
  const sysTokens = (cats.system_prompt ?? 0) + (cats.claude_md ?? 0);
  if (sysTokens > 0) {
    rows.push({
      id: "system",
      sources: [{ label: "System prompt" }, { label: "CLAUDE.md" }],
      category: "System",
      color: CATEGORY_COLORS.system_prompt,
      tokens: sysTokens,
      estimated: false,
    });
  }

  // 2. Tools schema (= systemOverhead, which is measured gap)
  // TODO-3: when proxyData available, use proxyData.tools.tokensEstimate + names
  if (snapshot.systemOverhead > 0) {
    rows.push({
      id: "tools",
      sources: [
        { label: "Tools schema", detail: "~100 tool JSON schemas" },
      ],
      category: "Tools schema",
      color: CATEGORY_COLORS.system_overhead,
      tokens: snapshot.systemOverhead,
      estimated: true, // proxy not yet integrated
    });
  }

  // 3. Tool outputs (per-tool breakdown)
  const toolTokens = cats.tool_output ?? 0;
  if (toolTokens > 0) {
    const children = snapshot.toolOutputByTool.map((t) => ({
      label: t.toolName,
      tokens: t.tokens,
    }));
    rows.push({
      id: "tool_output",
      sources: snapshot.toolOutputByTool.slice(0, 3).map((t) => ({
        label: t.toolName,
        detail: `${fmtK(t.tokens)} tok`,
      })),
      category: CATEGORY_LABELS.tool_output,
      color: CATEGORY_COLORS.tool_output,
      tokens: toolTokens,
      estimated: false,
      children,
    });
  }

  // 4. Thinking text
  const thinkingTokens = cats.thinking_text ?? 0;
  if (thinkingTokens > 0) {
    rows.push({
      id: "thinking",
      sources: [{ label: "Thinking blocks" }],
      category: CATEGORY_LABELS.thinking_text,
      color: CATEGORY_COLORS.thinking_text,
      tokens: thinkingTokens,
      estimated: false,
    });
  }

  // 5. User messages + @file mentions
  const userTokens = (cats.user_message ?? 0) + (cats.mentioned_file ?? 0);
  if (userTokens > 0) {
    rows.push({
      id: "user",
      sources: [
        { label: "Human inputs" },
        ...(cats.mentioned_file > 0 ? [{ label: "@file mentions" }] : []),
      ],
      category: CATEGORY_LABELS.user_message,
      color: CATEGORY_COLORS.user_message,
      tokens: userTokens,
      estimated: false,
    });
  }

  // 6. Injections (skills, task_reminder, permissions, task_coordination)
  const injTokens =
    (cats.skill_injection ?? 0) +
    (cats.task_coordination ?? 0);
  if (injTokens > 0) {
    rows.push({
      id: "injections",
      sources: [
        ...(cats.skill_injection > 0 ? [{ label: "Skills / tasks", detail: `${fmtK(cats.skill_injection)} tok` }] : []),
        ...(cats.task_coordination > 0 ? [{ label: "Task coord", detail: `${fmtK(cats.task_coordination)} tok` }] : []),
      ],
      category: CATEGORY_LABELS.skill_injection,
      color: CATEGORY_COLORS.skill_injection,
      tokens: injTokens,
      estimated: false,
    });
  }

  // 7. Prior context (everything else in messages[])
  const accountedFor = rows.reduce((s, r) => s + r.tokens, 0);
  const priorTokens = Math.max(0, total - accountedFor);
  if (priorTokens > 100) {
    rows.push({
      id: "prior",
      sources: [{ label: "Prior turns", detail: "accumulated history" }],
      category: "Prior context",
      color: "#94a3b8",
      tokens: priorTokens,
      estimated: false,
    });
  }

  return rows;
}

// ── ProvenanceRow component ───────────────────────────────────────────────────

function ProvenanceRowView({
  row,
  total,
}: {
  row: ProvenanceRow;
  total: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const proportion = total > 0 ? (row.tokens / total) * 100 : 0;

  return (
    <>
      <div className="grid grid-cols-[180px_1fr] gap-3 items-center py-1.5 group">
        {/* Left: sources */}
        <div className="flex flex-col gap-0.5">
          {row.sources.slice(0, 2).map((s, i) => (
            <div key={i} className="flex items-center gap-1.5">
              {i === 0 && (
                <span
                  className="w-2 h-2 rounded-sm flex-shrink-0"
                  style={{ background: row.color }}
                />
              )}
              {i > 0 && <span className="w-2 flex-shrink-0" />}
              <span className="text-xs text-gray-600 truncate">{s.label}</span>
              {s.detail && (
                <span className="text-xs text-gray-400 truncate">{s.detail}</span>
              )}
            </div>
          ))}
          {row.sources.length > 2 && (
            <span className="text-xs text-gray-400 pl-3.5">
              +{row.sources.length - 2} more
            </span>
          )}
        </div>

        {/* Right: bar + tokens + pct */}
        <div className="flex items-center gap-2">
          {/* proportion bar */}
          <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden relative">
            {row.estimated ? (
              <div
                className="h-full rounded"
                style={{
                  width: `${proportion}%`,
                  background: `repeating-linear-gradient(45deg, ${row.color}40, ${row.color}40 3px, ${row.color}20 3px, ${row.color}20 7px)`,
                }}
              />
            ) : (
              <div
                className="h-full rounded"
                style={{ width: `${proportion}%`, background: row.color }}
              />
            )}
          </div>

          {/* tokens */}
          <span className="text-xs font-mono text-gray-700 w-14 text-right flex-shrink-0">
            {fmtK(row.tokens)}
          </span>

          {/* pct */}
          <span className="text-xs text-gray-400 w-10 text-right flex-shrink-0">
            {pct(row.tokens, total)}
          </span>

          {/* confidence badge */}
          {row.estimated ? (
            <span
              className="text-xs px-1 py-0.5 rounded bg-gray-100 text-gray-400 flex-shrink-0"
              title="Estimated — proxy dump not yet integrated. See token_tracking.md TODO-3."
            >
              est
            </span>
          ) : (
            <span className="w-7 flex-shrink-0" />
          )}

          {/* expand toggle for tool breakdown */}
          {row.children && row.children.length > 1 && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-gray-400 hover:text-gray-600 flex-shrink-0"
            >
              {expanded ? "▲" : "▼"}
            </button>
          )}
        </div>
      </div>

      {/* Expanded tool breakdown */}
      {expanded && row.children && (
        <div className="ml-4 mb-1 space-y-0.5">
          {row.children.map((child) => {
            const childPct = total > 0 ? (child.tokens / total) * 100 : 0;
            return (
              <div
                key={child.label}
                className="grid grid-cols-[180px_1fr] gap-3 items-center py-0.5"
              >
                <div className="flex items-center gap-1.5 pl-3.5">
                  <span className="text-xs text-gray-500 font-mono">{child.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-2.5 bg-gray-100 rounded overflow-hidden">
                    <div
                      className="h-full rounded"
                      style={{
                        width: `${childPct}%`,
                        background: row.color,
                        opacity: 0.7,
                      }}
                    />
                  </div>
                  <span className="text-xs font-mono text-gray-600 w-14 text-right flex-shrink-0">
                    {fmtK(child.tokens)}
                  </span>
                  <span className="text-xs text-gray-400 w-10 text-right flex-shrink-0">
                    {pct(child.tokens, total)}
                  </span>
                  <span className="w-7 flex-shrink-0" />
                  <span className="w-4 flex-shrink-0" />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Delta panel ───────────────────────────────────────────────────────────────

function DeltaPanel({
  snapshot,
  prevSnapshot,
}: {
  snapshot: ContextSnapshot;
  prevSnapshot?: ContextSnapshot | null;
}) {
  const delta = prevSnapshot
    ? snapshot.measuredTotal - prevSnapshot.measuredTotal
    : snapshot.measuredTotal;

  const newMsgs = prevSnapshot
    ? Math.max(0, snapshot.measuredTotal - prevSnapshot.measuredTotal)
    : 0;

  const injections = snapshot.newInjections;

  return (
    <div className="px-5 py-3 border-t border-gray-100 bg-gray-50">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-medium text-gray-600">本轮新增</span>
        <span
          className={`text-xs font-mono px-1.5 py-0.5 rounded ${
            delta > 0
              ? "bg-orange-50 text-orange-600"
              : delta < 0
              ? "bg-green-50 text-green-600"
              : "bg-gray-100 text-gray-400"
          }`}
        >
          {delta >= 0 ? "+" : ""}{fmtK(delta)} tokens
        </span>
        {newMsgs > 0 && (
          <span className="text-xs text-gray-400">+2 messages</span>
        )}
      </div>

      {injections.length > 0 ? (
        <div className="space-y-1">
          {injections.map((inj, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span
                className="w-2 h-2 rounded-sm flex-shrink-0 mt-0.5"
                style={{ background: CATEGORY_COLORS[inj.category] }}
              />
              <span className="text-gray-500 flex-shrink-0">
                {CATEGORY_LABELS[inj.category]}
              </span>
              <span className="text-gray-400 font-mono flex-shrink-0">
                {fmtK(inj.tokens)}
              </span>
              <span className="text-gray-400 truncate">{inj.label}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-400">
          {delta <= 20
            ? "无语义变化（仅 billing header 计数器更新）"
            : "无新注入记录"}
        </p>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function TurnProvenanceView({
  snapshot,
  prevSnapshot,
  contextLimit,
  onClose,
}: Props) {
  const total = snapshot.measuredTotal || snapshot.estimatedTotal;
  const delta = prevSnapshot
    ? snapshot.measuredTotal - prevSnapshot.measuredTotal
    : null;
  const rows = buildProvenanceRows(snapshot);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      <div className="relative w-full max-w-xl bg-white shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-gray-900">
                  Turn {snapshot.turnIndex}
                </span>
                <span className="text-xs text-gray-400">
                  Phase {snapshot.phase}
                </span>
                {snapshot.isCompactionBoundary && (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-500">
                    compaction
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs font-mono text-indigo-600 font-semibold">
                  {fmtK(total)} tokens
                </span>
                {delta !== null && (
                  <span
                    className={`text-xs font-mono ${
                      delta > 0 ? "text-orange-500" : delta < 0 ? "text-green-500" : "text-gray-400"
                    }`}
                  >
                    {delta >= 0 ? "+" : ""}{fmtK(delta)} Δ
                  </span>
                )}
                <span className="text-xs text-gray-400">
                  / {fmtK(contextLimit)} limit
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Cache bar */}
        <CacheBar snapshot={snapshot} />

        {/* Provenance flow */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-3">
            {/* Column headers */}
            <div className="grid grid-cols-[180px_1fr] gap-3 mb-2 pb-1.5 border-b border-gray-100">
              <span className="text-xs font-medium text-gray-400">来源</span>
              <div className="flex items-center gap-2">
                <span className="flex-1 text-xs font-medium text-gray-400">占比</span>
                <span className="text-xs font-medium text-gray-400 w-14 text-right">tokens</span>
                <span className="text-xs font-medium text-gray-400 w-10 text-right">%</span>
                <span className="w-7" />
                <span className="w-4" />
              </div>
            </div>

            {/* Rows */}
            <div className="divide-y divide-gray-50">
              {rows.map((row) => (
                <ProvenanceRowView key={row.id} row={row} total={total} />
              ))}
            </div>

            {/* Total row */}
            <div className="grid grid-cols-[180px_1fr] gap-3 items-center pt-2 mt-1 border-t border-gray-200">
              <span className="text-xs font-semibold text-gray-600">Total (measured)</span>
              <div className="flex items-center gap-2">
                <div className="flex-1" />
                <span className="text-xs font-mono font-semibold text-gray-800 w-14 text-right">
                  {fmtK(total)}
                </span>
                <span className="text-xs font-semibold text-gray-600 w-10 text-right">100%</span>
                <span className="w-7" />
                <span className="w-4" />
              </div>
            </div>

            {/* Proxy data note */}
            {!snapshot.proxyData && (
              <div className="mt-3 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200 text-xs text-gray-400">
                {/* TODO-3: remove this note when proxy integration is complete */}
                <span className="font-medium text-gray-500">提示</span>：安装 proxy dump 后，
                Tools schema 行将显示精确工具名列表，system prompt 可展开查看原文。
              </div>
            )}
          </div>
        </div>

        {/* Delta panel */}
        <div className="flex-shrink-0">
          <DeltaPanel snapshot={snapshot} prevSnapshot={prevSnapshot} />
        </div>
      </div>
    </div>
  );
}
