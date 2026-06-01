---
ruleId: claude-code.messages.reminder.memory.v1
slotId: messages.inline.system-reminder.memory
verifiedFor: "2.1.158"
sourceUnits: []
description: >-
  userContext reminder 拆分后的「持久化记忆」子段:"Contents of <path>MEMORY.md (user's auto-memory…)"
  —— Claude Code 生成的跨会话记忆(MEMORY.md 索引内容)。语义=context、来源=user-config(你的)。
  memoryPath/memoryContents 为动态字段。
stability: dynamic
displayName: "记忆(MEMORY.md)"
summary: "Claude Code 持久化记忆 MEMORY.md 的索引内容(跨会话)"
dynamicSource: "memoryPath(运行时路径) + memoryContents(MEMORY.md 正文)"
sourcemapRef: 'proxy:9e1ba147 T3C2 + minimax fixture (2.1.158);splitUserContextReminder'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: memory_injection
  captureGroups:
    memoryPath: "MEMORY.md 的运行时路径(~/.claude/projects/<项目>/memory/)"
    memoryContents: "MEMORY.md 正文(# Memory Index 列表)"
---
## pattern

```regex
^Contents of (?<memoryPath>[^\n]+MEMORY\.md) \(user's auto-memory[^)]*\):\n\n(?<memoryContents>[\s\S]*?)\n*$
```
