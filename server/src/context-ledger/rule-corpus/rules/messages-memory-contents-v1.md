---
ruleId: claude-code.messages.memory-contents.v1
slotId: messages.inline.system-reminder
verifiedFor: null
sourceUnits: []
description: >-
  system-reminder 的 memory-contents 子类:CLAUDE.md / 嵌套 memory 文件注入。形如 'Contents
  of {path}{typeDesc}:\n\n{content}'，path/typeDesc/content 动态。
stability: dynamic
sourcemapRef: Piebald v2.1.150 system-reminder-memory-file-contents / nested-memory-contents
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: memory_injection
  captureGroups:
    memoryPath: memory 文件路径（含可选类型说明，如 " (user's auto-memory...)"）
    memoryContent: memory 文件正文
---
## pattern

```regex
^<system-reminder>\nContents of (?<memoryPath>.+?):\n\n(?<memoryContent>[\s\S]*?)\n</system-reminder>$
```
