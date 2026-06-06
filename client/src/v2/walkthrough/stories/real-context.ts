import type { Story } from "../types";
import { PACE } from "../pace";

// Story 2:看见真实的 Context —— 一次 Claude Code 调用,到底把什么发给了模型。
//
// 取材(ground truth,fixtures 已 dump,studio 直接吃):
//   首次请求:session c8d1c726-c7fb-463c-a39c-0056395374cb / turn 1 / call 1
//     实测 64,942 字符(≈6.5 万)/ 29 叶子;Tools 63.7% / Messages 24.7% / System 11.6%。
//     用户真实输入:「请输出现在时间」= 7 字符 = 0.01%(万分之一)。
//   满载请求(需求10):session 8a9637a5(本会话)/ turn 32 / call 190
//     实测 285.9 万字符 = 首次的 44 倍;Messages 98.2%;
//     thinking 166 段 58.9% / 图片 2 张 18.6%(单张 39 万)/ tool_result 213 条 9.3% / tool_use 216 次 5.6%。
//   英文版 session 64cebb6e fixtures 已 dump 备用(-en 后缀),英文轨后续接。
//
// leaf 级聚焦(「点击进去」):由 studio 侧 RealContextStory 的 LEAF_FOCUS 按 stepIdx 映射到
//   focusSlotType(main 998495e 的受控 prop);本文件只管 focus(段级)与文案。
//
// 旁白单一来源:本文件 →(scripts/voice/synth.ts)→ public/voice/real-context/zh.json。
//   别直接改 zh.json;改这里再 `npx tsx scripts/voice/synth.ts real-context --lang zh --provider mock`。
export const realContextStory: Story = {
  id: "real-context",
  title: "看见真实的 Context",
  titleEn: "Seeing the Real Context",
  steps: [
    // 0. 开场(JSON 幕):真实输入「请输出现在时间」。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "当你打开 Claude Code,敲下一句话 ——「请输出现在时间」。",
        "你也许认为,模型看到的就是你输入的这句话。",
        "但模型这一次真正读到的 ——",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.pause],
    },
    // 1. JSON 幕:庞大 → 逐层展开 → 收回到三个核心字段(需求2/3)。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "是一份庞大的 JSON,约 6.5 万字符。展开看,结构层层嵌套,信息量惊人。",
        "但先别被它吓到 —— 它的顶层,其实只有三个核心字段:Tools、System、Messages。",
        "我们用工具拦下 Claude Code 发往远端的原始请求,再对它的内容做归因分析。",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.pause],
    },
    // 2. Tools 总览。
    {
      act: "rc-real",
      focus: "sec-tools",
      lines: [
        "首先看 Tools。回顾上一章的 tool use 与 tool result —— Tools 这一段,声明了模型可以用哪些工具、以及怎么用。",
        "Bash 执行系统命令;Read、Edit、Write 读写文件;Agent 委托子任务;Skill、ToolSearch 负责动态扩展。",
        "注意这里 Tools 的数量:当前版本的 Claude Code 默认内置 10 个 Tool;后面会看到,工具数量是可以动态增加的。",
      ],
      pauseAfter: [PACE.breath, PACE.beat, PACE.pause],
    },
    // 3. 点入 tool.Bash(LEAF_FOCUS → tools.builtin.Bash;PANEL_SCROLL 按拍下滑:选中条 → 描述 → 参数)。
    {
      act: "rc-real",
      focus: "sec-tools",
      lines: [
        "我们点开其中一个看看 —— 就用 tool.Bash。注意上方色条:被选中的这一段,就是 Bash 在整个请求里占的长度。",
        "往下看它的结构。第一部分是描述 —— 它帮助模型理解:这个工具是干什么的、什么时候该调用它。",
        "第二部分是参数 —— 用 JSON Schema 写的格式声明,让模型能按需构建出正确的参数数据。",
        "有了这两样,模型才能生成正确的 tool call,驱动 Agent 去调用。",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.breath, PACE.pause],
    },
    // 4. System 总览。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "再看 System。它不是你说的话,却决定了模型怎么干活。",
        "身份、代码风格、怎么用工具、怎么如实汇报、怎么权衡安全与成本 —— 都在这里。",
        "它有固定的模板结构,但里面的值,由 Agent 按本次环境提取后注入。我们点开几个字段看看。",
      ],
      pauseAfter: [PACE.breath, PACE.beat, PACE.pause],
    },
    // 5. 点入 环境(需求6;LEAF_FOCUS → system.main-prompt.section.environment)。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "环境:你的工作目录、操作系统、模型版本 —— 模型对「你在哪干活」的全部感知,都来自这里。",
      ],
      pauseAfter: [PACE.pause],
    },
    // 6. 点入 记忆管理(需求6;LEAF_FOCUS → system.main-prompt.section.memory)。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "记忆管理:声明记忆该写到哪里、怎么写 —— 由模型驱动生成,跨会话保留。",
      ],
      pauseAfter: [PACE.pause],
    },
    // 7. 点入 git 状态(需求6;LEAF_FOCUS → system.main-prompt.section.context)+ 收束。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "git 状态:当前分支、改动文件 —— 每次调用时,仓库现场的快照。",
        "这里先记住一句:System 定义了模型「我是谁、我该怎么做事」,同时也包含了你项目的部分元信息。",
      ],
      pauseAfter: [PACE.breath, PACE.pause],
    },
    // 8. 转场到 Messages。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "而注入最频繁、长得最快的,是 Messages —— 它随你每一轮对话不断往上堆。",
      ],
      pauseAfter: [PACE.pause],
    },
    // 9. Messages 开头不是你的输入。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "终于到 Messages 了!你也许以为第一条就是你的输入?并不是。",
        "排在最前面的,是 Claude Code 替你动态注入的:CLAUDE.md、你的项目记忆,还有账号信息。",
      ],
      pauseAfter: [PACE.breath, PACE.pause],
    },
    // 10. 点入 全局提示词(需求7;LEAF_FOCUS → messages.inline.system-reminder.project-instructions,首条=全局)。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "比如这条 —— 全局提示词。CLAUDE.md 的作用和 System 有点像,",
        "不过 System 是 Claude Code 全局维度的统一提示册;而 CLAUDE.md 是你自己的专属提示词 —— 可以按全局、项目、本地等不同维度,按你的诉求生效。",
      ],
      pauseAfter: [PACE.breath, PACE.pause],
    },
    // 11. 留意 记忆(需求8 措辞;LEAF_FOCUS → messages.inline.system-reminder.memory)。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "让我们留意「记忆」这一块 —— 还记得 System 里那段 Memory 吗?",
        "System 讲的是记忆该写到哪、怎么写;而 Messages 这里,是此刻真正被写进去的内容 —— 一个是规则,一个是产出。",
      ],
      pauseAfter: [PACE.breath, PACE.pause],
    },
    // 12. 你的第一句输入(LEAF_FOCUS → messages.inline.free-text)。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "再往后,才轮到你真正敲下的第一句话。",
        "就这么一条:「请输出现在时间」—— 7 个字。",
        "在整块 context 里,它小到只占 0.01% —— 万分之一。",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.pause],
    },
    // 13. 拓展能力声明 + 点开 defer tool 对比(LEAF_FOCUS → messages.system-message,首条=deferred 清单)。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "对于第一条用户消息,除了你的输入,Claude Code 还会声明一系列拓展能力。",
        "比如点开这条 —— 延迟加载的工具清单。注意它有多短:每个工具只报了一个名称,不像前面完整的 tool 声明那么长。",
        "agent 类型、defer tool、还有 skills,都是类似的逻辑 —— 先报个名,等真正用到时再展开。",
        "为什么不一次全塞进来?这就是 Claude Code 的渐进式披露机制 —— 用得到时才展开,省下宝贵的 context。",
        "后续我们会用真实的 case,看渐进式披露机制如何生效。",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.breath, PACE.breath, PACE.pause],
    },
    // 14. 总览回扣:0.01%。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "让我们回到首次请求的全景。",
        "你真正输入的那 7 个字,在整个 context 里肉眼根本找不到 —— 只占 0.01%。",
        "剩下的 99.99%,是工具、规则、记忆,以及被注入的上下文。",
      ],
      pauseAfter: [PACE.beat, PACE.pause, PACE.dwell],
    },
    // 15. 满载请求(需求10;rc-full shot,fixture=8a9637a5/c190;beat 级 FULL_FOCUS 聚焦四类大块)。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "但 context 不会停在首次请求。这,是同一个工具开发会话进行到第 190 次调用时的样子。",
        "286 万字符 —— 首次请求的 44 倍。Messages 占了 98%,Tools 和 System 被挤成一条细线。",
        "占比最大的是模型思考 —— 166 段,占了整整 59%。",
        "两张贴进对话的截图,占 19% —— 单张图片就接近 40 万字符。",
        "213 条工具结果,占 9%;",
        "216 次工具调用,占 6%。你说的每一句话,都淹没在这片海里。",
      ],
      pauseAfter: [PACE.breath, PACE.pause, PACE.breath, PACE.breath, PACE.beat, PACE.dwell],
    },
    // 16. 回顾本章(rc-recap shot:切回首次请求面板 overview)。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "回顾本章:一次调用的 context,顶层就三个核心字段。",
        "Tools 是模型的能力说明书;System 是行为准则,也带着你项目的元信息;Messages 承载注入的上下文、能力声明,和你的对话。",
        "你输入的,只是其中极小的一部分;其余的一切,都由 Claude Code 为你构建。",
      ],
      pauseAfter: [PACE.breath, PACE.pause, PACE.dwell],
    },
    // 17. 下一章预告。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "在下一章,我们将观察每一轮对话中,context 是如何被填充的,工具调用和模型思考又是如何交替进行的。",
        "同时用可视化分析渐进式披露机制在对话中的生效情况,看它怎么帮我们省下宝贵的上下文资源。",
      ],
      pauseAfter: [PACE.pause, PACE.dwell],
    },
  ],
};
