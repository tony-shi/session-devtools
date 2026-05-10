// ─── drilldown-mock-fill.ts ───────────────────────────────────────────────────
// All mock/estimated data builders for the LLM Call Detail view.
// Consumed by LlmCallDetailPanel when real data is not yet available.
// Replace individual functions here as real attribution data becomes available.

import type { LlmCall, UserTurn } from "./drilldown-types";

// ─── Shared types (call-detail level, not in drilldown-types contract yet) ───

export type ChangeType = "added" | "removed" | "changed" | "retained" | "reclassified" | "moved";
export type ConfidenceLevel = "exact" | "high" | "medium" | "low" | "unknown";
export type TrustMode = "jsonl-only" | "proxy-exact" | "mixed" | "mock";
export type BridgeEventKind = "user_input" | "tool_use" | "tool_result" | "system_injection" | "compaction" | "assistant_response";

export interface CharRange {
  startChar: number;
  endChar: number;
  startByte?: number;
  endByte?: number;
}

export interface SourceEvent {
  type: "user_input" | "tool_result" | "assistant_response" | "tool_use" | "system_injection" | "compaction" | "unknown";
  id: string;
  label: string;
  timestamp?: string;
}

export interface AttributedDiffRange {
  id: string;
  changeType: ChangeType;
  previousRange?: CharRange;
  currentRange?: CharRange;
  textPreview: string;
  tokens: number;
  category: string;
  sourceEvent?: SourceEvent;
  cause?: string;
  confidence: ConfidenceLevel;
  evidenceRefs: Array<{ kind: "proxy" | "jsonl" | "tool_event"; label: string; detail: string }>;
}

export interface PayloadSegment {
  id: string;
  category: string;
  label: string;
  tokens: number;
  content?: string;
  currentRange?: CharRange;
  firstSeenCallId?: number;
  sourceEvent?: SourceEvent;
  confidence: ConfidenceLevel;
  relatedDiffIds?: string[];
}

export interface CallResponse {
  textOutput: string;
  toolUseBlocks: Array<{ id: string; name: string; input: string }>;
  stopReason: string;
  outputTokens: number;
  hasThinking: boolean;
  thinkingPreview?: string;
}

export interface MockBridgeEvent {
  id: string;
  kind: BridgeEventKind;
  label: string;
  tokenImpact: number;
  detail?: string;
  confidence: "High" | "Medium" | "Low";
}

// ─── Trust mode ───────────────────────────────────────────────────────────────

export function buildTrustMode(call: LlmCall): TrustMode {
  if (call.proxy) return "proxy-exact";
  return "jsonl-only";
}

// ─── Attributed diff ranges (mock, per-call) ─────────────────────────────────
// These represent what changed in the request payload vs the previous call.
// Real data requires proxy dump + attribution engine.

export function buildMockAttributedDiff(call: LlmCall): AttributedDiffRange[] {
  const ctx = call.contextSize;
  const ranges: AttributedDiffRange[] = [];

  if (call.significantDelta > 1000) {
    const toolTokens = Math.round(call.significantDelta * 0.65);
    const charStart = Math.round(ctx * 0.42);
    ranges.push({
      id: "adr-tool-read",
      changeType: "added",
      currentRange: { startChar: charStart, endChar: charStart + toolTokens * 4, startByte: charStart, endByte: charStart + toolTokens * 4 },
      textPreview: "export function parseSessionDrilldown(sourceFile: string, sessionId: string, sessionRow: Record<string, unknown>, db: Database): SessionDrilldown {\n  const lines = readFileSync(sourceFile, 'utf-8').trim().split('\\n')…",
      tokens: toolTokens,
      category: "Tool Output",
      sourceEvent: { type: "tool_result", id: "toolu_01A", label: "tool_result: Read(server/src/parser.ts)", timestamp: call.timestamp },
      cause: "tool_result from previous call injected into context",
      confidence: "high",
      evidenceRefs: [
        { kind: "jsonl", label: `JSONL line ${800 + call.id * 12}`, detail: `tool_result event for tool_call_id toolu_01A at offset ${800 + call.id * 12}` },
        { kind: "tool_event", label: "tool_call_id: toolu_01A", detail: "Matched exact tool_result content in request segment" },
      ],
    });
  }

  if (call.significantDelta > 5000) {
    const bashTokens = Math.round(call.significantDelta * 0.2);
    const charStart = Math.round(ctx * 0.62);
    ranges.push({
      id: "adr-bash",
      changeType: "added",
      currentRange: { startChar: charStart, endChar: charStart + bashTokens * 4 },
      textPreview: "✓ tsc -b completed\n  src/session-drilldown-parser.ts: 0 errors\n  Compiling 18 files...\n  Build succeeded in 3.2s",
      tokens: bashTokens,
      category: "Tool Output",
      sourceEvent: { type: "tool_result", id: "toulu_01B", label: "tool_result: Bash(npm run build)" },
      cause: "Bash build output returned and injected",
      confidence: "high",
      evidenceRefs: [{ kind: "jsonl", label: `JSONL line ${820 + call.id * 12}`, detail: "tool_result for bash command" }],
    });
    const histTokens = Math.round(call.significantDelta * 0.15);
    ranges.push({
      id: "adr-hist",
      changeType: "added",
      currentRange: { startChar: Math.round(ctx * 0.78), endChar: Math.round(ctx * 0.78) + histTokens * 4 },
      textPreview: "I've completed the initial analysis. The session drilldown parser correctly identifies turn boundaries…",
      tokens: histTokens,
      category: "Assistant History",
      sourceEvent: { type: "assistant_response", id: `msg_prev_${call.id - 1}`, label: "Previous assistant response" },
      cause: "Prior assistant turn appended to conversation history",
      confidence: "medium",
      evidenceRefs: [{ kind: "jsonl", label: "assistant event prior call", detail: `Accumulated from call ${call.id - 1}` }],
    });
  }

  if (call.indexInTurn === 1) {
    ranges.push({
      id: "adr-user",
      changeType: "added",
      currentRange: { startChar: Math.round(ctx * 0.88), endChar: Math.round(ctx * 0.9) },
      textPreview: "请帮我分析这个 session 的数据结构，重点关注 context 增长…",
      tokens: Math.round(ctx * 0.02),
      category: "User Messages",
      sourceEvent: { type: "user_input", id: "user-turn-msg", label: "User input this turn" },
      cause: "New user turn message injected",
      confidence: "high",
      evidenceRefs: [{ kind: "jsonl", label: "user event", detail: "Non-tool_result user event starting this turn" }],
    });
  }

  if (call.isCompaction) {
    ranges.push({
      id: "adr-comp-rm",
      changeType: "removed",
      previousRange: { startChar: 40000, endChar: 110000 },
      textPreview: "[prior tool outputs and assistant history removed by compaction]",
      tokens: -(Math.round(ctx * 0.4)),
      category: "Compaction Summary",
      sourceEvent: { type: "compaction", id: "compaction-event", label: "Context compaction applied" },
      cause: "Context window exceeded threshold — prior history compacted",
      confidence: "high",
      evidenceRefs: [{ kind: "jsonl", label: "compaction event", detail: "Claude Code context compaction marker" }],
    });
  }

  ranges.push({
    id: "adr-sys-retained",
    changeType: "retained",
    currentRange: { startChar: 0, endChar: Math.round(ctx * 0.22) * 4 },
    textPreview: "You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent that helps users with software engineering tasks…",
    tokens: Math.round(ctx * 0.22),
    category: "System",
    sourceEvent: { type: "system_injection", id: "sys-prompt", label: "System prompt (initial)" },
    confidence: "high",
    evidenceRefs: [],
  });

  return ranges;
}

// ─── Payload segments (mock, per-call) ───────────────────────────────────────
// Ordered by payload position (char offset ascending).
// Real data requires exact proxy request body + attribution.

export function buildMockPayloadSegments(call: LlmCall): PayloadSegment[] {
  const ctx = call.contextSize;
  let offset = 0;
  const seg = (
    id: string, category: string, label: string, pct: number,
    content: string, srcType: SourceEvent["type"], srcLabel: string,
    conf: ConfidenceLevel, firstSeen?: number,
  ): PayloadSegment => {
    const tokens = Math.round(ctx * pct);
    const chars = tokens * 4;
    const s: PayloadSegment = {
      id, category, label, tokens, content,
      currentRange: { startChar: offset, endChar: offset + chars },
      firstSeenCallId: firstSeen,
      sourceEvent: { type: srcType, id: `src-${id}`, label: srcLabel },
      confidence: conf,
    };
    offset += chars;
    return s;
  };
  return [
    seg("seg-sys",    "System",            "system prompt",               0.22, "You are Claude Code, Anthropic's official CLI…",                         "system_injection",   "initial system prompt",                                   "high",   1),
    seg("seg-schema", "Tool Schemas",      "tool definitions (12 tools)", 0.18, "Read, Write, Edit, Bash, Glob, Grep, WebFetch, Task, Mcp…",             "system_injection",   "tool schema injection",                                    "high",   1),
    seg("seg-hist",   "Assistant History", "prior assistant turns (×4)",  0.15, "I've completed the initial analysis…",                                  "assistant_response", "accumulated prior turns",                                  "medium", Math.max(1, call.id - 2)),
    seg("seg-tool",   "Tool Output",       "Read(server/src/parser.ts)",  0.28, "export function parseSessionDrilldown(sourceFile: string…",             "tool_result",        `tool_result toolu_01A · JSONL line ${800 + call.id * 12}`, "high",   call.id),
    seg("seg-user",   "User Messages",     "current user input",          0.08, "请帮我分析这个 session 的数据结构，重点关注 context 增长…",             "user_input",         "user turn message",                                        "high",   call.id),
    { id: "seg-unk", category: "Unknown", label: "unattributed delta", tokens: Math.max(Math.round(ctx * 0.09), 0), confidence: "unknown" as ConfidenceLevel },
  ].filter(s => s.tokens > 0);
}

// ─── Call response (mock, per-call) ──────────────────────────────────────────
// Derived from JSONL assistant events.
// Real: extract text + tool_use blocks from assistant.message.content.

export function buildMockCallResponse(call: LlmCall): CallResponse {
  const hasTools = call.stopReason === "tool_use";
  return {
    textOutput: call.stopReason === "end_turn"
      ? "根据分析，当前 session 的 context 结构主要由 Tool Output 主导（约 28%），系统提示占 22%，工具定义占 18%。建议关注 Tool Output 的累积增长，考虑在必要时触发 compaction 以控制 context 规模。"
      : "",
    toolUseBlocks: hasTools
      ? [{ id: "toolu_mock_01", name: "Read", input: JSON.stringify({ file_path: "server/src/session-drilldown-parser.ts" }, null, 2) }]
      : [],
    stopReason: call.stopReason ?? "end_turn",
    outputTokens: call.outputTokens,
    hasThinking: call.id % 4 === 0,
    thinkingPreview: call.id % 4 === 0
      ? "Let me think through this carefully. The session has multiple turns and each turn builds on the previous context…"
      : undefined,
  };
}

// ─── Bridge events (mock, per-call) ──────────────────────────────────────────
// Events that happened between the previous call and this call.
// Real: derived from JSONL tool_result + user events + system injections.

export function buildMockBridgeEvents(call: LlmCall): MockBridgeEvent[] {
  const events: MockBridgeEvent[] = [];
  if (call.indexInTurn === 1) {
    events.push({ id: "b-user", kind: "user_input", label: "User input", tokenImpact: 420, detail: "Current user turn message injected into context", confidence: "High" });
  }
  if (call.cacheWrite > 0) {
    events.push({ id: "b-sys", kind: "system_injection", label: "System / harness injection", tokenImpact: call.cacheWrite, detail: `${call.cacheWrite.toLocaleString()} tokens written to cache (system prompt, tool schemas, CLAUDE.md)`, confidence: "Medium" });
  }
  if (call.significantDelta > 1000) {
    events.push({ id: "b-tr1", kind: "tool_result", label: "tool_result: Read(server/src/parser.ts)", tokenImpact: Math.round(call.significantDelta * 0.65), detail: "tool_call_id: toolu_01A · ~12,840 tokens returned", confidence: "High" });
    if (call.significantDelta > 5000) {
      events.push({ id: "b-tr2", kind: "tool_result", label: "tool_result: Bash(npm run build)", tokenImpact: Math.round(call.significantDelta * 0.2), detail: "tool_call_id: toulu_01B · build output ~4,200 tokens", confidence: "High" });
      events.push({ id: "b-ar", kind: "assistant_response", label: "Previous assistant response retained", tokenImpact: Math.round(call.significantDelta * 0.15), detail: "Prior assistant turn appended to history", confidence: "Medium" });
    }
  }
  if (call.isCompaction) {
    events.push({ id: "b-comp", kind: "compaction", label: "Compaction applied", tokenImpact: -(call.contextSize * 0.4), detail: "Context compaction reduced prior history. Summary injected.", confidence: "High" });
  }
  return events;
}

// ─── Agent loop mock (per-turn) ───────────────────────────────────────────────
// Tool groups + transitions + tool summary.
// Real: derived from JSONL tool_use / tool_result event pairing.

export interface MockToolCall {
  id: string;
  tool: string;
  input: string;
  outputSize: number;
  durationMs: number;
  status: "ok" | "error" | "timeout";
  isParallel?: boolean;
}

export interface MockToolGroup {
  id: string;
  afterCallId: number;
  tools: MockToolCall[];
  totalOutputSize: number;
  isParallel: boolean;
}

export interface MockAgentLoopData {
  toolGroups: MockToolGroup[];
  transitions: Array<{ fromCallId: number; toCallId: number; contextDelta: number; dominantCause: string }>;
  toolSummary: Array<{ tool: string; calls: number; totalOutput: number; failed: number }>;
  status: "completed" | "interrupted" | "continued";
}

const TOOL_PATTERNS: Record<number, MockToolCall[]> = {
  0: [
    { id: "t1a", tool: "Read",  input: "src/index.ts",              outputSize: 2800,  durationMs: 45,    status: "ok" },
    { id: "t1b", tool: "Read",  input: "tsconfig.json",             outputSize: 1200,  durationMs: 38,    status: "ok" },
    { id: "t1c", tool: "Bash",  input: "ls -la src/",               outputSize: 340,   durationMs: 120,   status: "ok" },
  ],
  1: [
    { id: "t2a", tool: "Read",  input: "package.json",              outputSize: 980,   durationMs: 40,    status: "ok", isParallel: true },
    { id: "t2b", tool: "Read",  input: "src/routes/index.ts",       outputSize: 3400,  durationMs: 42,    status: "ok", isParallel: true },
    { id: "t2c", tool: "Read",  input: "src/middleware/auth.ts",    outputSize: 2100,  durationMs: 41,    status: "ok", isParallel: true },
    { id: "t2d", tool: "Read",  input: "src/db/connection.ts",      outputSize: 1800,  durationMs: 39,    status: "ok", isParallel: true },
  ],
  2: [
    { id: "t3a", tool: "Edit",  input: "src/routes/index.ts",       outputSize: 180,   durationMs: 55,    status: "ok" },
    { id: "t3b", tool: "Edit",  input: "src/middleware/auth.ts",    outputSize: 220,   durationMs: 52,    status: "ok" },
  ],
  3: [
    { id: "t4a", tool: "Bash",  input: "npm run build",             outputSize: 4200,  durationMs: 8400,  status: "ok" },
  ],
  4: [
    { id: "t5a", tool: "Bash",  input: "npm test",                  outputSize: 6800,  durationMs: 12300, status: "error" },
  ],
  5: [
    { id: "t6a", tool: "Read",  input: "src/__tests__/index.test.ts", outputSize: 5200, durationMs: 44,   status: "ok" },
    { id: "t6b", tool: "Bash",  input: "npx jest --testPathPattern=routes", outputSize: 3100, durationMs: 9800, status: "ok" },
  ],
};

export function buildMockAgentLoop(turn: UserTurn): MockAgentLoopData {
  const toolGroups: MockToolGroup[] = [];
  const toolCounts: Record<string, { calls: number; totalOutput: number; failed: number }> = {};

  turn.calls.forEach((call, i) => {
    const pattern = TOOL_PATTERNS[i % Object.keys(TOOL_PATTERNS).length];
    if (!pattern || call.isCompaction) return;
    const tools: MockToolCall[] = pattern.map(t => ({ ...t, id: `${call.id}-${t.id}` }));
    const totalOutput = tools.reduce((s, t) => s + t.outputSize, 0);
    toolGroups.push({ id: `tg-${call.id}`, afterCallId: call.id, tools, totalOutputSize: totalOutput, isParallel: tools.some(t => t.isParallel) });
    tools.forEach(t => {
      if (!toolCounts[t.tool]) toolCounts[t.tool] = { calls: 0, totalOutput: 0, failed: 0 };
      toolCounts[t.tool].calls++;
      toolCounts[t.tool].totalOutput += t.outputSize;
      if (t.status !== "ok") toolCounts[t.tool].failed++;
    });
  });

  const transitions: MockAgentLoopData["transitions"] = [];
  for (let i = 0; i < turn.calls.length - 1; i++) {
    const c = turn.calls[i];
    const next = turn.calls[i + 1];
    const delta = next.contextSize - c.contextSize;
    if (Math.abs(delta) < 500) continue;
    const tg = toolGroups.find(g => g.afterCallId === c.id);
    let cause = "incremental";
    if (c.isCompaction) {
      cause = "Compaction";
    } else if (tg) {
      const topTool = [...tg.tools].sort((a, b) => b.outputSize - a.outputSize)[0];
      const toolName = topTool?.tool ?? "tool";
      const toolCount = tg.tools.filter(t => t.tool === topTool?.tool).length;
      cause = toolCount > 1 ? `${toolName} ×${toolCount}` : `${toolName}: ${topTool?.input ?? ""}`;
    }
    transitions.push({ fromCallId: c.id, toCallId: next.id, contextDelta: delta, dominantCause: cause });
  }

  const toolSummary = Object.entries(toolCounts)
    .sort((a, b) => b[1].calls - a[1].calls)
    .map(([tool, s]) => ({ tool, ...s }));

  return { toolGroups, transitions, toolSummary, status: "completed" };
}

// ─── Mock sub agents (session-level) ─────────────────────────────────────────
// Used when real drilldown data has no sub agents but UI needs demo data.
// Real: populated by parseSubAgents() in the backend parser.

import type { SubAgentSummary } from "./drilldown-types";

export const MOCK_SUB_AGENTS: SubAgentSummary[] = [
  {
    agentFileId: "a373036faaffe1b06",
    agentType: "Explore",
    description: "Search for HTTP proxy/agent timeout settings",
    toolUseId: "toolu_mock_agent_01",
    toolUseName: "Agent",
    llmCallCount: 18,
    toolCallCount: 24,
    totalCacheRead: 485000,
    totalCacheWrite: 38000,
    totalFreshIn: 42,
    totalOutputTokens: 4200,
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
    llmCallCount: 12,
    toolCallCount: 15,
    totalCacheRead: 210000,
    totalCacheWrite: 18000,
    totalFreshIn: 28,
    totalOutputTokens: 3100,
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
