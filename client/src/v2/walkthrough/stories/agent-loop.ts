// 故事一:会话、轮次、模型调用
// 副标题:理解 Claude Code 的执行链路和智能体循环
//
// 主线 = 执行链(不是聊天记录):会话组织完整会话 → 轮次组织一次用户任务 →
//   模型调用组织每一次模型决策 → 工具调用 / 调用结果驱动智能体循环在模型调用之间前进。
// 反复强化两条边界:轮次 = 用户任务边界;模型调用 = 模型决策边界。
// 智能体循环在模型调用之间循环,不与会话 / 轮次平级。
//
// 节奏:用 PACE.* 标每句之后的留白。**不要改 manifest 的 durMs**(合成产物);
//   要更慢加 pauseAfter,要更短改文案。本轮只改文案 + recap 模型,场景结构不动。
//   (开场结构 intro、结尾产品页暂不做;TTS 后续单独实现。)

import type { Story } from "../types";
import { PACE } from "../pace";

export const agentLoopStory: Story = {
  id: "agent-loop",
  title: "故事一:会话、轮次、模型调用",
  titleEn: "Story 1: Session, Turn, Model Call",
  steps: [
    // 会话 —— 最外层:一次完整会话。开场先立"执行链"框架,不从聊天记录讲。
    {
      act: "conversation",
      focus: "overview",
      lines: [
        "想理解智能体,先别把它想成一个聊天助手。",
        "把它想成一个从外到内展开的流程。",
        "最外层是会话 -- 当前我们可以简单认为每当你打开一个终端就对应一个会话。",
        "你的每次输入、每次模型调用、每次工具调用和调用结果,都发生在这个会话内，",
        "甚至上下文注入、压缩这类后台动作，也在此发生。",
      ],
      linesEn: [
        "To understand an agent, don't think of it as just a chat assistant.",
        "Think of it as a process that unfolds from the outside in.",
        "The outermost layer is the session — for now, you can think of each terminal you open as one session.",
        "Every input you send, every model call, every tool call, and every tool result happens inside that session,",
        "even background steps like harness injection and compaction happen there too.",
      ],
      // 节奏:转折句后停顿,定义句 dwell 让 "Session" 落地。
      pauseAfter: [PACE.breath, PACE.breath, PACE.pause, PACE.breath, PACE.dwell],
    },
    // 轮次 —— 用户任务边界。强化:一个用户任务 = 一个轮次;一个会话多个轮次。
    {
      act: "conversation",
      focus: "turn",
      lines: [
        "把镜头推进到会话里的一个轮次。",
        "轮次可以先简单理解为:用户发出一次输入,智能体处理它,直到给出最终回复。",
        "一个会话里通常会有很多轮次。",
        "你在同一个终端里反复互动,每一次互动都会开启一个新的轮次。",
      ],
      linesEn: [
        "Move the camera into one turn inside the session.",
        "For now, think of a turn as one user input, followed by the agent processing it until it produces a final response.",
        "A single session usually contains many turns.",
        "As you keep interacting in the same terminal, each interaction starts a new turn.",
      ],
    },
    // 模型调用 —— 模型决策边界。强化:一个轮次可能多次模型调用;每次带上下文。
    {
      act: "turn-io",
      focus: "call",
      lines: [
        "让我们把一个轮次拆开看。",
        "第一步是用户输入:这一轮要解决的任务。",
        "但智能体不会把这句话原样丢给模型。",
        "它会先准备上下文:系统提示、记忆、规则、历史、工具定义……",
        "接着把用户输入放进去,打包成一次模型调用,让模型决定下一步。",
      ],
      linesEn: [
        "Let's open up one turn.",
        "Step one is the user input: the task this turn needs to solve.",
        "But the agent doesn't send that sentence to the model as-is.",
        "It first prepares the context: system prompt, memory, rules, history, tool definitions...",
        "Then it adds the user input and packages everything into one model call, so the model can decide the next step.",
      ],
    },
    // 工具调用 —— 模型提出动作(不是答案)。
    {
      act: "turn-io",
      focus: "tool-use",
      lines: [
        "如果任务很简单,模型可能直接给出结论。",
        "但更多时候,它会先发现:还需要一点信息。",
        "所以它不急着回答,而是发起一次工具调用。",
        "工具调用不是答案,它的含义是:请帮我执行一个动作。",
        "比如读文件、搜代码、运行命令。",
      ],
      linesEn: [
        "For a very simple task, the model might answer right away.",
        "But more often, it realizes: I need a bit more information.",
        "So it doesn't answer yet. It makes a tool call.",
        "A tool call is not the answer. Its meaning is: please run an action for me.",
        "For example: read a file, search the codebase, or run a command.",
      ],
    },
    // 调用结果 —— 世界返回的证据,进入下一次模型调用的上下文。
    {
      act: "turn-io",
      focus: "tool-result",
      lines: [
        "接下来,智能体接过这个工具调用,真的在你的电脑上执行工具。",
        "执行完,它提取这个调用的结果。",
        "这一步很关键:模型不再只靠自己推测。",
        "它看到的是工具从你的文件、代码和命令行里拿到的真实结果。",
        "然后,这个调用结果会被放进下一次模型调用的上下文。",
      ],
      linesEn: [
        "Next, the agent takes that tool call and actually runs the tool on your computer.",
        "When it finishes, it extracts the result of that call.",
        "This step matters: the model is no longer just speculating by itself.",
        "It sees real output from your files, your code, and your command line.",
        "Then that tool result is placed into the context for the next model call.",
      ],
    },
    // 智能体循环 + 停止条件 + 层级归属(在模型调用之间循环)。
    {
      act: "turn-io",
      focus: "loop",
      lines: [
        "让我们把这几步连起来看:模型调用、工具调用、调用结果,再回到下一次模型调用。",
        "这条反复出现的链路,就是智能体循环。",
        "每循环一次,模型就多拿到一块真实信息。",
        "直到某一次,模型判断:该知道的已经知道,该做的也已经做完。",
        "它可能直接回答,也可能是在最后一次工具调用改变文件、执行命令之后,再给出收尾说明。",
        "当没有新的下一步时,这个轮次就结束。",
      ],
      linesEn: [
        "Let's connect the pieces: model call, tool call, tool result, then back to the next model call.",
        "That repeating chain is the Agent Loop.",
        "Each time through the loop, the model gets one more piece of real information.",
        "Until, at some point, the model decides: it knows enough, and the needed actions are done.",
        "It may answer directly, or it may wrap up after a final tool call changes a file or runs a command.",
        "When there is no next step to take, the turn ends.",
      ],
    },
    // 回收三层模型:会话 > 轮次 > 模型调用 > 工具调用/调用结果 > 最终回答。
    {
      act: "recap",
      focus: "final",
      lines: [
        "会话 —— 一次完整的会话,组织起全部工作。",
        "轮次 —— 一次用户任务,以及为完成它的全部过程。",
        "模型调用 —— 带着上下文,让模型做一次决策。",
        "工具调用 —— 模型想让智能体做什么。",
        "调用结果 —— 智能体执行后带回了什么;塞回上下文,触发下一次模型调用。",
        "轮次结束时,模型可能直接回答,也可能在最后一次工具调用完成修改或执行后收尾。",
        "把循环抽象出来,其实就是三个阶段:收集上下文 → 采取行动 → 验证结果。",
        "而驱动它的只有两件事:模型负责推理,工具负责行动。",
        "接下来让我们切入智能体的核心,每次模型调用前那份上下文。",
        "也就是:模型在做决定之前到底看见了什么。",
      ],
      linesEn: [
        "Session — one complete conversation, organizing all the work.",
        "Turn — one user task, and the whole process to complete it.",
        "Model call — one model decision, carrying its context.",
        "Tool call — what the model wants the agent to do.",
        "Tool result — what the agent brings back after running it; fed back into context, triggering the next model call.",
        "A turn can end with a direct answer, or after a final tool call completes a change or command and the model wraps up.",
        "Abstract the loop and it's three stages: gather context → take action → verify result.",
        "And only two things drive it: the model reasons, the tools act.",
        "Next, let's move into the core of the agent: the context prepared before each model call.",
        "In other words: what exactly does the model see before it makes a decision?",
      ],
    },
  ],
};
