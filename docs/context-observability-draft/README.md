# Context Observability Draft

> 草稿目录，暂未接入站点导航。图片先留白，后续替换为真实 UI 截图。

## 结论

这组文档不应该做成又一份 Claude Code 使用教程。它应该成为 session-devtools 的 **Learn / 解读 Claude Code** 栏目：外部文档讲“怎么用、怎么配、有哪些机制”，我们用真实 UI 补上最稀缺的一层：

> 某一次 LLM call 真实发送了什么 context，来源证据在哪里，和上一次 call 相比发生了什么变化。

## 外部资料差异

查询时间：2026-05-29。Star 数只作为热度信号，不代表内容质量。

| 资料 | 信号 | 强项 | 我们的差异 |
|---|---:|---|---|
| [shanraisshan/claude-code-best-practice](https://github.com/shanraisshan/claude-code-best-practice) | 55.4k stars | Claude Code 概念地图、Agents / Commands / Skills / Hooks / MCP / Memory、工作流和社区 tips | 它是“最佳实践地图”；我们是“真实 session 取证仪表盘” |
| [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) | 10.6k stars | 抽取 system prompts、tool descriptions、agent prompts、版本 diff | 它展示“原材料”；我们展示“某次 call 真实拼进了哪些材料” |
| [FlorianBruniaux/claude-code-ultimate-guide](https://github.com/FlorianBruniaux/claude-code-ultimate-guide) | 4.5k stars | 教程化、学习路径、架构心智模型、安全与模板 | 它教“为什么和怎么做”；我们用 UI 证明“实际发生了什么” |
| [disler/claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery) | 3.7k stars | Hooks 生命周期、payload、控制点 | 它讲 hook 机制；我们展示 hook / system reminder 是否进入 context |
| [trailofbits/claude-code-config](https://github.com/trailofbits/claude-code-config) | 2.0k stars | 团队级配置、安全、sandbox、hooks、CLAUDE.md | 它是配置方案；我们可以验证配置后 context / cost / risk 如何变化 |
| [Piebald-AI/tweakcc](https://github.com/Piebald-AI/tweakcc) | 2.1k stars | 修改 Claude Code system prompts、工具集和本地安装 | 它改 Claude Code；我们观察修改后的真实影响 |

## 产品文档定位

建议把现有 docs 分成两类：

```text
product/
  讲界面怎么用：session list、session detail、turn detail、llm call detail

learn/
  讲 Claude Code 的机制如何落到真实 request：context、diff、cache、compact、sub-agent
```

本目录先写 `learn/` 的草稿。每篇遵循同一个结构：

```text
1. 概念结论
2. UI 上看哪里
3. 这块代表什么
4. 证据在哪里
5. 常见误读
6. 下一步
```

## 草稿清单

1. [看见真实 Context：一次 Claude Code LLM Call 的组成](./01-real-context-anatomy.md)
2. [Context 不是静态的：相邻 LLM Call 之间发生了什么变化](./02-context-diff.md)
3. [从机制到 Context：Hooks、Memory、Skills、Sub-agent 最终如何体现](./03-mechanisms-to-context.md)
4. [Claude Code 配置能力可视化落地方案](./04-claude-capability-visualization.md)

## 一份素材如何复用

| 形态 | 复用方式 | 重点 |
|---|---|---|
| 产品 docs | 保留完整解释、术语、证据路径 | 帮用户学会看 UI |
| 官网 walkthrough | 每篇压缩成 1 幕 | 讲“产品能看见什么” |
| 短文 / 社媒 | 提炼一个观点 + 一张图 | 传播观点 |
| 长文 | 串联 3 篇草稿 | 建立完整 context observability 心智 |
| 视频脚本 | 按点击路径播放 | 演示真实 UI |

## 图片占位规范

暂时不放真实图片，用下面格式留位：

```markdown
> 图片占位：这里放 [截图名]
> 目的：说明这张图要证明什么
> 标注：需要高亮哪些 UI 区域
```

这样后续替换截图时，不会破坏正文结构。

## 资料边界

- 外部资料负责提供背景和对照。
- 我们的文档不声称“完全还原 Claude Code 内部实现”。
- 更准确的表达是：基于本地 JSONL、proxy 捕获的真实 API request，以及 UI 中的 attribution / diff 结果，观察某次 session 实际发生了什么。
