---
ruleId: claude-code.messages.local-command.v1
slotId: messages.inline.local-command
verifiedFor: null
sourceUnits: []
description: >-
  Claude Code 在 user turn 里注入的本地命令历史块（bash/local-command 标签）。包含
  <local-command-caveat>, <bash-input>, <bash-stdout>, <bash-stderr>,
  <command-name>, <local-command-stdout> 等标签。
stability: dynamic
sourcemapRef: restored-src/src/utils/messages.ts (createUserMessage local command)
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: local_command_pattern
  category: local_command_history
---
## pattern

```regex
^(?:<local-command-[a-z-]+>|<bash-[a-z-]+>|<command-[a-z-]+>)[\s\S]*$
```
