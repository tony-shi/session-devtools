# CLI 交互演示集

C 类特性（不需要装文件，只靠"演示话术 + 实操"）的 example 形态：每篇 ≤ 50 行，**三段式结构** = 触发命令 / 预期效果 / 一句话解读。

## 收录

| 文件 | 文档来源 | 主题 |
|------|---------|------|
| [`goal.md`](goal.md) | docs/en/goal.md | `/goal` 自驱目标完成 |
| [`scheduled-tasks.md`](scheduled-tasks.md) | docs/en/scheduled-tasks.md | `/loop` + cron 工具 |
| [`fast-mode.md`](fast-mode.md) | docs/en/fast-mode.md | `/fast` 切换响应模式 |

## 写法规范

每篇遵循以下结构（直接套模板即可）：

```markdown
# <feature>

> 来源：docs/en/<file>.md

## 是什么
（一句话定位）

## 怎么演
1. 步骤 1
2. 步骤 2
3. 步骤 3

## 预期看到
（观众视角的可观察现象）

## 一句话解读
（这个特性的本质 / 适用场景）

## 易踩坑
（可选，列出新手常见误解）
```

## 用途

- 适合做"系列短视频脚本"（每篇 30-60 秒讲完）
- 适合做"内部分享的快速 cheat sheet"
- 适合给新人看的"功能速通"清单
