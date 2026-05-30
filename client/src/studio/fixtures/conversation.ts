import type { SceneTurn } from "../scenes/timeline";

// 取自真实 session(scripts/voice/dump-fixture.ts)的结构,文案已本地化为中文。
// session: 5e7476cd-c9cf-4029-9256-416a249c61a4
// title:   Analyze project purpose and functionality
// 注意:原 session 是英文问答;这里的 user/assistant 文案是按中文视频手工本地化的 ——
//      直接重跑 dump-fixture.ts 会覆盖回英文,翻译需重做。结构/统计(llmCalls/tools)与真实一致。
export const conversationFixture: SceneTurn[] = [
  {
    "id": 1,
    "user": "用一句话简要分析这个项目是做什么的。",
    "assistant": "这是一个会话仪表盘 / 开发者工具:它解析 Claude Code 的会话 JSONL 日志并可视化 —— 尤其是通过一棵基于「lens」的归因树,把每一段 context(系统提醒、规则、注入内容)追溯回它的来源;前端是 React,背后由一个 Node 归因服务支撑。",
    "llmCalls": 1,
    "tools": []
  },
  {
    "id": 2,
    "user": "这个项目里最重要的三个代码文件是哪些?各用一句话说明文件名和它的作用。",
    "assistant": "按数据流(解析 → 归因 → 可视化),最重要的三个文件是:\n\n1. **`server/src/session-drilldown-parser.ts`** —— 把原始的 Claude Code 会话 JSONL 解析成结构化的 turn / LLM 调用 / compact 事件;它是其余一切的基础摄取层。\n\n2. **`server/src/context-ledger/parser/attribution/jsonl-linker.ts`** —— 归因核心…",
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
    "user": "在最重要的那个文件里,有哪三个关键方法或函数?各用一句话说明名字和作用。",
    "assistant": "最重要的文件是归因核心 `server/src/context-ledger/parser/attribution/jsonl-linker.ts`。它的三个关键函数:\n\n1. **`linkJsonl(...)`**(唯一的公开入口,第 899 行)—— 遍历 `ParsedQuerySnapshot` 里的每个节点,分派给对应的 linker,并改写那些来源能从 JSONL 证明的节点。\n\n2. **`buildIndex(events)`**(第 …",
    "llmCalls": 2,
    "tools": [
      {
        "name": "Bash",
        "count": 1
      }
    ]
  }
];
