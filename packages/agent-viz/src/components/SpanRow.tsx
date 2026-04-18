import type { AgentSpan, SpanKind } from "../types";

// ── Color scheme ─────────────────────────────────────────────────────────────

const KIND_DOT: Record<SpanKind, string> = {
  session: "bg-gray-400",
  turn: "bg-gray-400",     // overridden per name below
  tool_use: "bg-amber-400",
  tool_result: "bg-emerald-400",
};

const NAME_DOT: Record<string, string> = {
  user: "bg-indigo-500",
  assistant: "bg-violet-500",
};

const STATUS_ICON: Record<string, string> = {
  ok: "text-emerald-500",
  error: "text-red-500",
  pending: "text-gray-300",
};

function dotColor(span: AgentSpan): string {
  return NAME_DOT[span.name] ?? KIND_DOT[span.kind] ?? "bg-gray-400";
}

function durationLabel(span: AgentSpan): string | null {
  if (!span.endTime || !span.startTime) return null;
  const ms = span.endTime - span.startTime;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function inputPreview(span: AgentSpan): string {
  const val = span.input;
  if (!val) return "";
  if (typeof val === "string") return val.slice(0, 120);
  try {
    return JSON.stringify(val).slice(0, 120);
  } catch {
    return "";
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  span: AgentSpan;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}

export function SpanRow({ span, depth, isExpanded, isSelected, onToggle, onSelect }: Props) {
  const hasChildren = span.children.length > 0;
  const dur = durationLabel(span);
  const preview = inputPreview(span);
  const dot = dotColor(span);
  const statusCls = STATUS_ICON[span.status] ?? STATUS_ICON.pending;

  return (
    <div
      className={`group flex items-start gap-1.5 px-3 py-1.5 cursor-pointer hover:bg-gray-50 transition-colors text-xs ${
        isSelected ? "bg-indigo-50 hover:bg-indigo-50" : ""
      }`}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
      onClick={onSelect}
    >
      {/* Expand/collapse toggle */}
      <button
        className={`flex-shrink-0 w-3 h-3 mt-0.5 flex items-center justify-center rounded ${
          hasChildren ? "text-gray-400 hover:text-gray-600" : "invisible"
        }`}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
      >
        <svg
          className={`w-3 h-3 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {/* Dot */}
      <div className={`flex-shrink-0 w-2 h-2 rounded-full mt-1 ${dot}`} />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`font-medium ${span.name === "user" ? "text-indigo-700" : span.name === "assistant" ? "text-violet-700" : "text-amber-700"}`}>
            {span.name}
          </span>
          {span.tokens && (
            <span className="text-gray-400">
              {span.tokens.output > 0 ? `${span.tokens.output} tok` : ""}
            </span>
          )}
          {span.kind === "tool_use" && span.children.length === 0 && (
            <span className={`ml-auto ${statusCls}`}>
              {span.status === "ok" ? "✓" : span.status === "error" ? "✗" : "·"}
            </span>
          )}
          {dur && (
            <span className="text-gray-400 ml-auto">{dur}</span>
          )}
        </div>
        {preview && !isSelected && (
          <p className="text-gray-400 truncate mt-0.5">{preview}</p>
        )}
      </div>
    </div>
  );
}
