# Context Ledger 架构修正报告

## 结论

当前 `server/src/context-ledger` 的方向基本正确：已经区分了 proxy fact、JSONL mutation、proxy attribution、reconciliation 和 char diff。但实现里存在一个最高优先级的架构矛盾：

**Expected/target request 现在会默认从 proxy attribution 反向生成 system/tools segment，这会把事实源 proxy 重新注入 expected，导致对账形成循环证明。**

这与目标模型“`JSONL mutation + rule` 正向构建 target request，再与 proxy dump 对比覆盖率”冲突。短期看它能抬高 coverage，长期会掩盖 rule 缺失、模板过宽、动态字段过度正则化和真实构建逻辑错误。

应修正为：

```text
proxy dump
  -> ProxyRawRequest / ProxyQuerySnapshot
  -> ProxyAttributionView（只帮助理解，不进入 target 构建）

JSONL / memory_fs / hook / harness_state / prior_session
  -> ContextMutation
  -> RuleEngine
  -> TargetRequest（完整 API request AST + source map + placeholders）

TargetRequest + ProxyRawRequest + ProxyAttributionView
  -> ReconcileReport（exact / template / regex / presence 分层覆盖率）
```

## 关键依据

- `server/src/context-ledger/expected-context-reconstructor.ts:83-106` 默认启用 `injectFromAttributions: true`，并在 `R9` 中用 `attributions` 和 `proxySegmentsById` 生成 expected segment。
- `server/src/context-ledger/audit/pipeline.ts:148-160` 和 `:244-255` 在重建 expected 时实际传入了 `attributions` 和 `proxySegmentsById`，所以这不是测试开关，而是默认主路径。
- `server/src/context-ledger/expected-context-reconstructor.ts:599-706` 的 `buildSegmentsFromAttributions()` 对 `normalized_text` / `shape` 会复制 proxy `rawText` / `rawHash` 来让 M1 精确匹配。这会把“从 proxy 看到的结果”伪装成“target 构建出来的结果”。
- `server/src/context-ledger/reconciliation-engine.ts:511-550` 的 `M3.5 ruleId match` 会把 R9 产生的 expected 与同 ruleId 的 proxy segment 对齐；对动态段只降为 heuristic/inferred，但 coverage 仍容易被抬高。
- `server/src/context-ledger/reconciliation-engine.ts:818-930` 以 `matchedProxyChars / proxyChars` 表示 `charCoverage`，且 matched 可包含 attribution-only、known_noise 等非 target 重建结果，语义和“target request 覆盖 proxy request”不一致。

## 主要矛盾

### 1. Proxy attribution 被用于 target 构建

设计预期：proxy attribution 是理解层，只解释“proxy 里的这段看起来是什么”。它不能提供 target request 的内容，否则对账失去审计价值。

当前状态：

- `ReconstructInput` 接收 `attributions` 与 `proxySegmentsById`。
- `R9_inject_from_attributions` 默认开启。
- 对 system/tools 规则，R9 会按 attribution 命中的 ruleId 反向生成 expected segment。
- 对 `shape` 动态段，R9 直接复制 proxy `rawHash`，使其可以 exact hash 命中。

风险：

- 规则越宽，coverage 越高，但这不是 reconstruction 能力提升。
- 如果某条 regex 错误命中，expected 会跟着生成同一段，reconcile 很难发现。
- “proxy-only gap” 被转换为“expected 已覆盖”，会弱化报告的告警价值。

修正：

- 默认禁用并逐步移除 `R9_inject_from_attributions` 作为 target 构建路径。
- attribution 只能进入 `ReconcileReport` 的解释列、候选 rule 建议、debug view。
- 若某段只能由 proxy attribution 识别，应标记为 `attribution_only` 或 `rule_gap`，不应成为 expected segment。

### 2. 当前没有真正的 Target Request

设计预期：target request 应该是一次 API 请求的完整候选结构，至少包含：

- `system[]`
- `tools[]`
- `messages[]`
- 请求级字段，如 `model`、`max_tokens`、`stream`、`context_management`、`output_config`
- 每个节点的 source map、ruleId、match policy、placeholder 信息

当前状态：

- `ExpectedQueryContext` 只有扁平 `segments`。
- `proxy-snapshot-parser.ts` 保存了 proxy request 的 `rawRequestHash`，但 expected 没有对应的 `targetRequestHash`。
- char diff 是按 segment 扁平拼接，不比较完整 JSON request 的结构、字段顺序、数组位置、对象内容。

风险：

- 无法满足“格式 + 文本 100% exact”的最佳覆盖形态。
- system/tools/messages 之间的结构错位可能被 segment 匹配掩盖。
- tool_use 的 JSON 序列化、tool schema 字段、cache_control、beta/context_management 等请求级差异没有完整对账口径。

修正：

- 新增 `TargetRequest` 中间产物，而不是只输出 `ExpectedQueryContext.segments`。
- `TargetRequest` 应保留 canonical JSON、原始 AST、segment source map。
- Reconcile 先做 request-level 比较，再下钻到 segment-level/char-level。

### 3. Proxy 原始 body 在 audit 入口被解析后覆盖，损害 request-level exact

设计预期：proxy dump 原始请求是事实源，exact 比较应以原始请求文本或可还原字节为准。

当前状态：

- proxy 写盘层声明 `reqBody` 绝不截断，UTF-8 原文或 base64 完整保存（`server/src/proxy/log/jsonl.ts:26-30`，`server/src/proxy/server/index.ts:576-588`）。
- 但 `server/src/context-ledger/audit/discovery.ts:119-172` 会把 traffic record 的 `reqBody` 字符串解析成对象，并用 `{ ...record, reqBody }` 覆盖原始字段。
- `server/src/context-ledger/proxy-snapshot-parser.ts:477-478` 的 `rawRequestHash` 是 `JSON.stringify(body)`，不是 proxy 落盘的原始请求字节 hash。

风险：

- JSON key 顺序、空白、转义、数字格式等 wire-level 细节会丢失。
- 后续即使 target 构建正确，也无法判断“格式 + 文本 exact”是否真的成立。

修正：

- discovery/pipeline 同时保留：
  - `rawReqBodyText` 或 `rawReqBodyBytesHash`
  - `parsedReqBody`
  - `canonicalReqBodyText`
- coverage 拆为 `wireExactCoverage` 与 `canonicalExactCoverage`，不要把 canonical match 等同 wire exact。

### 4. Rule schema 有方向，但缺少可执行模板与占位符计量

设计预期：动态字段通过 template/regex/placeholder 声明，reconcile 能标出哪些字段由占位符覆盖，以及占比。

当前状态：

- `ContextLedgerRule` 有 `matchMode`、`captureGroups`、`materialization`、`comparePolicy`。
- 但 `captureGroups` 基本是文档字段，运行时只把部分 group 写成 `notes: ["key=value"]`。
- `ReconciliationReport` / `CoverageSummary` 没有 `placeholderChars`、`literalChars`、`regexCapturedChars`、`presenceOnlyChars` 等指标。
- `comparePolicy` 没有成为 reconcile 的主调度策略，实际匹配主要靠 hash、tool_use_id、ruleId、category heuristic。

风险：

- regex 命中与 exact 命中在覆盖率里容易混在一起。
- 无法识别“正则占位符过宽导致 coverage 虚高”。
- 规则维护者看不到每条 rule 的动态比例，难以治理规则质量。

修正：

Rule 应输出结构化 `RuleMatchEvidence`：

```ts
{
  ruleId: string;
  mode: "exact" | "template" | "regex" | "presence";
  literalChars: number;
  placeholderChars: number;
  placeholderRatio: number;
  captures: Array<{
    name: string;
    valuePreview: string;
    charStart: number;
    charEnd: number;
    source: "env" | "memory" | "runtime" | "unknown";
  }>;
}
```

Coverage 至少拆为：

- `wireExactCoverage`
- `canonicalExactCoverage`
- `templateCoverage`
- `regexCoverage`
- `presenceOnlyCoverage`
- `attributionOnlyCoverage`
- `unexplainedCoverage`
- `placeholderRatio`
- `regexOverreachRisk`

### 5. Regex / template 命中被过度升级为 exact confidence

当前 `proxy-attribution.ts` 中，regex 只要命名捕获组都非空，就可能把 confidence 升为 `exact`。

这会混淆两件事：

- “规则识别类别很确定”
- “target request 字符级复现很确定”

建议拆开：

- `classificationConfidence`：这段是什么。
- `materializationConfidence`：target 是否能复现这段内容。
- `comparisonGrade`：exact / normalized / template / regex / presence。

Regex 可以有 exact classification，但不应自动获得 exact reconstruction coverage。

### 6. `known_noise` / `billing_noise` 口径仍然会污染覆盖率

当前 `billing_noise` 被作为 known_noise 处理，并在 coverage 里计入 matched/evidence-backed。

更准确的语义：

- 它是 proxy wire payload 的一部分。
- 它可能是服务端控制/归因字段。
- 它不一定是 model-visible 文本。
- 它也不是 target reconstruction exact 覆盖。

建议改名和拆口径：

- `server_side_attribution`
- `wirePayloadChars`
- `modelContextCandidateChars`
- `serverSideControlChars`
- `apiMeasuredInputTokens`

`known_noise` 只能表示“不算 unexplained”，不能表示“target 已 exact 覆盖”或“不计 token”。

### 7. 部分 hardcoded heuristic 仍散落在 attribution/reconcile 代码中

可接受留在代码里的逻辑：

- Anthropic Messages wire schema 解析。
- JSON path walking。
- hash/canonicalization。
- segment source map。

应迁入 rule 的逻辑：

- billing fallback prefix。
- `<system-reminder>` / local command tag。
- tool_result tail injection。
- prior_session guess。
- large segment detector 阈值。

特别是 `prior_session_guess: messages[0] user_message in a N-message context` 太宽，容易把正常第一条 user message 归为 prior session。它应依赖 JSONL parent chain、query boundary、resume/continue 证据，而不是单纯位置。

### 8. JSON path 粒度 fallback 过宽

`reconciliation-engine.ts` 的 attribution 映射使用双向前缀匹配处理 jsonPath 粒度不一致。代码注释已经指出它可能把无关 segment 标记为已覆盖。

这在 coverage 场景下风险很高：

- 粗粒度 attribution 可能覆盖多个 parser segment。
- `matchedProxyIds` 可能被污染。
- attribution-only 与 evidence-backed 的边界会变模糊。

修正：

- 引入 `SourceSpan`，包含 `jsonPath + charRange + blockIndex + occurrenceIndex`。
- 粗粒度 attribution 只能作为 parent evidence，不能直接覆盖 child segment。
- child 覆盖必须有明确 overlap 规则，例如 `containsSpan >= 95%` 或 exact child path。

## 修正后的目标架构

### 方案 A：严格正向重建（推荐）

```text
JSONL Parser
  -> ContextMutation[]

Rule Engine
  -> TargetRequest AST
  -> TargetRequestSegment[]
  -> TargetRequestSourceMap

Proxy Parser
  -> ProxyRawRequest
  -> ProxyRequest AST
  -> ProxyRequestSegment[]

Attribution
  -> ProxyAttributionView（只解释 proxy，不参与 target 生成）

Reconcile
  -> Request-level exact/canonical diff
  -> Segment-level exact/template/regex/presence diff
  -> Placeholder ratio and rule risk
```

优点：

- 审计语义最干净。
- coverage 能真实代表 reconstruction 能力。
- 容易发现 rule 缺失与过宽正则。

缺点：

- 短期 coverage 会下降。
- 需要把 harness_state、memory、tool registry、system prompt rules 物化为 target 构建输入。

适用条件：

- 当前目标是做长期可信审计与回归防线。
- 接受先降低表面覆盖率，换取指标可信度。

### 方案 B：双轨报告，保留 R9 但降级为 attribution-only

保留现有 R9 的调试价值，但明确它不属于 target reconstruction：

- `targetExpected`：只来自 mutation + executable rule。
- `explainedByProxyAttribution`：来自 proxy attribution。
- `coverage` 默认只看 `targetExpected`。
- R9 产物只显示在 debug view，不参与 target coverage。

优点：

- 改动比方案 A 小。
- 保留已有 attribution 调试视图。
- 能逐步迁移 system/tools rules。

缺点：

- 代码里仍有两个“expected-like”概念，团队容易误用。
- 如果报告 UI 不够清楚，仍会误读 coverage。

适用条件：

- 需要保留当前 audit 输出连续性。
- 短期无法一次性重写 target request 构建。

### 方案 C：继续当前 R9 路线

不推荐。

优点：

- 表面 coverage 高。
- system/tools 很快“对齐”。

缺点：

- 循环证明。
- 无法证明 mutation + rule 真的能构建 target request。
- regex 过宽、rule 错配、动态字段失控都可能被掩盖。

适用条件：

- 只做 demo 或人工理解，不做工程审计。当前项目目标不符合这个条件。

## 推荐落地路径

### 第一阶段：收口指标语义

1. 将当前 `charCoverage` 标记为 `explainedCoverage` 或废弃展示。
2. 新增并优先展示：
   - `targetExactCoverage`
   - `targetTemplateCoverage`
   - `targetRegexCoverage`
   - `presenceOnlyCoverage`
   - `attributionOnlyCoverage`
   - `unexplainedCoverage`
   - `placeholderRatio`
3. `billing_noise` 从 evidence-backed 中移出，归入 `server_side_attribution / presenceOnly`。

### 第二阶段：切断循环构建

1. 默认关闭 `injectFromAttributions`。
2. `ReconstructInput` 不再接受 `attributions` / `proxySegmentsById` 作为 target 构建输入。
3. 保留一个独立 debug 函数，例如 `buildAttributionExplanationOverlay()`，服务三列视图，但不进入 expected。

### 第三阶段：引入 TargetRequest AST

1. 定义 `TargetRequest`：
   - `request`
   - `segments`
   - `sourceMap`
   - `rulesApplied`
   - `unmaterializedRules`
2. 同时输出：
   - `targetCanonicalJson`
   - `targetCanonicalHash`
   - `proxyRawBodyHash`
   - `proxyCanonicalHash`
3. request-level reconcile 先判断：
   - raw exact
   - canonical exact
   - structural exact
   - segment partial

### 第四阶段：把 rule 变成可执行模板

每条 rule 拆成三层：

- `identify`：proxy attribution 如何识别。
- `materialize`：target 如何从 mutation/harness state 构建。
- `compare`：reconcile 如何评估。

模板不要只用 `contentPattern: string | null`，应支持：

- literal spans
- placeholder spans
- source resolver
- regex validator
- privacy policy
- max placeholder ratio
- version verification

### 第五阶段：治理 hardcoded heuristic

迁移顺序：

1. `<system-reminder>` 与 local command tag 迁入 message-level rule。
2. billing fallback 迁入 rule 的 fallback pattern。
3. tool_result tail injection 迁入 rule-driven child span。
4. prior_session_guess 改为 JSONL parent chain + query boundary 证据。
5. jsonPath 前缀 fallback 改为 span overlap。

## 验收标准

修正后，一条 audit report 应能回答：

- proxy raw request 是否完整保留，raw hash 是什么。
- target request 是否由 mutation + rule 正向生成，没有 proxy 反向注入。
- request-level 是否 raw exact / canonical exact / structural exact。
- segment-level 每段属于 exact、template、regex、presence、attribution-only、unexplained 中哪一类。
- template/regex 命中的 captures 是哪些字段，字符范围和占比是多少。
- regex/template 占比是否超过阈值，是否存在过度泛化风险。
- `billing`、system reminder、memory、env、tool schema 等动态字段是否被归为正确口径。
- coverage 下降时能区分是真实 regression、rule 未物化、proxy-only attribution，还是 fixture/jsonl prefix 不完整。

## 缺失信息 / 关键假设

- 假设 proxy `traffic.jsonl` 的 `reqBody` 是完整事实源。当前 proxy 写盘层注释与实现均声明不截断，但 audit 入口需要保留原始 body 字符串，不能只保留 parse 后对象。
- 假设 Claude Code 版本仍采用当前 Messages API request 结构。若上游 schema 改变，应新增版本化 parser/rule，不在同一 rule 内兼容多大版本。
- 目前没有看到完整 harness runtime state 输入，例如 enabled tools、settings、memory path、output style、language、context management 等。没有这些输入，system/tools 的正向 target 只能停留在 template/presence，不能声明 exact。
- 现有 rule 大量 `verifiedFor: null`，说明它们不能作为稳定 exact coverage 的强证据，应在报告中降权或单独列出 pending rule coverage。
