import type { Story } from "../types";
import { PACE } from "../pace";

// Story 2:看见真实的 Context —— 一次 Claude Code 调用,到底把什么发给了模型。
//
// 取材(ground truth,config.ts 的 rc-real 已固定到这里,别改):
//   session 820f368b-ec02-4c59-b0b1-4ec76f0a4439 / turn 1 / call 1;实测 ~64.3k 字符 / 30 个叶子。
//   三段占比:Tools 63.9% / Messages 24.0% / System 12.1%。
//   该 session 的真实用户输入(45 字符 ≈ 0.07%):
//     "考虑我们的图片的渲染逻辑。前端,在归因的时候,可以对图片进行渲染吗?分析,不要直接改动。"
//
// 旁白单一来源:本文件 →(scripts/voice/synth.ts)→ public/voice/real-context/zh.json。
//   注意:别直接改 zh.json(那是产物,re-synth 会覆盖);改这里再 `npx tsx scripts/voice/synth.ts real-context --lang zh --provider mock`。
//
// ── 2026-06 用户改稿后,几处待你确认(我已按最合理方式处理,标在就近 [确认?] 注释)─────
//   A. 开场例子:你把开场用户输入改成了「你好,今天怎么样?」,但面板/step6 锚定的是真实 session
//      的「图片渲染」那句 —— 二者会对不上(开场说"你好",后面又出现"图片渲染")。现暂保留你的
//      「你好」,step6 仍是真实那句。要数据自洽,建议开场也用真实输入(或换一条真实输入就是寒暄的 session)。
//   B. 占比数字:真实是 45/64312 ≈ 0.07%(你写的 0.7% 与你自己 step8 的"99.9%"对不上 —— 99.9% 对应 0.07%)。
//      我统一用 0.07%。若你确实要 0.7%,告诉我。
//   C. step3「System 是固定模板」:你写"100%固定模版…由 Agent 提取并注入"内部有张力(固定 vs 注入)。
//      我理顺为"模板结构固定,但值由 Agent 提取后注入"。措辞请确认。
//   D. step4 只剩一句转场(你把前两句标了"去掉",第三句没标)。现保留这句做 System→Messages 过渡;
//      要整段删也可以,说一声(删了 RealContextStory 的 shots step 索引要同步)。
//   E. 两处内嵌备注已从旁白剥离为 TODO(见 step2 / step5 就近注释):tool 例子、记忆 callback 交叉引用。
//
// act 全用 rc-real;focus = overview / sec-tools / sec-system / sec-messages。中文优先(linesEn 留待英文化)。
export const realContextStory: Story = {
  id: "real-context",
  title: "看见真实的 Context",
  titleEn: "Seeing the Real Context",
  steps: [
    // 1. 开场:你打一句话。[确认? A:开场例子「你好」vs 真实输入]
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "当你打开 Claude Code,敲下一句话 ——「你好,今天怎么样?」",
        "你也许认为,模型看到的就是你输入的这句话。",
        "但模型这一次真正读到的 ——",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.pause],
    },
    // 2. 原始 JSON → 顶层三块(承接上一句"真正读到的 ——")。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "是一份庞大的 JSON,约 6.4 万字符。",
        "先别被它的长度吓到 —— 它的顶层其实只有三个字段:Tools、System、Messages。",
        "我们用工具拦下 Claude Code 发往远端的原始请求,再对它的内容做归因分析。",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.pause],
    },
    // 3. Tools:能力说明书 + 一行机制 + 数量(渐进式披露伏笔)。
    {
      act: "rc-real",
      focus: "sec-tools",
      lines: [
        "首先看 Tools。回顾上一章的 tool use 与 tool result —— Tools 这一段,声明了模型可以用哪些工具、以及怎么用。",
        "Bash 执行系统命令;Read、Edit、Write 读写文件;Agent 委托子任务;Skill、ToolSearch 负责动态扩展。",
        // 注(E):tool 的 name/description/input_schema 细节与举例,留到下一章(ep4 tools 专章)展开;本章只点机制。
        "每个工具都包含:一个名字、一段描述,加一份用 JSON Schema 写的参数声明 —— 有了这些,模型才能生成正确的 tool call,驱动 Agent 调用。",
        "注意这里 Tools 的数量:当前版本的 Claude Code 默认内置 10 个 Tool;后面会看到,工具数量是可以动态增加的。",
      ],
      pauseAfter: [PACE.breath, PACE.beat, PACE.pause, PACE.pause],
    },
    // 4. System:决定行为 + 模板结构固定/值动态注入。[确认? C:措辞]
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "再看 System。它不是你说的话,却决定了模型怎么干活。",
        "身份、代码风格、怎么用工具、怎么如实汇报、怎么权衡安全与成本 —— 都在这里。",
        "它有固定的模板结构,但里面的值 —— 当前目录、git 状态、你项目记忆的位置 —— 由 Agent 提取后注入。",
        "这里先记住一句:它定义了模型「我是谁、我该怎么做事」。",
      ],
      pauseAfter: [PACE.breath, PACE.beat, PACE.pause, PACE.pause],
    },
    // 5. 转场到 Messages。[确认? D:你把前两句标了"去掉",此处仅留这句过渡]
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "而注入最频繁、长得最快的,是 Messages —— 它随你每一轮对话不断往上堆。",
      ],
      pauseAfter: [PACE.pause],
    },
    // 6. Messages 开头不是你的输入,而是动态注入的上下文。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "终于到 Messages 了!你也许以为第一条就是你的输入?并不是。",
        "排在最前面的,是 Claude Code 替你动态注入的:项目的 CLAUDE.md、你的项目记忆,还有账号信息。",
        // 画面 callback(E):讲"记忆"这两句时,理想是切回/连到 System 段的 Memory 声明,做"机制↔内容"对照。
        // 现 focus 是 step 级(整个 step5 = sec-messages),旁白先做口头回指即可;要画面真正切到 system,
        // 需把这两句拆成独立 step(focus sec-system),会让 step 数 10→12、RealContextStory 的 shots 同步(见汇报)。
        "特别看「记忆」这一块 —— 还记得 System 里那段 Memory 吗?",
        "System 讲的是记忆该写到哪、怎么写;而 Messages 这里,是此刻真正被写进去的内容 —— 一个是规则,一个是产出。",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.breath, PACE.pause],
    },
    // 7. 之后才是你真正的第一句输入。[确认? A:与开场例子一致性 / B:占比]
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "再往后,才轮到你真正敲下的第一句话。",
        "就这么一条:「看看图片能不能渲染,先分析,别动手改」。",
        "在整块 context 里,它只是很小的一条 —— 占比只有约 0.07%。",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.pause],
    },
    // 8. 输入之后还会追加能力:defer tool / agent / skills —— 渐进式披露。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "在你的首次输入之外,Claude Code 还会再追加一批能力声明。",
        "延迟加载的工具、可用的 agent 类型、还有 skills —— 它们同样被放进 Messages。",
        "你也许好奇:为什么不一次全塞进来?Tools 不是已经声明了 10 个吗?简单说,这是 Claude Code 的渐进式披露机制 —— 用得到时才展开,省下宝贵的 context。",
        "后续我们会用真实的 case,看渐进式披露机制如何生效。",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.breath, PACE.pause],
    },
    // 9. 总结:你的输入只占 ~0.07%。[确认? B:占比]
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "让我们回到首次请求的全景。",
        "你真正输入的那 45 个字,在整个 context 里几乎肉眼难辨 —— 只占约 0.07%。",
        "剩下的 99.9%,是工具、规则、记忆,以及被注入的上下文。",
      ],
      pauseAfter: [PACE.beat, PACE.pause, PACE.dwell],
    },
    // 10. 回顾上一章 + 引入下一章(context 如何被逐步填充 + 渐进式披露生效)。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "再回顾一下上一章:一个会话会有很多个轮次;你每多问一句,上下文就往后追加一段。",
        "很快,工具调用、模型思考、工具结果会把它迅速填满 —— Messages 快速膨胀,Tools、System 的占比相对缩小。",
        "下一章,我们就观察每一轮对话里 context 是怎么被填充的,工具调用和模型思考又如何交替进行。",
        "同时用可视化分析渐进式披露机制在对话中的生效情况,看它怎么帮我们省下宝贵的上下文资源。",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.pause, PACE.dwell],
    },
  ],
};
