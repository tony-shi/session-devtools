---
ruleId: claude-code.smoosh.plan-mode-reminder.v1
slotId: messages.inline.system-reminder
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Smoosh 内容：plan mode 周期提醒。前缀 'Plan mode still active...'，内容含 plan file
  path。harness 注入，jsonl 无直接对应 attachment。
stability: semi-static
sourcemapRef: restored-src/src/utils/messages.ts (plan mode reminder)
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: smoosh_content_match
  category: harness_injection
  captureGroups:
    planFilePath: 当前 plan 文件路径
---
## pattern

```regex
^<system-reminder>\nPlan mode still active \(see full instructions earlier in conversation\)\. Read-only except plan file \((?<planFilePath>[^)]+)\)[\s\S]*?\n</system-reminder>$
```
