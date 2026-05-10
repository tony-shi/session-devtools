// ─── Session Drilldown Contract ──────────────────────────────────────────────
// Shared type definitions for the /api/v2/sessions/:id/drilldown endpoint.
// Backend returns this shape; frontend consumes it directly.

export interface DiffEntry {
  id: string;
  category: string;
  label: string;
  delta: number;
  changeType: "added" | "removed" | "changed" | "retained";
  cause: string;
  confidence: "High" | "Medium" | "Low" | "Unknown";
  evidence?: string;
}

export interface ProxyCallData {
  requestId: number;
  reqMessageCount: number | null;
  reqHasTools: boolean | null;
  resInputTokens: number | null;
  resOutputTokens: number | null;
  resCacheCreation: number | null;
  resCacheRead: number | null;
  resStopReason: string | null;
  errorClass: string | null;
  durationMs: number | null;
}

export interface LlmCall {
  // Position within the session (1-based, globally across all turns)
  id: number;
  // Position within the parent turn (1-based)
  indexInTurn: number;

  contextSize: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: string;
  model: string;
  stopReason: string | null;

  isCompaction: boolean;
  isUnknownHeavy: boolean;
  isSignificant: boolean;
  // Net delta vs previous call in the session (positive = growth)
  significantDelta: number;

  // null when no proxy record matches this call
  proxy: ProxyCallData | null;

  // Empty array in v1 backend — frontend fills with mock when empty
  incomingDiff: DiffEntry[];
}

export interface UserTurn {
  // 1-based index within the session
  id: number;
  userInput: string;
  startedAt: string;
  endedAt: string;

  llmCallCount: number;
  toolCallCount: number;
  netContextDelta: number;
  peakContext: number;
  cacheRead: number;
  cacheWrite: number;

  // v1 backend: always 0 (unknown attribution not yet computed)
  unknownDelta: number;

  hasCompaction: boolean;
  // v1 backend: always false
  hasUnknownSpike: boolean;

  calls: LlmCall[];
}

export interface SessionDrilldown {
  sessionId: string;
  tool: string;
  project: string;
  cwd: string;
  title: string | null;
  firstEventAt: string;
  lastEventAt: string;

  totalLlmCalls: number;
  totalToolCalls: number;
  peakContext: number;
  totalCacheRead: number;
  totalCacheWrite: number;

  // true if at least one proxy_requests row is linked to this session
  hasProxyData: boolean;
  // true if source_file exists on disk at the time of the request
  hasJsonlSource: boolean;

  turns: UserTurn[];
}
