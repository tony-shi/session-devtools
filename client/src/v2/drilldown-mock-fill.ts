// ─── drilldown-mock-fill.ts ───────────────────────────────────────────────────
// Demo/mock sub-agent data for the session detail view — used when real drilldown
// data has no sub agents but the UI needs something to render. Also hosts the
// shared TrustMode enum consumed by SessionBadges.

import type { LlmCall, SubAgentSummary } from "./drilldown-types";

export type TrustMode = "jsonl-only" | "proxy-exact" | "mixed" | "mock";

// ─── Mock sub agents (session-level) ─────────────────────────────────────────
// Used when real drilldown data has no sub agents but UI needs demo data.
// Real: populated by parseSubAgents() in the backend parser.

export const MOCK_SUB_AGENTS: SubAgentSummary[] = [
  {
    agentFileId: "a373036faaffe1b06",
    agentType: "Explore",
    description: "Search for HTTP proxy/agent timeout settings",
    toolUseId: "toolu_mock_agent_01",
    toolUseName: "Agent",
    parentLineIdx: -1,
    parentCallId: 0,
    llmCallCount: 18,
    toolCallCount: 24,
    totalCacheRead: 485000,
    totalCacheWrite: 38000,
    totalFreshIn: 42,
    totalOutputTokens: 4200,
    peakContext: 78500,
    lastContext: 76200,
    startedAt: "2026-05-09T14:22:05.000Z",
    endedAt: "2026-05-09T14:23:10.000Z",
    durationMs: 65000,
    resultPreview: "I have thoroughly searched the codebase and found the following timeout configurations in the shark → oceanus HTTP calls:\n\n1. `HttpClient.builder().connectTimeout(5000)` in `OceanusHttpClient.java:42`\n2. Read timeout set to 30s in `ProxyConfig.java:87`\n\nThe main bottleneck appears to be the default 30s read timeout which…",
  },
  {
    agentFileId: "a5db760ff93a6f685",
    agentType: "general-purpose",
    description: "Research Devin and Fly.io Sprites architecture from public docs",
    toolUseId: "toulu_mock_agent_02",
    toolUseName: "Agent",
    parentLineIdx: -1,
    parentCallId: 0,
    llmCallCount: 12,
    toolCallCount: 15,
    totalCacheRead: 210000,
    totalCacheWrite: 18000,
    totalFreshIn: 28,
    totalOutputTokens: 3100,
    peakContext: 46300,
    lastContext: 44800,
    startedAt: "2026-05-09T14:24:00.000Z",
    endedAt: "2026-05-09T14:24:55.000Z",
    durationMs: 55000,
    resultPreview: "Based on public documentation, Devin uses a sandboxed VM environment with persistent storage. Fly.io Sprites provide lightweight ephemeral microVMs. Key architectural differences:\n\n- Devin: full OS snapshot + replay\n- Sprites: fast cold start (<100ms), stateless by default\n\nFor agent loop architecture, Sprites better fit the…",
  },
];

// Attach mock sub agents to specific calls in a turn (for UI demo)
export function attachMockSubAgents(_call: LlmCall, turnId: number, callIdx: number): SubAgentSummary | null {
  // Give turn 2, call index 2 a sub agent for demo
  if (turnId === 2 && callIdx === 2) return MOCK_SUB_AGENTS[0];
  if (turnId === 2 && callIdx === 5) return MOCK_SUB_AGENTS[1];
  return null;
}
