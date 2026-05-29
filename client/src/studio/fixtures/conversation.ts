import type { SceneTurn } from "../scenes/timeline";

// Phase 1 静态 fixture —— 代表性会话内容,形状即 SceneTurn(不依赖 server / drilldown)。
// 内容仿真实 demo 会话(找关键文件那条 turn)。接真数据时,换成
//   fromUserTurns(dd.turns) 的产物即可,Scene 不用改。
// assistant 里特意放一个 markdown 表格,验证 Remotion 里 ReactMarkdown + GFM 表格渲染。
export const conversationFixture: SceneTurn[] = [
  {
    id: 1,
    user:
      "找出这个仓库里最关键的 3 个文件,请先浏览目录结构,再搜索相关关键词,然后读取你判断最关键的文件,最后用一个表格给出:文件名 + 一句话职责。不要修改任何文件。",
    assistant:
      "我浏览了目录、搜索了关键词并读取了核心文件。最关键的 3 个:\n\n| 文件 | 一句话职责 |\n|---|---|\n| `server/main.ts` | 启动入口,装配路由与代理 |\n| `session-drilldown-parser.ts` | 把 jsonl 会话解析成结构化 Turn/Call |\n| `attribution-service.ts` | 把每段 context 归因到来源 |\n\n以上均未修改任何文件。",
    llmCalls: 6,
    tools: [
      { name: "Bash", count: 2 },
      { name: "Grep", count: 3 },
      { name: "Read", count: 4 },
    ],
  },
  {
    id: 2,
    user: "很好。那 server/main.ts 里,代理是怎么挂上去的?给我关键几行。",
    assistant:
      "代理在启动时通过 `registerProxy(app)` 挂载:它注册一个 catch-all 路由,把匹配到的请求转发给上游,并在响应回来时落盘记录,供后续归因使用。关键就是「先注册业务路由,代理放最后兜底」这个顺序。",
    llmCalls: 3,
    tools: [
      { name: "Read", count: 1 },
      { name: "Grep", count: 1 },
    ],
  },
];
