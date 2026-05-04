# Context Reconstruction Fixtures

Fixtures in this directory exercise the context-ledger contract. They are shared by proxy parsing, JSONL mutation parsing, reconstruction, reconciliation, and debug-dashboard work.

Each case should live in its own directory:

```text
server/test/fixtures/context-reconstruction/<case-name>/
  session.jsonl
  proxy-request.json
  call-summary.json
  notes.md
```

Optional files:

```text
  expected-report.json
  memory/
    CLAUDE.md
    AGENTS.md
  subagents/
    *.jsonl
  raw/
    traffic-slice.jsonl
```

## Required Files

- `session.jsonl`: local agent log source used to build `ContextMutation[]`.
- `proxy-request.json`: proxy ground truth used to build `ProxyQuerySnapshot`.
- `call-summary.json`: compact fixture metadata such as session id, query id, query index, model, and important timestamps.
- `notes.md`: human-readable fixture purpose and known gaps.

## Optional Expected Report

`expected-report.json` is a fixture assertion file, not necessarily a full `ReconciliationReport`.

Minimum shape:

```json
{
  "fixtureName": "single-tool-call",
  "sessionId": "session-id",
  "queryId": "query-id",
  "expectedCoverage": {
    "minSegmentCoverage": 0.8,
    "minCharCoverage": 0.8
  },
  "requiredFindings": ["matched", "merge_alignment"],
  "requiredCategories": ["user_message", "tool_use", "tool_result"]
}
```

Use `server/src/context-ledger/__fixtures__/mock-report.json` for the full report schema example.

## Notes Template

```md
# <case-name>

## Purpose

## Expected Features

## Known Gaps

## Important JSON Paths

## Important JSONL Lines
```

## Boundary Rules

- Proxy files only feed `ProxyQuerySnapshot` and proxy-first `ProxySegmentAttribution`.
- JSONL, memory files, hooks, harness rules, prior sessions, and unknown placeholders feed `ContextMutation`.
- A proxy-only diff must become `ReconciliationFinding.type = "unmatched_proxy_segment"` until independently explained.
- Do not add fixture-only fields to the core contract. Use `metadata` for temporary notes and promote fields only after multiple fixtures need them.

## Reconstruction vs Reconcile（proxy 的角色边界）

**proxy 只参与 reconcile，不参与 expected materialization。**

```
JSONL mutations + RuleRegistry + HarnessRuntimeSnapshot
  → ExpectedQueryContext（正向重建）
  → TargetRequest candidate

ProxyQuerySnapshot + ProxySegmentAttribution
  → reconcile / audit only（对账、归因、分桶，不写入 expected）
```

约束：
- `ExpectedQueryContext.segments[].sourceRefs` 不允许出现 `kind: "proxy"`。
- `reconstructExpectedClaudeContext()` 的输入不接受 `ProxyQuerySnapshot` / `ProxySegmentAttribution`。
- proxy rawText 不得复制到 expected；`proxy_snapshot_fallback` 标注的字段只用于
  reconcile 报告，不计入 exact reconstruction 口径。
- `presenceCoverage` / `templateCoverage` 均来自 rule 正向 materialization；
  `attributionOnlyCoverage` 表示 rule 已识别但 expected 缺段——这是真实缺口，
  不应在 fixture 中包装成成功。
