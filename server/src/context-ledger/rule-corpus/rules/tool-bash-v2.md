---
ruleId: claude-code.tool.Bash.v2
slotId: tools.builtin
verifiedFor: "2.1.158"
appliesTo:
  minCcVersion: "2.1.158"
priority: 10
sourceUnits: []
description: "Claude Code 工具：Bash。规则匹配整个 tool JSON(node.rawText)：锚定 name=Bash + 提交署名 Co-Authored-By，(?<model>) 在模型名真实出现处捕获(完整 家族+版本+可选 1M)，其余含 input_schema 由 [sS]* 全覆盖；仅署名里的模型名随会话所选模型变。对多个子版本真实 fixture 验证 fullyCovered。"
stability: dynamic
displayName: "Bash"
summary: "工具定义：Bash（2.1.158；署名模型名动态，其余固定）"
dynamicSource: "model ← 提交署名里的模型名（随会话所选模型，如 Opus 4.8 (1M context) / Opus 4.7 / Sonnet 4.6）"
sourcemapRef: 'proxy:9e1ba147 T3C2 (2.1.158.d60); 放宽后对 16 条真实 fixture 验证(Opus 4.7 / 4.7-1M / 4.8-1M)'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: tools_schema_pattern
  category: tools_schema
  captureGroups:
    model: "提交署名中的活动模型名，如 Opus 4.8 (1M context)"
---
## pattern

```regex
^[\s\S]*"name":\s*"Bash"[\s\S]*Co-Authored-By: Claude (?<model>(?:Opus|Sonnet|Haiku) [0-9.]+(?: \(1M context\))?) <noreply@anthropic\.com>[\s\S]*$
```
