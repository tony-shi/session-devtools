import type { Story } from "../types";

// Episode 2: Context Window 不是容量条 —— 模型看到的是 runtime 组装的工作集。
// 只完成一个任务:让观众知道每次 LLM Call 发给模型的,是一份运行时上下文工作集,
// 不是终端 transcript。不讲 diff / attribution schema / sub-agent / hooks /
// MCP / compaction —— 那些会稀释主线,留给后面。
export const contextWindowStory: Story = {
  id: "context-window",
  title: "Context Window 不是容量条",
  steps: [
    {
      // 概念栈构建:每行字幕 = context-stack 的一个揭示阶段(共 8 拍)
      act: "cw-stack",
      focus: "stack",
      lines: [
        "放大其中一次 Call —— 这一次,模型到底看见了什么?",
        "最常见的误解:以为模型只看见终端里这句用户输入。",
        "但用户 prompt,只是 context 里的一部分。",
        "在它之前,runtime 已经放入基础规则:行为、工具用法、边界。",
        "项目的 CLAUDE.md、用户 memory、团队约定,也可能在里面。",
        "随着 Agent 推进,历史消息、assistant 回复、工具结果不断累积。",
        "所以 tool_result 不是停在工具那里 —— 它变成后续 Call 的可见信息。",
        "最终,模型收到的是这整份组装好的 context,而不是一条孤立 prompt。",
      ],
    },
    {
      // 切到真实 UI:这一次 call 的真实 context 构成(复用 attribution 的分类聚合,
      // 不带 diff / cache)。
      act: "cw-real",
      focus: "stack",
      lines: [
        "切到真实 UI —— 这是这一次 Call 真实的 context 构成。",
        "system、tools、messages…… 每一类占了多少,一目了然。",
        "session-devtools 把这份隐藏的工作集,变成可以检查的证据。",
      ],
    },
    {
      // 收尾结构图 + 下一章预告
      act: "cw-stack",
      focus: "diagram",
      lines: [
        "记住这张图:Runtime + Project + Trace + Current task。",
        "Context window 不是聊天记录容量条。",
        "它是每次 LLM Call 前,被 runtime 组装出来的工作集。",
        "下一章:两次 Call 之间,这份 context 到底变了什么。",
      ],
    },
  ],
};
