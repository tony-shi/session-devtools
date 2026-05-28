---
ruleId: claude-code.smoosh.todowrite-reminder.v1
slotId: messages.inline.system-reminder
verifiedFor: null
sourceUnits: []
description: >-
  Smoosh 内容:todowrite reminder（task-reminder 的兄弟）。前缀 'The TodoWrite tool hasn't
  been used recently.'，正文全静态。smoosh 进 tool_result 尾部,harness 注入。
stability: semi-static
sourcemapRef: Piebald v2.1.150 system-reminder-todowrite-reminder
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: smoosh_content_match
  category: attachment
---
## pattern

```regex
^<system-reminder>\nThe TodoWrite tool hasn't been used recently\.[\s\S]*?\n</system-reminder>$
```
