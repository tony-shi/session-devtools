---
ruleId: claude-code.tool.Bash.v2
slotId: tools.builtin
verifiedFor: "2.1.158"
appliesTo:
  minCcVersion: "2.1.158"
priority: 10
sourceUnits: []
description: "Claude Code 工具：Bash。2.1.158：desc 主体静态，仅提交署名里的模型名随会话所选模型变；regex head+tail 锚定，(?<model>) 捕获模型名。desc 1304B。"
stability: dynamic
displayName: "Bash"
summary: "工具定义：Bash（2.1.158；署名模型名动态，其余固定）"
dynamicSource: "model ← 提交署名 Claude Opus X.Y（随会话所选模型，如 4.8/4.7）"
sourcemapRef: 'proxy:9e1ba147 T3C2 (2.1.158.d60)'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: tools_schema_pattern
  category: tools_schema
  captureGroups:
    model: "提交署名中的活动模型名，如 Opus 4.8"
---
## pattern

```regex
^Executes a bash command and returns its output\.[\s\S]*Co-Authored-By: Claude Opus (?<model>[0-9.]+) \(1M context\) <noreply@anthropic\.com>[\s\S]*🤖 Generated with \[Claude Code\]\(https://claude\.com/claude-code\)\n*$
```
