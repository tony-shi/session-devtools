// Unified IR for AI agent sessions.
//
// Designed as a SUPERSET of OpenTelemetry gen_ai semantic conventions:
//   - Core fields (id / parentId / name / timing / status) are OTel-shaped.
//   - Vendor / CLI-specific signals go into `attributes` under reserved
//     namespaces (e.g. `claude.thinking`, `claude.compaction.*`).
//
// This lets any agent-prism / Langfuse / Phoenix consumer view our data via
// the standard OTel gen_ai semconv, while we keep Claude-specific enrichment.

export type SpanKind =
  | "session"    // root invocation
  | "turn"       // a single assistant / user turn
  | "tool_call"  // a Bash / Read / Edit etc.
  | "tool_result"
  | "message";

export type SpanStatus = "ok" | "error" | "pending";

export interface AgentSpan {
  id: string;
  traceId: string;
  parentId?: string;
  kind: SpanKind;
  /** Human-visible title: "chat claude-opus-4-7", "execute_tool Bash", "user_input" */
  name: string;
  startTime: number; // ms epoch
  endTime?: number;  // ms epoch; undefined if still running
  status: SpanStatus;

  /**
   * OTel gen_ai semconv attributes and vendor extensions. Well-known keys:
   *   gen_ai.system, gen_ai.operation.name, gen_ai.request.model,
   *   gen_ai.usage.input_tokens / output_tokens / total_tokens,
   *   gen_ai.tool.name, gen_ai.agent.name,
   *   input.value / output.value (agent-prism input/output panel),
   *   claude.thinking.text, claude.subagent.parent_session_id, ...
   */
  attributes: Record<string, string | number | boolean | undefined>;
}
