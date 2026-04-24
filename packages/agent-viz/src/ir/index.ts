export type {
  AgentSpan,
  SpanKind as AgentSpanKind,
  SpanStatus as AgentSpanStatus,
} from "./span";
export {
  parseClaudeJsonlToIR,
  type ClaudeParseOptions,
  type SubagentInput,
  type SubagentMeta,
} from "./claude-to-ir";
export { agentSpansToOtelDocument } from "./ir-to-otel";

import { parseClaudeJsonlToIR, type SubagentInput } from "./claude-to-ir";
import { agentSpansToOtelDocument } from "./ir-to-otel";
import { openTelemetrySpanAdapter } from "@evilmartians/agent-prism-data";
import type { TraceRecord, TraceSpan } from "@evilmartians/agent-prism-types";

/**
 * One-shot convenience: Claude JSONL (+ optional subagent transcripts) →
 * agent-prism `{ traceRecord, spans }`.
 *
 * Pipeline: JSONL → AgentSpan[] (OTel superset) → OpenTelemetryDocument →
 * openTelemetrySpanAdapter → TraceSpan tree.
 */
export function claudeJsonlToTraceViewerData(
  raw: string,
  opts: {
    sessionId: string;
    sessionName?: string;
    agentDescription?: string;
    subagents?: Record<string, SubagentInput>;
  },
): { traceRecord: TraceRecord; spans: TraceSpan[]; irSpans: import("./span").AgentSpan[] } {
  const ir = parseClaudeJsonlToIR(raw, {
    sessionId: opts.sessionId,
    subagents: opts.subagents,
  });
  const doc = agentSpansToOtelDocument(ir);
  const spans = openTelemetrySpanAdapter.convertRawDocumentsToSpans(doc);

  const root = ir[0];
  const durationMs =
    root?.endTime !== undefined && root.startTime
      ? Math.max(0, root.endTime - root.startTime)
      : 0;

  return {
    traceRecord: {
      id: opts.sessionId,
      name: opts.sessionName ?? opts.sessionId.slice(0, 8),
      spansCount: ir.length,
      durationMs,
      agentDescription: opts.agentDescription ?? "claude-code",
    },
    spans,
    // Also return the flat IR — Timeline / other custom views need it without
    // re-parsing.
    irSpans: ir,
  };
}
