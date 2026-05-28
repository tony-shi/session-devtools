---
ruleId: claude-code.messages.tool-result.smoosh.v1
slotId: messages.tool_result
verifiedFor: null
sourceUnits: []
description: >-
  tool_result segment 的 smoosh 注入规则。当 tool_result rawText 尾部含有 task_reminder
  注入时，attribution 标记 smooshed_reminder flag（P1-2 后不再写 tail_injection_chars）。
stability: semi-static
sourcemapRef: 'restored-src/src/utils/messages.ts:1835'
attribution:
  patternFromBody: false
  trailingNewlines: 0
  matchMode: structural
  mechanism: tool_use_id_match
  category: tool_result
---
(patternFromBody=false,无 pattern body)
