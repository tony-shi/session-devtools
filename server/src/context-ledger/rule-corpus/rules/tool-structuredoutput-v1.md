---
ruleId: claude-code.tool.StructuredOutput.v1
slotId: tools.builtin
verifiedFor: "2.1.167"
appliesTo: { minCcVersion: "2.1.167" }
priority: 10
sourceUnits: []
description: >-
  Workflow subagent 专属工具：StructuredOutput（带 schema 的 agent() 强制其
  调用一次返回结构化结果）。description 178B session-static、跨 agent/项目
  逐字节一致，exact 锚定；input_schema 是 per-agent 动态的（编排脚本现场
  定义的输出 shape），不入 pattern。
stability: static
displayName: "StructuredOutput"
summary: "工具定义：StructuredOutput（workflow subagent 结构化返回）"
sourcemapRef: 'proxy:bd5d3dd7 wf_ca00a61b (2.1.167.483)'
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: exact
  mechanism: tools_schema_pattern
  category: tools_schema
---
## 说明

仅出现在带 schema 的 workflow subagent 请求（tools 7 个：Bash/Edit/Read/Skill/
ToolSearch/Write/StructuredOutput）；schema-less agent 无此工具（6 个）。

## pattern

```exact
Use this tool to return your final response in the requested structured format. You MUST call this tool exactly once at the end of your response to provide the structured output.
```
