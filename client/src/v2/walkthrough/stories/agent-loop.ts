// Episode 1: 看懂 Claude Code 的 Agent Loop。
// 文案取自 docs/pr/script/agent-loop.md。流程骨架阶段:每步只标「哪一幕」+ 文案。

import type { Story } from "../types";

export const agentLoopStory: Story = {
  id: "agent-loop",
  title: "看懂 Claude Code 的 Agent Loop",
  steps: [
    {
      act: "conversation",
      lines: [
        "你以为只问了一句话,Claude 回答了一次。",
        "用户问 → Claude 答,看似一来一回。",
        "但背后,是一段可以被检查的执行轨迹。",
        "Session = 一次被保存下来的 Claude Code 会话。",
      ],
    },
    {
      act: "turn-io",
      lines: [
        "放大其中一个 Turn —— 它不是一次模型调用。",
        "Claude 反复地:读取上下文 → 决定动作 → 调用工具。",
        "每个工具结果,又被塞回下一次的上下文。",
        "如此循环,直到给出最终答案。",
        "Turn = 一次用户请求,以及为回答它发生的全部工作。",
      ],
    },
    {
      act: "llm-call",
      lines: [
        "再放大其中一次 LLM Call。",
        "它带着完整的 request context 发给模型。",
        "模型回应:AI 的思考 + 一个 tool_use。",
        "LLM Call = 一次带有具体上下文的模型请求。",
      ],
    },
  ],
};

export const STORIES: Record<string, Story> = {
  [agentLoopStory.id]: agentLoopStory,
};
