// turn-io 幕的 fixture —— 一个 Turn 的内部调用链(用户输入 → N 轮 tool_use/tool_result → 结论)。
// 形状是 AgentLoopScene 消费的最小 LoopTurn(与庞大的 UserTurn 解耦)。
// 内容仿"找关键文件"那条 turn:2 轮工具(Bash 浏览、Grep 搜索),最后一次 LLM 不再 tool_use,给出表格结论。

export type LoopToolCall = {
  name: string;
  inputPreview: string;
  outputPreview: string;
  outputSize: number;
  isError: boolean;
};
export type LoopCall = {
  contextSize: number;
  assistantText: string;
  toolCalls: LoopToolCall[];
};
export type LoopTurn = {
  userInput: string;
  finalOutput: string;
  calls: LoopCall[];
};

export const turnFixture: LoopTurn = {
  userInput:
    "找出这个仓库里最关键的 3 个文件,请先浏览目录结构,再搜索相关关键词,然后读取你判断最关键的文件,最后用一个表格给出:文件名 + 一句话职责。不要修改任何文件。",
  finalOutput:
    "最关键的 3 个:\n- server/main.ts — 启动入口,装配路由与代理\n- session-drilldown-parser.ts — 把 jsonl 会话解析成结构化 Turn/Call\n- attribution-service.ts — 把每段 context 归因到来源\n\n以上均未修改任何文件。",
  calls: [
    {
      contextSize: 11800,
      assistantText: "我先浏览一下仓库的目录结构,弄清大致分层。",
      toolCalls: [
        {
          name: "Bash",
          inputPreview: JSON.stringify({ command: "ls -la; echo '---'; ls server/src | head" }),
          outputPreview: "bin\nclient\nserver\npackage.json\ntsconfig.json\n---\nmain.ts\nsession-drilldown-parser.ts\nattribution-service.ts\nrule-corpus",
          outputSize: 142,
          isError: false,
        },
      ],
    },
    {
      contextSize: 13400,
      assistantText: "目录清楚了。再搜一下入口和解析相关的关键词,定位核心文件。",
      toolCalls: [
        {
          name: "Grep",
          inputPreview: JSON.stringify({ pattern: "registerRoutes|drilldown|attribution" }),
          outputPreview:
            "server/src/main.ts: registerRoutes(app)\nserver/src/session-drilldown-parser.ts: export function parseDrilldown\nserver/src/attribution-service.ts: export class AttributionService",
          outputSize: 3120,
          isError: false,
        },
      ],
    },
    {
      // 最后一次 LLM 调用:已掌握足够信息,不再 tool_use,直接给结论。
      contextSize: 15900,
      assistantText: "",
      toolCalls: [],
    },
  ],
};
