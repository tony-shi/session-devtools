---
ruleId: claude-code.system-prompt-tone-style.external.v0
slotId: system.main-prompt.section.tone-style
verifiedFor: 2.1.140.453
sourceUnits: []
description: >-
  Claude Code # Tone and style section，2.1.140 及更早的 wire 形态（leaf 含尾
  `\n\n`，557B）。Nm3 函数输出本身仍是 555B，但 system block 拼接的 glue 被 splitByH1Headers 划入了
  leaf。
stability: static
sourcemapRef: 'binary:Nm3 (2.1.140) | dump:15aa1c88 #47 (2.1.139) + 427a2904 T3 C1 (2.1.140)'
appliesTo:
  maxCcVersion: 2.1.140
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 2
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
