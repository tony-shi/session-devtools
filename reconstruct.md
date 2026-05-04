# reconstruct.md — rule + JSONL 正向重建 TargetRequest 任务拆分

## 结论

目标不是恢复旧 R9，而是把 `rule + JSONL + harness/runtime state` 做成正向 request materializer：

```text
JSONL mutations + RuleRegistry + HarnessRuntimeSnapshot
  -> ExpectedQueryContext
  -> TargetRequest candidate

ProxySnapshot + ProxyAttribution
  -> reconcile / audit only
```

核心边界：`expected` / `targetRequest` 不能从当前 proxy segment、proxy attribution、proxy raw text 中反写内容。proxy 只能验证、归因、对账、生成候选 rule，不能作为 expected 的输入事实。

---

## 全局不变量

- `reconstructExpectedClaudeContext()` 不接受 `ProxyQuerySnapshot` / `ProxySegmentAttribution`。
- `ExpectedQueryContext.segments[].sourceRefs` 不允许出现 `kind: "proxy"`。
- `TargetRequest.sourceMap[].sourceRefs` 不允许出现 `kind: "proxy"`，除非字段名明确标为 legacy/debug 且不参与 coverage。
- `ProxySnapshot.request` 只能作为临时 fallback，必须在 metadata 里标注 `proxy_snapshot_fallback`，不得算作正向重建 exact。
- `verifiedFor !== SUPPORTED_CLAUDE_CODE_VERSION` 的 rule 不得贡献 evidence-backed exact/template coverage。
- `presence / shape / unavailable` 只能证明“应存在/结构应存在”，不能升级为 exact。
- `billing_noise` 是 request wire payload 的一部分，但不是 evidence-backed reconstruction；归入 `server_side_attribution` 或 `presence`，不能算 exact。

---

## 推荐推进顺序

| 顺序 | Worktree | 目标 | 依赖 |
|---|---|---|---|
| 1 | `reconstruct-01-guardrails` | 固化禁止 proxy 反写的测试与类型边界 | 无 |
| 2 | `reconstruct-02-rule-materializer` | 建立通用 rule materializer 骨架 | 01 |
| 3 | `reconstruct-03-runtime-snapshot` | 引入 `HarnessRuntimeSnapshot`，承载非 JSONL 运行态 | 01 |
| 4 | `reconstruct-04-system-rules` | 用 rule 正向生成 system[] 的可验证部分 | 02 + 03 |
| 5 | `reconstruct-05-tool-rules` | 用 rule 正向生成 tools[] 的可验证部分 | 02 + 03 |
| 6 | `reconstruct-06-request-scalars` | 清理 request 标量字段 provenance 与 fallback 口径 | 03 |
| 7 | `reconstruct-07-audit-fixtures` | 补 audit、fixture、scorecard 和文档验收 | 04 + 05 + 06 |

可以并行：04 和 05 在 02/03 合入后并行推进。06 可以和 04/05 并行，但最终需要一起过 audit。

---

## 并行执行准备

本仓库提供 `scripts/reconstruct-parallel.ts` 从本文件提取各 worktree prompt，并生成 Claude Code 非交互命令。

先在 develop 主 worktree 跑一次 fixture baseline，所有 worker 共享同一个 `CONTEXT_AUDIT_HOME` 和 `RECON_BASELINE_RUN_ID`：

```bash
export RECON_AUDIT_HOME="$PWD/.audit/reconstruct"
mkdir -p "$RECON_AUDIT_HOME"
export RECON_BASELINE_RUN_ID="$(
  CONTEXT_AUDIT_HOME="$RECON_AUDIT_HOME" \
  bun run context:audit:fixtures --no-update-latest \
    | tee /tmp/reconstruct-baseline.log \
    | sed -n 's/^run: //p' \
    | tail -1
)"
echo "$RECON_BASELINE_RUN_ID"
```

生成某一批次的 worker 命令：

```bash
bun run reconstruct:commands -- --batch 1
bun run reconstruct:commands -- --batch 2
bun run reconstruct:commands -- --batch 3
bun run reconstruct:commands -- --batch 4
```

每条生成的命令都只打印，不自动执行。复制到不同终端执行即可。worker 内部跑 audit 时必须带：

```bash
CONTEXT_AUDIT_HOME="$RECON_AUDIT_HOME" bun run context:audit:fixtures --baseline "$RECON_BASELINE_RUN_ID" --no-update-latest
```

注意：`claude --worktree` 从当前 `HEAD` 创建新 worktree。若本文件或并行脚本尚未提交到 develop，新 worktree 不会自动包含这些文件；但生成命令时 prompt 已内嵌任务内容，所以 worker 不依赖新 worktree 中存在本文件。若希望 worker 也能读取本文件，请先把前置准备改动提交到 develop。

---

## 总 TODO

- [ ] 增加 guardrail tests：expected / target 不得含 proxy sourceRef。
- [ ] 增加 regression tests：proxy attribution 命中 identity/billing 时，不会自动生成 expected，除非对应 reconstruction rule 被 materializer 正向激活。
- [ ] 在 `expected-context-reconstructor.ts` 中增加 rule materializer 阶段。
- [ ] 为 generated-by-rule 的 segment 增加统一 metadata：`ruleId`、`ruleVerified`、`materialization`、`preConditionStatus`。
- [ ] 引入 `HarnessRuntimeSnapshot` 类型，并从 JSONL、进程环境、本地配置、memory path 等非 proxy 来源填充第一版。
- [ ] 实现 `RulePreCondition` evaluator；不能判断时默认 skip，并记录 `unmaterializedRules`。
- [ ] system[]：先 materialize `billing_noise` presence 与 identity exact，再逐步扩展静态 system prompt body。
- [ ] tools[]：只 materialize verified exact tool schema；未知 MCP/plugin tool 继续 attribution_only。
- [ ] TargetRequest：从 segment metadata 识别 `exact / template / shape / presence / unavailable`，不要只用 `contentRef.text` 推断。
- [ ] request scalar：把 `model`、`max_tokens`、`stream`、`context_management` 等字段的来源拆清楚。
- [ ] reconciliation：确保 rule materialized segment 的 coverage 分桶正确，presence 不进入 exact/template。
- [ ] audit report：展示每条 rule 的 verified 状态、materialization 状态和 fallback 来源。
- [ ] fixture：至少覆盖 main session、side query、tool schema、billing、identity、runtime state 缺失降级。

---

## Worktree 01 — guardrails

### 目标

先用测试把架构边界钉住，防止后续实现为了 coverage 又把 proxy 反写进 expected。

### 建议改动范围

- `server/src/context-ledger/expected-context-reconstructor.test.ts`
- `server/src/context-ledger/target-request-builder.test.ts`
- 必要时少量调整 `types.ts`，但不要改 reconstructor 主逻辑

### 验收标准

- 任意 fixture 的 expected segments 均不含 `sourceRefs.kind === "proxy"`。
- TargetRequest sourceMap 不含 proxy sourceRef。
- `reconstructExpectedClaudeContext()` 的 public input 类型不包含 proxy / attribution。
- 测试证明 `inferClaudeProxyAttributions()` 的输出不会影响 expected segment 数量。

### Prompt

```text
你在 session-dashboard 仓库的独立 worktree 中工作，任务名 reconstruct-01-guardrails。

目标：为 context-ledger 的正向重建链路增加架构 guardrail，防止 proxy / attribution 反写 expected。

请先阅读：
- AGENTS.md
- reconstruct.md
- server/src/context-ledger/expected-context-reconstructor.ts
- server/src/context-ledger/target-request-builder.ts
- server/src/context-ledger/audit/pipeline.ts

要求：
1. 增加测试，断言 ExpectedQueryContext.segments[].sourceRefs 不允许出现 kind="proxy"。
2. 增加测试，断言 TargetRequest.sourceMap 中不允许出现 proxy sourceRef。
3. 增加测试或类型检查，确认 reconstructExpectedClaudeContext 的输入不包含 ProxyQuerySnapshot / ProxySegmentAttribution。
4. 不实现 rule materializer，不追求 coverage 提升。
5. 不修改 proxy-attribution 的业务逻辑。

验证：
- bun test server/src/context-ledger/expected-context-reconstructor.test.ts
- bun test server/src/context-ledger/target-request-builder.test.ts
- bunx tsc --noEmit

交付：
- 说明新增了哪些 guardrail。
- 说明是否发现现有代码仍有 proxy fallback，并区分“反写 expected”和“target request scalar fallback”。
```

---

## Worktree 02 — rule materializer skeleton

### 目标

把 `rule-registry.ts` 中已有的 `reconstruction` 字段真正接入 expected 构建流程，但只做通用骨架，不一次性打开所有 rule。

### 建议改动范围

- `server/src/context-ledger/expected-context-reconstructor.ts`
- `server/src/context-ledger/types.ts`
- `server/src/context-ledger/expected-context-reconstructor.test.ts`

### 验收标准

- 新增 `materializeHarnessRules()` 或同等函数。
- 只消费 `CONTEXT_LEDGER_RULES[].reconstruction`，不读取 proxy。
- 支持至少三类输出：
  - `exact_text` + `contentPattern` -> 带 `contentRef.text`
  - `presence` -> placeholder/presence segment，不伪造 text
  - `shape/unavailable` -> 记录 unmaterialized，不生成 exact segment
- generated segment 的 sourceRef 为 `harness_rule`。
- 未 verified rule 默认不进入 evidence-backed；具体策略可通过 metadata 暴露。

### Prompt

```text
你在 session-dashboard 仓库的独立 worktree 中工作，任务名 reconstruct-02-rule-materializer。

目标：在 expected-context-reconstructor 中增加通用 rule materializer 骨架，让 RuleRegistry 的 reconstruction 字段可以正向生成 expected segments。

请先阅读：
- reconstruct.md
- server/src/context-ledger/rule-registry.ts
- server/src/context-ledger/expected-context-reconstructor.ts
- server/src/context-ledger/types.ts

实现要求：
1. 新增一个独立 materializer 函数，输入为 rules + query boundary + 后续 runtime snapshot 占位，输出 ContextSegment[] 和 AppliedRule[]。
2. 仅使用 rule.reconstruction，不使用 rule.attribution 命中的 proxy 结果。
3. exact_text + contentPattern 可以生成 contentRef.text 和 rawHash。
4. presence / shape 不能伪造 text；需要通过 metadata 或新的 TargetMaterialization 让 target-request-builder 能识别。
5. preCondition 暂时只支持 always / 缺省；其它条件默认 skip，并写入 metadata.unmaterializedRules。
6. 不在本任务中打开复杂 system prompt / tools schema 的完整覆盖。

验证：
- bun test server/src/context-ledger/expected-context-reconstructor.test.ts
- bunx tsc --noEmit

交付：
- 说明 materializer 支持的 materialization 类型。
- 说明哪些 rule 被保守跳过，以及为什么。
```

---

## Worktree 03 — HarnessRuntimeSnapshot

### 目标

补上 `jsonl + rule` 之外缺失的第三类输入：非 proxy 的 harness/runtime state。没有这个对象，system/tools/request scalar 的 precondition 都会漂。

### 建议改动范围

- `server/src/context-ledger/types.ts`
- `server/src/context-ledger/jsonl-mutation-parser.ts`
- `server/src/context-ledger/expected-context-reconstructor.ts`
- `server/src/context-ledger/target-request-builder.ts`
- `server/src/context-ledger/audit/pipeline.ts`

### 第一版字段建议

```ts
interface HarnessRuntimeSnapshot {
  source: "jsonl" | "local_env" | "derived" | "unknown";
  claudeCodeVersion?: string;
  entrypoint?: string;
  cwd?: string;
  userType?: "external" | "ant" | "unknown";
  model?: string;
  outputStyleConfig?: "default" | "custom" | "unknown";
  enabledToolNames?: string[];
  mcpToolNames?: string[];
  autoMemoryEnabled?: boolean;
  autoMemoryPath?: string;
  settings?: Record<string, unknown>;
  featureFlags?: Record<string, boolean | "unknown">;
}
```

### 验收标准

- `reconstructExpectedClaudeContext()` 可接收 runtime snapshot。
- `target-request-builder` 优先从 runtime/jsonl 取 request scalar，proxy fallback 明确降级。
- `RulePreCondition` evaluator 有第一版实现；未知条件不默认 true。
- pipeline 中 runtime snapshot 的生成不读取 proxy body。

### Prompt

```text
你在 session-dashboard 仓库的独立 worktree 中工作，任务名 reconstruct-03-runtime-snapshot。

目标：引入 HarnessRuntimeSnapshot，作为 rule materializer 和 target-request-builder 的非 proxy 运行态输入。

请先阅读：
- reconstruct.md
- server/src/context-ledger/types.ts
- server/src/context-ledger/jsonl-mutation-parser.ts
- server/src/context-ledger/expected-context-reconstructor.ts
- server/src/context-ledger/target-request-builder.ts
- server/src/context-ledger/audit/pipeline.ts

实现要求：
1. 在 types.ts 定义 HarnessRuntimeSnapshot，字段保持保守，未知值显式为 undefined 或 "unknown"。
2. 从 JSONL parser 已有 inferredModel 等信息填充第一版 runtime snapshot。
3. pipeline 把 runtime snapshot 传入 reconstructExpectedClaudeContext 和 buildTargetRequest。
4. 增加 RulePreCondition evaluator：always / userType / settingsField / harnessFlag 的未知值必须返回 unknown/false，不要默认通过。
5. 标注所有 proxy snapshot fallback 为 fallback，不得参与 exact reconstruction 口径。

验证：
- bun test server/src/context-ledger/jsonl-mutation-parser.test.ts
- bun test server/src/context-ledger/target-request-builder.test.ts
- bunx tsc --noEmit

交付：
- 列出 runtime snapshot 第一版可用字段。
- 列出仍需后续从本地配置或 cli.js 派生的字段。
```

---

## Worktree 04 — system rules materialization

### 目标

先覆盖 system[] 中最确定、最有价值的部分：billing presence、identity exact、当前版本已验证的静态 system prompt section。动态 section 只能在 runtime state 足够时启用。

### 建议改动范围

- `server/src/context-ledger/rule-registry.ts`
- `server/src/context-ledger/expected-context-reconstructor.ts`
- `server/src/context-ledger/reconciliation-engine.ts`
- `server/src/context-ledger/expected-context-reconstructor.test.ts`
- `server/src/context-ledger/reconciliation-engine.test.ts`

### 验收标准

- `system[0]` billing 以 presence/server-side segment 表达，不含 proxy text。
- `system[1]` identity 由 `claude-code.system-prompt-identity.v1` 正向 exact materialize。
- 已验证 exact_text system rules 可生成 expected segment。
- preCondition 不可判断的 rule 进入 `unmaterializedRules`，不猜。
- reconcile 中 rule-generated exact_text 命中应进入 template 或 exact 合理桶；presence 不进入 exact。

### Prompt

```text
你在 session-dashboard 仓库的独立 worktree 中工作，任务名 reconstruct-04-system-rules。

目标：用 RuleRegistry 正向 materialize system[] 的可验证部分，重点是 billing presence 和 identity exact。

请先阅读：
- reconstruct.md
- server/src/context-ledger/rule-registry.ts
- server/src/context-ledger/expected-context-reconstructor.ts
- server/src/context-ledger/reconciliation-engine.ts
- server/test/fixtures/context-reconstruction/*/proxy-request.json
- server/test/fixtures/context-reconstruction/*/session.jsonl

实现要求：
1. 不从 proxy raw text 复制任何 system 内容。
2. billing rule 生成 presence/server-side segment，不能有 contentRef.text，不能计入 exact。
3. identity rule 生成 exact_text segment，sourceRef.kind 必须是 harness_rule。
4. 对 verifiedFor 未通过的 system rule，默认不进入 evidence-backed；如临时启用，必须在 metadata 标注 pending。
5. 动态 system section 只有 runtime snapshot 足够时才启用；否则写入 unmaterializedRules。
6. 更新或新增测试，证明 system[1] identity 不再是 attribution_only，而是 rule materialized。

验证：
- bun test server/src/context-ledger/expected-context-reconstructor.test.ts
- bun test server/src/context-ledger/reconciliation-engine.test.ts
- bunx tsc --noEmit

交付：
- 列出本任务 materialize 的 system rule。
- 列出仍保持 attribution_only 的 system rule 及原因。
```

---

## Worktree 05 — tools schema materialization

### 目标

把 tools[] 从长期 attribution_only 推进到 verified rule 正向生成。只覆盖稳定、已 verified、exact 的内建工具；MCP/plugin tool 保守降级。

### 建议改动范围

- `server/src/context-ledger/rule-registry.ts`
- `server/src/context-ledger/expected-context-reconstructor.ts`
- `server/src/context-ledger/target-request-builder.ts`
- `server/src/context-ledger/target-request-builder.test.ts`
- `server/src/context-ledger/reconciliation-engine.test.ts`

### 验收标准

- verified built-in tool rules 可生成 `section="tools"` 的 expected segment。
- TargetRequest 可把 tool segment materialize 成 tool object，而不是字符串 placeholder。
- enabled tools 未知时，不生成全量 tools[] 假象；应记录 `unmaterializedRules`。
- MCP/plugin tools 未知时继续 attribution_only 或 presence，不算 exact。
- 不从 proxy.tools[] 复制 schema。

### Prompt

```text
你在 session-dashboard 仓库的独立 worktree 中工作，任务名 reconstruct-05-tool-rules。

目标：用 RuleRegistry 正向 materialize tools[] 中 verified exact 的工具 schema，避免 tools[] 永久 attribution_only。

请先阅读：
- reconstruct.md
- server/src/context-ledger/rule-registry.ts
- server/src/context-ledger/expected-context-reconstructor.ts
- server/src/context-ledger/target-request-builder.ts
- server/src/context-ledger/proxy-snapshot-parser.ts

实现要求：
1. 只 materialize verifiedFor === SUPPORTED_CLAUDE_CODE_VERSION 的 exact_text tool rules。
2. 如果 runtime snapshot 没有 enabledToolNames，不要假设所有工具都启用；可以先支持显式全量模式，但必须通过 metadata 标注来源。
3. TargetRequest 中 tools[] 应是对象结构；contentPattern 如果是 JSON 字符串，解析失败时降级为 placeholder 并报告。
4. 不允许从 proxy reqBody.tools 复制任何 tool schema。
5. MCP/plugin tool schema 未知时保留 attribution_only，不要伪造 exact。

验证：
- bun test server/src/context-ledger/target-request-builder.test.ts
- bun test server/src/context-ledger/reconciliation-engine.test.ts
- bunx tsc --noEmit

交付：
- 列出已 materialize 的 tool rules。
- 列出未 materialize 的 tool rules 和阻塞原因。
```

---

## Worktree 06 — request scalar provenance

### 目标

把 request-level 字段的来源说清楚：哪些是 JSONL/runtime 正向推断，哪些仍是 proxy fallback。没有来源的字段不要伪装成 expected。

### 建议改动范围

- `server/src/context-ledger/target-request-builder.ts`
- `server/src/context-ledger/types.ts`
- `server/src/context-ledger/reconciliation-engine.ts`
- `server/src/context-ledger/target-request-builder.test.ts`
- `server/src/context-ledger/audit/render-reconcile-fusion-html.ts`

### 验收标准

- `model` 优先来自 JSONL/runtime。
- `max_tokens / stream / thinking / context_management / output_config / metadata` 若仍来自 proxy，metadata 中必须逐字段标注 fallback。
- request-level `canonicalExact` 不能因为 proxy fallback 字段相等就被误判为完整正向重建。
- audit UI/report 能展示 request scalar provenance。

### Prompt

```text
你在 session-dashboard 仓库的独立 worktree 中工作，任务名 reconstruct-06-request-scalars。

目标：清理 TargetRequest request scalar 的 provenance，避免 proxy fallback 被误认为 rule+jsonl 正向重建。

请先阅读：
- reconstruct.md
- server/src/context-ledger/target-request-builder.ts
- server/src/context-ledger/reconciliation-engine.ts
- server/src/context-ledger/types.ts

实现要求：
1. TargetRequest.metadata 中按字段记录来源，例如 model=jsonl_inferred，max_tokens=proxy_snapshot_fallback。
2. computeRequestLevelExact 需要识别 fallback 字段；只要 request body 依赖 proxy fallback，就不能给出“纯正向 canonical exact”的语义。
3. 保留临时 fallback 以维持现有 audit 可用，但报告必须明显标注。
4. 不修改 proxy parser。

验证：
- bun test server/src/context-ledger/target-request-builder.test.ts
- bun test server/src/context-ledger/reconciliation-engine.test.ts
- bunx tsc --noEmit

交付：
- 列出每个 request scalar 当前来源。
- 列出下一步如何从 runtime snapshot 替代 proxy fallback。
```

---

## Worktree 07 — audit, fixture, scorecard

### 目标

把前面实现变成可持续治理的 audit 输出：每次跑 fixture 都能看出 exact、template、presence、attribution_only、proxy_only 的真实变化。

### 建议改动范围

- `server/src/context-ledger/audit/*`
- `server/src/context-ledger/debug/*`
- `server/test/fixtures/context-reconstruction/*`
- `scripts/context-audit*.ts`
- `docs/context-reconstruction-correction.md`
- `final-task.md` 或后续归档文档

### 验收标准

- scorecard 展示 rule materialized chars、presence chars、proxy fallback scalar count。
- audit report 展示 pending rule coverage 和 unmaterialized rule 列表。
- fixture 覆盖：
  - billing + identity
  - built-in tools
  - unknown MCP/plugin tool
  - side query
  - runtime state 缺失降级
- `bun run context:audit:fixtures` 或现有等价命令可运行并输出稳定报告。

### Prompt

```text
你在 session-dashboard 仓库的独立 worktree 中工作，任务名 reconstruct-07-audit-fixtures。

目标：更新 audit / fixture / scorecard，让 rule+jsonl 正向重建的进展可量化、可回归。

请先阅读：
- reconstruct.md
- server/src/context-ledger/audit/scorecard.ts
- server/src/context-ledger/audit/report-generator.ts
- server/src/context-ledger/audit/render-reconcile-fusion-html.ts
- scripts/context-audit.ts
- server/test/fixtures/context-reconstruction/README.md

实现要求：
1. scorecard 增加或明确展示：ruleMaterializedCoverage、presenceCoverage、proxyScalarFallbackCount、unmaterializedRuleCount。
2. audit HTML/report 中展示每个 TargetRequest segment 的 source kind、ruleId、verifiedFor、materialization。
3. 更新 fixture 或新增最小 fixture，覆盖 billing + identity 正向 materialization。
4. 保持 attribution_only 作为真实缺口，不要把它包装成成功。
5. 文档更新：说明 proxy 只参与 reconcile，不参与 expected materialization。

验证：
- bun test server/src/context-ledger/audit/audit.test.ts
- bun test server/src/context-ledger/audit/fixture-pipeline-coverage.test.ts
- bunx tsc --noEmit
- 如本地数据允许，运行现有 context audit fixture 命令并记录结果。

交付：
- 给出 before/after scorecard 字段变化。
- 给出仍未 materialize 的主要 proxy chars 来源。
```

---

## 合并策略

1. 先合并 01，保证后续所有 PR 有 guardrail。
2. 02 和 03 合并后，再推进 04/05；否则 system/tools 的 preCondition 会继续靠猜。
3. 04/05 合并后再审视 coverage，不要为了提升 coverage 放宽 verified 策略。
4. 06 可以早合，但若与 03 冲突，以 03 的 runtime snapshot 类型为准。
5. 07 最后合并，作为回归仪表盘，不要在 07 里补核心 reconstruction 逻辑。

---

## 当前可接受的中间状态

- identity 已正向 materialize，但 intro/environment/tools 仍 attribution_only：可接受。
- tools 只覆盖内建工具，MCP/plugin 仍 attribution_only：可接受。
- request scalar 仍有 proxy fallback，但报告清楚标注：可接受。
- presenceCoverage 上升但 exactCoverage 不变：可接受。

不可接受：

- 为了对齐，把 proxy rawText 复制到 expected。
- 未 verified rule 命中后进入 exact/template evidence-backed。
- runtime/preCondition 未知时默认 true。
- canonical exact 混入 proxy fallback 后仍被描述为“rule+jsonl 完整重建”。
