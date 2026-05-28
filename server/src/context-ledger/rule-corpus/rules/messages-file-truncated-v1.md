---
ruleId: claude-code.messages.file-truncated.v1
slotId: messages.inline.system-reminder
verifiedFor: null
sourceUnits: []
description: >-
  system-reminder 的 file-truncated 子类:读文件超长被截断的告知。filename / maxLines / readTool
  动态;大段静态文本作锚点。
stability: dynamic
sourcemapRef: Piebald v2.1.150 system-reminder-file-truncated
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: attachment
  captureGroups:
    filename: 被截断的文件名
    maxLines: 保留的首行数
    readTool: 用于继续读取的工具名
---
## pattern

```regex
^<system-reminder>\nNote: The file (?<filename>.+?) was too large and has been truncated to the first (?<maxLines>\d+) lines\. Don't tell the user about this truncation\. Use (?<readTool>\S+) to read more of the file if you need\.\n</system-reminder>$
```
