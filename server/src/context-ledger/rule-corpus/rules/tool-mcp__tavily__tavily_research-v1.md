---
ruleId: claude-code.tool.mcp__tavily__tavily_research.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: 'MCP tool: tavily_research（综合研究）。description 269c，总 766c。'
stability: static
sourcemapRef: 'mcp:tavily'
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
Perform comprehensive research on a given topic or question. Use this tool when you need to gather information from multiple sources to answer a question or complete a task. Returns a detailed response based on the research findings. Rate limit: 20 requests per minute.
```
