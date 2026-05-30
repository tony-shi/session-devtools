# 看见真实 Context：一次 Claude Code LLM Call 的组成

## 结论

Claude Code 看起来像聊天，但真正驱动模型行为的是一次次 `/v1/messages` request。对单次 LLM call 来说，最重要的第一层结构不是“用户说了什么”，而是：

```text
Tools + System + Messages
```

这篇文档的目标是让用户理解：session-devtools 展示的不是模拟，也不是总结，而是这一次 call 真实的 context 构成。

## 开场

> 图片占位：官方 context window 模拟页面截图  
> 目的：对照官方用模拟时间线解释 context 如何填充  
> 标注：标题、token bar、timeline、右侧说明卡片

官方文档用一个模拟 session 解释 context window：启动前加载 CLAUDE.md、memory、MCP 工具和 skills；工作中读文件、触发 rules / hooks；后续 prompt、sub-agent、compact 继续改变上下文。

我们的切入点不同：

> 官方解释“机制可能如何填充 context”。  
> session-devtools 展示“这一轮 call 实际发送了哪些 context”。

> 图片占位：session-devtools LLM call attribution 总览  
> 目的：切到真实 UI  
> 标注：Tools / System / Messages 三个 section

文案：

```text
切到真实 UI。
这是某一次 LLM Call 真实发送给模型的 context 构成。
先不要看细节，我们只看最外层：Tools、System、Messages。
```

## 第一幕：三块物理结构

> 图片占位：三段结构总览  
> 目的：解释物理结构  
> 标注：Tools、System、Messages 三个框

文案：

```text
一次 Claude Code 调用，物理结构上主要分成三块：

Tools：模型可调用的工具定义。
System：Claude Code 和运行环境给模型的规则与约束。
Messages：用户、助手、工具结果、运行时注入共同组成的对话历史。
```

这里先讲物理结构，不讲语义分类。原因是物理结构最稳定，也最接近真实 request body。

## 第二幕：Tools 是能力说明书

> 图片占位：点击 Tools 后的条带  
> 目的：展示 tool.Agent / tool.Bash / tool.Skill / tool.ScheduleWakeup 等  
> 标注：几个代表性 tool block

文案：

```text
Tools 不是工具执行结果，而是模型在这次 call 里可见的工具说明书。
它告诉模型：有哪些工具、参数是什么、什么时候该用、有哪些限制。
```

建议解释的代表工具：

| 工具类型 | 解释重点 |
|---|---|
| Read / Grep / Bash / Edit | 基础代码操作能力 |
| Agent / Task | 委托另一个上下文窗口执行工作 |
| Skill / ToolSearch | 动态扩展能力，不一定每次都完整加载 |
| MCP tools | 外部服务暴露给 Claude Code 的操作面 |

边界：

- 不逐条解释所有 tool schema。
- 只讲工具定义会占 context，而且工具列表变化可能影响 cache 和 diff。

## 第三幕：System 是行为边界

> 图片占位：点击 System 后的条带  
> 目的：展示 Core / Tool policy / Env-git / Billing / Memory 等  
> 标注：稳定块和动态块分开标

文案：

```text
System 是最容易被低估的一层。
它不是用户说的话，但它决定 Claude Code 如何工作、如何使用工具、如何报告事实、如何处理安全和成本。
```

推荐拆法：

| 子类 | 解释 |
|---|---|
| Core | 身份、工作方式、交互原则 |
| Tool policy | 工具调用规则、并行策略、安全约束 |
| Environment | cwd、git 状态、平台信息、可用资源 |
| Memory | 用户或项目级长期记忆 |
| Billing / Model info | 成本、模型、服务端策略相关信息 |

这里可以引用 `claude-code-system-prompts` 作为“原材料”背景，但不要把这篇写成 prompt 文件列表。我们的重点是：这些片段最终是否进入了某一次真实 call。

## 第四幕：System 里既有稳定内容，也有动态注入

> 图片占位：System 中稳定块和动态块对比  
> 目的：解释为什么同一个项目不同 call 也可能不完全一样  
> 标注：Core / Tool policy 为稳定，Env / Memory / runtime info 为动态

文案：

```text
System 不是一整块固定字符串。
一部分相对稳定，例如核心行为规则和工具策略。
另一部分会随项目、目录、git 状态、权限、记忆、模型和可用工具变化。
```

用户应该得到的认知：

- 稳定块适合解释 Claude Code 的默认行为风格。
- 动态块适合解释“为什么这次 call 和上次不完全一样”。

## 第五幕：Messages 是最复杂的一层

> 图片占位：点击 Messages 后的条带  
> 目的：展示 Human / Assistant / Tool call / Tool result / Injection / Msg misc  
> 标注：用户消息、助手历史、工具结果、运行时注入

文案：

```text
Messages 不只是聊天记录。
它还包括工具调用、工具结果、图片、运行时提醒，以及 Claude Code 根据当前状态注入的系统提醒。
```

推荐大类：

| 子类 | 解释 |
|---|---|
| Human | 用户输入 |
| Assistant | 模型之前的回答 |
| Tool call | 模型请求执行工具 |
| Tool result | 工具执行结果返回给模型 |
| Injection | 运行时通知、hook、提醒、特殊上下文 |
| Misc | 无法归入主类的消息片段 |

边界：

- 这里只讲大块、大类。
- 不逐条解释所有动态注入 rule。
- 复杂注入规则留到后续“机制如何落到 context”。

## 第六幕：点中一块，落到证据

> 图片占位：选中某个 segment 后，下方出现明细  
> 目的：证明这不是概念图，而是可追溯证据  
> 标注：slot、size、pct、jsonPath、callId、jsonl line、raw preview、source button

文案：

```text
每个色块都可以落到证据：
它在 request 的哪个位置？
来自哪条 JSONL？
属于哪个 call？
占了多少 context？
是否来自用户、工具结果，还是运行时注入？
```

建议 UI 标注：

```text
slot: messages[90].content[1]
type: user_input:image
call: #298
jsonl: L182
size: 433k
pct: 15.0%
```

这一幕是产品差异的核心：外部文档通常解释机制，我们把机制落到证据。

## 第七幕：收束

> 图片占位：回到 Tools / System / Messages 总览  
> 目的：回收叙事  
> 标注：三段结构 + 下一篇 diff 入口

文案：

```text
今天先理解结构：
Claude Code 的能力、规则、环境、历史和工具结果，最终都会体现在 context 里。

下一步，我们不再只看“这一次有什么”，而是看“下一次 call 为什么变成这样”。
```

## 常见误读

| 误读 | 更准确的说法 |
|---|---|
| Tools 是工具执行结果 | Tools 是工具定义；工具结果通常在 Messages 的 tool_result 中 |
| System prompt 是单一大字符串 | Claude Code 的 system 由稳定规则和动态环境片段共同组成 |
| Messages 就是终端聊天记录 | Messages 还包含工具调用、工具结果、图片、注入提醒等 |
| UI 展示的是估算 | attribution 视图基于真实 request 和本地数据做归因；覆盖率和未知段需要明确标出 |

## 不在本篇展开

- Call-to-call diff
- Cache 命中和失效
- `/compact` 后哪些内容保留
- Sub-agent 独立上下文窗口
- Hook / skill / memory 的完整机制

这些放到后续文档。

## 参考资料

- [Claude Code docs: Explore the context window](https://code.claude.com/docs/zh-CN/context-window)
- [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)
- [shanraisshan/claude-code-best-practice](https://github.com/shanraisshan/claude-code-best-practice)
