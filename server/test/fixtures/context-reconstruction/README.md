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
