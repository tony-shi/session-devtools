---
ruleId: claude-code.smoosh.plan-mode-strict.v1
slotId: messages.inline.system-reminder
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Smoosh 内容：plan mode 进入/重申。前缀 'Plan mode is active...'，包含 plan
  文件路径与工作流说明。harness 注入，jsonl 无直接对应 attachment。
stability: semi-static
sourcemapRef: restored-src/src/utils/messages.ts (plan mode prompt)
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
^<system-reminder>\nPlan mode is active\. The user indicated that they do not want you to execute yet[\s\S]*?\n</system-reminder>$
```
