---
ruleId: claude-code.messages.file-attachment.v1
slotId: messages.inline.system-reminder
verifiedFor: null
sourceUnits: []
description: >-
  @file attachment 注入：用户 @-mention 文件时，JSONL attachment.type=file
  携带文件全文，normalizeAttachmentForAPI 将其展开为 Read call + Read result 两条
  system-reminder 包裹的 synthetic
  messages。行号格式：{n}\t{line}（FileReadTool.ts）。truncated 时附带第三条截断提示。
stability: dynamic
sourcemapRef: >-
  restored-src/src/utils/attachments.ts:3020 (generateFileAttachment) +
  restored-src/src/utils/messages.ts:3545 (case 'file') +
  restored-src/src/tools/FileReadTool/FileReadTool.ts:652 (行号格式) +
  restored-src/src/tools/FileReadTool/prompt.ts:10 (MAX_LINES_TO_READ=2000)
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: attachment
  captureGroups: {}
---
## pattern

```regex
^<system-reminder>\nCalled the Read tool with the following input: 
```
