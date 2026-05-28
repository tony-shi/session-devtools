---
ruleId: claude-code.messages.token-usage.v1
slotId: messages.inline.system-reminder
verifiedFor: null
sourceUnits: []
description: >-
  system-reminder 的 token-usage 子类：harness 注入的预算统计。形如 'Token usage:
  {used}/{total}; {remaining} remaining'，三个数值动态。
stability: dynamic
sourcemapRef: >-
  Piebald v2.1.150 system-reminder-token-usage
  (ATTACHMENT_OBJECT.used/total/remaining)
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: attachment
  captureGroups:
    used: 已用 token 数
    total: 总预算 token 数
    remaining: 剩余 token 数
---
## pattern

```regex
^<system-reminder>\nToken usage: (?<used>\d+)/(?<total>\d+); (?<remaining>\d+) remaining\n</system-reminder>$
```
