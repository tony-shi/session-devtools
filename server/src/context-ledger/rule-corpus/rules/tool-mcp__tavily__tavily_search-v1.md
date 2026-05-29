---
ruleId: claude-code.tool.mcp__tavily__tavily_search.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: 'MCP tool: tavily_search（网页搜索）。description 145c，含 input_schema 总 2905c。'
stability: static
sourcemapRef: 'mcp:tavily'
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: prefix
  mechanism: tools_schema_pattern
  category: tools_schema
---
## pattern

```text
Search the web for current information on any topic. Use for news, facts, or data beyond your knowledge cutoff. Returns snippets and source URLs.
```
