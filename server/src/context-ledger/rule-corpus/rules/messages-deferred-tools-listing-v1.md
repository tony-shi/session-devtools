---
ruleId: claude-code.messages.deferred-tools-listing.v1
slotId: messages.inline.system-reminder
verifiedFor: "2.1.150"
priority: 10  # 具体 prefix 优先于 catch-all system-reminder.v1(priority -100)
sourceUnits: []
description: >-
  harness 在 user turn 注入的「deferred tools 可用列表」声明。本质是工具能力声明(后端 attribution 归 environment & resources),非临时事件。常见来源:ToolSearch / 异步加载的 MCP 工具 / 大量已注册但未在 schema 列出的能力。
stability: dynamic
sourcemapRef: claude-code/runtime/tool-search.ts (deferred tool registry)
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
The following deferred tools are now available via ToolSearch.
```
