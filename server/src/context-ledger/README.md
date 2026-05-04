# Context Ledger Contract

This module defines the minimal stable contract for Claude Code attribution work. It is intentionally limited to types, report schema, mock report data, tests, and fixture conventions.

It does not implement a proxy parser, JSONL parser, reconciler, storage layer, routes, or UI.

## Layer Boundaries

### Fact Layer

`ProxyQuerySnapshot` records the request captured by proxy ground truth. It contains request-level metadata, usage, and `ContextSegment[]` entries for sections such as `system`, `tools`, and `messages`.

The fact layer can point back to proxy files and JSON paths with `SourceRef.kind = "proxy"`.

### Attribution Layer

`ProxySegmentAttribution` is a formal contract object, not debug-only data. It is proxy-first reverse attribution: it labels what a proxy segment appears to be and which mechanism likely explains it, for example `tool_use_id_match`, `tools_schema_pattern`, or `local_command_pattern`.

Attribution can use proxy evidence, but it is not a mutation ledger and must not be treated as proof that a JSONL or memory event occurred. It is allowed to say "this looks like a tool_result because the proxy block has a tool_use_id"; it is not allowed to create a `ContextMutation` from that observation.

### Explanation Layer

`ContextMutation` records why expected context changed. Its `source` is restricted to:

- `jsonl`
- `memory_fs`
- `harness_rule`
- `hook`
- `prior_session`
- `unknown`

`ContextMutation.source` and `ContextMutation.sourceRef` intentionally exclude `proxy`. If a segment only appears in proxy output, it remains an audit finding until an independent source or harness rule explains it.

`ExpectedQueryContext` is the forward reconstruction result derived from mutations and rules. In this phase it is a serializable intermediate product, not a persisted state machine.

### Audit Layer

`ReconciliationReport` compares `ExpectedQueryContext`, `ProxyQuerySnapshot`, and `ProxySegmentAttribution`.

Unexplained proxy blocks, unmatched expected blocks, order mismatches, token mismatches, N:1 merge alignments, retry observations, and known noise all belong in `AlignmentRef` or `ReconciliationFinding`.

## Forbidden Data Flow

Do not write proxy diffs back into `ContextMutation`.

Correct flow:

```text
JSONL / hooks / memory FS / harness rules / prior session
  -> ContextMutation
  -> ExpectedQueryContext

proxy dump
  -> ProxyQuerySnapshot
  -> ProxySegmentAttribution

ExpectedQueryContext + ProxyQuerySnapshot + ProxySegmentAttribution
  -> ReconciliationReport
```

Incorrect flow:

```text
proxy diff -> ContextMutation
```

That creates circular attribution and removes the audit value of the report.

## Contract Status

### Implemented

- `AgentKind` and `AgentCapabilityMatrix` — multi-agent support beyond Claude Code.
- `SourceRef` variants — JSONL lines, proxy JSON paths, memory files, harness rules, hooks, prior sessions, unknown.
- `ContextSegment.section` and `ContextSegment.category` — stable segment grouping.
- `agentId`, `subagentId`, `parentAgentId` — subagent fixture support without contract break.
- `rawHash`, `normalizedHash`, `charCount`, `tokenEstimate` — exact, approximate, bloat-oriented matching.
- `toolUseId` — tool_use/tool_result alignment.
- `AlignmentRef` — 1:1, 1:N, and N:1 relationships, with `comparisonGrade` replacing legacy `matchKind`.
- `CoverageSummary` — orthogonal char buckets (wireExact / canonical / template / regex / presence / serverSide / attributionOnly / unexplained).
- `Confidence` / `ClassificationConfidence` / `MaterializationConfidence` — distinguishes exact evidence from estimated or inferred.
- `RuleMatchEvidence` and `RuleMatchCapture` — structured regex/template match evidence with per-capture char spans (P1-1).
- `FindingType` — merged enum covering match quality, single-side mismatches, and governance findings.
- `ComparisonGrade` — replaces MatchKind/DiffKind across reconcile and char-diff layers (P3-2).
- `TargetRequest` / `TargetSegment` / `TargetMessage` / `SegmentSourceMap` — forward-reconstructed request AST (P3-1).
- `RequestLevelExact` — raw / canonical / structural / segment-only exact levels (P3-1).
- `RulePreCondition` — structured (machine-readable) reconstructor activation conditions (P3-6).
- `ProxyQuerySnapshot.canonicalRequestHash` / `rawRequestBytesHash` — P0-3 wire-bytes hash fields.
- `CoverageSummary.suspectMatchChars`, `alignedTextDriftChars` — governance metrics (P3-3).

### Not Yet Implemented (pending rule)

- `wireExactCoverage` populated from `rawRequestBytesHash` — depends on P0-3 proxy raw body preservation.
- `requestLevelExact` populated in reconcile output — depends on P3-1 TargetRequest full materialization.
- `RulePreCondition` machine evaluation in reconstructor — type is defined; evaluation logic is a future step.
- `RuleLocationConstraint` precise span matching — `orderHint` is advisory only; full `SourceSpan` (P2-5) not yet introduced.

## Rule Registry

`rule-registry.ts` 是 attribution rule 的元数据与查找层，独立于 parser、reconciler 和 ContextMutation。

### 当前 registry 状态

每条 rule 的字段：`ruleId / verifiedFor / matchMode / stability / sourcemapRef`。
`verifiedFor` 字段值含义见下节"版本口径"。

### 版本口径（B1.4 单版本策略）

我们只针对**当前实际安装**的一个 Claude Code 版本维护 rule，不做跨版本兼容。

- 当前目标版本由 `SUPPORTED_CLAUDE_CODE_VERSION` 常量声明（见 `rule-registry.ts` 顶部，当前 `2.1.126`）。
- 每条 rule 的 `verifiedFor` 字段记录"已对照该版本人工校对通过的版本号"：
  - `verifiedFor === SUPPORTED_CLAUDE_CODE_VERSION` → 已校对，audit 报告标"verified"
  - `verifiedFor === null` → 待人工校对（运行时仍参与 attribution，但 audit 报告标"pending"）
  - 其它字符串（如旧版本号）→ 等同于 null
- 升级 `SUPPORTED_CLAUDE_CODE_VERSION` 时，所有 `verifiedFor` 必须批量重置为 `null` 并逐条复审。
- 校对来源优先级（与 AGENTS.md §6.3 一致）：
  - **P0 事实**：`~/.api-dashboard/proxy/traffic.jsonl` dump + 本地安装的 `cli.js`（grep 验证）
  - **P1 参考**：`claude-code-sourcemap@2.1.88` 还原源码 / `claude-code-survey` 文档

辅助工具：调用 `getRuleVerificationSummary()` 可拿到 `{ supportedVersion, total, verified, pending, pendingRuleIds }`。

### 新增/修订 rule 的人工审核流程

1. 在本地安装的 `cli.js` 里 grep 目标字段，确认当前版本的真实文本。
2. 在 `~/.api-dashboard/proxy/traffic.jsonl` 里找 ≥1 条真实 dump 样本验证 pattern。
3. （可选参考）在 `claude-code-sourcemap/restored-src/` 中找对应源码段，理解语义。
4. PR 中附上 dump 行号 + cli.js grep 结果 + sourcemap 路径，reviewer 人工确认。
5. 确认后在 `rule-registry.ts` 中将 `verifiedFor` 设为 `SUPPORTED_CLAUDE_CODE_VERSION`，**不接受自动推断写入**。
5. 同步更新 `mock-report.json` fixture（通过 `bun -e` 重新生成）。

### 禁止的数据流

- proxy diff 只能产生 **candidate rule** 供人工审核，不能自动写入 registry 或 ContextMutation。
- attribution 识别出某段疑似新 rule 时，走 `mechanism: "unknown"` + finding，等人工审核后才入 registry。

## Reserved For Later

- `metadata` fields are reserved for adapter-specific raw details and must not become required consumer semantics.
- `request.contextManagement`, cache fields, compaction categories, subagent identity fields, hooks, and memory fields are present so later branches do not need to break the contract.
- `ContentRef.kind = "external"` and `ContentRef.kind = "omitted"` are for large payloads and privacy-sensitive data.
- `AgentKind = "custom"` and `SegmentCategory = "unknown"` are escape hatches for adapter incubation, not a replacement for adding stable categories once patterns repeat.
