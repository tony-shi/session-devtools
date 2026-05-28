---
ruleId: claude-code.messages.user-context.v1
slotId: messages.inline.system-reminder
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Claude Code 在每次请求首条 user message 注入的 userContext block：内容 = CLAUDE.md
  层级（claudeMd）+ userEmail + currentDate，以固定前缀 + # key 格式拼接，包裹于
  <system-reminder>。sourcemap: context.ts:155 getUserContext + utils/api.ts:449
  prependUserContext。
stability: dynamic
sourcemapRef: >-
  restored-src/src/context.ts:155 (getUserContext) +
  restored-src/src/utils/api.ts:449 (prependUserContext)
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: harness_injection
  captureGroups: {}
---
## pattern

```regex
^<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\n[\s\S]+\n\n      IMPORTANT: this context may or may not be relevant to your tasks\. You should not respond to this context unless it is highly relevant to your task\.\n</system-reminder>\n+$
```
