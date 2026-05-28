---
ruleId: claude-code.smoosh.plan-mode-exited.v1
slotId: messages.inline.system-reminder
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Smoosh 内容：plan mode 退出告知。前缀 '## Exited Plan Mode\n\nYou have exited plan
  mode.'。harness 注入，jsonl 无直接对应 attachment。
stability: semi-static
sourcemapRef: restored-src/src/utils/messages.ts (plan mode exited)
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: smoosh_content_match
  category: harness_injection
---
## pattern

```regex
^<system-reminder>\n## Exited Plan Mode\n\nYou have exited plan mode\.[\s\S]*?\n</system-reminder>$
```
