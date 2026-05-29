---
ruleId: claude-code.system-prompt-intro.standard.v2
slotId: system.main-prompt.section.prelude
verifiedFor: "2.1.150"
appliesTo: { minCcVersion: "2.1.150" }
sourceUnits: []
description: >-
  Claude Code 2.1.150 起的简化 intro(sys[2] 头部,# Harness 之前)。措辞从"Use the instructions below and the tools available to you to assist the user."简化掉,移除了 NEVER URLs 那句。prefix 锚定。
stability: static
displayName: "开场白"
summary: "开场引导:用下列指令和可用工具协助用户"
sourcemapRef: "Piebald v2.1.150 + tmp/ea0bc205_T2_C4 sys[2]"
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: prefix
  mechanism: system_prompt_pattern
  category: system_prompt
---

## 说明

2.1.150 起 sys[2] 头部的 intro 段。原 v1(2.1.149-)pattern 是 exact 全文,2.1.150 措辞改了
→ exact 失配。这里改 prefix 锚定首句,正文允许跟任意后续(含 IMPORTANT 安全声明)。

## pattern

```text
You are an interactive agent that helps users with software engineering tasks.
```
