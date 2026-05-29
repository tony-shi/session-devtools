---
ruleId: claude-code.tool.RemoteTrigger.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Claude Code 工具：RemoteTrigger（调用 claude.ai remote-trigger API）。description
  452B。
stability: static
sourcemapRef: 'binary:RemoteTrigger tool (2.1.126)'
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: exact
  mechanism: tools_schema_pattern
  category: tools_schema
---
## pattern

```exact
Call the claude.ai remote-trigger API. Use this instead of curl — the OAuth token is added automatically in-process and never exposed.

Actions:
- list: GET /v1/code/triggers
- get: GET /v1/code/triggers/{trigger_id}
- create: POST /v1/code/triggers (requires body)
- update: POST /v1/code/triggers/{trigger_id} (requires body, partial update)
- run: POST /v1/code/triggers/{trigger_id}/run (optional body)

The response is the raw JSON from the API.
```
