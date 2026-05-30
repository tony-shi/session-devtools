# 从机制到 Context：Hooks、Memory、Skills、Sub-agent 最终如何体现

## 结论

Claude Code 的许多高级能力，最终都会以某种方式影响 context：

```text
配置改变 system
工具改变 messages
hooks 改变运行时反馈
memory 改变启动和检索内容
skills 改变可用指令和工作流
sub-agent 改变主窗口和子窗口的边界
compact 改变历史的形态
```

外部文档通常讲这些机制怎么配置。session-devtools 的价值是：看它们是否真实影响了某次 call，以及影响落在 request 的哪里。

## 机制总览

> 图片占位：机制到 context 的映射图  
> 目的：展示机制不是孤立功能，而是最终落到 Tools / System / Messages  
> 标注：Hooks、Memory、Skills、Sub-agent、Compact 指向三大 section

| 机制 | 通常影响哪里 | UI 上怎么验证 |
|---|---|---|
| CLAUDE.md / memory | System 或 Messages 中的 memory / instruction 片段 | 看 System / Messages 中对应 slot 和 origin |
| Built-in tools / MCP | Tools section | 看 Tools 列表、工具 schema、tool count |
| Skills | System / Messages 中的 skill listing 或 skill body | 看 Skills / Injection / system reminder |
| Hooks | 运行时反馈、阻断信息、PostToolUse 输出 | 看 Injection、tool result、background / side call |
| Sub-agent | 子 agent 独立 session + 父窗口中的返回摘要 | 看 sub-agent boundary 和父 next call |
| Compact | 用摘要替代旧历史 | 看 diff 中删除/新增/修改，以及 compact event |
| Prompt cache | 计费和处理复用 | 看 ledger、cache ratio、cache read/write |

## 第一幕：Memory 和 CLAUDE.md

> 图片占位：System / Messages 中 memory 或 instruction 片段  
> 目的：解释启动时和项目级指令如何进入 context  
> 标注：memory、CLAUDE.md、project instruction

文案：

```text
CLAUDE.md 和 memory 的价值不在于“它们存在于磁盘上”。
真正重要的是：它们有没有进入这一次 call，进入了哪个位置，占了多少 context。
```

需要讲清楚：

- 全局 / 项目 / 子目录的指令可能进入不同位置。
- 自动 memory 可能按相关性注入，不一定每次完整进入。
- UI 要避免把“磁盘上存在”误说成“本轮模型已看见”。

## 第二幕：Tools 和 MCP

> 图片占位：Tools section 中 built-in tools 和 MCP tools  
> 目的：解释工具定义是 context 的一部分  
> 标注：tool.Bash、tool.Read、mcp.*、ToolSearch

文案：

```text
工具能力不是免费的。
每个可用工具都需要以 schema 或说明的形式被模型看到。
工具列表变化，可能改变 system / tools 前缀，也可能影响 prompt cache。
```

注意：

- 工具定义在 Tools。
- 工具执行结果通常在 Messages 的 tool_result。
- 不要把两者混在一起。

## 第三幕：Hooks

> 图片占位：hook 相关注入或 tool result  
> 目的：把 hooks-guide 的机制落到 UI  
> 标注：PreToolUse / PostToolUse / Stop / PreCompact 对应证据

文案：

```text
Hooks 是 Claude Code 生命周期上的控制点。
但对模型来说，只有被反馈回会话或 request 的内容，才真正影响后续 reasoning。
```

建议解释：

| Hook 类型 | 产品解释 |
|---|---|
| PreToolUse | 可能阻断工具调用，错误信息可能反馈给模型 |
| PostToolUse | 可能把 lint/test/log 结果反馈给下一轮 |
| Stop | 可能要求模型继续完成未做完的事 |
| PreCompact | 可能影响压缩前保存或总结策略 |

边界：

- Hook 代码本身不一定进入 context。
- Hook 的输出、错误、提醒是否进入，要看真实 call。

## 第四幕：Skills

> 图片占位：Skills / system reminder / skill body 片段  
> 目的：解释 skill listing 和 skill body 的区别  
> 标注：skill listing、selected skill body、token size

文案：

```text
Skills 通常不是一开始把所有内容都塞进 context。
很多时候模型先看到 skill listing，再在需要时加载具体 skill body。
```

UI 要讲清楚：

- 哪些只是 skill 名称 / 描述。
- 哪些是具体 skill body。
- 哪些因为本次任务触发而进入。

## 第五幕：Sub-agent

> 图片占位：父 agent -> 子 agent -> 父 next call  
> 目的：解释 context boundary  
> 标注：parent call、sub-agent own session、returned summary、parent next call

文案：

```text
Sub-agent 的关键不是“多了一个助手”，而是多了一个独立上下文窗口。
子 agent 可以读大量文件、跑工具链，但父 agent 通常只接收返回摘要和必要元数据。
```

要突出：

- 子 agent 自己的 context 不等于父窗口 context。
- 父下一次 call 中看到的是子 agent 返回结果，不是子 agent 的完整历史。
- 这就是 sub-agent 能降低主 context 污染的原因之一。

## 第六幕：Compact

> 图片占位：compact 前后 diff  
> 目的：解释历史不是消失，而是换形态  
> 标注：删除旧历史、新增 summary、保留 system/tools

文案：

```text
Compact 不是简单清空上下文。
它通常用结构化摘要替代旧对话历史，同时一些启动内容会重新加载。
```

这里适合连接官方文档：

- 系统提示和输出样式不是消息历史的一部分。
- 根目录 CLAUDE.md、无范围规则、自动 memory 可能重新注入。
- 带 paths 的规则或嵌套 CLAUDE.md 可能需要再次读取匹配文件才出现。

## 第七幕：Cache

> 图片占位：ledger + cache ratio + cache overlay  
> 目的：解释成本维度  
> 标注：cache read、cache write、fresh input、output

文案：

```text
Cache 不是 context 的来源分类，而是处理和计费方式。
同一段内容可能来自 System 或 Messages，同时又被 cache read 复用。
```

固定术语：

| 项 | 解释 |
|---|---|
| Fresh input | 本轮需要新处理的输入 |
| Cache read | 服务端复用的前缀 |
| Cache write | 本轮写入缓存的内容 |
| Output | 模型生成输出 |

## 文档和产品的关系

> 图片占位：外部 docs vs session-devtools 的对照图  
> 目的：说明不是替代外部文档，而是补齐观测层

```text
外部文档：解释机制和配置。
session-devtools：验证机制是否进入某次真实 call。
```

建议在产品 docs 里固定使用这句话：

```text
别人告诉你 Claude Code 可能怎么工作；
session-devtools 让你看到它这一次到底怎么工作。
```

## 常见误读

| 误读 | 更准确的说法 |
|---|---|
| 配置了 hook 就一定影响模型 | 只有 hook 输出进入后续 request，才影响模型 reasoning |
| skill 安装后全文都会进 context | 常见路径是先 listing，再按需加载 body |
| sub-agent 的所有历史都会回到父窗口 | 父窗口通常看到返回摘要和必要元数据 |
| compact 后旧信息完全没了 | 旧历史可能被摘要替代，部分启动内容可能重新注入 |
| cache 是内容来源 | cache 是处理/计费维度，不是内容来源 |

## 参考资料

- [Claude Code docs: Explore the context window](https://code.claude.com/docs/zh-CN/context-window)
- [Claude Code Hooks Mastery](https://github.com/disler/claude-code-hooks-mastery)
- [Trail of Bits Claude Code Config](https://github.com/trailofbits/claude-code-config)
- [Claude Code Best Practice](https://github.com/shanraisshan/claude-code-best-practice)
- [Piebald Claude Code System Prompts](https://github.com/Piebald-AI/claude-code-system-prompts)
