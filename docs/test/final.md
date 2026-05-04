# Context Ledger 最终工作方案

## 结论

最终路线采用 **“先双轨止血，再严格正向重建”**：

1. **立即切断 R9 对 coverage 的污染**：proxy attribution 只能用于解释与调试，不再作为 target/expected 的构建输入，也不能把 proxy `rawText/rawHash` 拷回 expected。
2. **把覆盖率改成分层指标**：exact、template/placeholder、regex、presence、attribution-only、unknown 必须分开统计，不能再用一个 `charCoverage` 混合表达。
3. **引入 `TargetRequest` 作为核心中间产物**：最终目标不是重建一组扁平 segment，而是由 `mutation + rule + harness state` 正向构建一次完整 API request，再与 proxy raw request 对账。
4. **rule registry 从“识别表”升级为“可执行规则系统”**：每条 rule 拆成 identify / materialize / compare 三部分，并输出 placeholder 结构化证据。

不推荐继续当前 R9 路线。它能提高表面覆盖率，但本质是循环证明，会让 audit 失去工程价值。

## 方案对比

| 方案 | 内容 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 严格正向重建 | 只允许 JSONL/memory/harness state + rule 构建 target request，proxy 只用于对账 | 审计语义最干净，coverage 可信 | 初期覆盖率会下降，system/tools 需要补物化能力 | 最终目标 |
| B. 双轨止血 | 保留 proxy attribution 解释视图，但不计入 target coverage | 改动较小，能保持现有调试能力 | 仍有两个相似概念，UI/报告必须清楚 | 第一阶段采用 |
| C. 继续 R9 | attribution 反向生成 expected，提升匹配率 | 短期数字好看 | 循环证明，掩盖 rule 缺失和 regex 过宽 | 放弃 |

推荐路径不是 A 或 B 二选一，而是：**P0/P1 用 B 止血，P2 之后演进到 A**。

## 目标数据流

```text
proxy traffic.jsonl
  -> ProxyRawRequest（原始 reqBody text/bytes hash）
  -> ProxyRequest AST
  -> ProxySegment[]
  -> ProxyAttributionView（解释层，只读 proxy）

Claude JSONL / memory_fs / hook / harness_state / prior_session
  -> ContextMutation[]
  -> RuleEngine
  -> TargetRequest AST
  -> TargetSegment[] + SourceMap + PlaceholderEvidence

TargetRequest + ProxyRawRequest + ProxyAttributionView
  -> ReconciliationReport
  -> CharDiff / Scorecard / Audit UI
```

硬约束：

- `Expected/Target` 不得读取 proxy `rawText`、`rawHash`、`charCount` 来生成自身内容。
- proxy attribution 不得生成 `ContextMutation`，也不得生成 target segment。
- shape/presence 类规则只能证明“存在/结构符合”，不能进入 exact/evidence-backed 覆盖率。

## 核心模型调整

### 1. 新增 TargetRequest

`ExpectedQueryContext` 可以保留为兼容层，但新主模型应是：

```ts
interface TargetRequest {
  id: string;
  queryId: string;
  request: {
    model?: string;
    stream?: boolean;
    max_tokens?: number;
    context_management?: unknown;
    output_config?: unknown;
    system?: unknown[];
    tools?: unknown[];
    messages?: unknown[];
  };
  canonicalJson: string;
  canonicalHash: string;
  segments: TargetSegment[];
  sourceMap: TargetSourceSpan[];
  rulesApplied: AppliedRule[];
  unmaterializedRules: UnmaterializedRule[];
}
```

Proxy 侧同时保留：

- `rawReqBodyText` 或 `rawReqBodyBytesHash`
- `parsedReqBody`
- `canonicalReqBodyText`
- `canonicalReqBodyHash`

这样 request-level 可以判断：

- raw exact
- canonical exact
- structural exact
- segment partial

### 2. 覆盖率重新定义

废弃或降级当前 `charCoverage` 展示。新的主指标：

| 指标 | 含义 | 是否正向 target 覆盖 |
|---|---|---|
| `wireExactCoverage` | proxy 原始文本/字节与 target raw 完全一致的比例 | 是 |
| `canonicalExactCoverage` | canonical JSON 一致的比例 | 是 |
| `exactCoverage` | rule/mutation 生成文本与 proxy 字符级一致 | 是 |
| `templateCoverage` | template + placeholder resolve 后一致 | 是 |
| `regexCoverage` | regex 识别，不能完整物化 | 部分，不算 exact |
| `presenceCoverage` | 只能确认存在/结构 | 否，只是解释 |
| `attributionOnlyCoverage` | proxy attribution 知道是什么，但 target 未生成 | 否 |
| `unknownCoverage` | 无 attribution、无 target 对应 | 否 |
| `placeholderRatio` | placeholder chars / matched chars | 风险指标 |
| `pendingRuleCoverage` | verifiedFor=null 的 rule 贡献比例 | 风险指标 |

阈值建议：

- `placeholderRatio > 60%`：标记 `regex_too_loose`。
- `pendingRuleCoverage > 30%`：整条 query `needs_review`。
- `presenceCoverage` 上升不能算 improvement，只能说明解释能力增加。

### 3. Rule 升级为三段式

每条 rule 分为：

```ts
interface ContextLedgerRuleV2 {
  id: string;
  priority: number;
  verifiedFor: string | null;
  scope: QueryScope;

  identify: {
    source: "proxy";
    matchMode: "exact" | "prefix" | "regex" | "structural";
    pattern?: string;
    captures?: CaptureSpec[];
    notesTemplate?: NoteTemplate[];
  };

  materialize: {
    source: "jsonl" | "memory_fs" | "harness_state" | "static_rule" | "unavailable";
    mode: "exact_text" | "template" | "regex_validated" | "shape" | "presence";
    template?: TemplateSpec;
    preconditions?: StructuredPrecondition[];
  };

  compare: {
    policy: "raw_hash" | "canonical_hash" | "template" | "regex" | "presence" | "known_nonsemantic";
    contributesTo: "exact" | "template" | "regex" | "presence" | "attribution_only" | "none";
  };
}
```

关键点：

- `preCondition` 不能继续只是自然语言。要么结构化，要么明确仅人读且不参与运行时。
- `notes` 不能靠 `ruleId if/else` 硬编码，应由 rule 的 `notesTemplate` 渲染。
- regex 命中可以有高分类置信度，但不能自动获得 exact reconstruction coverage。

## 分阶段工作计划

### P0：止血，恢复 audit 可信度

目标：不让 proxy 反向污染 expected，不再让 coverage 虚高。

任务：

1. 默认关闭 `injectFromAttributions`，并把 R9 从 target coverage 中移除。
2. 保留 attribution 三列视图，但标记为 `ProxyAttributionView`，只用于解释。
3. 禁止 R9/target 构建读取 proxy `rawText/rawHash`，加 invariant 测试。
4. `charCoverage` 改名或废弃，新增 `exactCoverage/templateCoverage/presenceCoverage/attributionOnlyCoverage/unknownCoverage`。
5. `billing_noise` 改为 `server_side_attribution` 或等价语义，不计入 evidence-backed。
6. `verifiedFor=null` 的 rule 默认降级，不计入 exact/evidence-backed。

验收：

- 关闭 R9 后 coverage 下降是预期结果，报告必须明确说明降在哪里。
- shape/presence rule 不再产生 raw_hash exact match。
- attribution-only 不再被展示成 target 已覆盖。

### P1：保留 proxy 原始事实，建立 request-level 对账

目标：让 proxy dump 真正成为 wire-level fact。

任务：

1. discovery/pipeline 保留原始 `reqBody` 字符串或 bytes hash，不再只保留 parse 后对象。
2. Proxy parser 输出 `rawReqBodyHash`、`canonicalReqBodyHash`、`parsedReqBody`。
3. Target 侧输出 `canonicalJson/canonicalHash`。
4. Reconcile 先比较 request-level，再进入 segment-level。
5. 明确 raw exact 与 canonical exact 的差异，避免把 JSON.stringify 结果当 wire exact。

验收：

- report 能展示 proxy raw hash、target canonical hash。
- JSON key 顺序/空白差异不会被误报为内容缺失，但也不会被误称为 wire exact。

### P2：引入 TargetRequest AST

目标：把“扁平 expected segments”升级为“完整 request 重建”。

任务：

1. 定义 `TargetRequest`、`TargetSegment`、`TargetSourceSpan`。
2. JSONL mutation 先编译成 API message AST，再拆 segment。
3. system/tools/messages/request fields 都进入 TargetRequest。
4. source map 精确到 `jsonPath + charRange + blockIndex + occurrenceIndex`。
5. `ExpectedQueryContext` 作为兼容输出从 TargetRequest 派生，不再作为主模型。

验收：

- 可以回答“target request 里 system[2] 的这 300 字来自哪条 rule/哪个文件/哪个 mutation”。
- char diff 与 request diff 使用同一套 source span。

### P3：placeholder 与 regex 治理

目标：回答“哪些字段靠正则/占位符命中，占比多高，是否过度泛化”。

任务：

1. attribution 输出 `RuleMatchEvidence`，包含 captures 的 char range。
2. template materialization 输出 placeholder spans。
3. coverage 统计 `literalChars/placeholderChars/placeholderRatio`。
4. char-diff UI 对 literal、placeholder、presence、unknown 使用不同视觉层级。
5. 超阈值生成 `regex_too_loose` finding。

验收：

- Environment、billing、auto memory、Bash/Agent tool description 能分别显示动态字段占比。
- regex 命中但 placeholderRatio 过高时，query verdict 进入 `needs_review`。

### P4：把硬编码迁回 rule

目标：让规则沉淀在 rule registry，而不是散落在 attribution/reconcile 代码里。

任务：

1. system-reminder、local-command、billing fallback、task_reminder smoosh、large segment detector 都建 rule。
2. 删除 `proxy-attribution.ts` 中按 ruleId 特判 notes/confidence 的分支。
3. `billing` regex 不命中时不再 prefix fallback 吞掉问题，而是输出 unknown/rule_gap。
4. prior_session 不再靠 `messages[0] + totalMessages > 1` 猜测，改为 JSONL parent chain + resume/continue 证据。
5. `jsonPath` 双向前缀 fallback 改为 span overlap 规则。
6. RULE_TABLE 增加显式 `priority`，不依赖数组顺序。

验收：

- 新增 dynamic rule 不需要修改 attribution 主流程。
- 粗粒度 attribution 不会覆盖无关 child segment。
- prior session 与 prefixIncomplete 信号一致，不再各自独立猜测。

### P5：修正 expected/reconcile 语义债

目标：减少 reconcile 层的特例消化，让 target 真正重建请求。

任务：

1. task_reminder smoosh 改“加法”：expected tool_result 直接拼接注入文本，而不是 reconcile 从 proxyChars 里减。
2. 实现 R-MERGE-N1，或在实现前关闭相关 merge rule，避免半成品热路径。
3. 统一 `parser.category` 与 `attribution.category` 权威关系：reconcile 只使用 effective category，parser category 仅作 fallback 输入。
4. `comparePolicy` 真正被 reconciliation engine 消费，不再只靠 M1-M4 隐式决定。
5. `MatchKind / Confidence / DiffKind` 做一次语义收敛，至少文档化映射关系。

验收：

- smoosh 不再依赖 `notes: "tail_injection_chars:N"` 字符串协议。
- 同名指标只由一处计算，char-diff 和 scorecard 不再各算一遍 evidence coverage。

### P6：fixture、版本与文档治理

目标：让 rule 质量可持续。

任务：

1. 录制 external CLI fixture，替换或补充 ant-native/旧版 fixture。
2. `verifiedFor=null` 的 rule 在主报告中单独列 pending contribution。
3. 升级 `SUPPORTED_CLAUDE_CODE_VERSION` 时强制 pending reset 和复审清单。
4. 清理 README 过时的 Required Now。
5. 清理 `SegmentLink` 幽灵别名。
6. rule-registry 注释统一为中文，清理韩文注释。
7. exact_text rule 增加测试：`reconstruction.contentPattern` 必须能被 `identify.pattern` 命中。

验收：

- 主报告能区分 verified rule coverage 与 pending rule coverage。
- fixture 能代表当前真实 external 用户请求，而不是旧内部构建。

## 推荐实施顺序

最小可交付切片：

1. **第 1 个 PR：指标止血**
   - 关闭 R9 对 target coverage 的贡献。
   - 新增分层 coverage 字段。
   - billing/known_noise 移出 evidence-backed。

2. **第 2 个 PR：proxy raw fact 保留**
   - discovery 保留 raw reqBody。
   - proxy snapshot 增加 raw/canonical hash。
   - report 展示 request-level 对账结果。

3. **第 3 个 PR：TargetRequest AST MVP**
   - 先覆盖 messages。
   - system/tools 暂时允许 `unmaterializedRules`，不强行伪造 expected。

4. **第 4 个 PR：placeholder evidence**
   - rule capture range。
   - placeholderRatio。
   - regex_too_loose finding。

5. **第 5 个 PR：rule-driven 清理**
   - system-reminder/local-command/billing/task_reminder rule 化。
   - 删除主要硬编码分支。

6. **第 6 个 PR：fixtures 与 verifiedFor**
   - external fixture。
   - pending rule 降权。
   - 文档清理。

## 非目标

- 不追求所有动态字段 100% 字符级还原。
- 不把 proxy-only 内容反写成 mutation 或 target。
- 不把 regex/presence 命中包装成 exact coverage。
- 不用更多 hardcoded 特例换短期 coverage。
- 不在同一 parser/rule 中兼容 Claude Code 跨大版本 schema。

## 最终验收标准

一条 audit report 至少应能明确回答：

- proxy raw request 是否完整保留，raw hash 与 canonical hash 分别是什么。
- target request 是否完全由 mutation + rule + harness state 正向构建。
- request-level 是否 raw exact / canonical exact / structural exact。
- 每个 segment 是 exact、template、regex、presence、attribution-only 还是 unknown。
- regex/template 命中的 capture 字段、char range、placeholder ratio 是多少。
- pending/unverified rule 贡献了多少 coverage。
- coverage 下降是 regression、rule 未物化、prefix 不完整，还是 attribution-only gap。
- 是否存在 regex 过宽、jsonPath 粒度过宽、prior_session 猜测不充分等风险 finding。

这套方案的核心判断是：**宁可短期覆盖率下降，也要让每一个 coverage 数字都可解释、可复验、不会被 proxy 自身污染。**
