import type { Story } from "../types";

// Episode 7: Skills / MCP / Hooks —— 三种扩展,共同点都是"往 context 注入"。
// 接 Ep4(内置工具)→ 这里讲怎么往 context 加新能力;为 Ep8 subagent 埋"能不能开第二个 context"。
// 边界:不讲各自配置细节;只讲"它们都在改变 context 里有什么,而不改模型本身"。
export const extendStory: Story = {
  id: "extend",
  title: "Skills / MCP / Hooks:往 context 注入能力",
  steps: [
    {
      // 概念:三张卡逐拍 → 汇聚到 context(6 拍)
      act: "extend-concept",
      focus: "inject",
      lines: [
        "前面的工具,是 Claude 内置的。但你可以往 context 里加新能力。",
        "Skills:一包专长说明。平时只占一行描述,被调用时才把全文加载进 context。",
        "MCP:接外部服务 —— 数据库、API、设计稿。它的工具注入进 tools 块。",
        "Hooks:在固定时机自动跑命令,把结果或提醒注入进 context。",
        "三种方式,一个共同点:都在改变 context 里有什么。",
        "它们都不改模型本身 —— 只是改变了放进 context 的东西。",
      ],
    },
    {
      // 切真实 Skill 调用(inline 注入全文 / forked 起子进程);无则兜底
      act: "extend-real",
      focus: "inject",
      lines: [
        "看一次真实的 skill 调用。",
        "inline 就把全文塞进 context;forked 则丢给子进程,主对话几乎不涨。",
        "无论哪种,本质都是在管理'context 里放什么'。",
      ],
    },
    {
      // 收尾 + 预告 subagent
      act: "extend-concept",
      focus: "diagram",
      lines: [
        "skills、MCP、hooks —— 三种扩展,都在改变 context。",
        "Claude 的能力边界,很大程度上就是'context 里有什么'。",
        "最后一个问题:能不能开第二个 context?",
      ],
    },
  ],
};
