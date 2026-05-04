# Context Ledger 架构审视 — 修正报告（refine-2）

> 范围：`server/src/context-ledger/`（types / rule-registry / proxy-attribution /
> expected-context-reconstructor / reconciliation-engine / proxy-snapshot-parser /
> proxy-block-splitter / debug/char-diff / audit/scorecard）。
>
> 本文只做问题诊断与修正方向，不动代码。

---

## 0. 期望对齐（用户陈述的 5 条原则）

| # | 原则 | 当前实现是否守住 |
|---|------|------------------|
| 1 | proxy dump = 事实层 | ✅ snapshot 层基本守住，但 R9 把 proxy.rawText / rawHash 反向拷进 expected（见 §2） |
| 2 | mutation + rule → target request | ⚠️ system / tools 段并不是从 mutation 推出来的，而是从 attribution 反向"塞回"expected（设计文档与代码冲突，§2、§3） |
| 3 | proxy vs target 形成对比 + 占位符标记 | ⚠️ 占位符（regex captureGroups + resolvePlaceholders）已实现，但产出报告里没有"placeholder-resolved 占比"这个独立维度（§4） |
| 4 | 覆盖率分级：exact > template/正则 > placeholder | ❌ 当前 evidenceBackedCoverage 把"shape 类 rule 直接复制 proxy rawHash 后假性命中"也算 exact，三个层级被 conflate（§2、§4） |
| 5 | 逻辑沉淀进 rule，不要 trick 硬编码 | ⚠️ rule 表已经很厚（2583 行），但 attribution 主流程仍有针对 ruleId 的硬编码分支（§5） |

---

## 1. 顶层数据流契约

README 与 reconstructor 顶部都有强约束（节选）：

> Forbidden：proxy diff → ContextMutation。
>
> reconstructor：1. 不读取 proxy-request.json；不依赖 ProxyQuerySnapshot。

代码里的实际数据流（reconstruct 入口签名）：

```
ReconstructInput {
  mutations,
  boundary,
  attributions?,           // ← 来自 ProxyQuerySnapshot
  proxySegmentsById?,      // ← ProxyQuerySnapshot.segments 直接传入
}
```

R9（`buildSegmentsFromAttributions`）的核心做法：

```ts
// materialization === "shape"
if (pSeg?.rawHash) {
  seg.rawHash = pSeg.rawHash;          // 直接复制 proxy 的 hash
  if (text) seg.contentRef = { kind: "inline", text, ... };  // 直接复制 proxy 文本
}
```

**这条路径是对原则 1、原则 2 的直接违反**。区别仅在于：未写进 `ContextMutation`，而是写进 `ExpectedQueryContext.segments`——但下游 reconciliation 对账只看 segments，语义上等价于把 proxy diff 反写回 target，原则是被绕过的。

后果（§4 详述）：所有 `materialization: "shape"` 的 rule（Bash / Agent /
ScheduleWakeup / context-management 等）在 reconcile 时进入 M1 raw_hash exact
match → 计入 `evidenceBackedCoverage` 分子，但实际上 expected 一侧并没有"独立重建出文本"，
只是把 proxy 当真相 echo 了一遍。

---

## 2. R9 让覆盖率指标失去 audit 价值

### 现象

`evidenceBackedCoverage` 的设计意图（types.ts 注释）：

> matched 或 approximate_match（有 rawHash/normalizedHash/toolUseId/ruleId 锚点）
> 的 proxy chars / proxyChars。suspect_match 不计入。

但 R9 让两类完全不同的命中走同一条 raw_hash 路径：

| 场景 | rawHash 来自哪里 | 是否真的"重建" | 当前是否计入 evidenceBacked |
|------|------------------|----------------|------------------------------|
| identity / system-section / 静态 tool description | rule.contentPattern → sha256 | ✅ 是 | ✅ 是 |
| Bash / Agent / context-management（`materialization: "shape"`） | proxy rawHash 拷贝 | ❌ 否 | ✅ 也是 |
| Environment / auto-memory（`normalized_text`，含占位符） | resolvePlaceholders → sha256 | ✅ 是（如果 captureGroup 完整） | ✅ 是 |

第二行是问题核心：**Bash 工具 description 10686 字节，rule 没有任何 reconstructed 文本，仅靠 regex 头尾锚定确认"格式 OK"，但 R9 直接拷贝 `pSeg.rawHash` 后让 reconciliation 走 M1 exact match——这是"自匹配"。**

### 为什么这破坏 audit 价值

用户设计的覆盖率层级（按可信度递减）：
1. exact 文本（rule 拥有完整 contentPattern → 哈希命中）
2. template / 正则（rule 提供模板 + captureGroups → 替换后哈希命中）
3. presence / shape（仅声明"存在这一段"，不能复现）
4. unknown

当前 R9 把第 3 类伪装成第 1 类。结果：

- `evidenceBackedCoverage` 数字虚高，看起来"已经覆盖到位"。
- 真正的 gap（"我们对 Bash 的 description 几乎没有重建能力"）被掩盖。
- 升级 Claude Code 版本时，Bash description 几个字节漂移不会触发任何指标恶化——因为 expected 永远等于 proxy。

### 修正方向（不动代码的提示）

- **R9 必须按 `materialization` 分流给不同 alignment basis**：
  - `exact_text` / `normalized_text`：允许 raw_hash / normalized_hash 对齐 → evidenceBacked。
  - `shape` / `presence`：必须落在新的 `presence_only` / `shape` basis 上 → 单独指标，不计入 evidenceBacked。
- **覆盖率指标按 comparePolicy 拆**：
  - `exactCoverage` = comparePolicy ∈ {raw_hash} 命中字符 / proxyChars
  - `templateCoverage` = comparePolicy ∈ {normalized_hash, char_diff} 命中字符 / proxyChars
  - `placeholderResolvedCoverage` = 通过 resolvePlaceholders 命中 raw_hash 的字符 / proxyChars（占位符路径独立计数，回答用户原则 4 的最后一句）
  - `presenceCoverage` = comparePolicy ∈ {presence_only, structural} 命中 / proxyChars
  - `noiseCoverage` = comparePolicy = known_noise 命中 / proxyChars
  - `unknownCoverage` = 1 - 以上之和
- **明确禁止反写**：把"R9 不得读 `pSeg.rawHash` / `pSeg.rawText`"写成 lint / runtime invariant；shape 类 rule 应当只生成 `charCount`（而且 charCount 也应来自 rule 推断而非 proxy ground truth，最次也要标 `confidence: "inferred"` 而不是 exact）。

---

## 3. preCondition / queryScope / trigger 三者职责重叠且非强制

`ContextLedgerRule.reconstruction` 同时存在：

- `trigger: "always_per_query" | "from_jsonl" | "from_memory" | "from_harness_state"`
- `preCondition: string`（自然语言）
- 上层 `queryScope: "main_session" | "side_query" | "any"`

### 矛盾点

- `SESSION_GUIDANCE_EMBEDDED_RULE.reconstruction.trigger = "always_per_query"`，
  但 `preCondition` 写的是"ant-native build，external 用户不适用"。
  按 trigger 应当无条件注入；按 preCondition 应当跳过 external 用户。
- `preCondition` 是字符串，**reconstructor 完全不评估它**，R9 仅根据 attribution
  是否命中决定是否生成 expected。换言之 attribution 命中是 "preCondition 已满足"
  的代理证据——这是隐式契约，没有断言保护。
- `queryScope` 在 attribution 阶段强制（`tryMatchRule`），但 R9 反向生成时
  **没有再次校验 queryScope**——理论上 main_session 请求误命中 side_query rule
  的情况（双向防御缺失）。当前因为 attribution 已经卡住，没暴露问题，但属于
  fail-open 设计。

### 修正方向

- 把 `preCondition` 从字符串升级为结构化判定（或显式承认它"仅人读"，并把
  实际门槛移到 `queryScope` + `attributionRequired: true` + `triggerEvidence`
  这类机器可读字段）。
- R9 应当显式校验 `rule.queryScope ∈ {snapshot.request.queryKind, "any"}`，
  然后才允许注入 expected。
- 把 `trigger` 重命名为 `materializationSource`（来源是 jsonl / memory / harness state /
  proxy-evidence-only）；`always_per_query` 这个枚举值名字与"是否需要 attribution
  作为先决条件"混为一谈。

---

## 4. 占位符命中（用户原则 4 的核心诉求）没有独立度量

### 现状

- `resolvePlaceholders(pattern, attr.notes)` 的实现存在，但仅在 R9 内部用一次。
- `attribution.captureGroups` 的命中信息在 attribution 的 `notes` 里以
  `key=value` 形式带出，但 reconcile 不知道这些 chars 是"动态字段"。
- `Coverage` 字段只有 attribution / evidenceBacked / suspect / aligned drift，
  没有"placeholder chars / total chars"这一项。

### 问题

用户原话：

> 哪些是正则的命中的占位符的字段？这个比例也很关键，不可能太高否则明显
> 可能是正则的规则过度了。

当前架构无法回答这个问题。比如：

- billing header 100 chars 全部是动态（cc_version、cch、workload）→ 占位符
  贡献接近 100%。
- Environment section ~1500 chars，但占位符（cwd、shell、osVersion 等）
  通常只占 200~400 chars。
- Bash tool description 10686 chars，shape rule，整段当占位符或不当？目前模糊。

### 修正方向

- 在 attribution 输出里增加 `placeholderChars / fixedChars` 拆分：
  对每条 regex rule，根据 captureGroup 在 rawText 上的偏移区间，把字符
  归入"模板固定段"或"占位符段"。
- Coverage 增加 `placeholderRatio`（占位符字符 / 该 rule 命中字符），并
  设阈值告警（例如 > 60% 视为"rule 过度泛化"，给 `regex_too_loose` finding）。
- char-diff 渲染层把占位符段标成不同颜色，UI 直观体现"模板 vs 动态"。

---

## 5. rule-driven 与硬编码的裂缝

### 5.1 attribution 主流程仍有 ruleId 特例

`proxy-attribution.ts:applyRuleMatch`：

```ts
if (rule.ruleId === CLAUDE_CODE_ENVIRONMENT_SECTION_RULE.ruleId && groups) { ... }
else if (rule.ruleId === CLAUDE_CODE_AUTO_MEMORY_SECTION_RULE.ruleId && ...) { ... }
else if (rule.ruleId === CLAUDE_CODE_CONTEXT_MANAGEMENT_RULE.ruleId && ...) { ... }
if (rule.ruleId === CLAUDE_CODE_SESSION_GUIDANCE_EMBEDDED_RULE.ruleId) { ... confidence 升 exact }
```

注释开头宣称"所有语义判断均由 CONTEXT_LEDGER_RULES 驱动"，但 notes 文案、
confidence 升级仍是硬编码 switch。后果：每加一条 dynamic section rule，
都要回到 attribution 代码补一段——违反原则 5。

**修正**：把 notes 模板下沉到 rule，例如：

```ts
attribution: {
  ...
  notesTemplate: [
    { format: "cwd={cwd}" },
    { format: "platform={platform}" },
    { whenGroup: "gitUser", format: "gitUser={gitUser}" },
  ],
  confidenceOverride: "exact",   // 取代 EMBEDDED_RULE 的 special case
}
```

attribution 主流程只做模板渲染，不再认 ruleId。

### 5.2 wire-schema fallback 的 magic constants

```ts
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const SYSTEM_REMINDER_TAG = "<system-reminder>";
const LOCAL_COMMAND_TAGS = ["<local-command-caveat>", "<bash-input>", ...];
```

这些都是硬编码 pattern。billing 已经有 rule，但 attribution 又复刻一份
"prefix fallback"；system-reminder / local-command 完全没有对应 rule，
全靠这几个常量。原则 5 要求"沉淀进 rule"，这部分明显欠下技术债。

**修正**：

- billing fallback 删掉，让 regex rule 不命中时直接走 unknown + finding
  ("billing header 格式异常")；这是 audit 应当暴露的真实信号，而非吞掉。
- 为 system-reminder 和 local-command 建立专门 rule（`category` 已经有
  `harness_injection` / `local_command_history`）；attribution 主流程只剩
  rule 命中逻辑。

### 5.3 reconciliation 的 jsonPath 双向前缀匹配

`buildAttrBySegId` 注释直白：

> 双向前缀匹配是过宽的 heuristic——如果 attribution 粒度比 parser 粗很多
> （如整个 reqBody.messages），会把无关 segment 也标记为已覆盖。

这个 fallback 暂未触发是因为 attribution 当前只会以 tools / messages.content
作为粗粒度，但属于潜在 false positive 源。

**修正**：让 attribution 始终以 parser segment id 为锚点（而不是 jsonPath），
两边共用同一个 segment 索引。粒度差异问题在 attribution 层就消化掉。

---

## 6. fixture 与版本对齐的隐式 bias

### 6.1 fixture 的来源混杂

- `SESSION_GUIDANCE_EMBEDDED_RULE` 注释承认 fixture 是 ant-native build 录制，
  external 用户不会触发。但这条 rule 是 `verifiedFor: null`，仍参与 attribution。
- `DOING_TASKS_RULE` / `USING_YOUR_TOOLS_RULE` 注释承认"fixture 版本较旧，
  当前 2.1.123 sourcemap 已有变化"。

这意味着：**当前的高覆盖率部分是"过时 fixture × 过时 rule"的循环验证**，
对 2.1.126 真实 external 流量的代表性存疑。

### 6.2 verifiedFor 的语义弱

- `SUPPORTED_CLAUDE_CODE_VERSION = "2.1.126"`，但大量 system prompt rule 标
  `verifiedFor: null`；audit 只是报"pending"。
- 用户在 README 里规定"升级 SUPPORTED_CLAUDE_CODE_VERSION 时，所有 verifiedFor
  必须批量重置为 null 并逐条复审"——但目前同时存在 `verifiedFor=null` 和
  `verifiedFor=SUPPORTED_CLAUDE_CODE_VERSION` 的混合状态，说明流程其实没走完。

### 6.3 修正方向

- 把"verifiedFor=null 的 rule 是否参与 attribution"做成显式开关：默认参与
  但 confidence 强制降为 `inferred`，evidenceBackedCoverage 把它们排除。
- 录制一份 external CLI（非 ant-native）的 fixture，作为 rule 的真正校验集；
  现在所有指标的"分布"是失真的。
- audit pipeline 强制要求"主报告必须基于 verified rule 命中产生的 chars 占主导"，
  如果 pending rule 贡献 > 30% chars，verdict 直接 `needs_review`。

---

## 7. expected 与 reconciliation 的语义错位

### 7.1 task_reminder smoosh 走"减法"而非"加法"

- harness 把 task_reminder 折进 tool_result 尾部 → proxy 看到 tool_result chars 多了 N。
- 当前 expected 跳过 task_reminder（`isExpectedRelevant` 显式过滤），
  reconciliation 用 `tail_injection_chars` 从 proxyChars 里减掉 N。

按用户的原则 2（mutation + rule 重建 target request），正确做法应该是：
**expected 把 task_reminder 文本拼接到对应 tool_result 的 contentRef.text 上**，
让 expected.charCount 与 proxy 完美一致——这是真正的"重建"。当前的"减法"绕开了
重建，把责任转嫁给 reconcile 层做特例消化，长远会派生越来越多 tail_injection 类
特例（hooks / memory pre-prompt / 等）。

代码里也明确 `TODO(task-reminder-expected)` 承认这是临时方案。

### 7.2 N:1 merge 是声明式 stub

`tryMergeAlignment` 直接 `return null`，注释"4 个 fixture 均无此场景"。但
`R3_merge_user_tool_results` 已经把多个 expected tool_result 标到同一
logicalMessageId——一旦 proxy 用 string content（非 array of blocks）把
它们合并成单个 segment，整组 expected 都会变成 `unmatched_expected_segment`，
findings 数量爆炸而 reconciliation 不会自动识别这是 N:1 场景。

**修正**：要么实现 R-MERGE-N1（注释里给出的方案），要么把 `mergeUserToolResults`
默认 OFF 直到 N:1 检测真正落地，避免"实现了一半"的状态。

### 7.3 attribution category 与 parser category 的双重权威

- reconciliation step 1：`effectiveCategory = attrBySegId.get(pseg.id)?.category ?? pseg.category`
- reconciliation M4：`s.category === eseg.category || attrBySegId.get(s.id)?.category === eseg.category`
- coverage：`cat = attr?.category ?? pseg.category`

三处选择策略不完全一致（OR vs `??`），且没有声明"哪个层是权威"。
如果 attribution 把 user_message 升格为 `local_command_history`，coverage 会按
local_command_history 算，但 M4 的候选过滤又允许两边任一命中——可能导致
attribution 升格的 segment 与 parser 原始分类的 expected segment 错配。

**修正**：宣布 attribution.category 为唯一 effective category，parser
category 仅作为 attribution 的 fallback 输入。M4 candidate filter 改成单边。

---

## 8. char-diff 与 reconciliation 的指标双源

`debug/char-diff.ts` 文件头：

> Bypass / debug-only tool. NOT imported by any production path.

但 `audit/scorecard.ts` 同时引用了 CharDiffReport：

```ts
const alignedAuditedChars =
  diff.summary.totalProxyChars > 0
    ? Math.round(diff.summary.evidenceBackedCoverage * diff.summary.totalProxyChars)
    : evidenceBackedProxyChars;
const falseReliableMatchCount = diff.summary.suspectMatch;
```

两个事实：

1. char-diff 不是 debug-only，audit pipeline 在用。
2. 同一个 evidenceBackedCoverage 在 reconciliation engine 与 char-diff 各算
   一次，可能出现两个数字不一致而下游用了其中一个。

**修正**：

- 删除 char-diff 文件头的"debug-only"声明（与事实不符）；要么把它移到 audit/
  目录下，要么把 audit 直接改成读 reconciliation 的同名字段（不再走 char-diff
  汇总）。
- 同名指标只能由一处计算，另一处只能引用，避免漂移。

---

## 9. 杂项隐患（短列表）

| # | 位置 | 问题 |
|---|------|------|
| A | `rule-registry.ts` exact_text rules | `attribution.pattern` 与 `reconstruction.emits.contentPattern` 是同一段文字的两份拷贝；缺少 unit test 自动校验"用 contentPattern 跑 attribution 必命中"，升级时极易漂移 |
| B | `rule-registry.ts` regex rules | regex pattern 没有统一的 anchor 约定。Environment 用 `^# Environment\n` 但末尾无 `$`；BILLING 用 `^...$` 全锚；TOOL_AGENT 用 `^...[\s\S]*$` 容忍尾部噪声。混用会让 trailing trash 在某些 rule 命中、其他 rule 不命中 |
| C | `proxy-attribution.ts:applyRuleMatch` | regex 命中 + captureGroup 全填 → confidence 升级为 `"exact"`。但 regex 本身就是"次一级匹配"，与原则 4 的层级冲突。建议封顶为 `"estimated"` |
| D | `expected-context-reconstructor.ts` `proxyWrapTextForCategory` | 把 skill_listing 的 wrapper header 硬编码在 reconstructor 里。同一 header 在 sourcemap 里属于 messages.ts 常量。属于"trick 硬编码"，应当下沉成一条 wrapper rule |
| E | `reconciliation-engine.ts:940` | `void attributionOnlyChars;` —— 显式悬空变量是技术债痕迹，说明 attributionCoverage 计算路径有重复分支 |
| F | `rule-registry` 的 RULE_TABLE 顺序敏感 | findMatchingRule 返回首个命中 rule。INTRO_OUTPUT_STYLE 是 prefix（`outputStyle` 措辞），INTRO_STANDARD 是 exact 全文。当 standard 全文里某段恰巧命中 OUTPUT_STYLE 的 prefix 时，顺序决定结果；当前靠数组顺序兜底，没有显式 `priority` 字段 |
| G | `ContextSegment.rawText` | 注释要求"reconciliation/UI 不应依赖"，但 R9 直接读它。rawText 实际上跨越了 fact → explanation 边界 |
| H | `expected-context-reconstructor.ts:order = -100000` | 用大负数 hack 让 system/tools 段排在 messages 之前；reconciliation 又针对 `basis === "rule_id"` 跳过 order_mismatch。两处 hack 互相对冲，可读性差 |
| I | `tools_schema rule.location.jsonPathHint = "reqBody.tools[*]{name=Edit}.description"` | 既不是 JSONPath 标准也不被运行时使用，仅人读。需要明确"hint 字段不参与匹配"，否则后人会把它当成约束 |
| J | tool descriptions 标 `materialization: "exact_text"` 但 `stability: "semi-static"` | 当 binary 升级 description 微变（最常见的版本变动），所有 tool rule fail-closed，没有 graceful degradation 路径（如 char_diff 模式） |

---

## 10. 修正路线图（建议优先级）

### P0（影响 audit 可信度的根因，必须先解）

1. **R9 拆分 materialization 路径**（§2）。`shape` / `presence` 不得反写
   proxy 数据；evidenceBackedCoverage 重定义为"仅 exact_text + normalized_text
   命中"；新增 presenceCoverage / shapeCoverage 单独维度。
2. **Coverage 按 comparePolicy 分层**（§4）。新增 `exactCoverage` /
   `templateCoverage` / `placeholderResolvedCoverage` / `presenceCoverage` /
   `noiseCoverage` / `unknownCoverage`，回答用户原则 4。
3. **占位符命中独立度量**（§4）。从 attribution 的 captureGroup 偏移区间
   计算 `placeholderChars`，给出"模板固定 vs 占位符"占比；> 60% 触发
   `regex_too_loose` finding。

### P1（数据流契约 / 一致性）

4. **expected ⊥ proxy 的硬隔离**（§1）。R9 不读 `pSeg.rawHash` / `pSeg.rawText`；
   把这条做成 invariant 测试。
5. **task_reminder 改"加法"重建**（§7.1）。expected tool_result 直接吸收
   task_reminder 文本；删除 reconcile 层的 `tail_injection_chars` 减法路径。
6. **N:1 merge 真正实现或关闭 R3**（§7.2）。当前是"实现了一半"的危险状态。
7. **attribution.category 单一权威**（§7.3）。统一三处 category 选择规则。

### P2（rule-driven 彻底化）

8. **notes 模板下沉到 rule**（§5.1）。删除 attribution 主流程对 ruleId 的
   if/else 分支。
9. **system-reminder / local-command 建 rule**（§5.2）。删除 attribution
   里的 magic constants。
10. **billing prefix fallback 删除**（§5.2）。让 regex 不命中时直接落 unknown，
    暴露真实问题。
11. **regex anchor 约定统一**（§9.B）；contentPattern 与 attribution.pattern
    的双拷贝改成 single source（§9.A）。

### P3（fixture / 版本流程）

12. **录制 external CLI fixture**（§6.1）。当前的"高覆盖率"部分来自过时
    fixture × 过时 rule 的循环。
13. **pending rule 不计入 evidenceBacked**（§6.3）。verifiedFor=null 的 rule
    confidence 强制降级。

### P4（可读性 / 技术债）

14. **char-diff 与 reconciliation 指标合一**（§8）。删除文件头错误的
    "debug-only"标注；同名指标只一处计算。
15. **preCondition 字段做出选择**（§3）。要么变成机器可读结构，要么明确为
    人读注释、把判定移到 queryScope+attributionRequired。
16. **rule 显式 priority 字段**（§9.F）；删 `void` 悬空变量（§9.E）。

---

## 附录：关键数据流示意（修正前 / 修正后）

### 修正前（当前）

```
proxy dump ──► snapshot ─► attribution ─┐
                          │              │
                          └─► rawText ──► R9 ─► expected.segments
                                          │           │
                                          └───────────┴─► reconcile ─► evidenceBackedCoverage 虚高
                                                          (M1 raw_hash 自匹配)
```

### 修正后（目标）

```
proxy dump ──► snapshot ─► attribution ─► coverage by comparePolicy
                                          (placeholder ratio 单独维度)

JSONL/memory/harness ─► mutations ─► reconstruct
                                     ├─ exact_text rule  → contentPattern → rawHash ─┐
                                     ├─ normalized_text  → placeholder resolve → hash┤
                                     └─ shape/presence   → 仅 charCount + 标 presence┤
                                                                                      ▼
                                                                                 reconcile
                                                                                      ▼
                                                          exactCoverage / templateCoverage /
                                                          placeholderResolvedCoverage /
                                                          presenceCoverage / unknownCoverage
```

修正后：expected 永远不读 proxy 内容；R9 仅在"我们对这条 rule 有
contentPattern"时才能产生可对账的 hash；shape 类 rule 公开承认"不可重建"，
进入独立的 presence 桶，不再借 R9 假装命中。

