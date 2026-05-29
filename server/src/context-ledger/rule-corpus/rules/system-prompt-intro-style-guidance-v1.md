---
ruleId: claude-code.system-prompt-intro.style-guidance.v1
slotId: system.main-prompt.section.prelude
verifiedFor: "2.1.150"
appliesTo: { minCcVersion: "2.1.150" }
sourceUnits: []
description: >-
  Claude Code 2.1.150 起 sys[3] 头部的全新 prelude:写代码风格指引("Write code that reads like the surrounding code...")+ 不可逆操作确认 + 诚实汇报。在 2.1.149- 不存在。
stability: static
displayName: "输出风格"
summary: "输出风格与格式约束(终端 Markdown / 简洁度)"
sourcemapRef: "tmp/ea0bc205_T2_C4 sys[3] head (810 chars)"
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: prefix
  mechanism: system_prompt_pattern
  category: system_prompt
---

## 说明

slotId 仍为 `system.main-prompt.section.prelude`(splitByH1Headers 对 sys[3] 也会切出 prelude
= H1 之前的内容)。两条 prelude rule(intro-standard.v2 与本条)都绑 prelude slot,evaluator
按 first-match 选——pattern 互斥(首句完全不同)。

## pattern

```text
Write code that reads like the surrounding code: match its comment density, naming, and idiom.
```
