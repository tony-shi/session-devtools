import type { Story } from "../types";

// Episode 8: Subagent —— 开第二个 context。
// 系列收尾:子 agent 把整条 context 生命周期(loop→组成→缓存→压缩)又独立走了一遍。
// 边界:不讲调度/并发细节;强调"隔离探索、带回摘要,但不是免费魔法"。
export const subagentStory: Story = {
  id: "subagent",
  title: "Subagent:开第二个 context",
  steps: [
    {
      // 概念:主 context → 派发 → 隔离子 context → 带回摘要(7 拍)
      act: "subagent-concept",
      focus: "spawn",
      lines: [
        "前面所有 context,都是同一个。现在 Claude 可以开第二个。",
        "遇到一个大的子任务,主 agent 派一个子 agent 去做。",
        "子 agent 走完前几集那一整套:自己的 loop、自己的 context、自己的成本。",
        "它有独立的 context —— 主 agent 的历史看不到,它的探索也不挤占主 context。",
        "做完,它只把一段摘要交回主 agent —— 主 context 保持干净。",
        "好处明显;但代价是,它不是免费魔法:自己烧 token,也会丢中间细节。",
      ],
    },
    {
      // 切真实子 agent:类型、独立调用/工具数、自身峰值 context、回交摘要;无则兜底
      act: "subagent-real",
      focus: "spawn",
      lines: [
        "看一个真实的子 agent。",
        "它有自己的调用次数、自己的 context 峰值 —— 完全独立的一摊。",
        "而主 agent 拿到的,只是最后那段摘要。",
      ],
    },
    {
      // 系列收尾结构图
      act: "subagent-concept",
      focus: "diagram",
      lines: [
        "子 agent = 开第二个 context,隔离探索,带回摘要。",
        "它把整条 context 生命周期,又独立走了一遍。",
        "到这里你已经看懂 Claude Code 的运转:loop、context、扩展、子 agent。",
      ],
    },
  ],
};
