---
ruleId: claude-code.messages.user-context.v2
slotId: messages.inline.system-reminder
verifiedFor: "2.1.158"
appliesTo:
  minCcVersion: "2.1.158"
priority: 10
sourceUnits: []
description: >-
  2.1.158 首条 user message 的 <system-reminder> userContext block：项目指令(CLAUDE.md，
  可含 AGENTS.md) + 持久化记忆(MEMORY.md) + userEmail + currentDate，包裹于固定前后缀。
  相比 v1（captureGroups 空、整块一坨、verifiedFor 2.1.126 → inferred），v2 钉 2.1.158、
  priority 10 压过 v1，并用 named group 拆出 5 个动态载荷（→ dynamicFields，definitive）。
  仅当 CLAUDE.md+MEMORY.md+email+date 同时存在时命中；缺项回退 v1/catch-all。
stability: dynamic
displayName: "用户上下文注入"
summary: "首条注入：项目指令(CLAUDE.md)+持久化记忆(MEMORY.md)+邮箱+日期；静态壳包动态载荷"
dynamicSource: "projectInstructions←CLAUDE.md/AGENTS.md, memoryContents←MEMORY.md, userEmail, currentDate, memoryPath"
sourcemapRef: 'proxy:9e1ba147 T3C2 (2.1.158.d60); restored-src/src/context.ts getUserContext + utils/api.ts prependUserContext'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: harness_injection
  captureGroups:
    projectInstructions: "项目指令文件正文（CLAUDE.md，可含 AGENTS.md），含 'Contents of … (project instructions…):' 壳"
    memoryPath: "持久化记忆 MEMORY.md 的运行时路径"
    memoryContents: "持久化记忆 MEMORY.md 正文（# Memory Index 列表）"
    userEmail: "账号邮箱"
    currentDate: "当前日期"
---
## pattern

```regex
^<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\n[\s\S]*?\n\n(?<projectInstructions>Contents of [\s\S]*?)\n\nContents of (?<memoryPath>[^\n]+MEMORY\.md) \(user's auto-memory[^)]*\):\n\n(?<memoryContents>[\s\S]*?)\n# userEmail\nThe user's email address is (?<userEmail>[^\n]+)\.\n# currentDate\nToday's date is (?<currentDate>[^\n]+)\.\n\n      IMPORTANT: this context may or may not be relevant to your tasks\. You should not respond to this context unless it is highly relevant to your task\.\n</system-reminder>\n*$
```
