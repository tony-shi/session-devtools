---
ruleId: claude-code.messages.reminder.wrapper-prefix.v1
slotId: messages.inline.system-reminder.wrapper.prefix
verifiedFor: "2.1.158"
sourceUnits: []
description: >-
  userContext reminder 拆分后的前置 envelope:<system-reminder> + "As you answer..."
  固定引导语。仅用于 raw/audit 完整性,默认 UI raw-only。
stability: static
displayName: "system-reminder 前置封装"
summary: "userContext 注入块的固定前置封装"
sourcemapRef: 'proxy:9e1ba147 / minimax fixture (2.1.158);splitUserContextReminder'
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: harness_injection
---
## pattern

```regex
^<system-reminder>\nAs you answer the user's questions, you can use the following context:\n*$
```
