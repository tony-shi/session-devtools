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
        "Agent看上去只是一个聊天界面，但它背后其实有一整套执行链路在运转。",
        "最外层是会话。当前我们可以简单认为每当你打开一个终端就开启了一次会话。",
        "你的每次输入、模型的每次调用、Agent执行工具，都发生在这个会话中。",
      ],
      // en 文案约束:单行字幕 ≤46 汉字当量(拉丁 ≈92 字符)—— 改写收窄,不拆行(保持 zh/en 逐句对齐)。
      linesEn: [
        "An Agent looks like a chat interface, but behind it runs a whole execution chain.",
        "The outermost layer is the session — for now, opening a terminal starts a session.",
        "Every input, every model call, every tool the Agent runs — all happen in that session.",
      ],
      // 节奏:转折句后停顿,定义句让 "Session" 落地,收尾留白进入 Turn。
      pauseAfter: [PACE.pause, PACE.pause, PACE.dwell],
    },
    // 轮次 —— 用户任务边界。强化:一个用户任务 = 一个轮次;一个会话多个轮次。
    { 
      act: "conversation",
      focus: "turn",
      lines: [
        "把镜头推进到会话里的一个轮次。",
        "轮次可以先简单理解为，用户发出一次输入，Agent处理它，直到给出最终回复。",
        "一个会话里通常会有很多轮次。",
      ],
      linesEn: [
        "Now move the camera into one turn inside the session.",
        "For now, a turn is one user input, processed until the Agent gives a final response.",
        "A single session usually contains many turns.",
      ],
      // 节奏:定义句(轮次)落地;末句留白,接 conversation→turn-io 的全片最大视觉转场。
      pauseAfter: [PACE.beat, PACE.pause, PACE.pause],
    },
    // 模型调用 —— 模型决策边界。强化:一个轮次可能多次模型调用;每次带上下文。
    {
      act: "turn-io",
      focus: "call",
      lines: [
        "让我们把一个轮次拆开看。",
        "第一步是用户输入。",
        "但Agent不会把这句话原样丢给模型。",
        "它会先准备上下文，例如，系统提示词、记忆、工具定义等等。",
        "接着把用户输入放进去，打包成一次模型调用，让模型决定下一步。",
      ],
      linesEn: [
        "Let's open up one turn.",
        "The first step is the user input.",
        "But the Agent doesn't send that sentence to the model as-is.",
        "It first prepares the context: system prompt, memory, tool definitions, and more.",
        "Then it adds your input, packing everything into one model call to decide the next step.",
      ],
      // 节奏:转折句(不会原样丢)与列举句后呼吸;末句是「模型调用」关键概念 + step 边界 → pause。
      pauseAfter: [PACE.beat, PACE.beat, PACE.breath, PACE.breath, PACE.pause],
    },
    // 工具调用 —— 模型提出动作(不是答案)。
    {
      act: "turn-io",
      focus: "tool-use",
      lines: [
        "如果任务很简单，模型可能直接给出结论。",
        "但更多时候，它会先发现，还需要更多信息。",
        "所以它不直接回答，而是返回一次“工具调用”作为响应。",
        "工具调用不是答案。它的含义是，请帮我执行一个动作。",
        "例如读文件、搜代码、运行命令。",
      ],
      linesEn: [
        "For a very simple task, the model might answer right away.",
        "But more often, it first realizes that it needs more information.",
        "So it does not answer directly. Instead, it returns a tool call as its response.",
        "A tool call is not the answer. It means: please run an action for me.",
        "For example: read a file, search the codebase, or run a command.",
      ],
      // 节奏:「工具调用不是答案」是本步核心翻转句 → pause;末句列举收尾 + step 边界 → pause。
      pauseAfter: [PACE.beat, PACE.beat, PACE.breath, PACE.pause, PACE.pause],
    },
    // 调用结果 —— 世界返回的证据,进入下一次模型调用的上下文。
    {
      act: "turn-io",
      focus: "tool-result",
      lines: [
        "接下来，Agent解析这个工具调用，真实地在你的电脑上执行工具。",
        "执行完，它提取这个调用的结果。",
        "然后，这个调用结果会被放进下一次模型调用的上下文。",
        "这一步很关键，模型不再只是在远端思考。",
        "它可以借助工具，去查看你的文件，运行你的代码，操作你的命令行，真实地和你的世界互动。",
      ],
      linesEn: [
        "Next, the Agent parses that tool call and actually runs the tool on your computer.",
        "When it finishes, it extracts the result of that call.",
        "Then that tool result is placed into the context for the next model call.",
        "This step matters: the model is no longer just thinking remotely.",
        "With tools, it can read your files, run your code — truly interact with your world.",
      ],
      // 节奏:「塞回上下文」是关键机制 → breath;末句「和你的世界互动」是情绪峰值 → dwell。
      pauseAfter: [PACE.beat, PACE.beat, PACE.breath, PACE.breath, PACE.dwell],
    },
    // 智能体循环 + 停止条件 + 层级归属(在模型调用之间循环)。
    {
      act: "turn-io",
      focus: "loop",
      lines: [
        "让我们把这几步连起来看：模型调用、工具调用、调用结果，再回到下一次模型调用。",
        "这条反复出现的链路，就是Agent loop。",
        "每循环一次，模型就多拿到一块真实信息。",
        "直到某一次，模型判断：该知道的已经知道，该做的也已经做完。",
        "它可能直接回答，也可能是在最后一次工具调用改变文件之后，再给出收尾说明。",
        "当没有新的下一步时，这个轮次就结束。",
      ],
      linesEn: [
        "Connect the pieces: model call, tool call, tool result, then the next model call.",
        "That repeating chain is the Agent loop.",
        "Each time through the loop, the model gets one more piece of real information.",
        "Until, at some point, the model decides: it knows enough, and the needed actions are done.",
        "It may answer directly, or it may wrap up after a final tool call changes a file.",
        "When there is no next step to take, the turn ends.",
      ],
      // 节奏:「就是 Agent loop」全片标题概念 → dwell;末句收束本幕、切 recap → pause。
      pauseAfter: [PACE.breath, PACE.dwell, PACE.beat, PACE.beat, PACE.breath, PACE.pause],
    },
    // 回收三层模型:会话 > 轮次 > 模型调用 > 工具调用/调用结果 > 最终回答。
    {
      act: "recap",
      focus: "final",
      lines: [
        "让我们回顾本章的内容。",
        "会话，一次完整的对话，组织起全部工作。",
        "轮次，一次用户任务，以及为完成它的全部过程。",
        "模型调用，带着上下文，让模型做一次决策。",
        "工具调用，模型想让Agent做什么。",
        "调用结果，Agent执行后的结果，它将会塞回上下文，触发下一次模型调用。",
        "轮次结束时，模型可能直接回答，也可能在最后一次工具调用完成修改后收尾。",
        "把循环抽象出来，其实就是三个阶段：收集上下文、采取行动、验证结果。",
        "模型负责推理，工具负责行动。模型就像是人的大脑，工具则是手脚。",
        "下一章让我们切入Agent的核心，即每次模型调用前那份上下文。",
        "我们将会了解到，模型在做决定之前到底看见了什么。",
      ],
      linesEn: [
        "Let's review what this chapter covered.",
        "Session — one complete conversation, organizing all the work.",
        "Turn — one user task, and the whole process to complete it.",
        "Model call — carrying context into the model so it can make one decision.",
        "Tool call — what the model wants the Agent to do.",
        "Tool result — what the run returns; it goes back into context for the next model call.",
        "A turn may end with a direct answer, or wrap up after the last tool call completes.",
        "Abstract the loop: three stages — gather context, take action, verify the result.",
        "The model handles reasoning; the tools handle action — the brain, and the hands.",
        "Next chapter, we enter the Agent's core: the context prepared before each model call.",
        "We will see exactly what the model sees before it makes a decision.",
      ],
      // 节奏:recap 是「定义清单」,每项后留短停顿让它落地(英文项尤其短、易连读)。
      // 0 引子 / 1-4 Session·Turn·Model·Tool call 逐项 breath / 5 Tool result 收尾列表 → pause /
      // 6-7 过渡 breath / 8 二引擎 punchline → pause / 9-10 下一章过渡。中英共用(节拍是语义)。
      pauseAfter: [
        PACE.breath,  // 让我们回顾… / Let's review…
        PACE.breath,  // 会话 / Session
        PACE.breath,  // 轮次 / Turn
        PACE.breath,  // 模型调用 / Model call
        PACE.breath,  // 工具调用 / Tool call
        PACE.pause,   // 调用结果 / Tool result —— 清单收尾,停长一点
        PACE.breath,  // 轮次结束时 / A turn can end…
        PACE.breath,  // 三阶段 / three stages
        PACE.pause,   // 二引擎 punchline / model & tools
        PACE.breath,  // 下一章 / In the next chapter
        PACE.beat,    // 收尾句(末句,间隙影响不大)
      ],
    },
  ],
};
