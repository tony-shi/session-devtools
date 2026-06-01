---
ruleId: claude-code.messages.reminder.preamble.v1
slotId: messages.inline.system-reminder.preamble
verifiedFor: "2.1.158"
sourceUnits: []
description: >-
  userContext <system-reminder> 拆分后的「前言」子段(splitUserContextReminder 产出):
  "# claudeMd" + 固定前言(CC 框架语,静态)。wrapper prefix 已单独拆成 raw-only envelope。
  语义=directive、来源=cc-static。
stability: static
displayName: "claudeMd 前言"
summary: "注入上下文的固定开场(claudeMd 指令优先级声明)"
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
^# claudeMd\nCodebase and user instructions are shown below\. Be sure to adhere to these instructions\. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written\.\n*$
```
