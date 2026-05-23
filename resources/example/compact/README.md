# Compact × Skill 联动 demo（草案 · DRAFT）

> 状态：**草案**，待打磨。当前目的：先把 compact 和 skill 的联动点讲清楚，演示流程留位后续完善。

## 为什么 compact 值得单独讲

`/compact` 看起来只是"清理历史腾出 context"，但它对 skill 的处理**特殊**——理解这点能解释一类常见困惑："我之前调过的 skill 现在好像不灵了？"

## 联动机制（官方文档摘要）

1. skill 被激活后，整份 SKILL.md 内容作为**单条消息**进入对话上下文
2. 该内容**跨 turn 留存**，Claude Code 不会在后续 turn 重新读取 SKILL.md 文件
3. 当对话被 auto-compact 或 `/compact` 压缩时：
   - 普通对话历史 → 被摘要替代
   - **每个被调用过的 skill** → 按"最近调用"重新附加到摘要之后
   - **每个 skill 保留前 5000 token**，超出截断
   - **所有重附加 skill 共享 25000 token 总预算**，按 LRU 填，预算超了老 skill 整个被丢

## 这意味着什么

| 现象 | 原因 |
|------|------|
| compact 后某个 skill"忘了"自己的指令 | 该 skill 不在 LRU 前列，被丢出预算 |
| compact 后 skill 行为变弱但没完全失效 | 内容被截到前 5000 token，后段指令丢失 |
| 重新触发一次 skill 就恢复了 | 重新激活把完整内容塞回最新位置，重置 LRU |

## 极简演示流程（草案，待打磨）

> ⚠️ 以下流程**没有实测过**，是基于文档推理的设计稿。

### 流程 A · 单 skill 截断观察

1. 装好 `todo-scan-args`（或任意正文较长的 skill）
2. 故意构造一份**正文超过 5000 token** 的 SKILL.md（在末尾贴大段约束/示例）
3. 触发一次：`/todo-scan-args tmp/skill-demo-todos`
4. 主对话灌大量无关内容直到接近 context 上限
5. 触发 `/compact`
6. 再触发同一个 skill，观察末尾约束是否还生效

**预期**：末尾的指令丢失，前 5000 token 内的还在。

### 流程 B · 多 skill LRU 淘汰

1. 依次调用 5-6 个 skill（确保总 token 超过 25000）
2. 灌内容到接近上限
3. `/compact`
4. 试触发**最早调用**的 skill —— 应被完全丢出，需要重新激活才能恢复

### 流程 C · `/compact` vs `/clear` 对比

- `/compact` —— 保留 skill 内容（按 LRU + 截断）
- `/clear` —— 不保留任何东西，包括 skill

可以让观众理解"清空"和"压缩"对 skill 的处理差异。

## TODO（草案待完善）

- [ ] 实测流程 A，确认 5000 token 截断在实际行为中怎么体现
- [ ] 实测流程 B，确认 LRU 顺序（最近调用 = 优先保留）
- [ ] `/doctor` 是否能可视化 skill 预算使用？（文档提到 `/doctor` 可以看 skill listing budget，但未提 compact 预算）
- [ ] 找一个能让 token 用量可观测的方法（`/cost` 或 `/context` 是否有暴露）
- [ ] 写一个"compact 友好"的 skill 写作建议：把最关键指令放前 5000 token

## 关联

- 主教学 demo：[`../skill/README.md`](../skill/README.md)
- 官方文档（compact 段）：https://code.claude.com/docs/en/skills#skill-content-lifecycle
- 官方文档（context 管理）：https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up
