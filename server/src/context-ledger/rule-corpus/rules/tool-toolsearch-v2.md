---
ruleId: claude-code.tool.ToolSearch.v2
slotId: tools.builtin
verifiedFor: "2.1.158"
appliesTo:
  minCcVersion: "2.1.158"
priority: 10
sourceUnits: []
description: "Claude Code 工具：ToolSearch。2.1.158 模板，exact 全文锚定（static，可复现）。desc 953B。"
stability: static
displayName: "ToolSearch"
summary: "工具定义：ToolSearch（2.1.158 版固定描述）"
sourcemapRef: 'proxy:9e1ba147 T3C2 (2.1.158.d60); ref: claude-code-system-prompts tool-description-toolsearch'
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
Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms
```
