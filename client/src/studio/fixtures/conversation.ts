import type { SceneTurn } from "../scenes/timeline";

// 自动 dump 自真实 session(scripts/voice/dump-fixture.ts)。
// session: 5e7476cd-c9cf-4029-9256-416a249c61a4
// title:   Analyze project purpose and functionality
// 重新生成:npx tsx scripts/voice/dump-fixture.ts 5e7476cd-c9cf-4029-9256-416a249c61a4 --turn 2
export const conversationFixture: SceneTurn[] = [
  {
    "id": 1,
    "user": "Answer in English. Briefly analyze what this project does in one sentence.",
    "assistant": "This project is a session dashboard/devtool that parses Claude Code session JSONL logs and visualizes them — notably attributing each piece of context (system reminders, rules, injected content) back to its source through a \"lens\"-based attribution tree in a React client backed by a Node attribution service.",
    "llmCalls": 1,
    "tools": []
  },
  {
    "id": 2,
    "user": "Answer in English. What are the three most important code files in this project? List each filename and its role in one sentence.",
    "assistant": "The three most important files, based on the data flow (parse → attribute → visualize):\n\n1. **`server/src/session-drilldown-parser.ts`** — Parses the raw Claude Code session JSONL into structured turns/LLM-calls/compact-events; it's the foundational ingestion layer everything else consumes.\n\n2. **`server/src/context-ledger/parser/attribution/jsonl-linker.ts`** — The attribution…",
    "llmCalls": 3,
    "tools": [
      {
        "name": "Bash",
        "count": 2
      }
    ]
  },
  {
    "id": 3,
    "user": "Answer in English. In the most important file, what are the three key methods or functions? List each name and its role in one sentence.",
    "assistant": "The most important file is the attribution core, `server/src/context-ledger/parser/attribution/jsonl-linker.ts`. Its three key functions:\n\n1. **`linkJsonl(...)`** (the sole public entry, line 899) — Walks every node in a `ParsedQuerySnapshot` and dispatches each to the appropriate linker, rewriting nodes whose origin can be proven from JSONL.\n\n2. **`buildIndex(events)`** (line …",
    "llmCalls": 2,
    "tools": [
      {
        "name": "Bash",
        "count": 1
      }
    ]
  }
];
