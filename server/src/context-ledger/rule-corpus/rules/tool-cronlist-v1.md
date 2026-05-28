---
ruleId: claude-code.tool.CronList.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: Claude Code 工具：CronList（列出定时任务）。description 60B。
stability: semi-static
sourcemapRef: 'binary:CronList tool (2.1.126)'
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
List all cron jobs scheduled via CronCreate in this session.
```
