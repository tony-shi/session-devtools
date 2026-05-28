---
ruleId: claude-code.messages.away-summary.v1
slotId:
  - messages.inline.free-text
  - messages.text
verifiedFor: null
sourceUnits: []
description: >-
  Claude Code 的 "while-you-were-away" recap 提示词。CLI 在用户离开重回时生成简短复盘，prompt 以 "The
  user stepped away and is coming back." 开头。覆盖两种发送形态：独立 side query
  (querySource=away_summary) 和 main session 末尾追加。
stability: static
sourcemapRef: restored-src/src/services/awaySummary.ts buildAwaySummaryPrompt
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: session_recap_prompt
  category: system_local_command
---
## pattern

```regex
^(?:Session memory \(broader context\):\n[\s\S]+?\n\n)?The user stepped away and is coming back\.[\s\S]+$
```
