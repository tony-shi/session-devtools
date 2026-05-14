import type { SessionDrilldown, UserTurn, LlmCall } from "./session-drilldown-types.ts";

// Placeholder factory — returns a hardcoded mock SessionDrilldown in the correct contract shape.
// Real data computation will replace this function field-by-field in subsequent iterations.
export function buildMockDrilldown(sessionId: string): SessionDrilldown {
  const turns = buildMockTurns();
  const totalLlmCalls = turns.reduce((s, t) => s + t.llmCallCount, 0);
  const totalToolCalls = turns.reduce((s, t) => s + t.toolCallCount, 0);
  const peakContext = Math.max(...turns.map(t => t.peakContext));
  const totalCacheRead = turns.reduce((s, t) => s + t.cacheRead, 0);
  const totalCacheWrite = turns.reduce((s, t) => s + t.cacheWrite, 0);

  return {
    sessionId,
    tool: "claude",
    project: "session-dashboard",
    cwd: "/Users/demo/Documents/session-dashboard",
    title: "Mock drilldown — real data not yet parsed",
    firstEventAt: "2026-05-09T14:01:02.000Z",
    lastEventAt: "2026-05-09T16:06:08.000Z",
    totalLlmCalls,
    totalToolCalls,
    peakContext,
    totalCacheRead,
    totalCacheWrite,
    totalFreshIn: 0,
    totalFreshOut: 0,
    lastContext: 0,
    systemErrorCount: 0,
    modelBreakdown: { "claude-opus-4-7": { calls: totalLlmCalls, outputTokens: 0, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, freshIn: 0 } },
    hasProxyData: false,
    hasJsonlSource: false,
    compactionCount: 0,
    toolDistribution: [],
    subAgentCount: 0,
    subAgents: [],
    turns,
    interTurnBlocks: [],
  };
}

function buildMockTurns(): UserTurn[] {
  return [
    {
      id: 1,
      userInput: "初始化项目，帮我搭一个 Express + TypeScript 的后端框架",
      finalOutput: "已完成框架搭建。创建了 `src/index.ts`、`tsconfig.json` 和 `package.json`，安装了 express、typescript 依赖，项目可通过 `npm run dev` 启动。",
      startedAt: "2026-05-09T14:01:00.000Z",
      endedAt: "2026-05-09T14:01:52.000Z",
      durationMs: 52000,
      llmCallCount: 4,
      toolCallCount: 6,
      netContextDelta: 18400,
      peakContext: 62000,
      cacheRead: 14200,
      cacheWrite: 8100,
      unknownDelta: 0,
      hasCompaction: false,
      hasUnknownSpike: false,
      errorCount: 0,
      midTurnInjections: [] as import("./session-drilldown-types.ts").MidTurnInjection[],
      calls: [
        call(1, 1, { contextSize: 42000, outputTokens: 1200, cacheRead: 0, cacheWrite: 8100, timestamp: "2026-05-09T14:01:02.000Z", significantDelta: 42000, isSignificant: true,
          incomingDiff: [
            diff("d1", "System", "system prompt", 31000, "added", "initial", "High", "First call in session"),
            diff("d2", "Tool Schemas", "tool schemas", 9400, "added", "initial", "High"),
            diff("d3", "User Messages", "user input", 1600, "added", "user input", "High", "Matched user turn content"),
          ],
        }),
        call(2, 2, { contextSize: 54200, outputTokens: 980, cacheRead: 6800, cacheWrite: 0, timestamp: "2026-05-09T14:01:18.000Z", significantDelta: 12200, isSignificant: true,
          incomingDiff: [
            diff("d4", "Tool Output", "Bash(mkdir -p src/routes)", 840, "added", "tool result", "High", "tool_call_id: toulu_01A"),
            diff("d5", "Tool Output", "Write(src/index.ts)", 4800, "added", "tool result", "High", "tool_call_id: toulu_01B"),
            diff("d6", "Tool Output", "Write(tsconfig.json)", 1200, "added", "tool result", "High"),
            diff("d7", "Assistant History", "assistant response #1", 5360, "added", "assistant output", "High"),
          ],
        }),
        call(3, 3, { contextSize: 58900, outputTokens: 720, cacheRead: 4200, cacheWrite: 0, timestamp: "2026-05-09T14:01:35.000Z", significantDelta: 4700,
          incomingDiff: [
            diff("d8", "Tool Output", "Read(package.json)", 2100, "added", "tool result", "High", "tool_call_id: toulu_01C"),
            diff("d9", "Tool Output", "Bash(npm install)", 2600, "added", "tool result", "Medium", "Matched bash output pattern"),
          ],
        }),
        call(4, 4, { contextSize: 62000, outputTokens: 540, cacheRead: 3200, cacheWrite: 0, timestamp: "2026-05-09T14:01:52.000Z", significantDelta: 3100,
          incomingDiff: [
            diff("d10", "Assistant History", "assistant response #2", 3100, "added", "assistant output", "High"),
          ],
        }),
      ],
    },
    {
      id: 2,
      userInput: "review 当前 context 展示逻辑，看看哪里有性能问题",
      finalOutput: "分析完成。主要性能瓶颈在 `StackedAreaChart.tsx` 的 `useMemo` 依赖数组过于宽泛，每次父组件重渲染都会触发重计算。建议将 `snapshots` 数组的引用稳定化，或拆分为更细粒度的 selector。另外 `AgentContextPanel` 存在 O(n²) 的 segment 匹配，数据量大时影响明显。",
      startedAt: "2026-05-09T14:22:00.000Z",
      endedAt: "2026-05-09T14:28:00.000Z",
      durationMs: 360000,
      llmCallCount: 17,
      toolCallCount: 9,
      netContextDelta: 81600,
      peakContext: 143000,
      cacheRead: 121000,
      cacheWrite: 2100,
      unknownDelta: 0,
      hasCompaction: true,
      hasUnknownSpike: false,
      errorCount: 0,
      midTurnInjections: [] as import("./session-drilldown-types.ts").MidTurnInjection[],
      calls: [
        call(12, 1, { contextSize: 90000, outputTokens: 1100, cacheRead: 18000, cacheWrite: 0, timestamp: "2026-05-09T14:22:01.000Z", significantDelta: 28000,
          incomingDiff: [
            diff("e1", "User Messages", "user input (turn 2)", 820, "added", "user input", "High"),
            diff("e2", "Tool Output", "retained bash outputs", 6200, "retained", "retained", "High"),
          ],
        }),
        call(13, 2, { contextSize: 103000, outputTokens: 1400, cacheRead: 22000, cacheWrite: 0, timestamp: "2026-05-09T14:22:18.000Z", significantDelta: 12800, isSignificant: true,
          incomingDiff: [
            diff("e3", "Tool Output", "Read(server/src/context.ts)", 12800, "added", "tool result", "High", "tool_call_id: toulu_02A · source: JSONL line 1842 · proxy request: req_abc123"),
            diff("e4", "Assistant History", "assistant step #3", 180, "added", "assistant output", "High"),
          ],
        }),
        call(14, 3, { contextSize: 106000, outputTokens: 880, cacheRead: 19000, cacheWrite: 0, timestamp: "2026-05-09T14:22:34.000Z", significantDelta: 3000,
          incomingDiff: [
            diff("e5", "Tool Output", "Read(server/src/parser.ts)", 3100, "added", "tool result", "High"),
          ],
        }),
        call(15, 4, { contextSize: 109000, outputTokens: 760, cacheRead: 21000, cacheWrite: 0, timestamp: "2026-05-09T14:22:51.000Z", significantDelta: 2800,
          incomingDiff: [
            diff("e6", "Tool Output", "Bash(grep -n performance)", 2800, "added", "tool result", "Medium"),
          ],
        }),
        call(16, 5, { contextSize: 143000, outputTokens: 2100, cacheRead: 24000, cacheWrite: 0, timestamp: "2026-05-09T14:23:08.000Z", significantDelta: 3400, isSignificant: true,
          incomingDiff: [
            diff("e7", "Tool Output", "Bash test output", 3400, "added", "tool result", "High", "tool_call_id: toulu_02B"),
            diff("e8", "Unknown", "unattributed delta +1.2k", 1200, "added", "unknown", "Unknown"),
          ],
        }),
        call(17, 6, { contextSize: 102000, outputTokens: 1800, cacheRead: 0, cacheWrite: 2100, timestamp: "2026-05-09T14:23:22.000Z", significantDelta: -41000, isCompaction: true,
          incomingDiff: [
            diff("e9", "Compaction Summary", "compaction summary injected", 4200, "added", "compaction", "High"),
            diff("e10", "Tool Output", "previous tool outputs (removed)", -41200, "removed", "compaction", "High"),
            diff("e11", "Assistant History", "prior assistant history (removed)", -4000, "removed", "compaction", "High"),
          ],
        }),
        call(18, 7, { contextSize: 118000, outputTokens: 1200, cacheRead: 17000, cacheWrite: 0, timestamp: "2026-05-09T14:23:38.000Z", significantDelta: 2100, isSignificant: true,
          incomingDiff: [
            diff("e12", "Skills / Task Injection", "task reminder re-injected", 2100, "added", "skill injection", "Medium", "Matched skill/task pattern in system context"),
            diff("e13", "Unknown", "environment delta", 1100, "changed", "unknown", "Low"),
          ],
        }),
        ...[19, 20, 21, 22, 23, 24, 25, 26, 27, 28].map((id, i) =>
          call(id, 8 + i, {
            contextSize: 118000 + (id - 18) * 1200,
            outputTokens: 600,
            cacheRead: 15000,
            cacheWrite: 0,
            timestamp: `2026-05-09T14:2${id}:00.000Z`,
            significantDelta: 400 + id * 30,
            incomingDiff: [
              diff(`minor-${id}`, "Assistant History", "incremental assistant step", 400 + id * 30, "added", "assistant output", "High"),
            ],
          })
        ),
      ],
    },
    {
      id: 3,
      userInput: "把 ContextTimeline 组件拆分为更小的子组件",
      finalOutput: "拆分完成。将原 `ContextTimeline/index.tsx` 拆为 `StackedAreaChart`、`TurnProvenanceView`、`CompactionDiff` 三个独立子组件，各自持有独立 props interface，父组件只传递必要数据。",
      startedAt: "2026-05-09T15:10:00.000Z",
      endedAt: "2026-05-09T15:11:45.000Z",
      durationMs: 105000,
      llmCallCount: 8,
      toolCallCount: 12,
      netContextDelta: 24200,
      peakContext: 138000,
      cacheRead: 98000,
      cacheWrite: 1200,
      unknownDelta: 0,
      hasCompaction: true,
      hasUnknownSpike: false,
      errorCount: 0,
      midTurnInjections: [] as import("./session-drilldown-types.ts").MidTurnInjection[],
      calls: [
        call(29, 1, { contextSize: 118000, outputTokens: 900, cacheRead: 19000, cacheWrite: 0, timestamp: "2026-05-09T15:10:01.000Z", significantDelta: 740,
          incomingDiff: [
            diff("f1", "User Messages", "user input (turn 3)", 740, "added", "user input", "High"),
          ],
        }),
        call(30, 2, { contextSize: 128000, outputTokens: 1300, cacheRead: 22000, cacheWrite: 0, timestamp: "2026-05-09T15:10:18.000Z", significantDelta: 9800, isSignificant: true,
          incomingDiff: [
            diff("f2", "Tool Output", "Read(ContextTimeline/index.tsx)", 9800, "added", "tool result", "High", "tool_call_id: toulu_03A"),
          ],
        }),
        call(31, 3, { contextSize: 138000, outputTokens: 1100, cacheRead: 20000, cacheWrite: 0, timestamp: "2026-05-09T15:10:35.000Z", significantDelta: 7200, isSignificant: true,
          incomingDiff: [
            diff("f3", "Tool Output", "Read(ContextTimeline/types.ts)", 4100, "added", "tool result", "High"),
            diff("f4", "Tool Output", "Read(StackedAreaChart.tsx)", 3100, "added", "tool result", "High"),
          ],
        }),
        call(32, 4, { contextSize: 91000, outputTokens: 800, cacheRead: 0, cacheWrite: 1200, timestamp: "2026-05-09T15:10:52.000Z", significantDelta: -47000, isCompaction: true,
          incomingDiff: [
            diff("f5", "Compaction Summary", "compaction summary", 3800, "added", "compaction", "High"),
            diff("f6", "Tool Output", "large tool reads (removed)", -38000, "removed", "compaction", "High"),
          ],
        }),
        ...[33, 34, 35, 36].map((id, i) =>
          call(id, 5 + i, {
            contextSize: 91000 + (id - 32) * 3000,
            outputTokens: 700,
            cacheRead: 14000,
            cacheWrite: 0,
            timestamp: `2026-05-09T15:11:${String((id - 32) * 15).padStart(2, "0")}.000Z`,
            significantDelta: 2800 + id * 20,
            incomingDiff: [
              diff(`f-minor-${id}`, "Tool Output", `Write(new-component-${id - 32}.tsx)`, 2800 + id * 20, "added", "tool result", "High"),
            ],
          })
        ),
      ],
    },
    {
      id: 4,
      userInput: "运行测试，确认没有回归",
      finalOutput: "测试全部通过，无回归。`npm test` 输出：19 passed, 0 failed。",
      startedAt: "2026-05-09T15:32:00.000Z",
      endedAt: "2026-05-09T15:32:30.000Z",
      durationMs: 30000,
      llmCallCount: 3,
      toolCallCount: 2,
      netContextDelta: 4800,
      peakContext: 108000,
      cacheRead: 76000,
      cacheWrite: 0,
      unknownDelta: 0,
      hasCompaction: false,
      hasUnknownSpike: false,
      errorCount: 0,
      midTurnInjections: [] as import("./session-drilldown-types.ts").MidTurnInjection[],
      calls: [
        call(37, 1, { contextSize: 103000, outputTokens: 600, cacheRead: 18000, cacheWrite: 0, timestamp: "2026-05-09T15:32:01.000Z", significantDelta: 420,
          incomingDiff: [
            diff("g1", "User Messages", "user input (turn 4)", 420, "added", "user input", "High"),
          ],
        }),
        call(38, 2, { contextSize: 106000, outputTokens: 820, cacheRead: 29000, cacheWrite: 0, timestamp: "2026-05-09T15:32:15.000Z", significantDelta: 3200, isSignificant: true,
          incomingDiff: [
            diff("g2", "Tool Output", "Bash(npm test)", 3200, "added", "tool result", "High", "tool_call_id: toulu_04A · Matched test runner output pattern"),
          ],
        }),
        call(39, 3, { contextSize: 108000, outputTokens: 540, cacheRead: 29000, cacheWrite: 0, timestamp: "2026-05-09T15:32:30.000Z", significantDelta: 1600,
          incomingDiff: [
            diff("g3", "Assistant History", "final summary", 1600, "added", "assistant output", "High"),
          ],
        }),
      ],
    },
    {
      id: 5,
      userInput: "更新 README，补充 context 追踪模块的说明",
      finalOutput: "README 已更新。在 `## Architecture` 章节新增了 `Context Tracking` 小节，说明了 `LlmCallSnapshot`、`SnapshotDiff` 的数据流向和 proxy 集成方式。",
      startedAt: "2026-05-09T16:05:00.000Z",
      endedAt: "2026-05-09T16:06:08.000Z",
      durationMs: 68000,
      llmCallCount: 5,
      toolCallCount: 3,
      netContextDelta: 6100,
      peakContext: 112000,
      cacheRead: 84000,
      cacheWrite: 0,
      unknownDelta: 0,
      hasCompaction: false,
      hasUnknownSpike: false,
      errorCount: 0,
      midTurnInjections: [] as import("./session-drilldown-types.ts").MidTurnInjection[],
      calls: [
        call(40, 1, { contextSize: 108000, outputTokens: 700, cacheRead: 20000, cacheWrite: 0, timestamp: "2026-05-09T16:05:01.000Z", significantDelta: 380,
          incomingDiff: [
            diff("h1", "User Messages", "user input (turn 5)", 380, "added", "user input", "High"),
          ],
        }),
        call(41, 2, { contextSize: 110000, outputTokens: 900, cacheRead: 22000, cacheWrite: 0, timestamp: "2026-05-09T16:05:18.000Z", significantDelta: 2400, isSignificant: true,
          incomingDiff: [
            diff("h2", "Tool Output", "Read(README.md)", 2400, "added", "tool result", "High"),
          ],
        }),
        call(42, 3, { contextSize: 111000, outputTokens: 1100, cacheRead: 21000, cacheWrite: 0, timestamp: "2026-05-09T16:05:35.000Z", significantDelta: 1200,
          incomingDiff: [
            diff("h3", "Tool Output", "Write(README.md)", 1200, "changed", "tool result", "Medium"),
          ],
        }),
        call(43, 4, { contextSize: 112000, outputTokens: 640, cacheRead: 21000, cacheWrite: 0, timestamp: "2026-05-09T16:05:52.000Z", significantDelta: 300,
          incomingDiff: [
            diff("h4", "Unknown", "environment block update", 300, "changed", "unknown", "Low"),
          ],
        }),
        call(44, 5, { contextSize: 114000, outputTokens: 480, cacheRead: 0, cacheWrite: 0, timestamp: "2026-05-09T16:06:08.000Z", significantDelta: 1800,
          incomingDiff: [
            diff("h5", "Assistant History", "closing summary", 1800, "added", "assistant output", "High"),
          ],
        }),
      ],
    },
  ];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type CallOverrides = Partial<Omit<LlmCall, "id" | "indexInTurn" | "proxy">> & {
  contextSize: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  timestamp: string;
  significantDelta: number;
  incomingDiff: LlmCall["incomingDiff"];
};

function call(id: number, indexInTurn: number, overrides: CallOverrides): LlmCall {
  return {
    id,
    indexInTurn,
    messageId: null,
    jsonlLineIdx: null,
    jsonlFrameLineIdxs: [],
    model: "claude-opus-4-7",
    stopReason: "end_turn",
    isCompaction: false,
    isUnknownHeavy: false,
    freshIn: Math.max(0, overrides.contextSize - overrides.cacheRead - overrides.cacheWrite),
    isSignificant: false,
    proxy: null,
    subAgents: [],
    toolNames: [],
    toolCalls: [],
    assistantText: "",
    intervalEvents: [],
    ...overrides,
  } as LlmCall;
}

type DiffChangeType = "added" | "removed" | "changed" | "retained";
type DiffConfidence = "High" | "Medium" | "Low" | "Unknown";

function diff(
  id: string,
  category: string,
  label: string,
  delta: number,
  changeType: DiffChangeType,
  cause: string,
  confidence: DiffConfidence,
  evidence?: string,
): import("./session-drilldown-types.ts").DiffEntry {
  return { id, category, label, delta, changeType, cause, confidence, evidence };
}
