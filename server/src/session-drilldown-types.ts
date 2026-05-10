// ─── Session Drilldown Contract ──────────────────────────────────────────────
// Mirror of client/src/v2/drilldown-types.ts.
// This file defines the shape returned by GET /api/v2/sessions/:id/drilldown.

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

export interface SubAgentSummary {
  agentFileId: string;
  agentType: string;
  description: string;
  toolUseId: string;
  toolUseName: string;
  llmCallCount: number;
  toolCallCount: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalFreshIn: number;
  totalOutputTokens: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  resultPreview: string;
}

export interface LlmCall {
  id: number;
  indexInTurn: number;
  contextSize: number;
  contextWindowSize: number;   // model's max context window, for ceiling line
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: string;
  model: string;
  stopReason: string | null;
  isCompaction: boolean;
  isUnknownHeavy: boolean;
  isSignificant: boolean;
  significantDelta: number;
  proxy: ProxyCallData | null;
  subAgent: SubAgentSummary | null;
  incomingDiff: DiffEntry[];
}

export interface UserTurn {
  id: number;
  userInput: string;
  finalOutput: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  llmCallCount: number;
  toolCallCount: number;
  netContextDelta: number;
  peakContext: number;
  cacheRead: number;
  cacheWrite: number;
  unknownDelta: number;
  hasCompaction: boolean;
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
  totalFreshIn: number;
  totalFreshOut: number;
  systemErrorCount: number;
  // Per-model breakdown: model name → { calls, outputTokens, cacheRead, cacheWrite }
  modelBreakdown: Record<string, ModelStats>;
  // The dominant context window ceiling across all calls (for chart Y-axis)
  contextWindowSize: number;
  hasProxyData: boolean;
  hasJsonlSource: boolean;
  subAgentCount: number;
  subAgents: SubAgentSummary[];
  turns: UserTurn[];
}

export interface ModelStats {
  calls: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  freshIn: number;
}
