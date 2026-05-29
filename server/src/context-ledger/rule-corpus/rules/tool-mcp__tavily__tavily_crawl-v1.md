---
ruleId: claude-code.tool.mcp__tavily__tavily_crawl.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: 'MCP tool: tavily_crawl（网页爬取）。description 101c，含 input_schema 总 1949c。'
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
Crawl a website starting from a URL. Extracts content from pages with configurable depth and breadth.
```
