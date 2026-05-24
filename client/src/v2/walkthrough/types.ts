// Walkthrough(教学画板)的声明式类型。
//
// 独立 path 上的特化画板:不复用真实 session 全量 UI,而是每一「幕」自己编排布局。
// 第一版只是流程骨架 —— step 只携带「属于哪一幕」+ 文案;真实叶子组件后续接入。

// 幕:对应脚本里的三层认知。
//   conversation —— 多轮对话(Session)
//   turn-io      —— 左侧树 + 一个 turn 的输入/输出(Turn)
//   llm-call     —— 某个 turn 的某次 LLM Call(LLM Call)
export type ActId = "conversation" | "turn-io" | "llm-call";

export interface Step {
  act: ActId;
  caption: string;
  takeaway?: string;
}

export interface Story {
  id: string;
  title: string;
  steps: Step[];
}
