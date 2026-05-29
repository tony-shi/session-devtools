---
ruleId: claude-code.messages.deferred-tools-listing.v1
slotId: messages.inline.system-reminder
verifiedFor: "2.1.150"
priority: 10  # 具体 prefix 优先于 catch-all system-reminder.v1(priority -100)
sourceUnits: []
description: >-
  harness 在 user turn 注入的「deferred tools 可用列表」声明(attachment.type=deferred_tools_delta 的 added 变体)。本质是工具能力声明:ToolSearch 源码原文称这些工具 "callable exactly like any tool defined at the top of the prompt",即 schema 延迟加载的工具子集,归 environment & resources。注:同 attachment 的 removed 变体(MCP 断连)语义不同,属 runtime,但本 rule 只匹配 added。
stability: dynamic
sourcemapRef: restored-src/src/utils/messages.ts (case 'deferred_tools_delta') + restored-src/src/tools/ToolSearchTool/prompt.ts (verified vs claude-code-sourcemap@2.1.88)
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
