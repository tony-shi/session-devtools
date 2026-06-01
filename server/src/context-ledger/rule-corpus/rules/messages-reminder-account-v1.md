---
ruleId: claude-code.messages.reminder.account.v1
slotId: messages.inline.system-reminder.account
verifiedFor: "2.1.158"
sourceUnits: []
description: >-
  userContext reminder 拆分后的「账号」尾段:"# userEmail … # currentDate …"。
  closing IMPORTANT 与 </system-reminder> 已单独拆成 raw-only envelope。语义=meta、
  来源=cc-runtime(CC 注入)。userEmail/currentDate 动态。
stability: dynamic
displayName: "账号(邮箱/日期)"
summary: "账号邮箱 + 当前日期(注入上下文尾部)"
dynamicSource: "userEmail + currentDate"
sourcemapRef: 'proxy:9e1ba147 + minimax fixture (2.1.158);splitUserContextReminder'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: harness_injection
  captureGroups:
    userEmail: "账号邮箱"
    currentDate: "当前日期"
---
## pattern

```regex
^# userEmail\nThe user's email address is (?<userEmail>[^\n]+)\.\n# currentDate\nToday's date is (?<currentDate>[^\n]+)\.$
```
