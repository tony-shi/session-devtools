// Convert our OTel-superset AgentSpan[] into an OpenTelemetryDocument that
// `@evilmartians/agent-prism-data`'s openTelemetrySpanAdapter can consume.

import type {
  OpenTelemetryDocument,
  OpenTelemetrySpan,
  OpenTelemetryStatusCode,
  TraceSpanAttribute,
} from "@evilmartians/agent-prism-types";

import type { AgentSpan, SpanStatus } from "./span";

function statusToOtelCode(s: SpanStatus): OpenTelemetryStatusCode {
  if (s === "ok") return "STATUS_CODE_OK";
  if (s === "error") return "STATUS_CODE_ERROR";
  return "STATUS_CODE_UNSET";
}

function attrsToOtel(
  attrs: AgentSpan["attributes"],
): TraceSpanAttribute[] {
  const out: TraceSpanAttribute[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      out.push({ key, value: { stringValue: value } });
    } else if (typeof value === "number") {
      out.push({ key, value: { intValue: String(Math.trunc(value)) } });
    } else if (typeof value === "boolean") {
      out.push({ key, value: { boolValue: value } });
    }
  }
  return out;
}

/** ms → nanosecond string (OTel wire format). */
function msToNano(ms: number): string {
  // Use BigInt to keep precision.
  return (BigInt(Math.trunc(ms)) * BigInt(1_000_000)).toString();
}

export function agentSpansToOtelDocument(
  spans: AgentSpan[],
): OpenTelemetryDocument {
  const otelSpans: OpenTelemetrySpan[] = spans.map((s) => {
    const end = s.endTime ?? s.startTime;
    return {
      traceId: s.traceId,
      spanId: s.id,
      parentSpanId: s.parentId,
      name: s.name,
      kind: "SPAN_KIND_INTERNAL",
      startTimeUnixNano: msToNano(s.startTime),
      endTimeUnixNano: msToNano(end),
      attributes: attrsToOtel(s.attributes),
      status: { code: statusToOtelCode(s.status) },
      flags: 0,
    };
  });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "claude-code" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "session-dashboard/agent-viz", version: "0.1.0" },
            spans: otelSpans,
          },
        ],
      },
    ],
  };
}
