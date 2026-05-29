---
ruleId: claude-code.messages.agent-types-listing.v2
slotId: messages.system-message
verifiedFor: "2.1.156"
priority: 10
sourceUnits: []
description: >-
  2.1.154+ beta:agent 类型列表(isInitial 变体)随 deferred-tools 一同从 <system-reminder>
  迁移到 mid-conversation role:"system" message(裸文本,无 <system-reminder> 包裹)。本质同
  v1(能力声明 → environment & resources),仅 wire 注入机制变化:slot 变为 messages.system-message。
  靠 slot 与 v1 自然分流,无需 appliesTo。注:本 rule 类比 deferred-tools v2 推断(同机制),
  待 role:system 的 agent-types 真实样本进一步确认。
stability: dynamic
sourcemapRef: >-
  Claude Code restored-src role:"system" message(CHANGELOG 2.1.154 beta system-message 迁移)。
materialization: presence
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: prefix
  mechanism: system_reminder_pattern
  category: harness_injection
---

## pattern

```text
Available agent types for the Agent tool:
```
