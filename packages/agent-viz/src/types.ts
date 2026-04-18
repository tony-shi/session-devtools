export type SpanKind = "session" | "turn" | "tool_use" | "tool_result";

export type SpanStatus = "ok" | "error" | "pending";

export interface AgentSpan {
  id: string;
  parentId?: string;
  kind: SpanKind;
  /** Tool name (e.g. "Bash"), or "user" / "assistant" for turn-level spans */
  name: string;
  startTime: number;  // ms epoch
  endTime?: number;   // ms epoch; undefined if still running
  status: SpanStatus;
  /** Raw tool input params, or user message text */
  input?: unknown;
  /** Raw tool result content */
  output?: unknown;
  /** Thinking block content (preserved; not filtered) */
  thinking?: string;
  /** Token usage — only present on assistant turn spans */
  tokens?: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  children: AgentSpan[];
}
