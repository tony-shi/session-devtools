---
ruleId: claude-code.system-prompt-output-efficiency.external.v1
slotId: system.main-prompt.section.output-efficiency
verifiedFor: null
sourceUnits: []
description: >-
  【STALE】旧 sourcemap 推测的 # Output efficiency section。2.1.126 binary 确认不存在此
  header；当前实际使用 # Text output (does not apply to tool calls)。保留仅作历史记录，实际不参与
  attribution 命中。
stability: static
sourcemapRef: 'restored-src/src/constants/prompts.ts:403 (stale, 2.1.123 era guess)'
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
^# Output efficiency\n
```
