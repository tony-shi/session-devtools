---
ruleId: claude-code.messages.system-reminder.v1
slotId: messages.inline.system-reminder
verifiedFor: null
priority: -100  # catch-all:仅作 fallback,优先级低于所有具名 reminder rule
sourceUnits: []
description: >-
  Claude Code 在每个 user turn 头部注入的 <system-reminder> block。内容每次不同(包含 hook
  输出、memory、file history 等动态数据),不可复现。
stability: dynamic
sourcemapRef: restored-src/src/utils/messages.ts (wrapMessagesInSystemReminder)
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: prefix
  mechanism: system_reminder_pattern
  category: harness_injection
---
## pattern

```text
<system-reminder>
```
