---
ruleId: claude-code.system-prompt-intro.output-style.v1
slotId: system.main-prompt.section.prelude
verifiedFor: null
appliesTo: { maxCcVersion: "2.1.149" }
sourceUnits: []
description: >-
  Claude Code system prompt intro 段（Output Style 模式）。outputStyleConfig !== null
  时注入，以 'according to your "Output Style" below' 替换标准措辞。
stability: static
displayName: "输出风格"
summary: "输出风格约束(旧版)"
sourcemapRef: restored-src/src/constants/prompts.ts
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: prefix
  mechanism: system_prompt_pattern
  category: system_prompt
---
## pattern

```text

You are an interactive agent that helps users according to your "Output Style" below
```
