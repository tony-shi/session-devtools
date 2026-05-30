# Context 不是静态的：相邻 LLM Call 之间发生了什么变化

## 结论

单次 attribution 回答的是：

```text
这一次 call 里有什么？
```

Call-to-call diff 回答的是：

```text
为什么下一次 call 变成这样？
```

这是理解 Claude Code 的关键，因为下一次 request 不是简单追加聊天记录。工具结果、运行时提醒、压缩、缓存边界、子代理返回，都可能改变下一次 call 的 context。

## 开场

> 图片占位：上一章 attribution 总览  
> 目的：承接“单次 call 的组成”  
> 标注：Tools / System / Messages

文案：

```text
上一幕我们看到了一次 LLM Call 的真实 context 构成。
但 Claude Code 真正难理解的地方在于：context 会变。
```

> 图片占位：切到 Diff overlay / Diff 视角  
> 目的：展示新增、修改、删除、未变  
> 标注：Diff toggle、绿色新增、黄色修改、红色删除、灰色未变

文案：

```text
现在我们比较相邻两次 LLM Call。
绿色表示新增进入 context 的内容。
黄色表示修改过的内容。
红色表示被移除或替换的内容。
灰色表示保持不变。
```

## 第一幕：为什么要看相邻 call

> 图片占位：同一个 turn 中多个 LLM call  
> 目的：说明一次 turn 往往有多个模型调用  
> 标注：Call #7 -> Call #8 -> Call #9

文案：

```text
一个用户 turn 内，Claude Code 往往会多次调用模型。
每一次 call 都基于上一轮的结果继续构造 request。
所以真正的调试问题通常不是“它看到了什么”，而是“它什么时候开始看到这段内容”。
```

## 第二幕：新增内容

> 图片占位：Diff 中新增段落  
> 目的：展示新工具结果 / 新用户消息 / 新运行时提醒如何进入下一轮  
> 标注：新增段、source call、jsonl line

文案：

```text
新增内容通常来自上一轮刚发生的事件：
用户新输入、工具调用结果、助手回复、运行时提醒，或者某些动态注入。
```

常见新增来源：

| 来源 | 例子 | 观察点 |
|---|---|---|
| user message | 用户追加指令 | messages.user |
| tool result | Read / Bash 输出 | messages.tool_result |
| assistant text | 上一轮回复 | messages.assistant |
| runtime injection | system reminder / hook notice | messages.injection |
| environment update | git / cwd / memory 变化 | system.env / system.memory |

## 第三幕：修改内容

> 图片占位：Diff 中修改段落  
> 目的：说明同一结构位置的内容变化  
> 标注：修改前后、jsonPath

文案：

```text
修改不是简单新增。
它通常意味着同一个结构位置的内容被重写，例如系统环境片段变了、运行时提醒换了，或者压缩后的摘要替代了旧历史。
```

这里要提醒用户：修改段要结合 `jsonPath` 和原始内容看，不能只凭颜色判断语义。

## 第四幕：删除内容

> 图片占位：Diff 中删除段落  
> 目的：解释 context 为什么会变小或旧内容消失  
> 标注：删除段、可能原因

文案：

```text
删除说明某些内容没有进入下一次 call。
可能是压缩、历史裁剪、工具列表变化，也可能是某类动态注入不再触发。
```

注意边界：

- 删除不一定是 bug。
- 删除也不一定意味着模型“不知道了”，如果内容被 compact 摘要吸收，可能以另一种形式继续存在。

## 第五幕：Diff 和 Cache 不是一回事

> 图片占位：Diff overlay + Cache overlay 同屏  
> 目的：区分内容变化和缓存命中  
> 标注：Diff 颜色、Cache ratio、cache read/write

文案：

```text
Diff 说的是内容结构有没有变。
Cache 说的是服务端有没有复用前缀。
内容没变也可能 cache miss；内容变了也可能只有后缀重新处理。
```

建议固定解释：

| 维度 | 回答的问题 |
|---|---|
| Diff | 相邻 call 的 context 内容变了什么 |
| Cache | 这些内容在计费和推理上有多少被复用 |
| Ledger | 本轮 fresh input、cache read、cache write、output 的账本 |

## 第六幕：点中 diff 段，回到证据

> 图片占位：选中新增 / 修改段后的下方明细  
> 目的：把 diff 色块落到原文、来源 call、jsonl line  
> 标注：diff kind、slot、origin、raw preview、source button

文案：

```text
颜色只是入口。
真正判断原因，要点中 segment 看证据：
它来自哪里，属于哪次 call，原始 JSON 是什么，和上一轮哪个位置对应。
```

## 收束

> 图片占位：Diff 总览回到 attribution 总览  
> 目的：建立两种视角的关系

文案：

```text
Attribution 让你看见“现在有什么”。
Diff 让你看见“它是怎么变成现在这样的”。

这就是为什么 session-devtools 不只是 token dashboard，而是 context debugging tool。
```

## 常见误读

| 误读 | 更准确的说法 |
|---|---|
| 新增就是用户新说的话 | 新增也可能是工具结果、运行时注入、环境变化 |
| 删除就是丢失 | 删除可能被 compact 摘要替代，需要看后续 segment |
| cache ratio 高就说明没变化 | Cache 是复用账本，Diff 是内容变化，两者不能互相替代 |
| diff 色块足够判断原因 | 颜色只提示变化类型，原因要看 selected detail 和 source |

## 下一步

下一篇进入机制层：

```text
Hooks、Memory、Skills、Sub-agent、Compact 这些机制，最终如何体现在真实 context 中？
```

## 参考资料

- [Claude Code docs: Explore the context window](https://code.claude.com/docs/zh-CN/context-window)
- [Claude Code Best Practice](https://github.com/shanraisshan/claude-code-best-practice)
- [Trail of Bits Claude Code Config](https://github.com/trailofbits/claude-code-config)
