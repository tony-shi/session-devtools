// 自动 dump 自真实 session(scripts/voice/dump-fixture.ts)。
// session: 5e7476cd-c9cf-4029-9256-416a249c61a4
// title:   Analyze project purpose and functionality
// 重新生成:npx tsx scripts/voice/dump-fixture.ts 5e7476cd-c9cf-4029-9256-416a249c61a4 --turn 2

// 形状是 AgentLoopScene 消费的最小 LoopTurn(与庞大的 UserTurn 解耦)。
export type LoopToolCall = { name: string; inputPreview: string; outputPreview: string; outputSize: number; isError: boolean };
export type LoopCall = { contextSize: number; assistantText: string; toolCalls: LoopToolCall[] };
export type LoopTurn = { userInput: string; finalOutput: string; calls: LoopCall[] };

export const turnFixture: LoopTurn = {
  "userInput": "Answer in English. What are the three most important code files in this project? List each filename and its role in one sentence.",
  "finalOutput": "The three most important files, based on the data flow (parse → attribute → visualize):\n\n1. **`server/src/session-drilldown-parser.ts`** — Parses the raw Claude Code session JSONL into structured turns/LLM-calls/compact-events; it's the foundational ingestion layer everything else consumes.\n\n2. **`server/src/context-ledger/parser/attribution/jsonl-linker.ts`** — The attribution core: it rewrites each context node (to…",
  "calls": [
    {
      "contextSize": 15954,
      "assistantText": "",
      "toolCalls": [
        {
          "name": "Bash",
          "inputPreview": "{\"command\":\"echo \\\"=== top-level ===\\\" && ls && echo \\\"=== server/src ===\\\" && ls server/src 2>/dev/null && echo \\\"=== client/src ===\\\" && ls client/src 2>/dev/null && echo \\\"=== client/src/v2 ===\\\" && ls client/src/v2 2>/dev/null && echo \\\"=== line counts ===\\\" && find server/src client/src -name '",
          "outputPreview": "=== top-level ===\nbin\nCHANGELOG.md\nclient\nCONTRIBUTING.md\ndevelopment.md\ndist\ndocs\nLICENSE\nlocal-scripts\nmock-to-real.md\nnode_modules\npackage-lock.json\npackage.json\nREADME.en.md\nREADME.md\nresources\nscripts\nserver\ntmp\ntsconfig.json\ntsup.config.ts\n=== server/src ===\napp.module.ts\nattribution-algorithm",
          "outputSize": 2905,
          "isError": false
        }
      ]
    },
    {
      "contextSize": 17649,
      "assistantText": "",
      "toolCalls": [
        {
          "name": "Bash",
          "inputPreview": "{\"command\":\"for f in server/src/session-drilldown-parser.ts server/src/context-ledger/parser/attribution/jsonl-linker.ts server/src/attribution-service.ts client/src/v2/AttributionTreeLensPanel.tsx; do echo \\\"===== $f =====\\\"; head -30 \\\"$f\\\"; echo; done\",\"description\":\"Read headers of candidate key",
          "outputPreview": "===== server/src/session-drilldown-parser.ts =====\nimport { readFileSync, existsSync, readdirSync } from \"fs\";\nimport { join, dirname, basename } from \"path\";\nimport type { Database } from \"better-sqlite3\";\nimport type { SessionDrilldown, UserTurn, LlmCall, ProxyCallData, ModelStats, SubAgentSummary",
          "outputSize": 5715,
          "isError": false
        }
      ]
    },
    {
      "contextSize": 20524,
      "assistantText": "The three most important files, based on the data flow (parse → attribute → visualize):\n\n1. **`server/src/session-drilldown-parser.ts`** — Parses the raw Claude Code session JSONL into structured turn…",
      "toolCalls": []
    }
  ]
};
