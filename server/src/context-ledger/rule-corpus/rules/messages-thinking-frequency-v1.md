---
ruleId: claude-code.messages.thinking-frequency.v1
slotId: messages.inline.system-reminder
verifiedFor: null
sourceUnits: []
description: >-
  system-reminder 的 thinking-frequency 子类:指示把 SR 当 harness
  指令并按复杂度调节思考频率。正文全静态。⚠️ 也可能注入到 system 段而非 inline SR;按推测绑 inline SR，待 smoke
  验证归属。
stability: static
sourcemapRef: Piebald v2.1.150 system-reminder-thinking-frequency-tuning
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
