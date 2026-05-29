---
ruleId: claude-code.system-prompt-identity.v1
slotId: system.identity
verifiedFor: "2.1.150"
sourceUnits: []
description: >-
  Claude Code system prompt 的固定身份标识行(57 chars)。仅用于 attribution 识别锚点与 reconstruction 注入,不归因整段 system prompt 内容来源。
stability: static
displayName: "身份"
summary: "固定身份标识行,标记这是 Claude Code 会话(归因锚点)"
sourcemapRef: restored-src/src/constants/system.ts
materialization: exact_text
attribution:
  patternFromBody: true
  matchMode: exact
  mechanism: system_prompt_pattern
  category: system_prompt
---

## 说明

Piebald 不把这条 identity 当作独立的 prompt 单元(它是 CLI 端的 `DEFAULT_PREFIX` wrap
字符串,不属于"被注入的 prompt 内容"),所以 `sourceUnits: []`。drift 脚本应将"sourceUnits
为空 + 规则仍命中"视作合法(rule 是 wire-level wrapper 识别,非 prompt-unit attribution)。

verifiedFor 保留 `"2.1.126"`(Phase 2 行为不变原则);Phase 3 升 2.1.150。

## pattern

```exact
You are Claude Code, Anthropic's official CLI for Claude.
```
