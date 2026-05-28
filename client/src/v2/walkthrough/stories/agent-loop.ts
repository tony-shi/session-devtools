// Episode 1: 看懂 Claude Code 的 Agent Loop。
// 文案取自 docs/pr/script/agent-loop.md。
//
// 节奏控制:用 PACE.* 标注每句之后的留白。原则:
//   - 普通断句 → PACE.beat(默认,可省略整个 pauseAfter)
//   - 段落转折 / 让概念落地 → PACE.breath
//   - 关键定义之后 / 话题切换 → PACE.pause
//   - 戏剧性 punchline / "想象一下" → PACE.dwell
// **千万不要去改 manifest 里的 durMs。** 那是合成产物,改了下次跑被覆盖。
// 想让某句更慢:加 pauseAfter 留白;想让某句更短:把文案改短。仅此两条。

import type { Story } from "../types";
import { PACE } from "../pace";

export const agentLoopStory: Story = {
  id: "agent-loop",
  title: "看懂 Claude Code 的 Agent Loop",
  // 脚手架样例 —— 仅这一集填了英文标题与开场字幕,其它幕 / 其它集留空,
  // 切到 EN 时会自动 fallback 到中文,你逐句补 linesEn 即可。
  titleEn: "Understanding the Claude Code Agent Loop",
  steps: [
    {
      act: "conversation",
      focus: "overview",
      lines: [
        "Claude Code 第一眼看上去,像终端里的编程聊天框。",
        "你输入一句需求,它回你一段解释。",
        "但如果它只是聊天,它就不能修 bug、跑测试、改代码。",
        "在这个框里面,它正在观察、行动、再观察。",
        "这段连续的工作记录,就是 Session。",
      ],
      // 顺序与 lines 一一对应;留空字符串或省略下标都会回退到中文。
      linesEn: [
        "At first glance, Claude Code looks like a coding chat box inside your terminal.",
        "You type a request, and it replies with an explanation.",
        "But if it were only chat, it could not fix bugs, run tests, or edit code.",
        "Inside that box, it is observing, acting, and observing again.",
        "That continuous work record is a Session.",
      ],
      // 节奏示范:转折句后 pause 让观众想一下,定义句 dwell 让 "Session" 这个词落地。
      // 其它幕 / 其它集没填 pauseAfter,自动走 PACE.beat —— 留给你按这个套路逐幕标。
      pauseAfter: [PACE.breath, PACE.breath, PACE.pause, PACE.breath, PACE.dwell],
    },
    {
      act: "conversation",
      focus: "turn",
      lines: [
        "一个 Session,是在某个工作区下持续推进的一段会话。",
        "而一个 Turn,对应你向 Claude Code 发起的一次请求。",
        "你可能以为,一个 Turn 就是一次模型调用。",
        "但真实情况复杂得多:Claude 可能要想很多次、查很多次,最后才给出答案。",
      ],
      linesEn: [
        "A Session is a continuous conversation inside a specific workspace.",
        "A Turn is one request you send to Claude Code.",
        "You might assume one Turn means one model call.",
        "But it is much more complex: Claude may need to think several times, inspect several things, and only then answer.",
      ],
    },
    {
      act: "turn-io",
      focus: "call",
      lines: [
        // 每行对应一个揭示阶段:0 用户输入 / 1 填前缀 / 2 填入问题 / 3 发起调用
        "让我们聚焦其中一个 Turn,看看里面到底发生了什么 —— 先从用户输入开始。",
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
        // 0-3 逐拍展开循环体;4-5 揭示「最后一次 LLM 调用 + 结论」+ Turn 终止
        "现在把它们串起来 —— 这是这个 Turn 真实的调用链路。",
        "Call 产生 tool_use,Agent 执行得到 tool_result。",
        "tool_result 被塞回下一次 Call 的 context,上下文越滚越大。",
        "循环往复 —— 模型负责推理,工具负责行动,理解越来越完整。",
        "直到某一次调用,模型判断信息已充分 —— 不再 tool_use,而是给出最终结论。",
        "从用户输入,到这最后一次 LLM 调用给出结果 —— 一个 Turn 就此终止。",
      ],
    },
    {
      act: "recap",
      focus: "final",
      lines: [
        // 前 6 行点亮结构图;后 2 行点出官方心智模型(三阶段 + 两引擎)
        "Session —— 一次完整的会话。",
        "Turn —— 一次用户请求,以及为回答它的全部工作。",
        "LLM Call —— 一次带着具体 context 的模型请求。",
        "tool_use —— 模型想做什么。",
        "tool_result —— 现实返回了什么 —— 指针又跳回 LLM Call,像一个 while 循环。",
        "出口只有一个 —— LLM 自行决策不再 tool_use,跳出循环、给出结论。",
        "把循环抽象出来,其实就是三个阶段:收集上下文 → 采取行动 → 验证结果。",
        "而驱动它的只有两件事:模型负责推理,工具负责行动。",
      ],
    },
  ],
};
