import type { Story } from "../types";

// Episode 4: Tools —— context 的关键部分。
// 放大 Ep2 三块条里的 tools 块:它是什么、五大类、为什么是一块巨大的稳定前缀(给 Ep5 cache 埋钩子)。
// 边界:不逐个讲工具用法;只讲"工具说明书就在 context 里,定义了 agent 能做什么"。
export const toolsStory: Story = {
  id: "tools",
  title: "Tools:context 的关键部分",
  steps: [
    {
      // 概念:三块条放大 tools → 五大类逐拍 → 稳定大前缀(7 拍)
      act: "tools-concept",
      focus: "tools-cat",
      lines: [
        "上一集你看到 context 由三块组成:system、tools、messages。",
        "现在放大中间那块 —— tools。你几乎从没注意它,但它常常是最大的一块。",
        "tools 块 = 每个可用工具的完整说明书。Piebald 数过:82 段。",
        "它们分五大类。第一类:文件 —— 读、写、改。",
        "搜索、执行、网络…… 模型能做的一切动作,都在这份说明书里声明。",
        "代码智能 —— 跳转、诊断。五类齐了。",
        "而且它几乎每轮都不变 —— 一块巨大的稳定前缀。记住这点,下一集 cache 会用到。",
      ],
    },
    {
      // 切真实归因:看 tools 块在一次真实 call 里到底占多少
      act: "tools-real",
      focus: "tools-cat",
      lines: [
        "看真实一次调用的 context 构成。",
        "中间这一大段,几乎全是工具说明书 —— 而且每轮重复。",
        "模型不是天生会用工具,是每次请求都把说明书放进了 context。",
      ],
    },
    {
      // 收尾结构图
      act: "tools-concept",
      focus: "diagram",
      lines: [
        "tools,是 context 的关键部分:它定义了 agent 能做什么。",
        "五大类工具,组成一块稳定的大前缀。",
        "下一集:这块大前缀每轮重复,为什么没让你破产 —— 缓存。",
      ],
    },
  ],
};
