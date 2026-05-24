// Episode 1: 看懂 Claude Code 的 Agent Loop。
// 文案取自 docs/pr/script/agent-loop.md。流程骨架阶段:每步只标「哪一幕」+ 文案。

import type { Story } from "../types";

export const agentLoopStory: Story = {
  id: "agent-loop",
  title: "看懂 Claude Code 的 Agent Loop",
  steps: [
    {
      act: "conversation",
      caption: "你在终端里看到的一次回答,背后是一段可检查的执行轨迹。",
      takeaway: "Session = 一次被保存下来的 Claude Code 会话。",
    },
    {
      act: "turn-io",
      caption: "一次用户请求,可能包含多次模型调用和工具调用。",
      takeaway: "Turn = 一次用户请求,以及为回答它发生的全部工作。",
    },
    {
      act: "llm-call",
      caption: "一次 LLM Call,才是真正带着具体 context 发给模型的一次请求。",
      takeaway: "LLM Call = 一次带有具体上下文的模型请求。",
    },
  ],
};

export const STORIES: Record<string, Story> = {
  [agentLoopStory.id]: agentLoopStory,
};
