---
ruleId: claude-code.system-prompt-using-your-tools.v1
slotId: system.main-prompt.section.using-tools
verifiedFor: null
sourceUnits: []
description: >-
  Claude Code system prompt 的 # Using your tools section（旧版文本，external
  用户）。taskToolName 缺失时（无 TaskCreate/TodoWrite）的变体，不含 'Break down and manage'
  bullet。ant 分支及 REPL 模式不适用。fixture 版本，当前 2.1.123 sourcemap 已有变化。
stability: static
sourcemapRef: 'restored-src/src/constants/prompts.ts:269'
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
# Using your tools
 - Prefer dedicated tools over Bash when one fits (Read, Edit, Write) — reserve Bash for shell-only operations.
 - Use TaskCreate to plan and track work. Mark each task completed as soon as it's done; don't batch.
 - You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially. For instance, if one operation must complete before another starts, run these operations sequentially instead.
```
