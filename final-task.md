# Context Ledger 修正工作方案（final）

> 整合自 `refine.md` / `refine-1.md` / `refine-2.md` 三份审视报告。
> 范围：`server/src/context-ledger/` 全模块。
> 性质：**可执行的工作计划**——给出阶段、任务、产出与验收口径，不预先动代码。

---

## 0. 结论与执行取舍

最终架构目标采用 **TargetRequest 正向重建 + request-level reconcile + rule-driven materialization**。但执行顺序需要调整：**先加固 evaluate/audit，再做 R9 止血和 TargetRequest 改造**。

原因是当前最大的风险不只是 coverage 虚高，而是 evaluate 本身还不能稳定说明"为什么虚高、虚高多少、关闭某条路径后下降在哪里"。如果直接重构 R9 或 TargetRequest，短期会得到一组新数字，但很难证明它更接近真实。因此本方案按两层推进：

1. **T0/E0：立即验证前提并加固 evaluate**，把当前 R9 污染、proxy raw 丢失、fixture bias、scorecard 双源等问题变成可重复观察的审计信号。
2. **P0-P3：在可观察基线之上修正架构**，先切断 proxy 反写，再保存 wire fact，再推进 TargetRequest 和 rule v2。

### 0.1 三种路线对比

| 方案 | 内容 | 优点 | 缺点 / 风险 | 适用阶段 | 结论 |
|------|------|------|-------------|----------|------|
| A. 直接做 TargetRequest 终态 | 立即重构 mutation + rule → TargetRequest，再 request-level reconcile | 架构最干净，一步到目标 | 工程量大；evaluate 未稳时无法证明收益；coverage 下降原因难解释 | evaluate 已可信、fixture 足够后 | **终态目标，不作为第一步** |
| B. 先加固 evaluate，再止血 | 先让 audit 输出分层指标、控制变量、baseline delta、风险桶，再改 R9/raw body | 风险最低；每次改动能被量化；便于团队接受 coverage 短期下降 | 前期可见功能少；需要先补审计元数据 | 当前阶段 | **推荐路径** |
| C. 继续沿 R9 提覆盖 | attribution 继续反向生成 expected，靠 heuristic 提高匹配率 | 短期数字好看，改动最小 | 循环证明；rule 缺失被掩盖；regex/presence 过宽无法暴露 | 仅临时 demo | **放弃** |

### 0.2 本次修订后的关键判断

- `final.md` 中的终态判断保留：`TargetRequest` 是最终核心 IR，`ExpectedQueryContext` 只能作为兼容输出。
- `final-task.md` 原有 P0/P1/P2/P3 细任务大体保留，但新增 **T0 立即验证** 与 **E0 evaluate 加固** 作为阻塞前置。
- R9 止血仍必须做，但不再作为第一步直接改；先让 audit 支持对照开关和分层 scorecard，避免"改完只知道 coverage 掉了"。
- fixture / 当前 CLI / proxy raw fact 的验证需要马上展开，不等待 TargetRequest。

---

## 1. 三份报告对照（共识 / 互补 / 仅一份命中）

| 主题 | refine.md | refine-1.md | refine-2.md | 处理方式 |
|------|-----------|-------------|-------------|----------|
| R9 把 proxy 反写进 expected | §1（核心） | §1.1（核心） | §2（核心） | **P0-1 一致采纳** |
| 覆盖率层级（exact/template/regex/presence/placeholder） | §4（最细，含 RuleMatchEvidence schema） | §1.2（charCoverage 命名/死代码 void） | §4（按 comparePolicy 分桶 + placeholder 比例） | **P0-2 综合三家** |
| 占位符独立度量 | §4（指标列表） | §3.2（缺口陈述） | §4（实施方法 + 阈值告警） | **P1-1 采用 refine-2 实施 + refine 指标命名** |
| rule.reconciliation.comparePolicy 字段未被消费 | （间接） | §1.3（直接） | §2（间接） | **P2-3 单独任务** |
| 硬编码 magic constants（system-reminder / local-command / billing prefix） | §7 | — | §5.2 | **P2-1 采纳** |
| attribution notes 模板下沉到 rule | — | — | §5.1 | **P2-2 采纳** |
| task_reminder smoosh 改"加法" | — | §2.6 | §7.1 | **P1-2 采纳** |
| attribution 双重角色（解释 + 重建） | §1（合并到 R9） | §2.1（独立） | §7.3（category 双权威） | **P0-1 + P1-3 合并** |
| prior_session_guess 弱 | §7（迁移到 JSONL chain） | §2.2（与 prefixIncomplete 不对齐） | — | **P2-4 采纳** |
| N:1 merge 是 stub | — | §2.5 | §7.2 | **P1-4 采纳** |
| HarnessRuleConfig 开关不生效 | — | §2.3 | — | **P1-5 采纳** |
| char-diff 与 reconciliation 指标双源 | — | — | §8 | **P3-3 采纳** |
| MatchKind / Confidence / DiffKind 枚举重叠 | — | §2.4 | — | **P3-2 采纳** |
| pipeline 无 JSONL 时 skip，无 attribution-only 报告 | — | §3.1 | — | **P3-4 采纳** |
| **proxy raw body 在 audit 入口被解析覆盖（wire-exact 失真）** | §3（独有） | — | — | **P0-3 采纳——独有但是阻塞性** |
| **缺少 TargetRequest AST（请求级 exact 比较）** | §2（独有） | — | — | **P3-1 采纳** |
| fixture / 版本 bias（ant-native vs external） | — | — | §6 | **P3-5 采纳** |
| jsonPath 双向前缀匹配过宽 | §8 | — | §9.J | **P2-5 采纳** |
| regex 命中升级为 exact confidence | §5（拆 classification/materialization/comparison） | — | §9.C | **P2-6 采纳 refine §5 拆法** |
| billing_noise 计入 evidence-backed | §6（独立"server_side_attribution"桶） | — | §4（noise 单独桶） | **P0-2 一并处理** |
| README 过时 / SegmentLink 幽灵 / 韩文注释 | — | §4 | — | **P3-6 文档清理** |
| `void attributionOnlyChars` 死代码 | — | §1.2 | §9.E | **P0-2 一并清理** |
| rule contentPattern 与 attribution.pattern 双拷贝 | — | — | §9.A | **P2-7 采纳** |
| regex anchor 不统一（`^...$` vs `^...` vs prefix） | — | — | §9.B | **P2-8 采纳** |

> 三份报告无矛盾；refine.md 长在"目标架构"，refine-1.md 长在"实现细节痕迹与命名问题"，refine-2.md 长在"覆盖率分桶语义与 fixture/版本风险"。本方案合并三家，按可执行阶段组织。

---

## 2. 设计目标（重申用户原则，作为验收源头）

1. proxy dump 是事实层。
2. mutation + rule **正向**构建 target request；**禁止**用 proxy 反写 expected。
3. 通过正则 / 占位符 / 模板声明动态字段；reconcile 输出"哪些是占位符命中"。
4. 覆盖率分级：**wire-exact > canonical-exact > template > regex > placeholder-resolved > presence > unknown**；高层级不得借低层级"自匹配"虚抬。
5. 逻辑沉淀进 rule，不要 trick 硬编码。

---

## 3. 阶段划分与里程碑

| 阶段 | 目标 | 主要交付 | 验收信号 |
|------|------|----------|----------|
| **T0 立即验证前提** | 把当前关键假设转成可执行检查 | fixture/local audit baseline / rule-vs-cli 验证 / R9 影响实验设计 / raw body 保真确认 | 能列出每个假设的当前状态：已证实 / 已证伪 / 需补采样 |
| **E0 evaluate 加固** | 先让审计可控、可对照、可解释 | audit modes / scorecard v2 兼容字段 / 控制变量开关 / baseline delta 报告 | 同一 query 可输出旧口径、新口径、关闭 R9 口径的差异 |
| **P0 止血** | 切断循环证明，恢复指标可信 | R9 拆路径 / 覆盖率分桶 / wire raw body 保真 | evidenceBackedCoverage 不再含 shape 类自匹配；coverage 数字短期下降但**可解释** |
| **P1 数据流契约** | 重建 expected ⊥ proxy 边界 | task_reminder 加法重建 / attribution 单一职责 / N:1 merge / HarnessRuleConfig gate / pipeline attribution-only 路径 | 关掉单条 rule 能产生可控的 coverage 变化；attribution-only 报告独立可生成 |
| **P2 rule-driven 彻底化** | 删除 attribution 主流程的硬编码 | notes 模板下沉 / magic constants 转 rule / comparePolicy 真正驱动 reconcile / regex anchor 与双源单一化 | proxy-attribution.ts 主流程不再有 `if rule.ruleId === XXX` 分支 |
| **P3 终态表达力** | TargetRequest AST + 指标合一 + 文档收尾 | TargetRequest 中间产物 / char-diff 与 reconciliation 单一指标源 / 枚举合并 / fixture 与版本治理 | request-level raw exact / canonical exact / structural exact 三档可输出 |

---

### 3.1 T0 — 立即展开的验证前提

T0 不要求先改核心链路，目标是把"我们以为的问题"变成可复现证据。建议在第一个实现 PR 前完成，并把结果贴进后续 PR 描述。

| 验证项 | 立即动作 | 产出 | 影响后续决策 |
|--------|----------|------|--------------|
| 当前 evaluate 基线 | 运行 `bun run context:audit:fixtures`，必要时再运行 `bun run context:audit --all-local` 或 `bun run context:audit:since-last` | baseline runId、`audit-run.md`、当前 scorecard 分布 | 决定 P0 改动后的下降是否是预期下降 |
| fixture 代表性 | 标记 fixture 来源：ant-native / external CLI / synthetic；记录每组 query 覆盖率 | fixture matrix | 如果 external CLI 缺失，P3-5 提前，不等 TargetRequest |
| rule 与当前 CLI 漂移 | 运行 `bun run scripts/verify-rules-against-cli.ts`，记录 missing / stale / pending rule | rule verification summary | `verifiedFor=null` 的 rule 是否立即降级 |
| R9 污染规模 | 设计并实现 E0 开关：同一 query 对比 current / `--no-r9` / `--verified-only` | R9 contribution delta | 决定 P0-1 的优先级和验收阈值 |
| proxy raw fact 是否丢失 | 检查 discovery/pipeline 中 `reqBody` 原文、解析对象、hash 的保存路径 | raw-body gap note | 决定 P0-3 是否必须先于 request-level reconcile |
| char-diff 与 scorecard 双源 | 对同一 report 比较 reconciliation coverage 与 diff summary coverage | metric source diff | 决定 P3-3 是否前移到 E0 |
| proxy_without_jsonl | 统计 `proxyWithoutJsonl` 分布和样例 | unmatched proxy list | 决定 P3-4 attribution-only 是否前移 |

### 3.2 推荐 PR 顺序

1. **PR-1：Evaluate/Audit 加固**。新增对照模式、scorecard v2 兼容字段、baseline delta、风险桶，不改变核心重建结果。
2. **PR-2：T0 验证结果固化**。补 fixture matrix、rule-vs-cli 报告、raw-body gap 记录，把验证前提变成持续检查。
3. **PR-3：R9 与 coverage 止血**。关闭 proxy 反写 target 的路径，分层 coverage，保留旧指标只作迁移对照。
4. **PR-4：proxy raw fact 保真**。保存 raw/canonical/parsed 三层 request fact，为 request-level exact 做准备。
5. **PR-5：TargetRequest MVP**。先覆盖 system/tools/messages 的主干，不追求一次性物化所有动态段。
6. **PR-6：rule-driven 清理与 placeholder 证据**。把硬编码和 notes 模板下沉到 rule，补 placeholder/regex 治理。

### 3.3 本次已展开的 T0 记录（2026-05-02）

已先跑两项低风险验证，作为 E0 的直接输入：

| 动作 | 结果 | 暴露的问题 | 后续处理 |
|------|------|------------|----------|
| `bun run context:audit:fixtures` | 成功；runId = `2026-05-02T07-24-09.391Z__40c8a5`；4 条 fixture 全部成功 | 默认 baseline 指向 `2026-05-02T06-46-47.849Z__7105cc`，该 baseline 有 1250 条 previous，而 fixture run 只有 4 条 current，说明 baseline 指针可能跨 mode 比较 | E0 必须让 baseline 按 mode/source 分域，或要求 fixture run 显式指定 fixture baseline |
| `bun run scripts/verify-rules-against-cli.ts` | 退出码 1；目标 Claude Code `2.1.126`；exact rules 40，non-exact skipped 19；结果为 1 unique match、5 multi、34 missing | 当前 exact_text rules 与本地 CLI 明显漂移，高覆盖率不能继续假设来自真实 exact | E0/PR-2 需要把 rule-vs-cli summary 写入 audit report；P3-5 的 `verifiedFor` 降级策略应前移 |

这两个结果支持当前执行取舍：**不是先追 TargetRequest 大重构，而是先把 evaluate 的 baseline、rule drift、coverage 分桶和控制变量补齐**。

---

## 4. 任务清单（按阶段展开）

### E0 — Evaluate / Audit 加固（先于 P0 代码重构）

**问题**：现有 audit 已能产出 run、scorecard、char-diff，但它仍使用旧 coverage 口径，并且缺少控制变量开关。直接修 R9 会导致 coverage 大幅下降，却无法向报告读者解释下降来自"真实退水"还是新 bug。

**任务**：
- audit CLI 增加兼容型运行模式：
  - `--no-r9`：禁用 attribution 注入 expected 的贡献，只保留 proxy attribution view。
  - `--verified-only`：`verifiedFor === null` 或版本不匹配的 rule 仅进入 pending/attribution-only，不进入 evidence-backed。
  - `--proxy-only`：允许没有 JSONL 的 query 也输出 proxy attribution-only 报告。
  - `--compare-run <runId>`：显式对比指定 run，输出 per-query metric delta。
- baseline / latest 指针按 mode/source 分域，避免 fixture run 与 all-local run 互相比出大量 removed/new 噪声。
- `QueryScorecard` 新增 v2 字段，但保留旧字段一个迁移周期：
  - `wireExactCoverage`
  - `canonicalExactCoverage`
  - `templateCoverage`
  - `regexCoverage`
  - `placeholderResolvedCoverage`
  - `presenceCoverage`
  - `serverSideAttributionChars`
  - `pendingRuleCoverage`
  - `regexOverreachRisk`
- `run.json` / `audit-run.md` 增加环境和规则元数据：
  - context-ledger 版本或 git commit
  - Claude Code 版本探测结果
  - rule verification summary
  - fixture source matrix
  - audit mode flags
- scorecard verdict 加入治理阈值：
  - `pendingRuleCoverage > 30%` → `needs_review`
  - `regexOverreachRisk > 60%` → `needs_review`
  - `suspectMatchChars > 0` → 至少 `needs_review`，不能被 evidence 上升抵消
- report-generator 输出同一 query 的旧口径 / 新口径 / 控制变量口径对照，避免只看一个覆盖率总数。

**验收**：
- 在不改 R9 逻辑的情况下，audit 能报告 R9 贡献的估算差异或待验证差异。
- 一条 fixture query 至少能看到：旧 `evidenceBackedCoverage`、新分桶覆盖率、pending rule 占比、regex/placeholder 风险。
- baseline 对比能说明 regression 原因来自哪一类桶，而不是只输出 coverage drop。

### P0 — 止血（E0 完成后阻塞性推进）

#### P0-1 R9 按 materialization 拆路径，禁止 proxy 反写

**问题**：R9 当前对 `materialization: "shape"` 直接拷贝 `pSeg.rawHash` / `pSeg.rawText`，让 reconcile 走 M1 raw_hash 自匹配。

**任务**：
- `ReconstructInput` 删掉 `proxySegmentsById`；R9 不再读 `pSeg.rawText` / `pSeg.rawHash`。
- `attributions` 输入仅作为"哪些 ruleId 在本次请求被观测到"的存在性信号，不携带任何 proxy 文本。
- R9 按 rule.reconstruction.materialization 严格分流：

  | materialization | 允许的 expected 锚点 | 允许的 alignment basis |
  |-----------------|----------------------|------------------------|
  | `exact_text` | rawHash from `contentPattern` | `raw_hash` |
  | `normalized_text` | rawHash from `resolvePlaceholders(contentPattern, captureGroups)` | `normalized_hash` 或 `placeholder_resolved` |
  | `shape` | 仅 `charCount` 估值（非 proxy 实测） | `presence_only` |
  | `presence` | 仅"段存在"标记 | `presence_only` |
  | `unavailable` | 不生成 expected segment，进 unimplementedRules | — |

- 增加 invariant 测试："R9 产出的任何 expected segment 的 rawHash 不得等于其对账的 proxy segment 的 rawHash 来自直接拷贝路径"——具体做法是给 R9 路径加一个 `materializationSource` 标签，禁止 `materializationSource = "proxy_copy"` 进入 evidenceBacked 计算。

**对应**：refine §1 + §2 / refine-1 §1.1 / refine-2 §1+§2

#### P0-2 覆盖率指标重构与死代码清理

**问题**：`charCoverage` 把 attribution-only 算进分子；`evidenceBackedCoverage` 把 shape 自匹配算进分子；`billing_noise` 计入 evidenceBacked；`void attributionOnlyChars` 是死代码。

**任务**：
- `CoverageSummary` 重定义为正交分桶（每个 proxy char 落在且仅落在一个桶）：

  ```ts
  {
    wireExactCoverage:           number;  // 原始字节级 exact（依赖 P0-3）
    canonicalExactCoverage:      number;  // canonical JSON exact
    templateCoverage:            number;  // contentPattern 含字面 + placeholder，placeholder 已解析
    regexCoverage:               number;  // regex anchor 命中但 expected 无可复现文本
    placeholderResolvedCoverage: number;  // 仅占位符值的字符（templateCoverage 内的子集，单独披露）
    presenceCoverage:            number;  // shape / presence rule
    serverSideAttributionChars:  number;  // billing 等 wire payload 但非 model context（refine §6）
    attributionOnlyCoverage:     number;  // 有归因但无 expected（U1-U5 缺口）
    unexplainedCoverage:         number;  // unknown
    // 治理指标
    placeholderRatio:            number;  // placeholderResolvedChars / templateCoverage 命中字符
    regexOverreachRisk:          number;  // regexCoverage 字符 / 总字符（高 → rule 过宽）
  }
  ```

- 删除 `void attributionOnlyChars` 与对应累加分支；用单一 effective category（attribution.category，参见 P1-3）一次性归桶。
- 把 `billing_noise` 从 evidenceBacked 移出，归入 `serverSideAttributionChars`；reconcile step 1 的 known_noise alignment basis 改 `server_side_attribution`。
- audit/scorecard 的 `evidenceBackedCoverage` × `proxyChars` 反推路径删除（参见 P3-3）。

**对应**：refine §4+§6 / refine-1 §1.2 / refine-2 §4+§9.E

#### P0-3 proxy raw body 保真

**问题**：`audit/discovery.ts` 把 traffic record 的 `reqBody` 字符串解析成对象后用 `{ ...record, reqBody }` 覆盖原始字段；`rawRequestHash = JSON.stringify(body)` 不是 wire bytes hash。

**任务**：
- discovery / pipeline 同时保留：
  - `rawReqBodyText`（proxy 写盘的 UTF-8 原文，必要时 base64）
  - `rawReqBodyBytesHash`（raw bytes sha256）
  - `parsedReqBody`（解析后对象，供 parser 使用）
  - `canonicalReqBodyText`（按 canonical 序列化规则重写）
  - `canonicalReqBodyHash`
- ProxyQuerySnapshot 增加 `rawRequestBytesHash` / `canonicalRequestHash` 两个字段，原 `rawRequestHash` 改名为 `parsedRequestHash` 并标 deprecated。
- `wireExactCoverage` 的判定使用 `rawReqBodyBytesHash`；`canonicalExactCoverage` 使用 `canonicalReqBodyHash`。

**对应**：refine §3（独有）

---

### P1 — 数据流契约

#### P1-1 占位符命中独立可观测

**任务**：
- `proxy-attribution.ts:applyRuleMatch` 在 regex 命中时计算每个 captureGroup 在 rawText 上的 `[charStart, charEnd)` 偏移区间，写入新增的 `RuleMatchEvidence`：

  ```ts
  {
    ruleId,
    mode: "exact" | "template" | "regex" | "presence",
    literalChars,
    placeholderChars,
    placeholderRatio,
    captures: Array<{
      name, valuePreview, charStart, charEnd,
      source: "env" | "memory" | "runtime" | "unknown",
    }>,
  }
  ```

- attribution 输出从"`notes: string[]`"升级为结构化 `RuleMatchEvidence`；旧 `notes` 字段保留 1 个 release 兼容。
- coverage 增加 `placeholderRatio`（`captureGroups` 字符 / 该 rule 命中字符）；按 rule 维度统计，>60% 触发 `regex_too_loose` finding。
- char-diff UI 把 placeholder 区间用不同颜色渲染（参见 P3-3 合一后落地）。

**对应**：refine §4（提供 schema） / refine-2 §4（提供阈值与实施方法）

#### P1-2 task_reminder smoosh 改"加法"重建

**问题**：当前 expected 跳过 task_reminder，reconcile 用 `tail_injection_chars:N` 字符串协议在 char_diff 里减掉 N。

**任务**：
- `expected-context-reconstructor` 不再过滤 `attachmentType === "task_reminder"`；在对应 tool_result expected segment 的 `contentRef.text` 尾部直接拼接 task_reminder 渲染文本（mutation 已携带 task list）。
- 删除 `proxy-attribution.ts` 写入 `tail_injection_chars:<N>` 的 notes 与 reconciliation-engine 解析它的正则。
- tool_result 的 `comparePolicy` 改回普通 `char_diff` / `raw_hash`，由 reconcile 统一处理。
- 验证：4 个现有 fixture 的 tool_result charDiff 不再依赖 tail_injection 注释也能与 proxy 对齐。

**对应**：refine-1 §2.6 / refine-2 §7.1

#### P1-3 attribution 单一权威：解释层与 effective category

**问题**：reconcile 三处 category 选择规则不一致（`??` vs OR）；attribution 同时被当成"解释"和"R9 重建源"。

**任务**：
- 宣布 attribution.category 为唯一 effective category；parser 仅做 wire schema 切割，category 字段标记为"draft"，不参与 reconcile 决策。
- reconcile step 1（known_noise 检测）、M4 candidate filter、coverage 归桶三处统一从 `attrBySegId.get(pseg.id)?.category` 取，没有 attribution 时落 unknown。
- attribution 输出严格只用于"解释 proxy 是什么"；"R9 重建"的依赖在 P0-1 已切断（仅靠 ruleId 存在性信号），attribution 不再是 expected 的内容输入。

**对应**：refine-1 §2.1 / refine-2 §7.3

#### P1-4 N:1 merge 真正实现或显式关闭 R3

**问题**：`tryMergeAlignment` 是 stub（`return null`），但 R3 已经在 expected 侧打 `logicalMessageId`——一旦 fixture 暴露 string content 场景，整组 expected 全部落 unmatched。

**任务**：
- 实现 R-MERGE-N1：同一 logicalMessageId group 的 expected segment 内容拼接 → sha256 → 与 proxyByRawHash 比对。命中则产出 `merge_alignment` finding（N:1）。
- 同时检测 1:N（一个 expected → 多个 proxy 同 toolUseId）：复用 `proxyByToolUseId`。
- 单测覆盖两类场景；如果阶段时间不够实现，**降级方案**：`mergeUserToolResults` 默认 OFF，明确不打 logicalMessageId，避免"实现一半"。

**对应**：refine-1 §2.5 / refine-2 §7.2

#### P1-5 HarnessRuleConfig 开关真正 gate segment 生成

**问题**：`injectSkillListing: false` 当前仅影响 sourceRefs 标签，segment 仍生成。

**任务**：
- `mapMutationsToSegments` 入口按 category gate：`if (m.category === "skill_listing" && !rules.injectSkillListing) continue;` 等。
- 单测：每个开关独立关闭，验证 expected segments 数量与 charCount 变化。
- 这是后续"控制变量法"对比 coverage 影响的前提。

**对应**：refine-1 §2.3

---

### P2 — rule-driven 彻底化

#### P2-1 system-reminder / local-command / billing-fallback 入 rule

**问题**：`SYSTEM_REMINDER_TAG` / `LOCAL_COMMAND_TAGS` / `BILLING_HEADER_PREFIX` 是 attribution.ts 的常量。

**任务**：
- 为 `<system-reminder>` 建独立 rule（category=`harness_injection`，section=`messages`，matchMode=`prefix`，segmentPosition=`segment_start`）。
- 为各 local-command tag 建 rule（category=`local_command_history`）。
- 删除 billing prefix fallback——regex rule 不命中时直接落 unknown + finding "billing header 格式异常"，让 audit 显式暴露。
- attribution 主流程仅剩 rule 命中逻辑 + tool_use/tool_result 的 wire schema 分支。

**对应**：refine §7 / refine-2 §5.2

#### P2-2 attribution notes 模板下沉到 rule

**问题**：`if (rule.ruleId === ENVIRONMENT/AUTO_MEMORY/CONTEXT_MGMT/SESSION_GUIDANCE_EMBEDDED)` 硬编码 switch。

**任务**：
- ContextLedgerRule.attribution 增加：

  ```ts
  notesTemplate?: Array<{
    format: string;                     // "cwd={cwd}"
    requireGroup?: string;              // 该 group 必须命中才生成此 note
  }>;
  confidenceOverride?: Confidence;     // 取代 SESSION_GUIDANCE_EMBEDDED 的 special case
  ```

- attribution 主流程根据 notesTemplate 渲染 notes，不再认 ruleId。
- billing-rule 已有 captureGroups（version/entrypoint/cch/workload），把当前硬编码格式迁过去。

**对应**：refine-2 §5.1

#### P2-3 rule.reconciliation.comparePolicy 真正驱动 reconcile

**问题**：字段存在但运行时不消费，reconcile 的比较方式由 M1-M4 优先级隐式决定。

**任务**：
- `matchOneExpected` 在选定 rule（M3.5 ruleId match）后，根据 `rule.reconciliation.comparePolicy` 决定后续比较：
  - `raw_hash` → 必须 rawHash 完全相等才算 matched；不等则 token_mismatch
  - `normalized_hash` → 允许规范化后相等
  - `char_diff` → 量化 charDiff，按阈值（5%）发 finding
  - `structural` → 仅比较结构（section/category/role）
  - `presence_only` → 仅检查存在
  - `known_noise` → step 1 直接处理（已在 P0-2）
- 增加单测：每条 rule 的 comparePolicy 与实际 reconcile 行为一致。

**对应**：refine-1 §1.3 / refine §4

#### P2-4 prior_session_guess 改为证据驱动

**问题**：仅靠"messages[0] 且 totalMessages > 1"猜，第一条真实 user 输入被误标。

**任务**：
- 删除 attribution 的位置性 `prior_session_guess` 分支。
- 改用 JSONL parser 的 `hasPreSessionActivity` + parent UUID chain 作为唯一信号——proxy 侧 attribution 不主动猜测 prior_session，而是 reconcile 阶段在 expected 标了 `prefixIncomplete: true` 时才允许把 messages[0] 标为 prior_session_history。
- `prefixIncomplete` 与 attribution `prior_session_guess` 的双信号合并为 reconstructor 单一输出。

**对应**：refine §7 / refine-1 §2.2

#### P2-5 jsonPath 双向前缀匹配收紧

**问题**：`buildAttrBySegId` 的双向前缀 fallback 注释已承认"过宽 heuristic"。

**任务**：
- 引入 `SourceSpan { jsonPath, charRange, blockIndex, occurrenceIndex }`。
- attribution 输出以 parser segment id 为锚点（不再以粗粒度 jsonPath）；attribution 与 parser 共用 segment 索引。
- 粒度差异在 attribution 层消化——若 attribution 必须粗粒度，需显式拆成多个 attribution 对应多个 parser segment。
- child 覆盖必须有明确 overlap 规则：`containsSpan >= 95%` 或 exact child path。

**对应**：refine §8 / refine-2 §9.J

#### P2-6 confidence 三维拆分

**问题**：regex 命中 + group 全填就升 `exact`，混淆"识别确信"与"复现确信"。

**任务**：
- ProxySegmentAttribution 拆为：
  - `classificationConfidence`：这段是什么（regex 命中可达 exact）
  - `materializationConfidence`：target 能否复现（regex rule 通常封顶 estimated）
  - `comparisonGrade`：`exact` / `normalized` / `template` / `regex` / `presence`
- 现有 `confidence` 标 deprecated；coverage 计算改用 `comparisonGrade` 决定归桶。

**对应**：refine §5 / refine-2 §9.C

#### P2-7 contentPattern 与 attribution.pattern 单源

**问题**：exact_text rule 的 attribution.pattern 与 reconstruction.emits.contentPattern 是同一段文字的两份拷贝，升级时易漂移。

**任务**：
- exact_text rule 只保留一份文本字段（`canonicalText`），attribution 与 reconstruction 都从它派生（attribution.pattern = canonicalText，contentPattern = canonicalText）。
- 单测：迭代每条 rule，自动用 contentPattern 跑 attribution.pattern 必须命中。

**对应**：refine-2 §9.A

#### P2-8 regex anchor 约定统一

**问题**：Environment 用 `^# Environment\n` 不锚尾，BILLING 全锚 `^...$`，TOOL_AGENT 用 `^...[\s\S]*$` 容忍尾部噪声——混用导致 trailing trash 在某些 rule 命中、其他 rule 不命中。

**任务**：
- 约定：所有 segment-level 的 regex pattern 都 `^...$`（用 m+s flag，多行 + dotall）；尾部需要容忍噪声的 rule 用显式 `[\s\S]*$`。
- 单测：每条 regex rule 在 fixture 上验证完整 segment 匹配（trailing 不溢出）。

**对应**：refine-2 §9.B

---

### P3 — 表达力提升

#### P3-1 引入 TargetRequest AST

**问题**：当前只有扁平的 `ExpectedQueryContext.segments`，没有 request-level exact 比较。

**任务**：
- 定义 `TargetRequest`：

  ```ts
  {
    request: { model, max_tokens, stream, context_management, output_config, ... };
    system: TargetSegment[];
    tools: TargetSegment[];
    messages: TargetMessage[];
    sourceMap: SegmentSourceMap;
    rulesApplied: AppliedRule[];
    unmaterializedRules: string[];
    canonicalJson: string;
    canonicalHash: string;
  }
  ```

- 三档对账：
  - raw exact：`rawReqBodyBytesHash === target.canonicalHash`（仅当 target 也按 wire 序列化输出）
  - canonical exact：`canonicalRequestHash === target.canonicalHash`
  - structural exact：JSON 结构相等，字符串字段允许 placeholder 替换
- coverage 增加 `requestLevelExact`：raw / canonical / structural / segment-only。

**对应**：refine §2（独有）

#### P3-2 MatchKind / Confidence / DiffKind 合并

**问题**：三套语义近似的枚举并存，认知负担。

**任务**：
- 用 P2-6 的 `comparisonGrade` 取代 MatchKind / DiffKind 大部分用途。
- `Confidence` 仅保留为 classification/materialization 两个独立字段（也来自 P2-6）。
- char-diff 的 DiffKind 与 reconcile 的 FindingType 合并：`matched_exact` ↔ `matched`，`matched_char_diff` ↔ `approximate_match`，`suspect_match`、`expected_only`、`proxy_only`、`attribution_only`、`known_noise`（→ `server_side_attribution`）。

**对应**：refine-1 §2.4

#### P3-3 char-diff 与 reconciliation 指标合一

**问题**：char-diff 文件头声明"debug-only NOT imported"，但 audit/scorecard 实际依赖；同名指标两处独立计算。

**任务**：
- 删除 char-diff 的"debug-only"声明。
- 同名指标只能由一处计算（reconciliation 为权威），char-diff 仅做渲染层（接收 ReconciliationReport，输出 UI 友好结构）。
- audit/scorecard 不再用 `diff.summary.evidenceBackedCoverage * diff.summary.totalProxyChars` 倒推；直接读 reconciliation 字段。

**对应**：refine-2 §8

#### P3-4 pipeline 支持 attribution-only 报告

**问题**：`jsonlFile === null` 直接 skip，无法独立验证 attribution。

**任务**：
- pipeline 新增 attribution-only 模式：proxy → snapshot → attribution → reconcile（expected=undefined）。
- audit 输出"哪些 proxy query 没有 JSONL 对应"的分布与原因（找不到匹配 / 不在时间窗 / 等等）。

**对应**：refine-1 §3.1

#### P3-5 fixture 与版本治理

**问题**：现有 fixture 是 ant-native build 录制；多条 system rule `verifiedFor: null` 仍参与命中；高覆盖率部分来自"过时 fixture × 过时 rule"循环。

**任务**：
- 录制至少 2 份 external CLI（非 ant-native）真实 fixture 作为校验集。
- `verifiedFor === null` 的 rule：classificationConfidence 强制降为 `inferred`，不进入 evidenceBacked / wireExact / canonicalExact / template 等高层级；仅可贡献 `attributionOnlyCoverage`。
- audit verdict 增加约束：pending rule 贡献 chars / 总 chars > 30% → 直接 `needs_review`。
- 升级 SUPPORTED_CLAUDE_CODE_VERSION 时强制 batch reset 所有 verifiedFor 为 null（已在 README，但实际状态未对齐）。

**对应**：refine-2 §6

#### P3-6 文档与残留清理

**任务**：
- README 的"Required Now"章节按已实现/未实现重新分组，避免误导。
- 删除 `SegmentLink` 别名（无实际使用者）。
- 把 `rule-registry.ts` 里 Environment rule 注释的韩文片段改回中文。
- preCondition 字段做出选择：要么变为机器可读（升级为结构化判定），要么明确为人读注释、把判定移到 `queryScope` + `attributionRequired` + `triggerEvidence`。
- `tools_schema rule.location.jsonPathHint = "reqBody.tools[*]{name=Edit}.description"` 这类既非 JSONPath 标准也不被运行时使用的字段，加注释明确"hint 不参与匹配"或者删除。
- 删除 `void attributionOnlyChars`（已在 P0-2 一并清理）。

**对应**：refine-1 §4 / refine §3 注解 / refine-2 §3+§9.I

---

## 5. 验收标准（继承自 refine.md，扩充三家）

E0 完成时，一条 audit run 应能先回答：

1. 当前 run 使用了哪些 audit mode flags，baseline runId 是什么。
2. 同一 query 在 current / `--no-r9` / `--verified-only` 下 coverage 分桶如何变化。
3. coverage 下降时来自哪个桶：exact/template/regex/presence/attribution-only/pending/unknown，而不是只有一个总数。
4. fixture 来源矩阵、rule-vs-cli 验证结果、pending rule 占比是否进入报告。
5. proxy_without_jsonl 是否能被统计，并有 attribution-only 或 skipped 的明确原因。

全量修正完成后，一条 audit report 还应能回答：

1. proxy raw request 是否完整保留，wire bytes hash 是什么。
2. target request 是否仅由 mutation + rule 正向生成，没有 proxy 反向注入（**P0-1 invariant 测试通过**）。
3. request-level：raw exact / canonical exact / structural exact 三档结果（**P3-1**）。
4. segment-level：每段属于 exact / template / regex / placeholder-resolved / presence / attribution-only / server-side-attribution / unexplained 中哪一类（**P0-2 + P1-1**）。
5. template/regex 命中的 captures 是哪些字段，字符范围与占比（**P1-1 RuleMatchEvidence**）。
6. regex/template 占比是否超过阈值（默认 60%），是否触发 `regex_too_loose` finding（**P1-1**）。
7. billing / system-reminder / memory / env / tool schema 等动态字段是否被归为正确口径（**P2-1**）。
8. 每条 rule 的 `comparePolicy` 与实际 reconcile 行为一致（**P2-3 单测**）。
9. coverage 下降时能区分：真实 regression / rule 未物化 / proxy-only attribution / fixture 不完整 / pending rule 占比过高（**P3-5 verdict**）。
10. 关闭单条 HarnessRuleConfig 开关能产生可控的 coverage 变化（**P1-5 单测**）。
11. proxy 无 JSONL 对应时也能产出 attribution-only 报告（**P3-4**）。
12. attribution 主流程不再含 `if rule.ruleId === XXX` 硬编码分支（**P2-1+P2-2 grep 验证**）。

---

## 6. 修正前后数据流对照

### 修正前（当前）

```
proxy dump ──► snapshot ─► attribution ─┐
                          │              │
                          └─► rawText ──► R9 ─► expected.segments
                                          │           │
                                          └───────────┴─► reconcile ─► evidenceBackedCoverage 虚高
                                                          (M1 raw_hash 自匹配)

audit/discovery 把 reqBody 解析后覆盖 → wire bytes 信息丢失
char-diff 标 "debug-only" 但 scorecard 实际在用 → 同名指标双源
HarnessRuleConfig 开关只改标签不 gate segment → 无法做控制变量
```

### E0 先行（新增）

```
proxy/jsonl fixture 或 local data
  ├─► current audit
  ├─► no-r9 audit
  ├─► verified-only audit
  └─► proxy-only audit
           │
           ▼
    scorecard v2 + baseline delta
           │
           ▼
    决定 P0/P1/P2 的真实优先级与验收阈值
```

### 修正后（目标）

```
proxy raw bytes ──► rawReqBodyText (preserved)
                    canonicalReqBodyText
                    parsedReqBody
                          │
                          ▼
                    snapshot ─► attribution ─► RuleMatchEvidence
                                                  (literal/placeholder spans)
                                                  + SourceSpan (precise overlap)

JSONL/memory/harness ─► mutations ─► reconstruct
                                     │
                                     ├─ exact_text rule  → contentPattern → rawHash
                                     ├─ normalized_text  → resolvePlaceholders → hash
                                     ├─ shape/presence   → 仅 charCount，不读 proxy
                                     └─ unavailable      → unimplementedRules
                                                                 │
                                                                 ▼
                                                           TargetRequest AST
                                                           + canonicalHash
                                                                 │
                                                                 ▼
                                                            reconcile
                                                                 │
                                                                 ▼
                                  request-level: raw/canonical/structural exact
                                  segment-level: exact / template / regex /
                                                 placeholder-resolved / presence /
                                                 attribution-only / server-side /
                                                 unexplained
                                  治理指标:     placeholderRatio,
                                                 regexOverreachRisk
```

---

## 7. 风险与权衡

| 风险 | 触发场景 | 缓释 |
|------|----------|------|
| E0 前置让架构修正看起来"变慢" | 团队期待马上改 R9/TargetRequest | E0 限定为一个短 PR，只做观测、开关、scorecard 兼容字段，不改业务语义 |
| 当前 baseline 本身被 R9 污染 | 用现有 `evidenceBackedCoverage` 作为质量目标 | baseline 只作为负控制和 delta 参照，不作为"正确覆盖率"目标 |
| local audit 读取真实会话隐私 | 执行 `context:audit --all-local` | 产物只写本地 `~/.api-dashboard/context-audit/`；PR 中只贴聚合指标，不贴敏感 payload |
| P0-2 重构后 evidenceBackedCoverage 数字大幅下降 | shape 类 rule 不再贡献 | 提前在团队对齐"短期下降换取真实指标"；对照报告同时输出新旧两套指标 1 个 release |
| P0-3 raw bytes 保留增加存储 | 大请求场景 | 仅保留近 N 天或抽样；canonicalHash 永久保留 |
| P3-1 TargetRequest AST 工程量大 | 需要 system/tools rule 全部 materialize | P0-P2 完成后再启动；先支持 segment-level，request-level 逐步落地 |
| P1-2 task_reminder "加法" 改造可能影响其他 attachment | hooks / memory pre-prompt 类似 smoosh 模式 | 同期审视所有 smoosh 类型，统一改造 |
| P1-4 N:1 merge 实现不完全 | 现有 fixture 不覆盖 string content | 实现 + 合成测试覆盖；时间不足时降级关闭 R3 |
| P2-1 删除 billing fallback 可能让现有 audit 出现告警 | 真实 billing header 微变 | 升级 BILLING regex 兜底字段（已有 `(?:; \w+=[^;]+)*`），同时把 fallback 改为"显式告警"而非"静默归类" |

---

## 8. 任务依赖图（关键路径）

```
T0 (立即验证前提) ─► E0 (evaluate/audit 加固)
                         │
                         ├─► P0-1 (R9 拆路径) ─────────┐
                         ├─► P0-2 (覆盖率重构) ────────┼─► P1-1 (placeholder 度量) ─► P3-3 (char-diff 合一)
                         └─► P0-3 (raw body 保真) ─────┘                                     │
                                                                ▼
P1-2 (task_reminder 加法) ──┐                              P3-1 (TargetRequest AST)
P1-3 (attribution 单一权威)─┼─► P2-3 (comparePolicy 驱动)        │
P1-4 (N:1 merge)            │                                    │
P1-5 (HarnessRuleConfig)────┘                                    │
                                                                ▼
P2-1 (magic constants 入 rule) ──┐                          P3-2 (枚举合并)
P2-2 (notes 模板下沉) ───────────┼─► P2-7 (单源) ─► P2-8 (anchor 统一)
P2-4 (prior_session 证据驱动) ───┤
P2-5 (jsonPath 收紧) ────────────┤
P2-6 (confidence 三维) ──────────┘
                                                                ▼
                                                          P3-4 (pipeline attr-only)
                                                          P3-5 (fixture 治理)
                                                          P3-6 (文档清理)
```

T0 是立即动作；E0 是后续所有架构改动的观测前置。E0 之后，P0 三个任务可以并行启动；P1 大部分依赖 P0-1 与 P0-2 落地；P2 依赖 P1 提供的 attribution 单一权威与可执行 ruleConfig；P3 的 TargetRequest 与指标合一不再作为第一步，但作为终态方向持续约束 P0/P1/P2 的接口设计。

---

## 9. 当前未决问题（需在动手前对齐）

来自三份报告的"假设/缺失信息"汇总：

1. proxy 的 `traffic.jsonl` 是否在所有路径下完整保留 reqBody 原始字节？（refine §3 已指出 audit 入口会破坏此假设——P0-3 修复）
2. Claude Code 是否承诺保持当前 Messages API request 结构？升级时新增版本化 rule 还是同 rule 内分支？（建议：版本化 rule，配合 SUPPORTED_CLAUDE_CODE_VERSION 单版本策略）
3. harness runtime state（enabled tools / settings / memory path / output style / language / context management）是否能完整暴露给 reconstructor？没有这些输入，system/tools rule 永远停留在 template/presence。这是 P3-1 TargetRequest 的强依赖。
4. external CLI fixture 何时能录制？P3-5 的"非 ant-native fixture"是后续多个验证步骤的前提。
5. P0-3 raw body 保留对存储的影响是否可接受？需要与运维侧对齐保留策略。
6. E0 的 `--no-r9` 开关是通过正式配置进入 pipeline，还是先作为 audit-only harness 开关？推荐先 audit-only，避免第一步改变生产路径。
7. scorecard v2 字段是否允许在一个迁移周期内与旧 `evidenceBackedCoverage` 并存？推荐并存，但 UI/报告必须标注旧指标为 legacy。

---

> **执行原则**：T0 立即展开，E0 先于所有语义重构；P0 必须在 E0 提供可对照报告后推进（否则后续指标仍不可解释）；P1-P2 可按依赖图并行；P3 是终态约束而不是第一步大爆炸。任何阶段的代码改动都必须配套单测与 fixture 验证；reconciliation 的覆盖率指标变化在每个阶段切换时输出对照报告（旧指标 vs 新指标 vs 控制变量），便于审视。
