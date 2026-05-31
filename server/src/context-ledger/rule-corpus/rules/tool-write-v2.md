---
ruleId: claude-code.tool.Write.v2
slotId: tools.builtin
verifiedFor: "2.1.158"
appliesTo:
  minCcVersion: "2.1.158"
priority: 10
sourceUnits: []
description: "Claude Code 工具：Write。2.1.158 模板，exact 全文锚定（static，可复现）。desc 240B。"
stability: static
displayName: "Write"
summary: "工具定义：Write（2.1.158 版固定描述）"
sourcemapRef: 'proxy:9e1ba147 T3C2 (2.1.158.d60); ref: claude-code-system-prompts tool-description-write'
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: exact
  mechanism: tools_schema_pattern
  category: tools_schema
---
## pattern

```exact
Writes a file to the local filesystem, overwriting if one exists.

When to use: creating a new file, or fully replacing one you've already Read. Overwriting an existing file you haven't Read will fail. For partial changes, use Edit instead.
```
