---
ruleId: claude-code.system-prompt-session-guidance.v1
slotId: system.main-prompt.section.session-guidance
verifiedFor: "2.1.150"
sourceUnits: []
description: >-
  Claude Code system prompt 的 # Session-specific guidance section（external CLI
  标准变体）。hasEmbeddedSearchTools()=false，searchTools='the Glob or Grep'（Glob/Grep
  工具在 tool registry 中存在）。这是外部用户的真实场景。完整文本待真实 external fixture 观测后补充 exact 匹配。
stability: dynamic
sourcemapRef: 'restored-src/src/constants/prompts.ts:352'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 1
  matchMode: prefix
  mechanism: system_prompt_pattern
  category: harness_injection
---
## pattern

```text
# Session-specific guidance
```
