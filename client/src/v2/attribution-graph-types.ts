// Session-level reverse attribution: how each jsonl event has been consumed
// across the session's LLM calls. Mirrors server-side
// SessionAttributionGraph / JsonlEventAnnotation in
// `server/src/session-attribution-graph.ts`.
//
// The forward edge (leaf → originating jsonl line) is already on
// SerializedNode.origin.jsonlLineIdx — this file types the *reverse* edge
// (jsonl line → call(s) that consumed it) plus the contextImpact tri-state.

/**
 * Primary event source ("most significant content type") — multi-content
 * events get collapsed to one of these for visual classification. Mirrors
 * `JsonlEventSource` in `server/src/context-ledger/parser`.
 */
export type JsonlEventSource =
  | "harness_injection"
  | "system_local_command"
  | "attachment"
  | "tool_use"
  | "tool_result"
  | "assistant_text"
  | "user_input"
  | "thinking"
  | "unknown";

/** Five-bucket authorship — mirrors server parser's `Authorship`. */
export type Authorship =
  | "harness"        // assembled by harness / system prompt machinery
  | "human"          // direct human input
  | "agent"          // LLM-emitted text / thinking
  | "tool"           // tool execution output
  | "unattributed";  // no source determinable

export type ContextImpact = "indexed" | "skipped" | "pending";

export interface JsonlEventAnnotation {
  /** Absolute jsonl line index (0-based). */
  lineIdx: number;
  source: JsonlEventSource;
  authorship: Authorship;
  /** Call id where this event first entered any reqBody; null = never. */
  firstSeenInCall: number | null;
  /** All call ids that referenced this event (sorted ascending). */
  consumedByCallIds: number[];
  /**
   * - "indexed" — appeared in at least one audited call's reqBody
   * - "skipped" — no consumable content by design (metadata / system)
   * - "pending" — has content but no audited call referenced it (may be
   *   outside audit window or genuinely dropped)
   */
  contextImpact: ContextImpact;
  /**
   * Audit-gap caveat: when `firstSeenInCall` is the earliest *audited* call
   * but unaudited calls exist before it, the true first-seen may live in
   * those unaudited slots. UI hides the jump chip and shows an "audit gap"
   * note instead, so users don't misread the window boundary as the actual
   * first consumer.
   */
  firstSeenIsAfterAuditGap?: boolean;
}

/** Mirror of server's UnauditedKind — structured so the UI can pick the right
 *  visual (NoProxyDot vs amber text vs error chip) and the right i18n bucket
 *  without having to substring-sniff the diagnostic `reason`. */
export type UnauditedKind = "no-proxy" | "drilldown-miss" | "parse-error" | "other";

export interface UnauditedCall {
  callId: number;
  kind: UnauditedKind;
  /** Server-side diagnostic message — kept around for hover/dev fallback. */
  reason: string;
}

export interface SessionAttributionGraph {
  sessionId: string;
  /** Sorted by lineIdx ascending; includes skipped events too. */
  events: JsonlEventAnnotation[];
  /** Audited call ids (input domain for the reverse projection). */
  auditedCallIds: number[];
  /** Calls explicitly skipped during audit (no proxy / mcli / fork). */
  unauditedCallIds: UnauditedCall[];
}
