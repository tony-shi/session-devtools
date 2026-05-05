# Context Ledger 模块说明

> 状态：实现导览
> 设计入口：`docs/draft/context/context-ledger-current.md`

## 结论

`context-ledger` 当前已经不是单纯的 contract stub，而是一条可运行的 Claude Code context reconstruction / attribution / audit pipeline。

核心数据流：

```text
JSONL mutations + RuleRegistry + HarnessRuntimeSnapshot
  -> ExpectedQueryContext
  -> TargetRequest

ProxyQuerySnapshot + ProxySegmentAttribution
  -> ReconciliationReport / Audit artifacts
```

proxy 只能作为事实层和 audit 对账输入，不能反向写入 `ContextMutation`、`ExpectedQueryContext` 或 `TargetRequest.sourceMap`。

## 模块边界

### Fact Layer

- `proxy-snapshot-parser.ts`
  - 解析 proxy dump / request body。
  - 产出 `ProxyQuerySnapshot`。
  - 允许 `SourceRef.kind = "proxy"`。

- `proxy-block-splitter.ts`
  - 将 proxy request body 中的 system/tools/messages 拆成可对账 segment。

### Attribution Layer

- `proxy-attribution.ts`
  - 对 proxy segment 做反向识别。
  - 产出 `ProxySegmentAttribution`。
  - 可以使用 proxy raw text，但结果只进入 reconcile / audit。

### Reconstruction Layer

- `jsonl-mutation-parser.ts`
  - 从 JSONL 解析 `ContextMutation[]`。
  - 同时构建第一版 `HarnessRuntimeSnapshot`。
  - 不读取 proxy。

- `expected-context-reconstructor.ts`
  - 按 query boundary 切片 mutation。
  - 应用 R1-R8 上下文组装规则。
  - 调用 `materializeHarnessRules()` 从 `RuleRegistry.reconstruction` 正向生成 system/tools 等 rule segment。
  - 不接收 `ProxyQuerySnapshot` 或 attribution。

- `rule-registry.ts`
  - rule 的 attribution / reconstruction / reconciliation 三面定义。
  - 当前只维护 `SUPPORTED_CLAUDE_CODE_VERSION = "2.1.126"`。

- `tool-schema-registry.ts`
  - verified built-in tool schema 的正向 materialization 来源。

### Target Layer

- `target-request-builder.ts`
  - 从 `ExpectedQueryContext` 构建 `TargetRequest`。
  - 生成 canonical JSON / canonical hash / sourceMap。
  - 过滤 sourceMap 中的 proxy sourceRef。
  - 标注 request scalar 的 `proxy_snapshot_fallback` 字段。

### Reconciliation Layer

- `reconciliation-engine.ts`
  - 对齐 expected / target 与 proxy ground truth。
  - 输出 `ReconciliationReport`、`CoverageSummary`、`RequestLevelExact`。
  - 使用正交 coverage 桶区分 exact、template、presence、server-side、attribution-only 和 unexplained。

### Audit Layer

- `audit/discovery.ts`
  - 发现 fixture 或本地 proxy/jsonl 匹配。

- `audit/pipeline.ts`
  - 串联 parse proxy、attribution、parse JSONL、reconstruct expected、build target、reconcile、char diff。

- `audit/scorecard.ts`
  - 计算 per-query scorecard 和 baseline delta。

- `audit/report-generator.ts`
  - 生成 run 级 Markdown / HTML。

- `audit/render-reconcile-fusion-html.ts`
  - 生成单 query 的融合视图。

- `debug/char-diff.ts`
  - 生成字符级 diff，辅助人工校对。

## 已实现的不变量

- `ContextMutation.sourceRef` 不允许 proxy。
- `reconstructExpectedClaudeContext()` 输入不包含 proxy / attribution。
- `ExpectedQueryContext.segments[].sourceRefs` 不允许 proxy。
- `TargetRequest.sourceMap[].sourceRefs` 不允许 proxy。
- proxy request scalar fallback 必须进入 metadata，不得算作完整正向重建。
- rule 未通过当前版本 verified 时，不应贡献 evidence-backed exact / template 语义。
- `presence / shape / unavailable` 只能表达存在性或缺口，不能升级为 exact。

## 当前已实现

- JSONL mutation parser。
- Proxy snapshot parser。
- Proxy attribution。
- Rule registry 三面模型。
- Rule materializer。
- `HarnessRuntimeSnapshot` 第一版。
- `RulePreCondition` evaluator，包括 `!xxx` flag 否定前缀。
- system billing presence 与 identity exact materialization。
- verified built-in tools materialization。
- TargetRequest AST / sourceMap / canonical hash。
- request scalar provenance。
- reconciliation 正交 coverage 桶。
- fixture audit、baseline、scorecard、HTML artifact。

## 仍是后续工作

- 从本地 settings / env / 当前 `cli.js` 补齐 `HarnessRuntimeSnapshot`。
- 用 runtime snapshot 替代更多 request scalar proxy fallback。
- 完整实现 `system_reminder_per_turn`、`prior_session_history`、`compaction_replacement`。
- 引入精确 `SourceSpan`，替代部分 `RuleLocationConstraint.orderHint`。
- 扩展 MCP/plugin tool 的安全表达方式：默认 attribution-only，不伪造 exact schema。

## 常用验证

```bash
bun test server/src/context-ledger/jsonl-mutation-parser.test.ts
bun test server/src/context-ledger/expected-context-reconstructor.test.ts
bun test server/src/context-ledger/target-request-builder.test.ts
bun test server/src/context-ledger/reconciliation-engine.test.ts
bun test server/src/context-ledger/audit/audit.test.ts
bunx tsc --noEmit
```

Audit 验证：

```bash
CONTEXT_AUDIT_HOME="$PWD/.audit/reconstruct" \
  bun run context:audit:fixtures --no-update-latest
```

完整 fixture 验证：

```bash
bun run context:audit:fixtures:full
```
