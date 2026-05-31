// 自动 dump 自真实 session(scripts/voice/dump-fixture.ts)。
// session: 9e1ba147-a077-4cbe-94ec-3558dbaef8e3
// title:   Analyze project purpose and functionality
// 重新生成:npx tsx scripts/voice/dump-fixture.ts 9e1ba147-a077-4cbe-94ec-3558dbaef8e3 --turn 2

// 形状是 AgentLoopScene 消费的最小 LoopTurn(与庞大的 UserTurn 解耦)。
export type LoopToolCall = { name: string; inputPreview: string; outputPreview: string; outputSize: number; isError: boolean };
export type LoopCall = { contextSize: number; assistantText: string; toolCalls: LoopToolCall[] };
export type LoopTurn = { userInput: string; finalOutput: string; calls: LoopCall[] };

export const turnFixture: LoopTurn = {
  "userInput": "What are the three most important code files in this project? List each filename and its role in one sentence.",
  "finalOutput": "Based on file size, centrality, and where the active work is concentrated:\n\n1. **`server/src/session-drilldown-parser.ts`** — The core parser that ingests raw Claude Code session JSONL and reconstructs the turn → LLM-call → tool-call structure that the entire dashboard is built on.\n\n2. **`server/src/context-ledger/parser/attribution/jsonl-linker.ts`** — The attribution engine that links each context segment (system p…",
  "calls": [
    {
      "contextSize": 25536,
      "assistantText": "",
      "toolCalls": [
        {
          "name": "Bash",
          "inputPreview": "{\"command\":\"echo \\\"=== top dirs ===\\\" && ls server/src client/src 2>/dev/null && echo \\\"=== line counts of key server files ===\\\" && find server/src -name \\\"*.ts\\\" -exec wc -l {} + 2>/dev/null | sort -rn | head -20 && echo \\\"=== client ===\\\" && find client/src -name \\\"*.tsx\\\" -o -name \\\"*.ts\\\" | xar",
          "outputPreview": "=== top dirs ===\nclient/src:\nApp.tsx\nassets\ncomponents\ni18n.ts\nindex.css\nlib\nlocales\nmain.tsx\ntypes\nv2\n\nserver/src:\napp.module.ts\nattribution-algorithms-diff.test.ts\nattribution-service.test.ts\nattribution-service.ts\nattribution-tree-enrich.test.ts\nattribution-tree-enrich.ts\ncall-detail.ts\ncompact-p",
          "outputSize": 2669,
          "isError": false
        }
      ]
    },
    {
      "contextSize": 27080,
      "assistantText": "Based on file size, centrality, and where the active work is concentrated:\n\n1. **`server/src/session-drilldown-parser.ts`** — The core parser that ingests raw Claude Code session JSONL and reconstruct…",
      "toolCalls": []
    }
  ]
};
