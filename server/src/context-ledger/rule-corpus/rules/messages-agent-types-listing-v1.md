---
ruleId: claude-code.messages.agent-types-listing.v1
slotId: messages.inline.system-reminder
verifiedFor: "2.1.150"
priority: 10
sourceUnits: []
description: >-
  harness 在 user turn 注入的「可用 agent 类型列表」声明。列出 Agent 工具可调度的子代理类型(claude / claude-code-guide / Explore / general-purpose / Plan 等),含每个 agent 的 description 与允许工具集。本质是能力声明(归 environment & resources),非临时事件。
stability: dynamic
sourcemapRef: claude-code/runtime/agent-registry.ts
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
<system-reminder>
Available agent types for the Agent tool:
```
