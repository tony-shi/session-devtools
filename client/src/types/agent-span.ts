export type SpanKind =
  | "session"
  | "turn"
  | "tool_call"
  | "tool_result"
  | "message";

export type SpanStatus = "ok" | "error" | "pending";

export interface AgentSpan {
  id: string;
  traceId: string;
  parentId?: string;
  kind: SpanKind;
  name: string;
  startTime: number;
  endTime?: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean | undefined>;
}
