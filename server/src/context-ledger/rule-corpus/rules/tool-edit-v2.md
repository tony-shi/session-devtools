---
ruleId: claude-code.tool.Edit.v2
slotId: tools.builtin
verifiedFor: "2.1.158"
appliesTo:
  minCcVersion: "2.1.158"
priority: 10
sourceUnits: []
description: "Claude Code 工具：Edit。2.1.158 模板，exact 全文锚定（static，可复现）。desc 360B。"
stability: static
displayName: "Edit"
summary: "工具定义：Edit（2.1.158 版固定描述）"
sourcemapRef: 'proxy:9e1ba147 T3C2 (2.1.158.d60); ref: claude-code-system-prompts tool-description-edit'
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
Performs exact string replacement in a file.

- You must Read the file in this conversation before editing, or the call will fail.
- `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.
- `replace_all: true` replaces every occurrence instead.
```
