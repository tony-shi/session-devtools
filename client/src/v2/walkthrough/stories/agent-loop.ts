// Episode 1: 看懂 Claude Code 的 Agent Loop。
// 文案取自 docs/pr/script/agent-loop.md。流程骨架阶段:每步只标「哪一幕」+ 文案。

import type { Story } from "../types";

export const agentLoopStory: Story = {
  id: "agent-loop",
  title: "看懂 Claude Code 的 Agent Loop",
  steps: [
    {
      act: "conversation",
      focus: "overview",
      lines: [
        "先看最大的盒子:Session。",
        "它不是一句话,也不是一次回复。",
        "而是一整段被保存下来的工作现场。",
        "用户的问题、Claude 的回答、每一次工具调用,都在里面。",
      ],
    },
    {
      act: "conversation",
      focus: "turn",
      lines: [
        "从 Session 里拿出一个 Turn。",
        "Turn = 用户发起的一次请求。",
        "但它不等于一次模型调用。",
        "一个 Turn 里,Claude 可能想很多次、查很多次,最后才给出答案。",
      ],
    },
    {
      act: "turn-io",
      focus: "call",
      lines: [
        // 每行对应一个揭示阶段:0 用户输入 / 1 填前缀 / 2 填入问题 / 3 发起调用
        "让我们深入一个 Turn,看看里面发生了什么 —— 先是用户的输入。",
        "Agent 开始准备上下文:先填入系统提示、记忆、规则、历史…",
        "再填入这一轮真正要解决的问题。",
        "打包完成,发起第一次 LLM 调用。",
      ],
    },
    {
      act: "turn-io",
      focus: "tool-use",
      lines: [
        // 0 模型在判断 / 1 返回 tool_use / 2 解释 / 3 举例
        "极简单的任务,LLM 可能直接回答;但更多时候,它会决定先获取更多信息。",
        "于是 LLM 返回一个特殊结果:tool_use。",
        "tool_use 不是答案,只是模型提出的一个动作请求。",
        "比如:读文件、搜代码、执行命令。",
      ],
    },
    {
      act: "turn-io",
      focus: "tool-result",
      lines: [
        "接下来,Agent 真的去执行这个工具。",
        "执行完,工具返回 tool_result。",
        "关键在这:模型不是自己幻想文件内容。",
        "它拿到工具返回的真实结果,再继续推理。",
        "tool_use 是模型提出的动作;tool_result 是世界返回的证据。",
      ],
    },
    {
      act: "turn-io",
      focus: "loop",
      lines: [
        // 0-3 逐拍展开后续真实调用链路;4-5 揭示最终输出 + Turn 结束
        "现在把它们串起来 —— 这是这个 Turn 真实的调用链路。",
        "Call 产生 tool_use,Agent 执行得到 tool_result。",
        "tool_result 被塞回下一次 Call 的 context,上下文越滚越大。",
        "如此循环,Claude 对现场的理解越来越完整。",
        "当 LLM 获取到充分信息,它不再输出 tool_use,而是给出最终结论。",
        "从用户输入,到 LLM 给出结果 —— 一个 Turn 就此结束。",
      ],
    },
    {
      act: "conversation",
      focus: "final",
      lines: [
        "最后的回答,看起来只是一段文字。",
        "但它背后是一串可检查的调用链。",
        "Session 记录整场工作,Turn 记录一次任务,Call 记录一次模型请求。",
        "tool_use 是模型想做什么,tool_result 是现实返回了什么。",
        "Loop,就是这些不断接上,直到任务完成。",
      ],
    },
  ],
};

export const STORIES: Record<string, Story> = {
  [agentLoopStory.id]: agentLoopStory,
};
