---
ruleId: claude-code.system-prompt-context-management.v1
slotId: system.main-prompt.section.context-management
verifiedFor: "2.1.150"
sourceUnits: []
description: >-
  Claude Code system prompt 的 # Context management section（静态前言常量 mm3 单独成段，对应
  slot system.main-prompt.section.context-management）。2.1.142 binary 里常量名
  mm3（2.1.126 是 DM3），文案完全替换 —— 见上方注释。
stability: static
sourcemapRef: 'binary:mm3 (2.1.142) | binary:DM3 (2.1.126) | sourcemap: 无对应条目'
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_prompt_pattern
  category: system_prompt
---
## pattern

```regex
^# Context management\nWhen the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task\.(?:\n\n)?$
```
