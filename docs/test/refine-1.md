# Context Ledger 架构修正报告

> 生成日期：2026-05-02  
> 范围：`server/src/context-ledger/` 全模块  
> 性质：设计矛盾与隐含问题分析，不修改代码

---

## 一、核心设计矛盾

### 1.1 R9 打破了"proxy 不反写 mutation"的根本原则

**位置**：`expected-context-reconstructor.ts`（R9_inject_from_attribution）、`README.md § Forbidden Data Flow`

**问题**：

README 明确禁止：
```
proxy diff -> ContextMutation  ← 非法
```

但 R9 实质上做了这件事的变体：
```
proxy attribution → expected segments（反向注入）
```

R9 调用 `buildSegmentsFromAttributions(input.attributions, input.proxySegmentsById)`，从 attribution 结果反向生成 `system` / `tools` expected segments，并直接使用 proxy 的 rawHash（`proxySegmentsById` 里读 rawText 再 hash）作为 expected segment 的 rawHash。

这意味着：
- expected context 里的内容锚点（rawHash）实际上来自 proxy，不来自 JSONL 或 harness rule
- 如果 proxy 内容有误，expected 也会被污染，审计失去意义
- 这与 README 第 44 行"Do not write proxy diffs back into ContextMutation"的精神矛盾

**严重度**：高。这不是实现层面的临时 hack，而是将一个"禁止数据流"以另一种名义合法化了。

**预期方向**：R9 的正确形式应该是：若 rule.reconstruction.materialization == "exact_text"，则用 contentPattern 计算 rawHash，完全不引用 proxy；若是 "shape/presence"，则 expected segment 不持有 rawHash，reconciliation 只做 presence_only 对比。

---

### 1.2 覆盖率的"分母"与"分子"语义不一致

**位置**：`reconciliation-engine.ts:computeCoverage`、`types.ts:CoverageSummary`

**问题**：

当前有三个相互叠加但互不正交的覆盖率指标：

| 指标 | 计入分子的内容 |
|------|----------------|
| `charCoverage` | evidenceBackedChars + attributionOnlyChars（两者合并为 matchedProxyChars）|
| `evidenceBackedCoverage` | 只有 matched / approximate_match 的 proxy chars |
| `attributionCoverage` | 有归因且 category != "unknown" 的 proxy chars |

**矛盾点**：

1. `charCoverage` 的分子把 `attributionOnly`（"有 attribution 但没有 expected 对应"）也算进了"已匹配"——而这些 segment 本质上是 **未实现规则造成的空洞**（U1-U5），不是真正的匹配。命名"charCoverage"给人"已重建覆盖"的印象，但实际上把"归因但未重建"也计入了。

2. `attributionOnlyGap = attributionCoverage - evidenceBackedCoverage` 是负向指标（gap 越大越糟），但被定义为 `CoverageSummary` 的一个常规字段，没有任何方向性说明，容易被消费方误读为正向覆盖。

3. `attributionOnlyChars` 在 `computeCoverage` 末尾有一行 `void attributionOnlyChars`（suppressing unused warning），说明这个中间变量已被废弃，但代码里仍然累加它，形成死代码但有副作用（如果哪天 void 被删就会产生误用）。

**预期方向**：
- 建议把 "charCoverage" 重命名为 "attributedCoverage"，语义上表示"proxy 有解释（无论是 expected 匹配还是 attribution-only）"
- 新增一个明确叫 "reconstructedCoverage" 的指标 = evidenceBackedCoverage，代表"有 expected 对应"
- 清理死代码 `attributionOnlyChars` 的累加逻辑

---

### 1.3 Rule 的三个视角（attribution / reconstruction / reconciliation）在 R9 路径下产生分裂

**位置**：`rule-registry.ts:ContextLedgerRule`、`reconciliation-engine.ts:matchOneExpected（M3.5）`

**问题**：

rule 的 `reconciliation.comparePolicy` 字段设计了 `raw_hash`、`char_diff`、`structural` 等策略，但 reconciliation engine 实际并不直接读取 `rule.reconciliation.comparePolicy` 来决定比较方式——它只通过 M1-M4 的优先级顺序来匹配，比较策略由匹配成功的"锚点类型"（rawHash / toolUseId / category）隐式决定。

M3.5（ruleId match）引入后，reconciliation 从 rule 读 `materialization` 来决定 `matchKind`（exact vs heuristic），但没有读 `reconciliation.comparePolicy`。换言之：

- rule 里声明了 `comparePolicy: "raw_hash"`（例如 identity rule）
- 但实际对比是通过 M3.5 ruleId match + materialization 推导的 matchKind 来做的
- `reconciliation.comparePolicy` 这个字段在运行时路径里从未被消费

**严重度**：中。字段设计存在，但代码不使用，文档和实现脱节，维护者会被误导。

---

## 二、设计隐含问题

### 2.1 Attribution 结果同时扮演两个角色

**位置**：`proxy-attribution.ts`、`expected-context-reconstructor.ts（R9）`、`reconciliation-engine.ts（buildAttrBySegId）`

**问题**：

`ProxySegmentAttribution` 被设计为"proxy-first 反向归因"（README § Attribution Layer），但在当前实现中它实际上有两个完全不同的用途：

1. **辅助 reconciliation**：`attrBySegId` 作为 proxy segment → category 的权威来源，覆盖 parser 的保守分类（reconciliation-engine.ts:94）

2. **驱动 R9 正向重建**：`buildSegmentsFromAttributions` 把 attribution 翻转为 expected segments，attribution 成为重建的输入源

这两个用途在 README 的分层设计里是冲突的：attribution 被明确定义为"不能产生 ContextMutation"，但 R9 实质上把它作为 expected segment 的生成源（绕过了 ContextMutation 这一中间层）。

**隐患**：
- 如果 attribution 有误识别（confidence="inferred"），R9 会把错误的 expected segment 注入，reconciliation 里会产生错误的 matched finding
- attribution 的归因错误会通过两条路（1 和 2）同时污染报告，比仅影响 reconciliation 的风险高一倍

---

### 2.2 `prior_session_guess` 是一个位置性猜测，不是内容归因

**位置**：`proxy-attribution.ts:395-402`

```typescript
} else if (seg.category === "user_message" && msgIndex === 0 && totalMessages > 1) {
  category = "prior_session_history";
  mechanism = "unknown";
  confidence = "inferred";
  ...
}
```

**问题**：

这条归因逻辑仅基于"messages[0] 是 user_message 且消息总数 > 1"就推断整个第一条消息是 prior_session_history。但 messages[0] 在很多正常场景下也是用户的第一条真实输入——比如刚开启会话时的首条消息。

当前的隐含假设是：`totalMessages > 1` 就代表存在历史 turn，但这等于把"有多条消息"等同于"有 prior session"，逻辑上不成立。

**已知影响**：
- `reconciliation-engine.ts:278` 里依赖 `expected?.metadata?.prefixIncomplete` 来降级 order_mismatch 的 severity，但 `prefixIncomplete` 是由 `hasPreSessionActivity` 决定的（来自 JSONL parser），而不是由 attribution 的 `prior_session_guess` 决定
- 两个"prior session"信号（JSONL 里的 `hasPreSessionActivity` 和 attribution 的位置猜测）各自独立运转，没有相互校验，可能产生矛盾

---

### 2.3 `HarnessRuleConfig` 开关实际上不生效

**位置**：`expected-context-reconstructor.ts:48-55`（TODO 注释）

```typescript
// TODO(rule-toggle-not-effective): HarnessRuleConfig 的
//   appendBaseMessages / injectSkillListing / injectLocalCommand 三个开关目前只
//   影响 sourceRefs / rulesApplied 的 ruleId 标签，没有真正 gate segment 生成。
```

**问题**：

这不仅是一个 TODO，它意味着 `HarnessRuleConfig` 作为 public API 对外提供了虚假的控制语义。调用方传入 `injectSkillListing: false` 期望关掉 skill_listing segment 的生成，但实际上该 segment 仍然会出现在 expected context 里。

**影响**：
- scorecard 对比时无法通过关掉某条 rule 来做"单变量实验"（控制变量法分析覆盖率变化）
- 若 pipeline 调用者依赖这个开关做条件化重建，会得到错误的 expected context

---

### 2.4 `MatchKind` 与 `Confidence` 的冗余和混用

**位置**：`types.ts`、`reconciliation-engine.ts`

**问题**：

`MatchKind = "exact" | "normalized" | "heuristic" | "inferred" | "unmatched"` 和 `Confidence = "exact" | "estimated" | "inferred" | "unknown"` 在语义上有大量重叠：

- M1（rawHash）→ matchKind="exact"，confidence="exact"：两者都传递"精确"，一个字段就够
- M2（normalizedHash）→ matchKind="normalized"，confidence="estimated"：略有区分（"normalized"是匹配方式，"estimated"是置信度）
- M4（heuristic）→ matchKind="heuristic"，confidence="inferred"：两者都表达"弱证据"
- M3.5（ruleId）→ matchKind 由 materialization 决定，confidence 同样由 materialization 决定：两个字段冗余

在 `computeCharDiff` 里，`DiffKind` 又引入了第三套分类（matched_exact / matched_char_diff / suspect_match），和上面两者有部分语义重叠但不完全对应。

**结果**：三套语义相近的枚举在代码中并行存在，维护者需要同时理解三者的含义及映射关系。

---

### 2.5 R-MERGE-N1 是占位符但被调用

**位置**：`reconciliation-engine.ts:617-633`

```typescript
function tryMergeAlignment(...): MergeResult | null {
  if (group.length < 2) return null;
  // R-MERGE-N1 检测占位：... 当前 4 个 fixture 无此场景，返回 null。
  return null;
}
```

**问题**：

`tryMergeAlignment` 在主流程的每个 group 上都被调用（`for (const group of groupedExpected) { const mergeResult = tryMergeAlignment(...)`），但函数始终返回 null，这意味着每次 reconciliation 都有一层无效的函数调用开销，且 `logicalMessageId` 分组逻辑（`groupByLogicalMessage`）所有的计算成本也是白费——因为 merge 永远不会命中。

这本身不算严重问题，但占位符函数进入了主流程热路径，混淆了代码阅读者对"merge 是否已实现"的判断。

---

### 2.6 `smoosh` 模型的单向性：attribution 有注入信息，expected 侧没有建模

**位置**：`proxy-attribution.ts:366-378`、`expected-context-reconstructor.ts:341-347`（TODO）

**问题**：

当前对 task_reminder smoosh 的处理是：
- attribution 侧：在 tool_result attribution 的 notes 里写 `tail_injection_chars:<N>`
- reconciliation 侧：从 notes 里解析 N，从 charDiff 里扣掉
- expected 侧：`task_reminder` mutation 被 R6 过滤，不生成任何 segment

这种处理方式把"smoosh 进了 tool_result"这个知识只存在于 attribution notes 字符串里（`"tail_injection_chars:123"`），而不是结构化类型。reconciliation engine 通过正则 `/^tail_injection_chars:(\d+)$/` 解析这个字符串，形成了一个隐式的字符串协议。

**风险**：
- `tail_injection_chars` 格式改变（比如变成 `smoosh_chars`）会静默失效，不会有类型错误
- expected 侧的 `TODO(task-reminder-expected)` 指出了正确方向（把注入文本附加到对应 tool_result 的 charCount），但当前的"用 notes 传递数字"方案未来与 expected 侧建模方案是互斥的，需要一次性切换，不能渐进过渡

---

## 三、结构性设计缺口

### 3.1 proxy 是 ground truth，但没有"proxy only"的完整对账路径

**位置**：`audit/pipeline.ts`

**问题**：

pipeline 设计假设每个 proxy query 都能找到对应的 JSONL（`jsonlFile: string | null`），当 `jsonlFile === null` 时直接标记为 `proxy_without_jsonl` 并 skip。

但按照设计目标"proxy 是 ground truth"，即使没有 JSONL，也应该能运行 attribution-only 报告：
- proxy → snapshot → attribution → 仅包含 attribution findings 的 reconciliation（没有 expected 端）

当前这条路径虽然在 `reconcileClaudeContext` 里技术上支持（`expected` 是可选参数），但 pipeline 在没有 JSONL 时直接 skip 了，不产生任何 attribution report。这意味着：
- 无法用 attribution-only 模式独立验证 attribution 逻辑的正确性
- 无法审计"哪些 proxy query 没有 JSONL 对应"的分布

---

### 3.2 覆盖率的正则/占位符匹配维度完全缺失

**问题**：

用户设计目标第 3-4 条提到：

> 次一级的，是正则或者是 template 匹配，这里，你需要识别出来，哪些是正则的命中的占位符的字段？这个比例也很关键，不可能太高否则明显可能是正则的规则过度了。

但当前的 `CoverageSummary` 里完全没有：
- "通过正则/模板匹配（而非精确 hash）命中的 proxy chars 比例"的独立统计
- "正则捕获组命中率"指标（衡量 regex rule 过度泛化的风险）
- 与"正则命中但 expected 无法精确重建"（materialization=shape/presence）的字段区分

当前的 `evidenceBackedCoverage` 把 raw_hash、normalizedHash、toolUseId 混合计算，没有区分"精确文本匹配"和"规则匹配（pattern）"两个质量层次。

**实际影响**：无法量化"我们的 rule 是否过度泛化"。

---

### 3.3 reconciliation engine 缺少对"单条 rule 在同一 request 出现多次"的处理

**位置**：`reconciliation-engine.ts:517-549`（M3.5 ruleId match）

```typescript
// 多个候选时取 charCount 最接近 expected 的（同一 rule 在同一 request 里只出现一次，一般只有一个候选）
```

**问题**：

注释说"一般只有一个候选"，但并没有对"多个候选"情况产生 finding 或 warning。如果同一 rule 对应了 proxy 里的多个 segment（比如 tools_schema 里同一名称的工具出现了两次，这在 proxy dump 里理论上可能出现），reconciliation 会静默选择第一个（charCount 最近的），不产生任何诊断信息。

---

## 四、文档与实现的漂移

### 4.1 README 的"Required Now"章节部分已过时

**位置**：`README.md:71-80`

```markdown
## Required Now
- AgentKind and AgentCapabilityMatrix ...
- SourceRef variants for JSONL lines ...
...
```

这些字段在 `types.ts` 里已经全部实现了，但 README 仍然把它们列为"Required Now"，产生了"这些还没实现"的误导。

---

### 4.2 `SegmentLink` 作为 `AlignmentRef` 的别名没有实际使用者

**位置**：`types.ts:355`

```typescript
export type SegmentLink = AlignmentRef;
```

这个别名被注释说"older planning docs use that name"，但 `SegmentLink` 在整个 `context-ledger/` 目录里没有任何实际使用，只是一个兼容层幽灵。

---

### 4.3 `rule-registry.ts` 混入了韩文注释

**位置**：`rule-registry.ts:397` 附近

```typescript
// 구조 분석（sourcemap 확인）：
// 고정 header（항상 고정）:
```

在中英文注释占主导的代码库里突然出现韩文（`# Environment` rule 的注释部分），破坏了代码库注释语言一致性（AGENTS.md §4 规定中文注释）。

---

## 五、优先级汇总

| 编号 | 问题 | 严重度 | 影响范围 |
|------|------|--------|----------|
| 1.1 | R9 用 proxy rawHash 污染 expected context | 高 | 审计有效性 |
| 1.2 | charCoverage 把 attribution-only 算进分子，死代码 attributionOnlyChars | 高 | 指标可信度 |
| 2.3 | HarnessRuleConfig 开关不生效 | 高 | 实验能力 |
| 2.6 | smoosh 通过字符串协议传递，类型不安全 | 中 | 可维护性 |
| 1.3 | rule.reconciliation.comparePolicy 从未被消费 | 中 | 文档可信度 |
| 2.1 | attribution 同时充当归因和重建两个角色 | 中 | 架构清晰度 |
| 2.2 | prior_session_guess 是位置性猜测，与 prefixIncomplete 信号不对齐 | 中 | 误报率 |
| 3.2 | 覆盖率缺少正则/模板匹配维度的拆分 | 中 | 可观测性 |
| 2.4 | MatchKind / Confidence / DiffKind 三套枚举语义重叠 | 低 | 认知负担 |
| 2.5 | tryMergeAlignment 是占位符但进入热路径 | 低 | 性能与可读性 |
| 3.1 | pipeline 无法运行 attribution-only（无 JSONL）报告 | 低 | 调试能力 |
| 4.1-4.3 | README 过时、SegmentLink 幽灵、韩文注释 | 低 | 维护体验 |
