---
ruleId: claude-code.smoosh.queued-command.v2
slotId: messages.inline.system-reminder
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Smoosh 内容：queued_command。用户在 LLM 调用进行中发新消息时，CLI 把消息排队为 queued_command
  attachment，随下次 normalize 时被 wrap+smoosh 进上一条 tool_result 尾部。
stability: dynamic
sourcemapRef: restored-src/src/utils/messages.ts queued_command flow
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: smoosh_content_match
  category: attachment
  captureGroups:
    messageBody: '用户排队的消息正文（可多行，含图片占位符 [Image #N]）'
---
## pattern

```regex
^<system-reminder>\nThe user sent a new message while you were working:\n(?<messageBody>[\s\S]*?)\n\nIMPORTANT: After completing your current task, you MUST address the user's message above\. Do not ignore it\.\n</system-reminder>$
```
