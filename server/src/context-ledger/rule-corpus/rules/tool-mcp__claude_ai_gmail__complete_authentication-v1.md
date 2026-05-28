---
ruleId: claude-code.tool.mcp__claude_ai_Gmail__complete_authentication.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  MCP tool: claude.ai Gmail OAuth callback 完成。description 469c，含 input_schema 总
  880c。
stability: semi-static
sourcemapRef: 'mcp:claudeai-proxy@gmailmcp.googleapis.com/mcp/v1'
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
Complete an in-progress OAuth flow for the `claude.ai Gmail` MCP server by submitting the callback URL.
```
