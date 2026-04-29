# Context 重建错位最小修正方案

## 结论

当前 `multi-turn-human` 报告中的严重错位，不应优先理解为单个 parser bug。更准确的结论是：

1. `ContextMutation` 层只负责从 JSONL 抽取事实，并保留必要标记；不在这里决定某条记录是否进入本次 API 请求上下文。
2. `ExpectedContext` 重建层是关键修正点：它负责按 Claude Code 的上下文组装规则，把 mutation 前缀编译成一次 API 请求应有的 system/tools/messages 候选序列。
3. `noise` 与 token 口径需要重新定义：proxy 请求体是 wire-level ground truth，不等价于 model-visible ground truth；更不能把“known noise”理解为“不计 token”。

因此最小修正应拆成三类改动：Parser 做事实标记，Reconstructor 做规则化重建，Audit/Token 口径做概念收敛。

## 背景

问题报告中出现了如下错配：

- expected：当前中文用户请求。
- proxy：历史 `are you there?`。
- expected：当前 assistant 文本。
- proxy：历史 `No response requested.`。

经核查，原始 Claude JSONL 文件包含完整历史会话，而 fixture 中的 `session.jsonl` 是截取后的 94 行，缺少早期多轮记录。也就是说：

- 原始 JSONL 并未缺失这些历史 turn。
- 当前 fixture 输入不完整，导致 expected 侧缺少 prior context。
- reconciliation 在精确锚点不足时使用了过宽的 `category + role` 启发式匹配，把缺口误判为“已匹配”。

这说明后续修正不能只补一个字段，而要明确三层边界。

## 改动一：Context Mutation Parser 只做事实抽取

### 目标

`JSONL Mutation Parser` 的职责是“把 Claude Code JSONL 事件忠实转成 mutation”，而不是决定最终上下文窗口。

### 应该做

- 保留 JSONL 原始事实：
  - `uuid`
  - `parentUuid`
  - `promptId`
  - `timestamp`
  - `message.id`
  - `message.role`
  - `isSidechain`
  - `isMeta`
  - `isApiErrorMessage`
  - `apiErrorStatus`
- 对 `assistant + isApiErrorMessage: true` 增加明确标记：
  - `metadata.syntheticApiError = true`
  - `metadata.apiErrorStatus = rec.apiErrorStatus`
  - `metadata.originalRecordType = "assistant"`
- 保留错误文本本身，方便后续审计和规则验证。

### 不应该做

- 不在 Parser 层直接丢弃 `isApiErrorMessage`。
- 不在 Parser 层判断它是否进入 API 请求上下文。
- 不用 `noise` 表达“永远无 token 成本”。

### 最小实现建议

短期不扩类型时，可以继续使用：

```text
type: "noise"
category: "hook_event"
metadata.syntheticApiError = true
metadata.originalRecordType = "assistant"
```

但这只是兼容现有类型的过渡表达。语义上它更像 `transport_event` 或 `control_event`，不是普通“噪声”。

## 改动二：Expected Context Reconstructor 是关键修改点

### 目标

`Expected Context Reconstructor` 负责把 mutation 前缀编译成“本次 API 请求预期发送的上下文”。这是错位问题的主修正点。

### 必须规则化

建议将以下行为显式建模为 rule，而不是散落在代码分支里：

| Rule | 含义 | 默认 |
|---|---|---|
| `R1_base_append` | 普通 user/assistant/tool_use/tool_result 进入候选上下文 | 开启 |
| `R2_merge_assistant_tool_uses` | 同一 assistant `message.id` 的 text/tool_use 合并为一个 API assistant message | 开启 |
| `R3_merge_user_tool_results` | 连续 tool_result 按 `tool_use_id` 对齐并合并 | 开启 |
| `R5_inject_local_command` | local command 历史作为 user block 注入 | 开启 |
| `R6_filter_runtime_events` | 过滤 permission、file snapshot、last prompt、turn duration 等运行时状态 | 开启 |
| `R8_filter_synthetic_api_error` | 默认过滤 `syntheticApiError`，但保留可关闭策略 | 开启 |

`R8_filter_synthetic_api_error` 应该是一个 rule。原因是：

- Claude Code 当前实现里，`normalizeMessagesForAPI` 会过滤 synthetic API error assistant。
- 但这仍是上下文组装策略，不是 JSONL 事实解析。
- 后续如果某版本把错误文本作为恢复提示注入 prompt，可以关闭或替换该 rule 做验证。

### 必须修正

1. 使用完整 JSONL 前缀。
   - fixture 不能只截当前窗口附近的 JSONL，否则无法重建 prior context。
   - 若为了 fixture 体积必须截取，也要保证截取范围覆盖 proxy `messages[]` 所需的完整 parent chain / prior turns。

2. expected segment 必须生成 hash。
   - `rawHash`
   - `normalizedHash`
   - `charCount`
   - `toolUseId`

   这样中文用户消息、assistant 文本、tool_use/tool_result 可以先走精确匹配，而不是退化到 category heuristic。

3. 以 API message 序列为中间产物。
   - 不应只输出扁平 segment。
   - 应先形成类似 `messages[0].content[0..n]` 的逻辑结构，再拆 segment。
   - 这样 proxy 的多轮顺序可以按 message/block 顺序确定性对应，而不是靠猜。

### 不应该做

- 不把 proxy-only 内容反写成 `ContextMutation`。
- 不让 `category + role` 直接产生可靠 matched。
- 不把 “expected 缺失” 静默转成 “proxy 已解释”。

## 改动三：noise 与 token 口径重新定义

### 核心判断

proxy 是 wire-level ground truth，不是 model-visible ground truth。

也就是说：

- proxy 能证明某段内容出现在 HTTP 请求体里。
- proxy 不能单独证明某段内容被模型实际看到。
- response usage 能证明 API 侧统计了输入 token 总量。
- 但没有公开逐段 usage，无法从单次请求精确归因每个 segment 的 model-visible token。

### 建议拆分指标

| 指标 | 含义 | 来源 | 可信度 |
|---|---|---|---|
| `wirePayloadChars` | 请求体中实际出现的字符数 | proxy reqBody | 精确 |
| `apiMeasuredInputTokens` | API 返回的输入 token 统计 | response usage | 精确到整次请求 |
| `modelContextCandidateChars` | 按 Messages API 结构推断可能进入模型上下文的字符 | proxy + 规则 | 推断 |
| `serverSideControlChars` | 可能被服务端消费的控制信息 | proxy + pattern | 推断 |
| `modelVisibleTokens` | 实际进入模型推理的 token | 无逐段 ground truth | 不可直接精确 |

### billing header 的新口径

`x-anthropic-billing-header` 不应继续简单称为 `billing_noise`。

更准确的分类是：

```text
category: billing_attribution / server_side_attribution
wirePayload: yes
modelVisible: unknown / likely_not_user_semantic
apiAccounted: unknown until usage/count_tokens delta validates
```

原因：

- Claude Code 将它放入 `system` block 传输。
- 源码注释显示服务端会解析该 header，用于版本、entrypoint、workload 等归因/路由信息。
- 但不能据此断言它逐字进入模型推理。

### known noise 的新定义

`known_noise` 不应表示“不计 token”，只表示：

- 来源已知；
- 非用户语义；
- 不应计入 unexplained；
- 是否计入 API token 或 model-visible token，需要看它处于哪个层级。

建议将现有 `known_noise` 拆成更精确的概念：

| 概念 | 示例 | 是否 unexplained | 是否 model-visible |
|---|---|---|---|
| `runtime_event` | `turn_duration`、`file-history-snapshot` | 否 | 否 |
| `transport_event` | `syntheticApiError` | 否 | 默认否，rule 控制 |
| `server_side_attribution` | billing header | 否 | unknown |
| `harness_injection` | system-reminder、local command caveat | 否 | 通常是 candidate |
| `user_context` | 用户输入、tool_result | 否 | 是 candidate |

## Reconciliation 的最小收紧

虽然主修正点在 reconstructor，但 reconciliation 也需要一个保护性改动：

```text
没有 rawHash / normalizedHash / toolUseId / message-block occurrence anchor 时，
category + role 不允许直接生成 reliable matched。
```

建议：

- 大字符差异或跨 order anchor 的匹配标记为 `suspect_match`。
- `suspect_match` 不应覆盖 expected/proxy 缺口。
- coverage 中区分：
  - exact matched
  - rule explained
  - attribution only
  - suspect
  - unexplained

## 最小落地顺序

1. **Parser 最小标记**
   - 给 `isApiErrorMessage` 增加事实标记。
   - 保留原文，不在 parser 丢弃。

2. **Reconstructor 主修**
   - 增加 `R8_filter_synthetic_api_error`。
   - expected segment 生成 hash。
   - 使用完整 JSONL 前缀重建 API message 序列。

3. **Reconciliation 防错**
   - 收紧 `category + role` heuristic。
   - 没有强锚点时只产出 suspect，不产出 matched。

4. **Token / coverage 口径调整**
   - 将 wire、API usage、model candidate、server-side control plane 拆开统计。
   - 将 `billing_noise` 迁移为 `server_side_attribution` 或同等语义。

## 非目标

本次不做以下事情：

- 不从 proxy diff 反写 `ContextMutation`。
- 不试图从单次 proxy 请求精确分摊每个 segment 的真实模型 token。
- 不把所有 Claude Code 内部注入一次性完整建模。
- 不把 fixture 截断问题伪装成 parser 兼容逻辑。

## 验收标准

修正后，`multi-turn-human` 至少应满足：

- 当前中文用户消息不再匹配历史 `are you there?`。
- 当前 assistant 文本不再匹配历史 `No response requested.`。
- `isApiErrorMessage` 不作为普通 assistant_text 进入 expected。
- 如果 fixture 缺失 prior history，报告应明确显示 expected 不完整，而不是用 heuristic 填平。
- billing attribution 不计入 unexplained，但也不被宣称为明确 model-visible token。
