---
ruleId: claude-code.tool.ScheduleWakeup.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Claude Code 工具：ScheduleWakeup（/loop 自定步调）。description 2312B，input_schema
  795B。外部插件，description 有 em-dash + 动态内容，用 regex 头尾锚定。
stability: static
sourcemapRef: 'binary:ScheduleWakeup tool not in core binary (external plugin)'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: tools_schema_pattern
  category: tools_schema
  captureGroups: {}
---
## pattern

```regex
^Schedule when to resume work in /loop dynamic mode[\s\S]+make it specific\.[\s\S]*$
```
