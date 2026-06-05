---
ruleId: claude-code.messages.reminder.local-instructions.v1
slotId: messages.inline.system-reminder.project-instructions
verifiedFor: "2.1.158"
sourceUnits: []
description: >-
  userContext reminder 拆分后的「项目本地指令」子段:一个 "Contents of <path> (user's private
  project instructions, not checked in)" 文件(项目根 CLAUDE.local.md,机器本地私有、不入库)。
  与全局(~/.claude/CLAUDE.md)、入库项目(CLAUDE.md)共用 project-instructions slot,靠 desc 区分:
  左括号后紧跟 "user's private project instructions",区别于全局的 "...global..." 与入库项目的
  "project instructions"(无 "user's private" 前缀),三者 pattern 互斥、各命中一条。
  语义=context、来源=user-config(你的本地)。path/content 为动态字段。
  对真实 session 31b1334b(2.1.158) 验证:此前无规则命中,落 STRUCTURAL。
stability: dynamic
displayName: "本地指令(CLAUDE.local.md)"
summary: "项目本地私有指令文件(CLAUDE.local.md),机器本地、不入库"
dynamicSource: "path(本地指令文件路径) + content(正文)"
sourcemapRef: 'proxy:31b1334b T1C1 (2.1.158);splitUserContextReminder;desc 区别于 global/project'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: memory_injection
  captureGroups:
    path: "本地指令文件路径(项目根 CLAUDE.local.md)"
    content: "文件正文"
---
## pattern

```regex
^(?:# claudeMd\nCodebase and user instructions are shown below\. Be sure to adhere to these instructions\. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written\.\n*)?Contents of (?<path>[^\n]+?) \(user's private project instructions[^)]*\):\n\n(?<content>[\s\S]*?)\n*$
```
