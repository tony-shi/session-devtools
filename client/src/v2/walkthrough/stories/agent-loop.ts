// Story 1:Session、Turn、LLM Call
// 副标题:理解 Claude Code 的执行链路和 agent loop
//
// 主线 = 执行链(不是聊天记录):Session 组织完整会话 → Turn 组织一次用户任务 →
//   LLM Call 组织每一次模型决策 → tool_use / tool_result 驱动 Agent Loop 在 LLM Call 之间前进。
// 反复强化两条边界:Turn = 用户任务边界;LLM Call = 模型决策边界。
// Agent Loop 从属于 LLM Call(在 Call 之间循环),不与 Session / Turn 平级。
//
// 节奏:用 PACE.* 标每句之后的留白。**不要改 manifest 的 durMs**(合成产物);
//   要更慢加 pauseAfter,要更短改文案。本轮只改文案 + recap 模型,场景结构不动。
//   (开场结构 intro、结尾产品页暂不做;TTS 后续单独实现。)

import type { Story } from "../types";
import { PACE } from "../pace";

export const agentLoopStory: Story = {
  id: "agent-loop",
  title: "Story 1:Session、Turn、LLM Call",
  titleEn: "Story 1: Session, Turn, LLM Call",
  steps: [
    // Session —— 最外层:一次完整会话。开场先立"执行链"框架,不从聊天记录讲。
    {
      act: "conversation",
      focus: "overview",
      lines: [
        "理解 Claude Code,先别从「聊天记录」开始。",
        "更准确地说,它是一条执行链:Session、Turn、LLM Call。",
        "先看最外层 —— Session,一次完整的会话。",
        "从开始到结束,所有用户请求、模型调用、工具调用和结果都在里面,",
        "也包括中途发生的维护动作。",
      ],
      linesEn: [
        "To understand Claude Code, don't start from the chat log.",
        "More precisely, it's an execution chain: Session, Turn, LLM Call.",
        "Start with the outermost layer — a Session, one complete conversation.",
        "Every user request, model call, tool call and result lives inside it, start to end,",
        "including the maintenance steps that happen along the way.",
      ],
      // 节奏:转折句后停顿,定义句 dwell 让 "Session" 落地。
      pauseAfter: [PACE.breath, PACE.breath, PACE.pause, PACE.breath, PACE.dwell],
    },
    // Turn —— 用户任务边界。强化:一个用户任务 = 一个 Turn;一个 Session 多个 Turn。
    {
      act: "conversation",
      focus: "turn",
      lines: [
        "从 Session 里拿出一个 Turn。",
        "Turn 是用户发起的一轮任务 —— 一个用户任务,就是一个 Turn。",
        "一次 Session 里可以有很多 Turn,每个都有自己的目标和执行过程。",
        "记住这条边界:Turn,是「用户任务」的边界。",
      ],
      linesEn: [
        "Take one Turn out of the Session.",
        "A Turn is one task the user starts — one user task, one Turn.",
        "A Session can hold many Turns, each with its own goal and process.",
        "Remember this boundary: a Turn is the boundary of a user task.",
      ],
    },
    // LLM Call —— 模型决策边界。强化:一个 Turn 可能多次 LLM Call;每次带 context。
    {
      act: "turn-io",
      focus: "call",
      lines: [
        "深入一个 Turn —— 先是用户输入,也就是这一轮要解决的任务。",
        "Agent 开始组装 context:系统提示、记忆、规则、历史、工具定义…",
        "再填入这一轮真正要解决的问题。",
        "打包发出 —— 这就是一次 LLM Call:带着 context,让模型决定下一步。",
      ],
      linesEn: [
        "Go inside one Turn — first the user input, the task for this round.",
        "The agent assembles the context: system prompt, memory, rules, history, tool definitions…",
        "then the real question for this round.",
        "Packed and sent — that's one LLM Call: context in, and the model decides the next step.",
      ],
    },
    // tool_use —— 模型提出动作(不是答案)。
    {
      act: "turn-io",
      focus: "tool-use",
      lines: [
        "极简单的任务,模型可能直接回答;但更多时候,它需要先拿到更多证据。",
        "于是它不直接回答,而是提出一个 tool_use。",
        "tool_use 不是答案,而是模型请求执行一个动作。",
        "比如:读文件、搜代码、执行命令。",
      ],
      linesEn: [
        "For trivial tasks the model may answer directly; more often, it needs more evidence first.",
        "So instead of answering, it proposes a tool_use.",
        "A tool_use is not an answer — it's the model requesting an action.",
        "For example: read a file, search code, run a command.",
      ],
    },
    // tool_result —— 世界返回的证据,进入下一次 LLM Call 的 context。
    {
      act: "turn-io",
      focus: "tool-result",
      lines: [
        "接下来,Agent 真的去执行这个工具。",
        "执行完,返回 tool_result。",
        "关键在这:模型不靠幻想 —— 它拿到的是工具返回的真实结果。",
        "而这个结果,会进入下一次 LLM Call 的 context。",
        "tool_use 是模型提出的动作;tool_result 是世界返回的证据。",
      ],
      linesEn: [
        "Next, the agent actually runs the tool.",
        "When it finishes, it returns a tool_result.",
        "Here's the key: the model doesn't hallucinate — it gets the tool's real output.",
        "And that result enters the context of the next LLM Call.",
        "tool_use is the action the model proposes; tool_result is the evidence the world returns.",
      ],
    },
    // Agent Loop + 停止条件 + 层级归属(在 LLM Call 之间循环)。
    {
      act: "turn-io",
      focus: "loop",
      lines: [
        "把它们串起来 —— 这就是 Agent Loop,发生在一次次 LLM Call 之间。",
        "Call 提出 tool_use,执行得到 tool_result,塞回 context,触发下一次 Call。",
        "循环继续,模型一步步收集证据,理解越来越完整。",
        "直到某一次,模型认为信息已经足够。",
        "它不再 tool_use,直接输出最终回答 —— 这一个 Turn 就此结束。",
        "记住层级:Agent Loop 在 LLM Call 之间循环,从属于 LLM Call,不和 Session、Turn 平级。",
      ],
      linesEn: [
        "String them together — this is the Agent Loop, running between LLM Calls.",
        "A Call proposes a tool_use; execution returns a tool_result; it's fed back into context and triggers the next Call.",
        "The loop continues — the model gathers evidence step by step, understanding more each time.",
        "Until, at some call, the model decides it has enough.",
        "It stops proposing tools and gives the final answer — and this Turn ends.",
        "Mind the hierarchy: the Agent Loop runs between LLM Calls — it sits under LLM Call, not beside Session or Turn.",
      ],
    },
    // 回收三层模型:Session > Turn > LLM Call > tool_use/tool_result > final answer。
    {
      act: "recap",
      focus: "final",
      lines: [
        "Session —— 一次完整的会话,组织起全部工作。",
        "Turn —— 一次用户任务,以及为完成它的全部过程。",
        "LLM Call —— 一次带着 context 的模型决策。",
        "tool_use —— 模型想做什么。",
        "tool_result —— 现实返回了什么;塞回 context,触发下一次 Call。",
        "信息足够时,模型不再 tool_use,给出 final answer —— Turn 结束。",
        "把循环抽象出来,其实就是三个阶段:收集上下文 → 采取行动 → 验证结果。",
        "而驱动它的只有两件事:模型负责推理,工具负责行动。",
      ],
      linesEn: [
        "Session — one complete conversation, organizing all the work.",
        "Turn — one user task, and the whole process to complete it.",
        "LLM Call — one model decision, carrying its context.",
        "tool_use — what the model wants to do.",
        "tool_result — what reality returned; fed back into context, triggering the next Call.",
        "When there's enough, the model stops calling tools and gives the final answer — the Turn ends.",
        "Abstract the loop and it's three stages: gather context → take action → verify result.",
        "And only two things drive it: the model reasons, the tools act.",
      ],
    },
  ],
};
