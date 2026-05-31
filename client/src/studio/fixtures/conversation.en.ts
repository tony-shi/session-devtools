import type { SceneTurn } from "../scenes/timeline";

// 自动 dump 自真实 session(scripts/voice/dump-fixture.ts)。
// session: 9e1ba147-a077-4cbe-94ec-3558dbaef8e3
// title:   Analyze project purpose and functionality
// 重新生成:npx tsx scripts/voice/dump-fixture.ts 9e1ba147-a077-4cbe-94ec-3558dbaef8e3 --turn 2
export const conversationFixture: SceneTurn[] = [
  {
    "id": 1,
    "user": "Briefly analyze what this project does in one sentence.",
    "assistant": "`session-devtools` is a local devtools dashboard that parses Claude Code session logs (JSONL) to let you drill into each session's turns, sub-agent boundaries, token/call/tool usage, context attribution, and call-to-call diffs—essentially a cockpit for inspecting every detail of an AI coding agent's interaction with the LLM.",
    "llmCalls": 2,
    "tools": [
      {
        "name": "Bash",
        "count": 1
      }
    ]
  },
  {
    "id": 2,
    "user": "What are the three most important code files in this project? List each filename and its role in one sentence.",
    "assistant": "Based on file size, centrality, and where the active work is concentrated:\n\n1. **`server/src/session-drilldown-parser.ts`** — The core parser that ingests raw Claude Code session JSONL and reconstructs the turn → LLM-call → tool-call structure that the entire dashboard is built on.\n\n2. **`server/src/context-ledger/parser/attribution/jsonl-linker.ts`** — The attribution engine t…",
    "llmCalls": 2,
    "tools": [
      {
        "name": "Bash",
        "count": 1
      }
    ]
  },
  {
    "id": 3,
    "user": "In the most important file, what are the three key methods or functions? List each name and its role in one sentence.",
    "assistant": "The most important file is `server/src/session-drilldown-parser.ts`. Its three key functions:\n\n1. **`parseSessionDrilldown(...)`** — The main exported entry point that takes a session's raw JSONL and produces the full drilldown structure (turns, LLM calls, tool calls, usage stats) consumed by the API and frontend.\n\n2. **`parseSubAgents(...)`** — Detects sub-agent delegation by …",
    "llmCalls": 2,
    "tools": [
      {
        "name": "Bash",
        "count": 1
      }
    ]
  }
];
