import { useState } from "react";
import type { AgentSpan } from "../types";

interface Props {
  span: AgentSpan;
}

function JsonBlock({ value, label }: { value: unknown; label: string }) {
  const [expanded, setExpanded] = useState(true);
  if (value === undefined || value === null) return null;

  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1 hover:text-gray-700"
      >
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {label}
      </button>
      {expanded && (
        <pre className="text-xs text-gray-700 bg-gray-50 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
          {text}
        </pre>
      )}
    </div>
  );
}

function durationLabel(span: AgentSpan): string | null {
  if (!span.endTime || !span.startTime) return null;
  const ms = span.endTime - span.startTime;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function SpanDetail({ span }: Props) {
  const dur = durationLabel(span);

  return (
    <div className="p-4 text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <span className="font-semibold text-gray-900">{span.name}</span>
        <span className="text-xs text-gray-400 font-mono">{span.kind}</span>
        {dur && <span className="text-xs text-gray-400 ml-auto">{dur}</span>}
      </div>

      {/* Token stats */}
      {span.tokens && (
        <div className="flex gap-3 text-xs text-gray-500 mb-4 flex-wrap">
          <span>in <strong className="text-gray-700">{span.tokens.input.toLocaleString()}</strong></span>
          <span>out <strong className="text-gray-700">{span.tokens.output.toLocaleString()}</strong></span>
          {span.tokens.cacheRead > 0 && (
            <span>cache_read <strong className="text-gray-700">{span.tokens.cacheRead.toLocaleString()}</strong></span>
          )}
          {span.tokens.cacheCreation > 0 && (
            <span>cache_write <strong className="text-gray-700">{span.tokens.cacheCreation.toLocaleString()}</strong></span>
          )}
        </div>
      )}

      {/* Thinking */}
      {span.thinking && (
        <JsonBlock value={span.thinking} label="Thinking" />
      )}

      {/* Input */}
      <JsonBlock value={span.input} label="Input" />

      {/* Output */}
      <JsonBlock value={span.output} label="Output" />

      {/* Span ID */}
      <p className="text-xs text-gray-300 font-mono mt-4 break-all">{span.id}</p>
    </div>
  );
}
