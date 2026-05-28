---
ruleId: claude-code.tool.Agent.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Claude Code 工具：Agent（spawn sub-agent）。description 8071B，input_schema
  1441B。description 含动态 agent 列表（用户自定义 agent 可扩展），无法 exact；用 regex 头尾锚定。
stability: dynamic
sourcemapRef: 'binary:Agent tool prompt fn (2.1.126)'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: tools_schema_pattern
  category: tools_schema
  captureGroups: {}
---
## pattern

```regex
^Launch a new agent to handle complex, multi-step tasks\. Each agent type has specific capabilities and tools available to it\.\n\n[\s\S]+\*\*Do not spawn agents unless the user asks\.\*\*[\s\S]+</example>\n[\s\S]*$
```
