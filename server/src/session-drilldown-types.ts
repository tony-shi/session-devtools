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
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: string;
  model: string;
  stopReason: string | null;
  isCompaction: boolean;
  isUnknownHeavy: boolean;
  freshIn: number;
  isSignificant: boolean;
  significantDelta: number;
  proxy: ProxyCallData | null;
  // All sub-agents spawned by this call (one per Agent tool_use block; usually 0-1, rarely >1)
  subAgents: SubAgentSummary[];
  incomingDiff: DiffEntry[];
  // Tool names dispatched in this call's content (tool_use blocks)
  toolNames: string[];
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
  errorCount: number;
  calls: LlmCall[];
}

export interface ToolUsageEntry {
  name: string;
  count: number;
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
  totalFreshIn: number;   // sum of API input_tokens (non-cached) — billing unit
  totalFreshOut: number;
  lastContext: number;    // contextSize of the final LLM call — current window usage
  systemErrorCount: number;
  compactionCount: number;
  // Per-model breakdown: model name → { calls, outputTokens, cacheRead, cacheWrite }
  modelBreakdown: Record<string, ModelStats>;
  // Top tool names by usage count, descending
  toolDistribution: ToolUsageEntry[];
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
