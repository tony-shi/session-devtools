---
ruleId: claude-code.messages.thinking-frequency.v1
slotId: messages.inline.system-reminder
verifiedFor: "2.1.150"
appliesTo: { maxCcVersion: "2.1.152" }
sourceUnits: []
description: >-
  system-reminder 的 thinking-frequency 子类:指示把 SR 当 harness
  指令并按复杂度调节思考频率。正文全静态。⚠️ 2.1.153 起此 reminder 被 Claude Code 移除(Piebald CHANGELOG:
  "REMOVED: System Reminder: Thinking frequency tuning"),故 appliesTo maxCcVersion 2.1.152——153+ 的 proxy 不再
  匹配此 rule,避免误命中。
stability: static
sourcemapRef: Piebald system-reminder-thinking-frequency-tuning (存在于 ≤v2.1.152;v2.1.153 移除)
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
^<system-reminder>\n# Thinking system reminder\nUser messages may include a <system-reminder> appended by this harness[\s\S]*?\n</system-reminder>$
```
