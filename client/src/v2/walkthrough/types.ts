// Walkthrough(教学画板)的声明式类型。
//
// 独立 path 上的特化画板:不复用真实 session 全量 UI,而是每一「幕」自己编排布局。
// 第一版只是流程骨架 —— step 只携带「属于哪一幕」+ 文案;真实叶子组件后续接入。

// 幕:对应脚本里的三层认知。
//   conversation —— 多轮对话(Session)
//   turn-io      —— 左侧树 + 一个 turn 的输入/输出(Turn)
//   llm-call     —— 某个 turn 的某次 LLM Call(LLM Call)
export type ActId =
  | "conversation" | "turn-io" | "llm-call" | "recap"  // ep1: agent loop
  | "cw-stack" | "cw-real"                             // ep2: context window
  | "cd-diff" | "cd-real"                              // ep3: context diff
  | "tools-concept" | "tools-real"                     // ep4: tools(context 的关键部分)
  | "cache-split" | "cache-real"                       // ep5: cache
  | "compact-concept" | "compact-real"                 // ep6: compaction
  | "extend-concept" | "extend-real"                   // ep7: skills / MCP / hooks
  | "subagent-concept" | "subagent-real";              // ep8: subagent

// 每一步的"放大镜阶段":告诉复用的 view 该强调/揭示哪一部分(布局不变,只换高亮)。
//   conversation 用:overview(整段) / turn(高亮一轮) / final(落到最终回答)
//   turn-io 用:call(Context 请求) / tool-use / tool-result / loop(整链 + Context 增长)
export type Focus =
  | "overview" | "turn" | "final"
  | "call" | "tool-use" | "tool-result" | "loop"
  | "stack" | "diagram"  // ep2: context-stack 构建 / 收尾结构图
  | "diff"               // ep3: context-diff 构建
  | "tools-cat"          // ep4: tools 五大类构建
  | "cache"              // ep5: cache 构建
  | "compact"            // ep6: compaction 构建
  | "inject"             // ep7: skills/MCP/hooks 注入构建
  | "spawn";             // ep8: subagent 开第二个 context 构建

export interface Step {
  act: ActId;
  focus: Focus;
  // 字幕脚本:逐行播报(打字 + 滚动切换),模拟视频字幕。
  lines: string[];
  // 英文字幕(选填,逐句对齐 lines 下标;缺位自动 fallback 到 lines)。
  // 双语支持的最小侵入面 —— 不加这一行,既有 story 文件零改动。
  linesEn?: string[];
}

export interface Story {
  id: string;
  title: string;
  titleEn?: string;  // 选填;缺省回退到 title
  steps: Step[];
}
