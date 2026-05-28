import type { Story } from "../types";

// Episode 4: Prompt Cache —— 稳定前缀几乎免费,成本在新鲜的尾部。
// 接 Ep3(前缀稳定 vs 尾部增长)的经济学结果;并为 Ep5(compaction 重写前缀 →
// 缓存失效 → 贵)铺垫。边界:不讲 cache TTL / ephemeral 细节,只讲"命中 vs 新鲜"。
export const cacheStory: Story = {
  id: "cache",
  title: "Prompt Cache:稳定前缀几乎免费",
  steps: [
    {
      // 概念:整份 context → 拆成 命中(灰) / 新鲜(绿),逐拍
      act: "cache-split",
      focus: "cache",
      lines: [
        "你以为:每次调用,都把整个 context 重新发给模型、重新计费?",
        "其实,稳定前缀(tools + system + 历史)被缓存了 —— 这次是'命中',几乎不重算。",
        "只有新增的那部分(上一章的 diff)是'新鲜'的,需要真正计算。",
        "所以成本不随 context 线性增长 —— 大头是缓存命中,代价在新鲜的尾部。",
      ],
    },
    {
      // 切真实 CallLedger:这次 call 的 token 去向
      act: "cache-real",
      focus: "cache",
      lines: [
        "切到真实数据 —— 这一次 Call 的 token 去向。",
        "cache_read 是缓存命中的部分;fresh 是这次新鲜计算的。",
        "大部分命中、少部分新鲜 —— 这就是 agent 反复调用还能高效的原因。",
      ],
    },
    {
      // 收尾 + Ep5 预告
      act: "cache-split",
      focus: "diagram",
      lines: [
        "缓存让稳定前缀几乎免费,成本集中在新增的尾部。",
        "但反过来:一旦**破坏了前缀**,缓存就全部失效,代价骤增。",
        "下一章:context 涨满时,Claude 会重写历史(/compact)—— 而那,正是破坏前缀的时刻。",
      ],
    },
  ],
};
