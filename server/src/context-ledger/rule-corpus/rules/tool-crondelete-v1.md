---
ruleId: claude-code.tool.CronDelete.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: Claude Code 工具：CronDelete（取消定时任务）。description 100B。
stability: static
sourcemapRef: 'binary:CronDelete tool (2.1.126)'
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
Cancel a cron job previously scheduled with CronCreate. Removes it from the in-memory session store.
```
