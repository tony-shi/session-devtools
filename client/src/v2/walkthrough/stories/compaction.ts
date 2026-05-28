import type { Story } from "../types";

// Episode 5: Compaction —— context 涨满时,Claude 重写历史。
// 收束 context 生命周期(组成→增长→缓存→压缩);代价 = 缓存失效(接 Ep4)+ 细节丢失。
// 之后转入"扩展"一线(skills / 子 agent / 工具)。边界:不讲 compaction 算法细节。
export const compactionStory: Story = {
  id: "compaction",
  title: "Compaction:context 涨满,重写历史",
  steps: [
    {
      // 概念:涨满 → 总结 → 缩小 + 代价,逐拍(7 拍)
      act: "compact-concept",
      focus: "compact",
      lines: [
        "对话越来越长,context 逐渐逼近上限。",
        "再涨就要超了 —— 触发 compaction。",
        "Claude 发起一次总结调用,把长长的历史压成一段摘要。",
        "长历史被摘要替换,context 大幅缩小。",
        "代价一:前缀被改写,Ep4 那个几乎免费的缓存 —— 全部失效。",
        "代价二:摘要保留大意,但丢了原话细节。agent 记得做过什么,记不清原文。",
        "可以手动 /compact,也会在接近上限时自动触发。",
      ],
    },
    {
      // 切真实 compaction 事件
      act: "compact-real",
      focus: "compact",
      lines: [
        "看一次真实的压缩事件。",
        "压缩前后的 token,一目了然。",
        "这就是 Claude 为了继续工作,主动重写了自己的历史。",
      ],
    },
    {
      // 收尾:收束 context 生命周期 + 预告"扩展"一线
      act: "compact-concept",
      focus: "diagram",
      lines: [
        "context 涨满 → 总结 → 缩小,这就是 compaction。",
        "它让长会话能继续,代价是缓存失效 + 细节丢失。",
        "到这里,context 的生命周期讲完了:组成 → 增长 → 缓存 → 压缩。",
        "接下来换一条线:Claude 如何被扩展 —— skills、子 agent、工具。",
      ],
    },
  ],
};
