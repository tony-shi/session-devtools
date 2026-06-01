---
ruleId: claude-code.messages.reminder.wrapper-suffix.v1
slotId: messages.inline.system-reminder.wrapper.suffix
verifiedFor: "2.1.158"
sourceUnits: []
description: >-
  userContext reminder 拆分后的后置 envelope:closing IMPORTANT + </system-reminder>。
  仅用于 raw/audit 完整性,默认 UI raw-only。
stability: static
displayName: "system-reminder 后置封装"
summary: "userContext 注入块的固定后置封装"
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
^\n\n      IMPORTANT: this context may or may not be relevant to your tasks\. You should not respond to this context unless it is highly relevant to your task\.\n</system-reminder>\n*$
```
