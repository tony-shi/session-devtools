import type { Story } from "../types";

// Episode 3: Context Diff —— 案发现场。两次相邻 Call 之间,context 怎么变。
// 核心:什么没变(稳定前缀)+ 什么变了(尾部追加的完整 diff:模型回应 thinking/text/
// tool_use + tool_result + 注入)。复用真实 diffTree 看真实新增。
// 边界:不讲 diff schema / cache 机制 / compaction(那是后面);只点一句"agent 还能
// 更主动操控 context,未来深入"。
export const contextDiffStory: Story = {
  id: "context-diff",
  title: "Context Diff:案发现场",
  steps: [
    {
      // 概念 diff 构建:稳定前缀 + 尾部逐拍追加(7 拍)
      act: "cd-diff",
      focus: "diff",
      lines: [
        "上一章看了一次 Call 的 context;现在看两次调用之间,它怎么变。",
        "大部分没变 —— tools + system + 之前的对话,是稳定的前缀。",
        "真正变的在尾部。先是模型上一步的回应被记进历史:它的思考与说明。",
        "以及它决定调用的 tool_use。",
        "然后 Agent 执行,tool_result 被追加进来。",
        "有时 runtime 还会注入 system-reminder(比如文件被改、待办提醒)。",
        "这一整块新增 —— 回应 + 工具结果 + 注入 —— 就是这一次的 diff。",
      ],
    },
    {
      // 切真实 diffTree:真实新增
      act: "cd-real",
      focus: "diff",
      lines: [
        "切到真实归因的 diff 视角。",
        "绿色的,就是这一次新增进 context 的部分。",
        "你不用猜模型为什么变聪明 —— diff 把新增的证据精确指了出来。",
      ],
    },
    {
      // 复杂行为预告 + 收尾(静态全图)
      act: "cd-diff",
      focus: "diagram",
      lines: [
        "这是最常见的 diff:模型回应 + 工具结果,不断往尾部追加。",
        "但 agent 还能更主动地操控 context —— 压缩历史、丢弃旧内容、用子 agent 隔离探索。",
        "那些更复杂的 context 操控,我们留到后面深入。",
        "下一次调用'懂了',是因为上一步的回应和结果进了它的 context。两次之间的 diff,就是案发现场。",
      ],
    },
  ],
};
