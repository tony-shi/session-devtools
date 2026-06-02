import type { Story } from "../types";

// Story 2:看见真实的 Context —— 一次 Claude Code 调用到底把什么发给了模型。
//
// 叙事主线 = 真实结构剖析式:不讲完整归因算法,而是讲一个清晰命题 ——
//   Claude Code 的核心不是"聊天",而是持续构造下一次 API request 的 context;
//   每一次 LLM Call 物理上主要由 Tools / System / Messages 三块组成。
// 借官方"逐层点击 + 右侧解释"的节奏,但我们的优势是展示真实 request 结构(ground truth)。
//
// 本章信息边界(只讲):物理结构三块 / 每层代表什么 / 哪些稳定哪些动态 / 点击块能落到证据 /
//   context 是所有功能的最终承载面。
// 本章不讲(留给后续):Diff 细节 / Cache 失效 / compact 保留规则 / 子代理隔离 / 每个 prompt 文件逐条。
//
// act 全部用 rc-real(复用真实 attribution 面板);focus 指示当前高亮哪个 section。
// 第一版只搭分镜 + i18n + section 高亮;块级点击取证、精确子块高亮留待"细化"。
export const realContextStory: Story = {
  id: "real-context",
  title: "看见真实的 Context",
  titleEn: "Seeing the Real Context",
  steps: [
    // 0. 开场:从"模拟"切到"真实" —— 建立信任(官方是 illustrative,我们是 ground truth)。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "切到真实 UI —— 这是这一次 LLM Call 真实的 context 构成。",
        "接下来我们不看聊天记录,",
        "而是看 Claude Code 实际发送给模型的 request。",
      ],
      linesEn: [
        "Switch to the real UI — this is the actual context of this one LLM call.",
        "From here we stop looking at the chat log,",
        "and look at the request Claude Code actually sends to the model.",
      ],
    },
    // 1. 第一层:物理结构只有三大块(先讲物理结构,不讲语义分类)。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "一次 Claude Code 调用,物理结构上主要分成三块。",
        "Tools:模型可调用的工具定义。",
        "System:Claude Code 和运行环境给模型的规则与约束。",
        "Messages:用户、助手、工具结果、运行时注入,共同组成的对话历史。",
      ],
      linesEn: [
        "One Claude Code call is, physically, three blocks.",
        "Tools: the definitions of the tools the model can call.",
        "System: the rules and constraints from Claude Code and the runtime.",
        "Messages: user, assistant, tool results and runtime injections — the conversation history.",
      ],
    },
    // 2. Tools:工具不是执行结果,而是能力说明书。
    {
      act: "rc-real",
      focus: "sec-tools",
      lines: [
        "Tools 不是工具的执行结果,而是这次 call 里模型可见的工具说明书。",
        "它告诉模型:有哪些工具、参数是什么、什么时候该用、有哪些限制。",
        "Bash、Edit、Read、Grep 是基础代码操作;",
        "Agent、Task 是委托能力;Skill、ToolSearch 是动态扩展。",
        "工具列表相对稳定,但会随可用工具、MCP、插件、权限模式变化。",
      ],
      linesEn: [
        "Tools is not tool output — it's the manual of tools the model can see in this call.",
        "It tells the model what tools exist, their parameters, when to use them, and the limits.",
        "Bash, Edit, Read, Grep are basic code operations;",
        "Agent and Task are delegation; Skill and ToolSearch are dynamic extension.",
        "The tool list is relatively stable, but shifts with available tools, MCP, plugins and permission mode.",
      ],
    },
    // 3. System:真正决定行为边界的地方。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "System 是最容易被低估的一层。",
        "它不是用户说的话,但它决定 Claude Code 如何工作。",
        "如何使用工具、如何报告事实、如何处理安全与成本。",
        "身份与工作方式、工具策略、运行环境、记忆、计费 —— 都在这里。",
      ],
      linesEn: [
        "System is the most underestimated layer.",
        "It's not what the user said, yet it decides how Claude Code works:",
        "how it uses tools, how it reports facts, how it handles safety and cost.",
        "Identity and working style, tool policy, environment, memory, billing — all live here.",
      ],
    },
    // 4. System 的稳定部分:为什么它适合解释。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "System 里有稳定的部分。",
        "同一版本、同一工具集下,它在多次 call 里大体一致。",
        "所以它适合回答:Claude Code 的默认行为风格是什么,为什么它这样使用工具。",
      ],
      linesEn: [
        "Part of System is stable.",
        "Under the same version and tool set, it stays largely the same across calls.",
        "So it answers: what is Claude Code's default behavior, and why it uses tools the way it does.",
      ],
    },
    // 5. System 的动态部分:为什么每次不完全一样。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "System 里也有动态的部分。",
        "当前目录、git 状态、可用工具、权限、记忆、模型与缓存策略,都可能随环境变化。",
        "所以同一个问题,在不同项目、不同会话里,Claude Code 看到的并不完全相同。",
      ],
      linesEn: [
        "Part of System is also dynamic.",
        "Working directory, git state, available tools, permissions, memory, model and cache policy can all change.",
        "So the same question, in a different project or session, gives Claude Code a different context.",
      ],
    },
    // 6. Messages:最复杂,但先抓大类。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "Messages 是最复杂的一层。",
        "它不只是用户和助手的聊天,",
        "还包括工具调用、工具结果、图片、运行时提醒,以及系统注入。",
        "Human、Assistant、Tool call、Tool result、Injection、Misc —— 先抓这几大类。",
      ],
      linesEn: [
        "Messages is the most complex layer.",
        "It's not just user-and-assistant chat —",
        "it also holds tool calls, tool results, images, runtime reminders, and system injections.",
        "Human, Assistant, Tool call, Tool result, Injection, Misc — start with these big categories.",
      ],
    },
    // 7. 选中一个真实块:从结构走到证据(这一步把 story 从"解释图"变成"取证工具")。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "每个色块都能落到证据。",
        "它在 request 的哪个位置?来自哪条 JSONL?属于哪个 call?",
        "占了多少 token、多少字符?来自用户、工具结果,还是运行时注入?",
        "这一步很关键 —— 它把解释图,变成可信的取证工具。",
      ],
      linesEn: [
        "Every block can be traced to evidence.",
        "Where is it in the request? Which JSONL line? Which call?",
        "How many tokens, how many characters? From the user, a tool result, or a runtime injection?",
        "This is the key step — it turns an explainer diagram into a real forensic tool.",
      ],
    },
    // 8. 收束:context 是 Claude Code 的操作界面。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "今天先理解结构。",
        "Claude Code 的能力、规则、环境、历史和工具结果,最终都落在 context 里。",
        "后续我们再看:为什么 context 会变大,缓存为何命中或失效,",
        "压缩、子代理、hook 又如何改变下一次 call。",
      ],
      linesEn: [
        "Today, just understand the structure.",
        "Claude Code's abilities, rules, environment, history and tool results all end up in the context.",
        "Later we'll see why context grows, why cache hits or misses,",
        "and how compaction, sub-agents and hooks change the next call.",
      ],
    },
  ],
};
