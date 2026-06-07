import type { Story } from "../types";
import { PACE } from "../pace";

// Story 2:看见真实的 Context —— 一次 Claude Code 调用,到底把什么发给了模型。
//
// 取材(ground truth,fixtures 已 dump,studio 直接吃):
//   版本:素材会话均为 Claude Code 2.1.167(jsonl 的 version 字段;step17 文案口播此版本)。
//   首次请求 zh:session c8d1c726-c7fb-463c-a39c-0056395374cb / turn 1 / call 1
//     实测 64,942 字符(≈6.5 万)/ 29 叶子;Tools 63.7% / Messages 24.7% / System 11.6%。
//     用户真实输入:「请输出现在时间」= 7 字符 = 0.01%(万分之一)。
//   首次请求 en:session 64cebb6e / turn 1 / call 1 —— 实测 64,977 字符;
//     三段占比与 zh 逐位一致(63.66/24.70/11.64);8 个 LEAF_FOCUS slotType 全兼容,首位匹配身份相同。
//     en 用户输入:"what time is it for now? answer in english" = 42 字符 = 0.065% ≈ 0.06%。
//     → linesEn 的数字按 en 会话实测(42 字符 / 0.06%),不照搬 zh 的 7 字 / 0.01%。
//   满载请求:session 8a9637a5(本会话)/ turn 32 / call 190
//     实测 285.9 万字符 = 首次的 44 倍;Messages 98.2%;
//     thinking 166 段 58.9% / 图片 2 张 18.6%(单张 39 万)/ tool_result 216 条 9.4% / tool_use 216 次 5.6%。
//     tool_result 口径:满载拍走 bucket 类视角(FULL_BUCKET),屏上 pill 与汇总条均为 wire 级
//     216 段 / 9.4% —— 旁白跟随屏幕念 216/9%(leaf 级 213/9.28% 已不上屏,勿再改回)。
//     en 轨复用本 zh 会话(无 en 满载素材);step16 第 2 句自指 case 顺带消化画面是中文的事实。
//
// leaf 级聚焦(「点击进去」):由 studio 侧 RealContextStory 的 LEAF_FOCUS 按 stepIdx 映射到
//   focusSlotType;本文件只管 focus(段级)与文案。改各 step 句数时同步检查:
//   FULL_FOCUS(step16 beat 4-7)、PANEL_SCROLL(step 4/6/11/12)、RealContextRecapScene(17.x 锚点)。
//
// 旁白单一来源:本文件 →(scripts/voice/synth.ts)→ public/voice/real-context/{zh,en}.json。
//   别直接改 json;改这里再 `npx tsx scripts/voice/synth.ts real-context --lang zh --provider mock`。
//   字幕单行约束:zh ≤46 汉字当量;en ≤92 拉丁字符。
export const realContextStory: Story = {
  id: "real-context",
  title: "看见真实的 Context",
  titleEn: "Seeing the Real Context",
  steps: [
    // 0. 开场(JSON 幕):真实输入。末句收完整,避免和下一句「是一份 JSON」之间形成语法悬停。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "当你打开 Claude Code,敲下一句话 ——「请输出现在时间」。",
        "你也许认为,模型看到的就是你输入的这句话。",
        "但模型这一次真正读到的,其实不是一句话。",
      ],
      linesEn: [
        "You open Claude Code and type one line — \"what time is it for now?\".",
        "You might assume the model sees exactly what you typed.",
        "But what the model actually read this time was not one line.",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.beat],
    },
    // 1. JSON 幕:庞大 → 展开 → 三个核心字段。
    //    注意:RealContextJsonScene 的 expandAt/foldAt 锚在本 step 的 beat 0/1,别动前两句的位置。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "而是一份庞大的数据,约 6.5 万字符。展开看,结构层层嵌套,信息量惊人。",
        "但先别被它吓到 —— 它的顶层,其实只有三个核心字段:Tools、System、Messages。",
        "我们用工具拦下 Claude Code 发往远端的原始请求,再对它的内容做归因分析。",
      ],
      linesEn: [
        "It was a huge JSON — about 65k characters. Expand it, and the nesting goes on and on.",
        "Don't be scared: its top level has only three core fields — Tools, System, Messages.",
        "We intercepted the raw request Claude Code sends out, then attributed its contents.",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.pause],
    },
    // 2. 桥接(D5):上一章闪回条 ↔ 眼前三段。独立 overview step,归 rc-panel 幕首拍 ——
    //    「就是眼前这三段」必须配面板总览画面,停在 JSON 上所指即空(用户反馈)。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "还记得上一章片尾那条横条吗?展开之后,就是眼前这三段。",
      ],
      linesEn: [
        "Remember the bar at the end of last chapter? Unfolded, it becomes these three.",
      ],
      pauseAfter: [PACE.pause],
    },
    // 3. Tools 总览(原 3 长句拆成 6 短句,字幕单行 + 节拍变密)。
    {
      act: "rc-real",
      focus: "sec-tools",
      lines: [
        "首先看 Tools。回顾上一章的「工具调用」与「调用结果」——",
        "Tools 这一段,声明了模型可以用哪些工具、以及怎么用。",
        "常见的 tool 有:Bash 执行系统命令;Read、Edit、Write 读写文件;",
        "Agent 委托子任务;Skill、ToolSearch 负责动态扩展。",
        "注意这里 Tools 的数量:当前版本默认内置 10 个。",
        "后面会看到,工具数量是可以动态增加的。",
      ],
      linesEn: [
        "First, Tools. Recall last chapter's tool calls and tool results —",
        "this section declares which tools the model may use, and how.",
        "The usual suspects: Bash runs commands; Read, Edit and Write handle files;",
        "Agent delegates subtasks; Skill and ToolSearch extend dynamically.",
        "Note the count: this version ships 10 built-in tools.",
        "Later you'll see that number grow at runtime.",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.beat, PACE.breath, PACE.beat, PACE.pause],
    },
    // 4. 点入 tool.Bash(LEAF_FOCUS → tools.builtin.Bash;PANEL_SCROLL 按拍下滑:选中条 → 描述 → 参数)。
    {
      act: "rc-real",
      focus: "sec-tools",
      lines: [
        "我们点开其中一个看看 —— 就用 Bash。",
        "往下看它的结构。第一部分是描述 —— 它帮助模型理解:这个工具是干什么的、什么时候该调用它。",
        "第二部分是参数 —— 一份格式声明,让模型能按需构建出正确的参数数据。",
        "有了这两样,模型才能生成正确的工具调用,驱动 Agent 去执行。",
      ],
      linesEn: [
        "Let's open one of them — Bash.",
        "Scroll its structure. Part one, the description: what the tool does and when to call it.",
        "Part two, the parameters: a JSON Schema so the model can build correct arguments.",
        "With these two, the model can produce a correct tool call for the Agent to run.",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.breath, PACE.pause],
    },
    // 5. System 总览。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "再看 System。它不是你说的话,却决定了模型怎么干活。",
        "身份、代码风格、怎么用工具、怎么如实汇报、怎么权衡安全与成本 —— 都在这里。",
        "它有固定的模板结构,但里面的值,由 Agent 按本次环境提取后注入。我们点开几个字段看看。",
      ],
      linesEn: [
        "Now System. These aren't your words, yet they decide how the model works.",
        "Identity, code style, tool usage, honest reporting, the safety-versus-cost tradeoffs.",
        "The template is fixed; the values are injected per environment. Let's open a few.",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.pause],
    },
    // 6. 点入 记忆管理(LEAF_FOCUS → system.main-prompt.section.memory;拆 2 拍给 PANEL_SCROLL 下滑)。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "记忆管理:声明记忆该写到哪里、怎么写 ——",
        "由模型驱动生成,跨会话保留。",
      ],
      linesEn: [
        "Memory management: where memories should be written, and how —",
        "model-driven, and it persists across sessions.",
      ],
      pauseAfter: [PACE.beat, PACE.pause],
    },
    // 7. 点入 环境(LEAF_FOCUS → system.main-prompt.section.environment)。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "环境:你的工作目录、操作系统、模型版本 —— 模型对「你在哪干活」的全部感知,都来自这里。",
      ],
      linesEn: [
        "Environment: your working directory, OS, model version — everything about where you work.",
      ],
      pauseAfter: [PACE.pause],
    },
    // 8. 点入 git 状态(LEAF_FOCUS → system.main-prompt.section.context)+ 自嘲 + 收束。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "git 状态:当前分支、改动文件 —— 每次调用时,仓库现场的快照。",
        "顺带一提:你的项目名和分支名,Anthropic 的服务器自然也都见过了。",
        "这里先记住一句:System 定义了模型「我是谁、我该怎么做事」,同时也包含了你项目的部分元信息。",
      ],
      linesEn: [
        "Git status: current branch, changed files — a snapshot of the repo at every call.",
        "Meaning Anthropic's servers have seen your project name and branch names.",
        "Remember this: System defines who the model is and how it works, plus project metadata.",
      ],
      pauseAfter: [PACE.breath, PACE.pause, PACE.pause],
    },
    // 9. 转场到 Messages。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "而注入最频繁、长得最快的,是 Messages —— 它随你每一轮对话不断往上堆。",
      ],
      linesEn: [
        "And the section injected most often, growing fastest, is Messages — it piles up every turn.",
      ],
      pauseAfter: [PACE.pause],
    },
    // 10. Messages 开头不是你的输入。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "终于到 Messages 了!你也许以为第一条就是你的输入?并不是。",
        "排在最前面的,是 Claude Code 替你动态注入的:Claude 点 M D、你的项目记忆,还有账号信息。",
      ],
      linesEn: [
        "Finally, Messages! You'd expect your input to come first? It doesn't.",
        "At the front sits what Claude Code injects for you: CLAUDE.md, project memory, account info.",
      ],
      pauseAfter: [PACE.breath, PACE.pause],
    },
    // 11. 点入 全局提示词(LEAF_FOCUS → messages.inline.system-reminder.project-instructions,首条=全局)。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "你也许了解:要高效使用 Claude Code,你需要配置好自己的 Claude 点 M D。",
        "现在,你可以理解它是如何被 LLM 感知的了 —— 就是眼前这条。",
        "System 是 Claude Code 全局维度的统一提示词;而 Claude 点 M D 是你自己的专属提示词,",
        "它可以按全局、项目、本地等不同维度,按你的诉求生效。",
      ],
      linesEn: [
        "You may know this: to use Claude Code well, you configure your own CLAUDE.md.",
        "Now you can see how the LLM actually perceives it — it's this very block.",
        "System is Claude Code's unified, global prompt; CLAUDE.md is your own,",
        "scoped however you need: global, per-project, or local.",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.breath, PACE.pause],
    },
    // 12. 留意 记忆(LEAF_FOCUS → messages.inline.system-reminder.memory;原超宽句拆 2,顺带给滚动 3 拍)。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "让我们留意「记忆」这一块 —— 还记得 System 里那段记忆管理吗?",
        "System 讲的是记忆管理规则:该写到哪、怎么写;",
        "而 Messages 这里,是此刻真正被写进去的内容 —— 一个是规则,一个是产出。",
      ],
      linesEn: [
        "Now notice \"memory\" — remember Memory Management back in System?",
        "System states the memory-management rules: where memories go, and how to write them;",
        "Messages holds what is actually written right now — one is the rule, one the output.",
      ],
      pauseAfter: [PACE.breath, PACE.beat, PACE.pause],
    },
    // 13. 你的第一句输入(LEAF_FOCUS → messages.inline.free-text)。「万分之一」punchline → dwell。
    //     en 数字按 en 会话:42 字符 / 0.06%。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "再往后,才轮到你真正敲下的第一句话。",
        "就这么一条:「请输出现在时间」—— 7 个字。",
        "在整块 context 里,它小到只占 0.01% —— 万分之一。",
      ],
      linesEn: [
        "Only after all that comes the first thing you actually typed.",
        "Just this: \"what time is it for now?\" — 42 characters.",
        "Inside the whole context, that's 0.06% — six parts in ten thousand.",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.dwell],
    },
    // 14. 拓展能力声明 + 点开 defer tool 对比(LEAF_FOCUS → messages.system-message,首条=deferred 清单)。
    //     原 13:2-13:3 压缩为一句(D3=b):定义保留,S3 仍可回指「上一章预告的渐进式披露」。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "对于第一条用户消息,除了你的输入,Claude Code 还会声明一系列拓展能力。",
        "比如点开这条 —— 延迟加载的工具清单。注意它有多短:",
        "前面 Tools 里的 10 个完整工具定义,占首次请求约 63.7%;",
        "而这条延迟工具清单只有 1.9%,因为每个工具只报一个名称。",
        "这就是渐进式披露 —— agent 类型、defer tool、skills 都同理:用到时才展开,省下 context。",
        "后续我们会用真实的 case,看渐进式披露机制如何生效。",
      ],
      linesEn: [
        "Along with your first message, Claude Code also declares a set of extensions.",
        "Open this one — the deferred-tools listing. Notice how short it is:",
        "The 10 full tool definitions in Tools take about 63.7% of this first request;",
        "this deferred-tools list is only 1.9%, because each tool is just a name.",
        "That's progressive disclosure — agent types, deferred tools, skills all work this way.",
        "Later, we'll watch this mechanism fire in a real case.",
      ],
      pauseAfter: [PACE.beat, PACE.beat, PACE.breath, PACE.breath, PACE.breath, PACE.pause],
    },
    // 15. 总览回扣:0.01%(en:0.06% / 99.94%)。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "让我们回到首次请求的全景。",
        "你真正输入的那 7 个字,在整个 context 里肉眼根本找不到 —— 只占 0.01%。",
        "剩下的 99.99%,是工具、规则、记忆管理,以及被注入的上下文。",
      ],
      linesEn: [
        "Let's return to the full view of this first request.",
        "The 42 characters you typed are invisible to the naked eye — just 0.06% of the whole.",
        "The other 99.94% is tools, rules, memories, and injected context.",
      ],
      pauseAfter: [PACE.beat, PACE.pause, PACE.dwell],
    },
    // 16. 满载请求(rc-full shot,fixture=8a9637a5/c190;beat 级 FULL_FOCUS 聚焦四类大块 → beat 4-7)。
    //     第 2 句 = 自指 case:忽略项目细节,看 context 规模本身;en 版顺带点破画面是中文会话(D1)。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "但 context 不会停在首次请求。这,是同一个工具开发会话进行到第 190 次调用时的样子。",
        "画面里就是我们开发这个工具的真实会话 —— 项目细节请忽略,只看 context 本身的规模。",
        "286 万字符 —— 首次请求的 44 倍。",
        "Messages 占了 98%,Tools 和 System 的占比已经小到几乎可以忽略。",
        "占比最大的是模型思考 —— 166 段,占了整整 59%。",
        "两张贴进对话的截图,占 19% —— 单张图片就接近 40 万字符。",
        "216 条工具结果,占 9%;",
        "216 次工具调用,占 6%。你说的每一句话,都淹没在这片海里。",
      ],
      linesEn: [
        "But context doesn't stop at the first request. This is call 190 of one dev session.",
        "This is us building this very tool — in Chinese. Ignore the details; watch the scale.",
        "2.86 million characters — 44 times the first request.",
        "Messages takes 98%; Tools and System are squeezed into a thin sliver.",
        "The biggest class: model thinking — 166 blocks, a full 59%.",
        "Two pasted screenshots take 19% — one alone is nearly 400k characters.",
        "216 tool results: 9%;",
        "216 tool calls: 6%. Every word you said is drowned in this sea.",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.breath, PACE.pause, PACE.breath, PACE.breath, PACE.beat, PACE.dwell],
    },
    // 17. 回顾本章(rc-recap shot = RealContextRecapScene,16.x 锚点见该文件)+ 版本说明 + 核心要旨。
    //     主题句(16.3)→ pause;原两条超宽句各拆 2。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "回顾本章:一次调用的 context,顶层就三个核心字段。",
        "Tools 是模型的能力说明书;System 是行为准则,也带着你项目的元信息;",
        "Messages 承载注入的上下文、能力声明,和你的对话。",
        "你输入的,只是其中极小的一部分;其余的一切,都由 Claude Code 为你构建。",
        "一点说明:本章的素材取自 Claude Code 2.1.167,而 Claude Code 的更新非常频繁。",
        "当你用 session-devtools 打开自己的会话时,看到的细节可能已经不同。",
        "但这并不要紧 —— 重点从来不是掌握每一条提示词的细节,",
        "而是理解 context 的核心组成,和它的演变机制。",
      ],
      linesEn: [
        "To recap: one call's context has just three top-level fields.",
        "Tools is the model's capability manual; System is the rulebook, plus project metadata;",
        "Messages carries injected context, capability listings, and your dialogue.",
        "What you typed is a tiny fraction; everything else is built for you by Claude Code.",
        "One note: this chapter's material comes from Claude Code 2.1.167, which updates fast.",
        "When you open your own session in session-devtools, details may already differ.",
        "That's fine — the point was never to memorize every prompt line,",
        "but to understand what a context is made of, and how it evolves.",
      ],
      pauseAfter: [PACE.breath, PACE.beat, PACE.pause, PACE.pause, PACE.breath, PACE.breath, PACE.beat, PACE.dwell],
    },
    // 18. 下一章预告(D4:删「交替」承诺,补 compact 悬崖钩子)。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "在下一章,我们将观察每一轮对话中,context 是如何一步步生长的;",
        "用真实 case,看渐进式披露如何生效,怎么帮我们省下宝贵的上下文;",
        "以及 —— 当增长逼近极限时,会发生什么。",
      ],
      linesEn: [
        "Next chapter: watch the context grow, step by step, across a conversation;",
        "see progressive disclosure fire in a real case, saving precious context;",
        "and — what happens when growth approaches the limit.",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.dwell],
    },
  ],
};
