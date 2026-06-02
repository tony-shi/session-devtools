---
ruleId: claude-code.messages.reminder.global-instructions.v1
slotId: messages.inline.system-reminder.project-instructions
verifiedFor: "2.1.160"
sourceUnits: []
description: >-
  userContext reminder 拆分后的「全局/用户级指令」子段:一个 "Contents of <path> (user's private
  global instructions for all projects)" 文件(~/.claude/CLAUDE.md,对你所有项目生效)。与项目级
  CLAUDE.md 共用 project-instructions slot,靠 desc 区分;作为首文件时可含 "# claudeMd" 固定导言。
  语义=context、来源=user-config。path/content 为动态字段。desc 跨 2.1.88→2.1.160 稳定,
  对真实 session 820f368b(2.1.160) 验证。
stability: dynamic
displayName: "全局指令(~/.claude/CLAUDE.md)"
summary: "用户全局指令文件(~/.claude/CLAUDE.md),对你所有项目生效"
dynamicSource: "path(全局指令文件路径) + content(正文)"
sourcemapRef: 'proxy:820f368b id=131411 (2.1.160);splitUserContextReminder;desc 同 2.1.88 sourcemap'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: memory_injection
  captureGroups:
    path: "全局指令文件路径(~/.claude/CLAUDE.md)"
    content: "文件正文"
---
## pattern

```regex
^(?:# claudeMd\nCodebase and user instructions are shown below\. Be sure to adhere to these instructions\. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written\.\n*)?Contents of (?<path>[^\n]+?) \(user's private global instructions[^)]*\):\n\n(?<content>[\s\S]*?)\n*$
```
