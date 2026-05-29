---
ruleId: claude-code.smoosh.file-modified.v1
slotId: messages.inline.system-reminder
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Smoosh 内容：file-modified。当文件在两次 LLM 调用之间被修改时，harness 注入修改后内容到下一次请求的 SR
  中。filepath 与文件正文为动态部分。
stability: dynamic
sourcemapRef: restored-src/src/utils/messages.ts (file_modified injection)
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: smoosh_content_match
  category: attachment
  captureGroups:
    filepath: 被修改的文件绝对路径
    fileBody: '带行号的文件内容（格式 ''N\t{line}''）'
---
## pattern

```regex
^<system-reminder>\nNote: (?<filepath>[^\s]+) was modified, either by the user or by a linter\..*?Here are the relevant changes \(shown with line numbers\):\n(?<fileBody>[\s\S]*?)\n</system-reminder>$
```
