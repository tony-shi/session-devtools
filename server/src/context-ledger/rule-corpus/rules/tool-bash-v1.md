---
ruleId: claude-code.tool.Bash.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  Claude Code 工具：Bash（执行命令）。description 10686B，input_schema 1440B。description
  含大量动态内容（git/gh 操作指南、working dir、条件段），无法 exact；用 regex 头尾锚定。
stability: dynamic
sourcemapRef: 'binary:Bash tool prompt fn (2.1.126)'
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
^Executes a given bash command and returns its output\.[\s\S]+- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments$
```
