---
ruleId: claude-code.system-prompt-tone-style.external.v1
slotId: system.main-prompt.section.tone-style
verifiedFor: 2.1.142.6c2
sourceUnits: []
description: >-
  Claude Code # Tone and style section，2.1.141 起的 wire 形态（leaf 严格止于
  `period.`，555B）。Nm3 函数名按版本：2.1.142 = Nm3 / 2.1.126 = HM3 / 2.1.88 sourcemap =
  getSimpleToneAndStyleSection。
stability: static
sourcemapRef: >-
  binary:Nm3 (2.1.142) | dump:59339097 #15 (2.1.141) + 9b61c7de #93 (2.1.142) |
  restored-src/src/constants/prompts.ts:430 (2.1.88, stale)
appliesTo:
  minCcVersion: 2.1.141
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: exact
  mechanism: system_prompt_pattern
  category: system_prompt
---
## pattern

```exact
# Tone and style
 - Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
 - Your responses should be short and concise.
 - When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.
 - Do not use a colon before tool calls. Your tool calls may not be shown directly in the output, so text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.
```
