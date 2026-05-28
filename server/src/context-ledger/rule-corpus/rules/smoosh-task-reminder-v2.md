---
ruleId: claude-code.smoosh.task-reminder.v2
slotId: messages.inline.system-reminder
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Smoosh 内容：task_reminder。每 10 个 assistant turn 触发，proxy 中作为
  <system-reminder>...</system-reminder> 段出现在 tool_result.content 字符串尾部。动态部分：可选
  task list（#id. [status] subject）。
stability: semi-static
sourcemapRef: 'restored-src/src/utils/attachments.ts:3375 + messages.ts:3680'
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: smoosh_content_match
  category: attachment
  captureGroups:
    dynamicTaskList: '可选：当前会话的 task list 渲染（每条 ''#id. [status] subject''）'
---
## pattern

```regex
^<system-reminder>\nThe task tools haven't been used recently\..*?(?:\n\nHere are the existing tasks:\n\n(?<dynamicTaskList>[\s\S]*?))?\n</system-reminder>$
```
