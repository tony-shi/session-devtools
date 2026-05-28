---
ruleId: claude-code.tool.TaskStop.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: Claude Code 工具：TaskStop（停止后台任务）。description 203B。
stability: semi-static
sourcemapRef: 'binary:TaskStop tool (2.1.126)'
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 1
  matchMode: exact
  mechanism: tools_schema_pattern
  category: tools_schema
---
## pattern

```exact

- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task
```
