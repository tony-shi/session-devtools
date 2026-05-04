# Context Ledger 修正工作方案（final）

> 整合自 `refine.md` / `refine-1.md` / `refine-2.md` 三份审视报告。
> 范围：`server/src/context-ledger/` 全模块。
> 性质：**已执行工作的存档 + 残留任务清单**——已完成条目已移除，仅保留未完成与有上下文注记需要说明的项。

---

## 0. 执行状态总览（2026-05-04）

绝大部分阶段已完成。当前仅剩两个未完成任务：

| 未完成任务 | 状态 | 说明 |
|------------|------|------|
| **P1-4 N:1 merge** | `tryMergeAlignment` 仍是 `return null` stub | 已回退上一次不完整实现（revert commit `10e48a4`） |
| **P3-4 attribution-only 模式** | `jsonlFile === null` 时直接 skip，无独立 attribution 报告输出 | pipeline 只有单路 reconcile，没有无 JSONL 时的 proxy-only 路径 |

### 关于 E0 控制开关的特殊演变

E0 任务中的"控制变量开关"（`--no-r9` / `--verified-only` / `--proxy-only` / `--compare-modes`）经历了以下过程：

1. **commit `2544800`**：实现了完整的三路 pipeline 对照（current / no-r9 / verified-only），输出 `ModeComparisonRow[]` 和三列对比表。
2. **commit `a9c062e`**：删除了上述所有控制开关和对照逻辑（-43% 代码量）。

删除原因：P0-1 完成后，R9 反写路径已彻底切断，`injectFromAttributions` 开关本身消失，对照"有无 R9"的意义消失。`--verified-only` 开关也因 `pendingRuleCoverage` 已内置进 scorecard 指标而不再需要独立路径。**控制变量的信息已内化为常态指标，不需要多路 pipeline。**

E0 中**保留并已完成**的部分：
- scorecard v2 字段（wireExactCoverage / canonicalExactCoverage / templateCoverage / regexCoverage / regexOverreachRisk / pendingRuleCoverage）
- baseline 按 mode 分域（fixtures / all-local / since-last 各自维护 latest 和 baseline 指针）
- audit run 包含环境和规则元数据（rule-vs-cli summary、fixture source matrix）
- scorecard verdict 阈值（`pendingRuleCoverage > 30%` → `needs_review`、`regexOverreachRisk > 60%`）

---

## 1. 残留未完成任务

### P1-4 N:1 merge — 本地数据扫描结果（2026-05-04）

**扫描范围**：本地 244 个 JSONL 文件（`~/.claude/projects/` 全量）。

**发现**：找到 53 个 `multi_block_tool_result` case（一个 tool_result 的 `content` 是多个 block 的数组），分布在多个 session 和项目中。

**但这 53 个 case 均不构成 N:1 merge 问题**，原因是：

- **proxy-snapshot-parser** 已将多 block 的 `content[]` 拼接为单个 segment（`\n` 连接），proxy 侧只有 1 个 segment
- **expected-context-reconstructor** 同样将 multi-block tool_result 重建为单个 segment，rawHash 完全一致
- 两侧 hash 相同，直接走 M1 raw_hash 匹配，无需 merge 逻辑

**验证**：
```
proxy rawText:    "First block\nSecond block"   → sha256:9d3250beca8eacdf
expected rawHash: sha256:9d3250beca8eacdf       ← 完全一致
```

**结论**：本地所有 2.1.126 数据中未找到需要 N:1 merge 的实际场景。`tryMergeAlignment` stub 不影响现有任何 case 的对账结果。**可以安全删除 merge 相关架构代码**（`tryMergeAlignment`、`groupByLogicalMessage`、`logicalMessageId` 打标逻辑），或保留 stub 不动。

---

### P3-4 pipeline 支持 attribution-only 报告

**状态**：未实现。`pipeline.ts` 中 `jsonlFile === null` 直接 skip，返回 `status: "skipped", skipReason: "proxy_without_jsonl"`，没有 attribution-only 输出路径。

**问题**：`jsonlFile === null` 直接 skip，无法独立验证 attribution。

**任务**：
- pipeline 新增 attribution-only 模式：proxy → snapshot → attribution → reconcile（expected=undefined）。
- audit 输出"哪些 proxy query 没有 JSONL 对应"的分布与原因（找不到匹配 / 不在时间窗 / 等等）。

**对应**：refine-1 §3.1

---

## 2. 已完成任务存档（验证截止 2026-05-04）

以下任务均已在代码中落实，列出关键 commit 供查阅。

| 阶段 | 任务 | 关键 commit | 验证方式 |
|------|------|-------------|----------|
| T0 | 验证前提固化（baseline、rule-vs-cli、fixture matrix） | `4fddec0` | `bun run scripts/verify-rules-against-cli.ts` |
| E0 | scorecard v2 字段 + baseline 分域 + verdict 阈值 | `278c71a` | `audit/types.ts` `QueryScorecard` v2 字段 |
| E0 | audit run 环境元数据 | `4fddec0` | `run.json` 含 rule summary、fixture source |
| P0-1 | R9 禁止 proxy 反写，`injectFromAttributions` 彻底切断 | `d565977` → `a9c062e` | `expected-context-reconstructor.ts` 无 proxySegmentsById |
| P0-2 | 覆盖率正交分桶，清除 `void attributionOnlyChars` 死代码 | `e6708f8` | `reconciliation-engine.ts` CoverageSummary 重构 |
| P0-3 | proxy raw body 保真（`_rawReqBodyText` / hash 三层） | `f6d68d6` | `discovery.ts:147-180` |
| P1-1 | RuleMatchEvidence 结构化占位符证据 | `6b791ff` | `proxy-attribution.ts:144-187` |
| P1-2 | task_reminder smoosh 改加法重建，删 `tail_injection_chars` | `1dcc9d6` | `expected-context-reconstructor.ts:367-667` |
| P1-3 | attribution.category 单一权威，reconcile 三处统一 | `260d83b` | `proxy-attribution.ts:335-336` |
| P1-5 | HarnessRuleConfig 开关真正 gate segment 生成 | `23c8ee6` | `expected-context-reconstructor.ts:399-402` |
| P2-1 | SYSTEM_REMINDER / LOCAL_COMMAND / BILLING 入 rule | `320e930` | `proxy-attribution.ts:51` 注释 |
| P2-2 | attribution notes 模板 `notesTemplate` 下沉到 rule | `320e930` | `rule-registry.ts:149-155` |
| P2-3 | `comparePolicy` 真正驱动 reconcile | `5710ee3` | `reconciliation-engine.ts:529-567` |
| P2-4 | `prior_session_guess` 改为 `prefixIncomplete` 证据驱动 | `5710ee3` | `proxy-attribution.ts:335-336` |
| P2-5 | jsonPath 双向前缀匹配改为 segment id 精确索引 | `5710ee3` | `reconciliation-engine.ts buildAttrBySegId` |
| P2-6 | confidence 三维拆分（classificationConfidence / materializationConfidence / comparisonGrade） | `5710ee3` | `types.ts:342-343,403` |
| P2-7 | contentPattern 与 attribution.pattern 单源 | `392f96d` | `rule-registry.ts:174` |
| P2-8 | regex anchor 约定统一（`^...$` + m+s flag） | `392f96d` | rule-registry regex 统一规范 |
| P3-1 | TargetRequest AST + canonicalHash + request-level 三档对账 | `a71cf7e` → `c6375df` | `target-request-builder.ts` + `reconciliation-engine.ts:119-157` |
| P3-1 | TargetRequest model 正向推断（inferredModel） | `2544800` | `jsonl-mutation-parser.ts` + `target-request-builder.ts` |
| P3-2 | MatchKind / Confidence / DiffKind 枚举合并为 comparisonGrade | `a71cf7e` | `types.ts:402-403` |
| P3-3 | char-diff 与 reconciliation 指标合一，reconcile 为权威 | `724b90b` | `debug/char-diff.ts` 删除 "debug-only" 声明 |
| P3-5 | `verifiedFor` 降级策略（confidence 强制 inferred + pendingRuleCoverage 统计） | `36c7eab` | `proxy-attribution.ts:280-284`；`scorecard.ts:24-103` |
| P3-6 | 文档清理（SegmentLink 已删、韩文注释已改、preCondition 结构化、README 更新） | `adad6d0` | `rule-registry.ts`、`types.ts`、`README.md` |

---

## 3. 上下文注记（有歧义或值得记录的架构决策）

### 3.1 P3-5 外部 CLI fixture 录制状态

`rule-registry.ts:302-308` 的注释表明 ant-native 变体已删除，fixture 已改为从真实 external CLI 会话（session-dashboard 主 worktree）录制。但录制数量和覆盖情况尚未有正式的 fixture matrix 记录。`verifiedFor: null` 的 rule 数量仍多（≥10 条），`pendingRuleCoverage` 在实际 run 中的实际数值需要运行 `bun run context:audit:fixtures` 确认。

### 3.2 P3-1 raw exact 对账尚不可用

`target-request-builder.ts:119-129` 注释明确：raw exact（`rawReqBodyBytesHash === target.canonicalHash`）在 target 按 wire 格式序列化之前无法比对。当前仅 canonical exact 和 structural exact 可用。

### 3.3 P3-4 与 P1-4 的优先级评估

P3-4（attribution-only 模式）对当前 audit 实际使用影响较小——主要影响 `proxyWithoutJsonl` 的 query 能否独立归因。P1-4（N:1 merge）影响 string content 场景的对账准确率。两者均属"nice-to-have"，不影响主要路径的正确性。

---

> **当前状态**：核心架构目标（正向重建、禁止 proxy 反写、coverage 分桶、rule-driven、TargetRequest AST）已全部落地。残留的 P1-4 和 P3-4 属于边缘场景补全，可按需推进。
