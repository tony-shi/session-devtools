---
ruleId: claude-code.messages.reminder.project-instructions.v1
slotId: messages.inline.system-reminder.project-instructions
verifiedFor: "2.1.158"
sourceUnits: []
description: >-
  userContext reminder 拆分后的「项目指令」子段:一个 "Contents of <path> (project instructions…)"
  文件(你的 CLAUDE.md / AGENTS.md 等,checked into the codebase)。可变数量,每文件一段。
  语义=context、来源=user-config(你的)。path/content 为动态字段。
stability: dynamic
displayName: "项目指令(CLAUDE.md)"
summary: "项目级指令文件(CLAUDE.md / AGENTS.md)的注入内容"
dynamicSource: "path(项目指令文件路径) + content(正文)"
sourcemapRef: 'proxy:9e1ba147 T3C2 (2.1.158);splitUserContextReminder'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: memory_injection
  captureGroups:
    path: "项目指令文件路径(home=~/.claude 全局 / 项目根=project)"
    content: "文件正文"
---
## pattern

```regex
^Contents of (?<path>[^\n]+?) \(project instructions[^)]*\):\n\n(?<content>[\s\S]*?)\n*$
```
