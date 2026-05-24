// Mock / fallback data used when the API is unavailable or during development.
//
// 抽出自 SessionDetailV2.tsx —— `normalizeTurns()` 把简化的 mock 结构补全成
// `UserTurn[]`，`buildFallbackTurns()` 产出一组固定示例 turns。纯数据 + 一个
// 默认值填充函数，无 React、无 i18n。

import type { DiffEntry, LlmCall, UserTurn } from "../drilldown-types";

// Local aliases for brevity (same as drilldown-types, no local re-declaration needed)
export type MockDiffEntry = DiffEntry;

// LlmCall fields added in drilldown-types are optional in the raw fallback
// data below; normalizeTurns() fills them in.
export type RawMockCall = Omit<LlmCall,
  "indexInTurn" | "messageId" | "apiRequestId" | "jsonlLineIdx" | "jsonlFrameLineIdxs" |
  "model" | "stopReason" | "proxy" | "proxyMatchMode" | "subAgents" |
  "isCompaction" | "isUnknownHeavy" | "isSignificant" | "significantDelta" | "freshIn" |
  "toolNames" | "toolCalls" | "assistantText" | "intervalEvents"
> & {
  isCompaction?: boolean; isUnknownHeavy?: boolean; isSignificant?: boolean;
  significantDelta?: number; freshIn?: number; toolNames?: string[];
};

export type RawMockTurn = Omit<UserTurn, "startedAt" | "endedAt" | "hasCompaction" | "hasUnknownSpike" | "finalOutput" | "durationMs" | "midTurnInjections" | "leadingEvents" | "errorCount" | "userInputLineIdx" | "calls"> & {
  hasCompaction?: boolean; hasUnknownSpike?: boolean; errorCount?: number; midTurnInjections?: UserTurn["midTurnInjections"]; leadingEvents?: UserTurn["leadingEvents"]; userInputLineIdx?: number | null; calls: RawMockCall[];
};

export type MockLlmCall = LlmCall;
export type MockUserTurn = UserTurn;

export function normalizeTurns(raw: RawMockTurn[]): UserTurn[] {
  return raw.map((t) => ({
    startedAt: "",
    endedAt: "",
    finalOutput: null,
    durationMs: 0,
    userInputLineIdx: t.userInputLineIdx ?? null,
    hasCompaction: t.hasCompaction ?? false,
    hasUnknownSpike: t.hasUnknownSpike ?? false,
    errorCount: t.errorCount ?? 0,
    ...t,
    midTurnInjections: t.midTurnInjections ?? [],
    leadingEvents: t.leadingEvents ?? [],
    calls: t.calls.map((c, ci) => ({
      ...c,
      indexInTurn: ci + 1,
      messageId: null,
      apiRequestId: null,
      jsonlLineIdx: null,
      jsonlFrameLineIdxs: [],
      model: "claude-opus-4-7",
      stopReason: "end_turn" as const,
      proxy: null,
      proxyMatchMode: "unmatched" as const,
      subAgents: [],
      freshIn: c.freshIn ?? 0,
      isCompaction: c.isCompaction ?? false,
      isUnknownHeavy: c.isUnknownHeavy ?? false,
      isSignificant: c.isSignificant ?? false,
      significantDelta: c.significantDelta ?? 0,
      toolNames: c.toolNames ?? [],
      toolCalls: [],
      assistantText: "",
      intervalEvents: [],
    })),
  }));
}

// ─── Fallback Mock Data (used when API is unavailable) ───────────────────────

export function buildFallbackTurns(): UserTurn[] {
  const raw: RawMockTurn[] = [
    {
      id: 1,
      userInput: "初始化项目，帮我搭一个 Express + TypeScript 的后端框架",
      llmCallCount: 4,
      toolCallCount: 6,
      netContextDelta: 18400,
      peakContext: 62000,
      cacheRead: 14200,
      cacheWrite: 8100,
      unknownDelta: 400,
      calls: [
        {
          id: 1, contextSize: 42000, outputTokens: 1200, cacheRead: 0, cacheWrite: 8100, timestamp: "14:01:02",
          incomingDiff: [
            { id: "d1", category: "System", label: "system prompt", delta: 31000, changeType: "added", cause: "initial", confidence: "High", evidence: "First call in session" },
            { id: "d2", category: "Tool Schemas", label: "tool schemas", delta: 9400, changeType: "added", cause: "initial", confidence: "High" },
            { id: "d3", category: "User Messages", label: "user input", delta: 1600, changeType: "added", cause: "user input", confidence: "High", evidence: "Matched user turn content" },
          ],
        },
        {
          id: 2, contextSize: 54200, outputTokens: 980, cacheRead: 6800, cacheWrite: 0, timestamp: "14:01:18", isSignificant: true, significantDelta: 12200,
          incomingDiff: [
            { id: "d4", category: "Tool Output", label: "Bash(mkdir -p src/routes)", delta: 840, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_01A" },
            { id: "d5", category: "Tool Output", label: "Write(src/index.ts)", delta: 4800, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_01B" },
            { id: "d6", category: "Tool Output", label: "Write(tsconfig.json)", delta: 1200, changeType: "added", cause: "tool result", confidence: "High" },
            { id: "d7", category: "Assistant History", label: "assistant response #1", delta: 5360, changeType: "added", cause: "assistant output", confidence: "High" },
          ],
        },
        {
          id: 3, contextSize: 58900, outputTokens: 720, cacheRead: 4200, cacheWrite: 0, timestamp: "14:01:35",
          incomingDiff: [
            { id: "d8", category: "Tool Output", label: "Read(package.json)", delta: 2100, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_01C" },
            { id: "d9", category: "Tool Output", label: "Bash(npm install)", delta: 2600, changeType: "added", cause: "tool result", confidence: "Medium", evidence: "Matched bash output pattern" },
          ],
        },
        {
          id: 4, contextSize: 62000, outputTokens: 540, cacheRead: 3200, cacheWrite: 0, timestamp: "14:01:52",
          incomingDiff: [
            { id: "d10", category: "Assistant History", label: "assistant response #2", delta: 3100, changeType: "added", cause: "assistant output", confidence: "High" },
          ],
        },
      ],
    },
    {
      id: 2,
      userInput: "review 当前 context 展示逻辑，看看哪里有性能问题",
      llmCallCount: 17,
      toolCallCount: 9,
      netContextDelta: 81600,
      peakContext: 143000,
      cacheRead: 121000,
      cacheWrite: 2100,
      unknownDelta: 2300,
      hasUnknownSpike: true,
      calls: [
        { id: 12, contextSize: 90000, outputTokens: 1100, cacheRead: 18000, cacheWrite: 0, timestamp: "14:22:01", incomingDiff: [
          { id: "e1", category: "User Messages", label: "user input (turn 2)", delta: 820, changeType: "added", cause: "user input", confidence: "High" },
          { id: "e2", category: "Tool Output", label: "retained bash outputs", delta: 6200, changeType: "retained", cause: "retained", confidence: "High" },
        ]},
        { id: 13, contextSize: 103000, outputTokens: 1400, cacheRead: 22000, cacheWrite: 0, timestamp: "14:22:18", isSignificant: true, significantDelta: 12800, incomingDiff: [
          { id: "e3", category: "Tool Output", label: "Read(server/src/context.ts)", delta: 12800, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_02A · source: JSONL line 1842 · proxy request: req_abc123" },
          { id: "e4", category: "Assistant History", label: "assistant step #3", delta: 180, changeType: "added", cause: "assistant output", confidence: "High" },
        ]},
        { id: 14, contextSize: 106000, outputTokens: 880, cacheRead: 19000, cacheWrite: 0, timestamp: "14:22:34", incomingDiff: [
          { id: "e5", category: "Tool Output", label: "Read(server/src/parser.ts)", delta: 3100, changeType: "added", cause: "tool result", confidence: "High" },
        ]},
        { id: 15, contextSize: 109000, outputTokens: 760, cacheRead: 21000, cacheWrite: 0, timestamp: "14:22:51", incomingDiff: [
          { id: "e6", category: "Tool Output", label: "Bash(grep -n performance)", delta: 2800, changeType: "added", cause: "tool result", confidence: "Medium" },
        ]},
        { id: 16, contextSize: 143000, outputTokens: 2100, cacheRead: 24000, cacheWrite: 0, timestamp: "14:23:08", isSignificant: true, significantDelta: 3400, incomingDiff: [
          { id: "e7", category: "Tool Output", label: "Bash test output", delta: 3400, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_02B" },
          { id: "e8", category: "Unknown", label: "unattributed delta +1.2k", delta: 1200, changeType: "added", cause: "unknown", confidence: "Unknown" },
        ]},
        { id: 17, contextSize: 102000, outputTokens: 1800, cacheRead: 0, cacheWrite: 2100, timestamp: "14:23:22", isCompaction: true, incomingDiff: [
          { id: "e9", category: "Compaction Summary", label: "compaction summary injected", delta: 4200, changeType: "added", cause: "compaction", confidence: "High" },
          { id: "e10", category: "Tool Output", label: "previous tool outputs (removed)", delta: -41200, changeType: "removed", cause: "compaction", confidence: "High" },
          { id: "e11", category: "Assistant History", label: "prior assistant history (removed)", delta: -4000, changeType: "removed", cause: "compaction", confidence: "High" },
        ]},
        { id: 18, contextSize: 118000, outputTokens: 1200, cacheRead: 17000, cacheWrite: 0, timestamp: "14:23:38", isSignificant: true, significantDelta: 2100, incomingDiff: [
          { id: "e12", category: "Skills / Task Injection", label: "task reminder re-injected", delta: 2100, changeType: "added", cause: "skill injection", confidence: "Medium", evidence: "Matched skill/task pattern in system context" },
          { id: "e13", category: "Unknown", label: "environment delta", delta: 1100, changeType: "changed", cause: "unknown", confidence: "Low" },
        ]},
        ...([19,20,21,22,23,24,25,26,27,28].map(id => ({
          id, contextSize: 118000 + (id - 18) * 1200, outputTokens: 600, cacheRead: 15000, cacheWrite: 0, timestamp: `14:2${id}:00`, incomingDiff: [
            { id: `minor-${id}`, category: "Assistant History", label: "incremental assistant step", delta: 400 + id * 30, changeType: "added" as const, cause: "assistant output", confidence: "High" as const },
          ],
        }))),
      ],
    },
    {
      id: 3,
      userInput: "把 ContextTimeline 组件拆分为更小的子组件",
      llmCallCount: 8,
      toolCallCount: 12,
      netContextDelta: 24200,
      peakContext: 138000,
      cacheRead: 98000,
      cacheWrite: 1200,
      unknownDelta: 600,
      hasCompaction: true,
      calls: [
        { id: 29, contextSize: 118000, outputTokens: 900, cacheRead: 19000, cacheWrite: 0, timestamp: "15:10:01", incomingDiff: [
          { id: "f1", category: "User Messages", label: "user input (turn 3)", delta: 740, changeType: "added", cause: "user input", confidence: "High" },
        ]},
        { id: 30, contextSize: 128000, outputTokens: 1300, cacheRead: 22000, cacheWrite: 0, timestamp: "15:10:18", isSignificant: true, significantDelta: 9800, incomingDiff: [
          { id: "f2", category: "Tool Output", label: "Read(ContextTimeline/index.tsx)", delta: 9800, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_03A" },
        ]},
        { id: 31, contextSize: 138000, outputTokens: 1100, cacheRead: 20000, cacheWrite: 0, timestamp: "15:10:35", isSignificant: true, significantDelta: 7200, incomingDiff: [
          { id: "f3", category: "Tool Output", label: "Read(ContextTimeline/types.ts)", delta: 4100, changeType: "added", cause: "tool result", confidence: "High" },
          { id: "f4", category: "Tool Output", label: "Read(StackedAreaChart.tsx)", delta: 3100, changeType: "added", cause: "tool result", confidence: "High" },
        ]},
        { id: 32, contextSize: 91000, outputTokens: 800, cacheRead: 0, cacheWrite: 1200, timestamp: "15:10:52", isCompaction: true, incomingDiff: [
          { id: "f5", category: "Compaction Summary", label: "compaction summary", delta: 3800, changeType: "added", cause: "compaction", confidence: "High" },
          { id: "f6", category: "Tool Output", label: "large tool reads (removed)", delta: -38000, changeType: "removed", cause: "compaction", confidence: "High" },
        ]},
        ...([33,34,35,36].map(id => ({
          id, contextSize: 91000 + (id - 32) * 3000, outputTokens: 700, cacheRead: 14000, cacheWrite: 0, timestamp: `15:11:${(id - 32) * 15}`, incomingDiff: [
            { id: `f-minor-${id}`, category: "Tool Output", label: `Write(new-component-${id - 32}.tsx)`, delta: 2800 + id * 20, changeType: "added" as const, cause: "tool result", confidence: "High" as const },
          ],
        }))),
      ],
    },
    {
      id: 4,
      userInput: "运行测试，确认没有回归",
      llmCallCount: 3,
      toolCallCount: 2,
      netContextDelta: 4800,
      peakContext: 108000,
      cacheRead: 76000,
      cacheWrite: 0,
      unknownDelta: 0,
      calls: [
        { id: 37, contextSize: 103000, outputTokens: 600, cacheRead: 18000, cacheWrite: 0, timestamp: "15:32:01", incomingDiff: [
          { id: "g1", category: "User Messages", label: "user input (turn 4)", delta: 420, changeType: "added", cause: "user input", confidence: "High" },
        ]},
        { id: 38, contextSize: 106000, outputTokens: 820, cacheRead: 29000, cacheWrite: 0, timestamp: "15:32:15", isSignificant: true, significantDelta: 3200, incomingDiff: [
          { id: "g2", category: "Tool Output", label: "Bash(npm test)", delta: 3200, changeType: "added", cause: "tool result", confidence: "High", evidence: "tool_call_id: toolu_04A · Matched test runner output pattern" },
        ]},
        { id: 39, contextSize: 108000, outputTokens: 540, cacheRead: 29000, cacheWrite: 0, timestamp: "15:32:30", incomingDiff: [
          { id: "g3", category: "Assistant History", label: "final summary", delta: 1600, changeType: "added", cause: "assistant output", confidence: "High" },
        ]},
      ],
    },
    {
      id: 5,
      userInput: "更新 README，补充 context 追踪模块的说明",
      llmCallCount: 5,
      toolCallCount: 3,
      netContextDelta: 6100,
      peakContext: 112000,
      cacheRead: 84000,
      cacheWrite: 0,
      unknownDelta: 300,
      calls: [
        { id: 40, contextSize: 108000, outputTokens: 700, cacheRead: 20000, cacheWrite: 0, timestamp: "16:05:01", incomingDiff: [
          { id: "h1", category: "User Messages", label: "user input (turn 5)", delta: 380, changeType: "added", cause: "user input", confidence: "High" },
        ]},
        { id: 41, contextSize: 110000, outputTokens: 900, cacheRead: 22000, cacheWrite: 0, timestamp: "16:05:18", isSignificant: true, significantDelta: 2400, incomingDiff: [
          { id: "h2", category: "Tool Output", label: "Read(README.md)", delta: 2400, changeType: "added", cause: "tool result", confidence: "High" },
        ]},
        { id: 42, contextSize: 111000, outputTokens: 1100, cacheRead: 21000, cacheWrite: 0, timestamp: "16:05:35", incomingDiff: [
          { id: "h3", category: "Tool Output", label: "Write(README.md)", delta: 1200, changeType: "changed", cause: "tool result", confidence: "Medium" },
        ]},
        { id: 43, contextSize: 112000, outputTokens: 640, cacheRead: 21000, cacheWrite: 0, timestamp: "16:05:52", incomingDiff: [
          { id: "h4", category: "Unknown", label: "environment block update", delta: 300, changeType: "changed", cause: "unknown", confidence: "Low" },
        ]},
        { id: 44, contextSize: 114000, outputTokens: 480, cacheRead: 0, cacheWrite: 0, timestamp: "16:06:08", incomingDiff: [
          { id: "h5", category: "Assistant History", label: "closing summary", delta: 1800, changeType: "added", cause: "assistant output", confidence: "High" },
        ]},
      ],
    },
  ];
  return normalizeTurns(raw);
}
