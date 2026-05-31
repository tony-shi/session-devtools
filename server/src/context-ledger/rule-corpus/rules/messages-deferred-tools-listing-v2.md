---
ruleId: claude-code.messages.deferred-tools-listing.v2
slotId: messages.system-message
verifiedFor: "2.1.156"
priority: 10
sourceUnits: []
description: >-
  2.1.154+ beta:deferred-tools 列表从 <system-reminder> 迁移到 mid-conversation
  role:"system" message(裸文本,无 <system-reminder> 包裹;Opus 4.8 等 supported model)。
  本质同 v1(工具能力声明 → environment & resources),仅 wire 注入机制变化:slot 从
  messages.inline.system-reminder 变为 messages.system-message。无需 appliesTo——v1/v2 靠
  slot 自然分流(SR 包裹→v1;role:system message→v2),wire 机制决定走哪条。
stability: dynamic
displayName: "延迟工具"
summary: "ToolSearch 按需加载的工具清单(schema 未载,调用前需 ToolSearch 取);内置 + MCP 工具,随 MCP 配置变"
sourcemapRef: >-
  Claude Code restored-src role:"system" message(CHANGELOG 2.1.154:"Replaces mid-session
  <system-reminder> guidance with beta role:'system' messages for supported models, with
  <system-reminder> retained as the fallback")。实证:5e7476cd T3 cc_version=2.1.156。
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
The following deferred tools are now available via ToolSearch.
```
