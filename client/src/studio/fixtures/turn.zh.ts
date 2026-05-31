// 取自真实 session(scripts/voice/dump-fixture.ts)的结构,prose 文案已本地化为中文。
// session: 5e7476cd-c9cf-4029-9256-416a249c61a4
// title:   Analyze project purpose and functionality
// 注意:userInput / finalOutput / assistantText 是按中文视频手工本地化的;Bash 的命令与
//      终端输出(inputPreview/outputPreview)保持原样 —— 它们是语言中立的代码 / 真实输出。
//      重跑 dump-fixture.ts 会覆盖回英文,翻译需重做。

// 形状是 AgentLoopScene 消费的最小 LoopTurn(与庞大的 UserTurn 解耦)。
export type LoopToolCall = { name: string; inputPreview: string; outputPreview: string; outputSize: number; isError: boolean };
export type LoopCall = { contextSize: number; assistantText: string; toolCalls: LoopToolCall[] };
export type LoopTurn = { userInput: string; finalOutput: string; calls: LoopCall[] };

export const turnFixture: LoopTurn = {
  "userInput": "这个项目里最重要的三个代码文件是哪些?各用一句话说明文件名和它的作用。",
  "finalOutput": "按数据流(解析 → 归因 → 可视化),最重要的三个文件是:\n\n1. **`server/src/session-drilldown-parser.ts`** —— 把原始的 Claude Code 会话 JSONL 解析成结构化的 turn / LLM 调用 / compact 事件;它是其余一切的基础摄取层。\n\n2. **`server/src/context-ledger/parser/attribution/jsonl-linker.ts`** —— 归因核心:它改写每个 context 节点(到…",
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
      "assistantText": "按数据流(解析 → 归因 → 可视化),最重要的三个文件是:\n\n1. **`server/src/session-drilldown-parser.ts`** —— 把原始的 Claude Code 会话 JSONL 解析成结构化的 turn…",
      "toolCalls": []
    }
  ]
};
