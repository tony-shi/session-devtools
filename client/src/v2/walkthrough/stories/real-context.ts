import type { Story } from "../types";
import { PACE } from "../pace";

// Story 2:看见真实的 Context —— 一次 Claude Code 调用,到底把什么发给了模型。
//
// 命题:你以为你在"聊天",其实每一次调用,Claude Code 都在替你构造一份庞大的 API request;
//   你敲下的那句话只是极小一片。
//   卖点点题(beat 2 / beat 9):我们不只是个 proxy 把请求录下来 —— 而是把这坨 64k 的 JSON
//   自动归因、分类,还原成看得懂的结构。裸看 JSON 几乎不可能,归因之后一眼就清楚。
//
// 取材(ground truth,config.ts 的 rc-real 已固定到这里,别改):
//   session 820f368b-ec02-4c59-b0b1-4ec76f0a4439 / turn 1 / call 1;实测 ~64.3k 字符 / 30 个叶子。
//   三段占比:Tools 63.9% / Messages 24.0% / System 12.1%。
//   用户真实输入 45 字符 ≈ 0.07%(不到千分之一)—— 结尾"0.1%"那一击的真实依据。
//   用户原话:"考虑我们的图片的渲染逻辑。前端,在归因的时候,可以对图片进行渲染吗?分析,不要直接改动。"
//
// 本版定调(评审后):
//   · 这是一章"锋利的地图":广度铺满,每块给一个有真实数据撑腰的钩子,深度留给后续专章。
//   · Tools 机制只讲一行(name + description + JSON Schema → 模型按 schema 发起调用);
//     tool_use / tool_result 循环、defer tools 的深入,留给 ep4 tools 专章动态深化。
//   · 静态/动态:不是"前两块静态、第三块动态",而是每一块都 = 稳定骨架 + 动态注入
//     (Tools 随模型变,System 随目录 / git / 记忆变)。beat 5 收口,并埋下"增长"的伏笔。
//   · System 远比看上去复杂,beat 4 埋"后面单开一集"的伏笔。
//
// 待配画面([需配画面] 标注处:narration 先到位,视觉后补,由后续推进):
//   beat 1  开场"输入瞬间"+ 拉远;beat 2  原始 JSON → 3-key 骨架 → 切到归因面板;
//   beat 9  拉远 morph 反放(与开场书挡:开场你的话占满屏,结尾只剩 0.1%);
//   beat 10 多轮、被填满的 context 截图(或切到一个更满的 call)。
//
// act 全用 rc-real;focus = overview / sec-tools / sec-system / sec-messages(见 DemoStage 的 focusSection 映射)。
// 中文优先:本轮只写中文 lines(英文 linesEn 留到英文化阶段,缺位自动回退中文)。
export const realContextStory: Story = {
  id: "real-context",
  title: "看见真实的 Context",
  titleEn: "Seeing the Real Context",
  steps: [
    // 1. 开场:你打一句话(与 beat 9 书挡)。[需配画面]
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "你打开 Claude Code,敲下一句话 —— 让它看看前端归因里,图片能不能渲染。",
        "在你眼里,这只是一句普通的提问。",
        "但模型这一次真正读到的,是这一整块东西。",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.pause],
    },
    // 2. 原始 JSON 难读 → 顶层三块 → 归因才是卖点(不只是 proxy)。[需配画面]
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "这,就是这次调用发给模型的原始请求 —— 六万多字符的 JSON,直接看,根本读不下去。",
        "但它顶层其实只有三块:Tools、System、Messages。",
        "我们做的,不只是把请求拦下来录一份 —— 而是把这一大坨 JSON 自动归因、分类,还原成你看得懂的结构。",
        "这正是关键:裸看 64k 的 JSON 几乎不可能,归因之后,一眼就清楚。",
        "下面我们一块一块点进去 —— 先不展开细节。",
      ],
      pauseAfter: [PACE.breath, PACE.beat, PACE.breath, PACE.pause, PACE.pause],
    },
    // 3. Tools:是什么 + 一行机制 + 它也是动态的(随模型变)。深入留给 ep4。
    {
      act: "rc-real",
      focus: "sec-tools",
      lines: [
        "先点开 Tools。它不是工具运行的结果,而是模型这次能看到的工具说明书。",
        "Bash、Read、Edit、Write 管代码;Agent 委托子任务;Skill、ToolSearch 负责动态扩展。",
        "每个工具就是:一个名字、一段描述,加一份用 JSON Schema 写的参数声明 —— 声明了,模型就能挑一个、按 schema 填好参数去调用。",
        "别看它像份固定清单,它其实跟着你的模型、可用工具、权限在变 —— 换个模型,这份说明书可能就不一样。",
      ],
      pauseAfter: [PACE.breath, PACE.beat, PACE.pause, PACE.pause],
    },
    // 4. System:被低估的一层 + 纠正"静态" + 埋"单开一集"的伏笔。
    {
      act: "rc-real",
      focus: "sec-system",
      lines: [
        "再点 System。这是最容易被低估的一层 —— 它不是你说的话,却决定了模型怎么干活。",
        "身份、代码风格、怎么用工具、怎么如实汇报、怎么权衡安全与成本 —— 都在这里。",
        "而且它不是一段固定模板:当前目录、git 状态、你的长期记忆,有一大半是为这次调用现拼进去的。",
        "System 远比看上去复杂,我们后面会单独讲;这里先记住一句:它定义了模型「我是谁、我该怎么做事」。",
      ],
      pauseAfter: [PACE.breath, PACE.beat, PACE.pause, PACE.pause],
    },
    // 5. 综合:没有哪一块是纯静态的 + 埋"增长"伏笔(过渡到 Messages)。
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "看出来了吗?没有哪一块是纯静态的。",
        "每一块都是这样:一副相对稳定的骨架,加上一截为这次调用现注入的内容。",
        "而注入最频繁、长得最快的,是 Messages —— 它随你每一轮对话不断往上堆。",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.pause],
    },
    // 6. Messages 的开头,不是你的输入,而是被动态注入的上下文。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "进到 Messages。你以为第一条就是你的输入?并不是。",
        "排在最前面的,是 Claude Code 替你动态注入的上下文:",
        "项目里的 CLAUDE.md、你的长期记忆、还有你的账号信息。",
        "有就注入,没有就跳过 —— 这些内容,你大概率从没亲手写进对话里。",
      ],
      pauseAfter: [PACE.breath, PACE.beat, PACE.beat, PACE.pause],
    },
    // 7. 再往后,才是你真正的第一句输入。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "再往后,才轮到你真正敲下的第一句话。",
        "就这么一条:「看看图片能不能渲染,先分析,别动手改」。",
        "在整块 context 里,它只是很小、很靠后的一条。",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.pause],
    },
    // 8. 你的输入之后,还会追加能力:defer tool / agent / skills —— 渐进式披露(留作伏笔)。
    {
      act: "rc-real",
      focus: "sec-messages",
      lines: [
        "你的输入之后,还会再追加一批能力声明。",
        "延迟加载的工具、可用的 agent 类型、还有 skills —— 它们同样被放进 Messages。",
        "为什么不一次全塞进来?因为这是渐进式披露:用得到时才展开,省下宝贵的 context。",
        "这套机制后面专门讲,这里先记住这个名字。",
      ],
      pauseAfter: [PACE.beat, PACE.breath, PACE.breath, PACE.pause],
    },
    // 9. 总结:你说的话只占千分之一,所以你需要一套东西帮你看清(回扣卖点)。[需配画面:与开场书挡]
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "退回来,看整体。",
        "你真正输入的,是那 45 个字。在整整六万多字符里,它连千分之一都不到。",
        "剩下的 99.9%,是工具说明书、是规则、是记忆、是被注入的上下文。",
        "这,才是 context 真正的样子 —— 也是为什么,你需要一套东西,帮你把它看清楚。",
      ],
      pauseAfter: [PACE.beat, PACE.pause, PACE.breath, PACE.dwell],
    },
    // 10. 回顾第一章 + 引入下一章(真实 diff 如何逐步变大)。[需配画面]
    {
      act: "rc-real",
      focus: "overview",
      lines: [
        "回顾一下:一个会话,会有很多个 turn;你每多问一句,context 就往后追加一段。",
        "很快,工具调用、模型思考、工具结果,就会把它迅速填满,长成密密麻麻的一大片。",
        "那么问题来了:这块 context,到底是怎么一次次变大的?",
        "下一章,我们就盯着真实的 diff,看它每次调用长大了多少,关键的优化点又在哪。",
      ],
      pauseAfter: [PACE.breath, PACE.breath, PACE.pause, PACE.dwell],
    },
  ],
};
