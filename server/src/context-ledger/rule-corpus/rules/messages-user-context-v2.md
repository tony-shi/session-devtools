---
ruleId: claude-code.messages.user-context.v2
slotId: messages.inline.system-reminder
verifiedFor: "2.1.158"
appliesTo:
  minCcVersion: "2.1.158"
priority: 10
sourceUnits: []
description: >-
  2.1.158 首条 user message 的 <system-reminder> userContext block。鲁棒版：只锚定
  恒定外壳（opener + `# userEmail` + `# currentDate` + 收尾 IMPORTANT + </system-reminder>），
  把 `# claudeMd\n` 到 `\n# userEmail` 之间整段抓成 contextBody（不假设 CLAUDE.md/AGENTS.md/
  MEMORY.md 谁在场——有项目指令则含，无则只有固定导言 + memory，缺项也不失配）。userEmail /
  currentDate 各自捕获。contextBody 的内部拆分（固定导言 / 各项目指令文件 / MEMORY.md）由
  resolver 的 parseUserContextBody 二次解析（payload.userContext）。
  实证：9e1ba147 T3C2（有 CLAUDE.md，2220B）与 6291b671 T3C1（无 CLAUDE.md，1200B）均命中。
stability: dynamic
displayName: "用户上下文注入"
summary: "首条注入：项目指令(CLAUDE.md/AGENTS.md, 可缺) + 持久化记忆(MEMORY.md) + 邮箱 + 日期；静态壳包动态载荷"
dynamicSource: "contextBody←CLAUDE.md/AGENTS.md/MEMORY.md 正文(组成可变), userEmail, currentDate"
sourcemapRef: 'proxy:9e1ba147 T3C2 + 6291b671 T3C1 (2.1.158)；restored-src context.ts getUserContext + utils/api.ts prependUserContext'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: harness_injection
  captureGroups:
    contextBody: "# claudeMd 与 # userEmail 之间的全部上下文载荷（固定导言 + 各项目指令文件 + MEMORY.md），由 parseUserContextBody 再拆"
    userEmail: "账号邮箱"
    currentDate: "当前日期"
---
## pattern

```regex
^<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\n(?<contextBody>[\s\S]*?)\n# userEmail\nThe user's email address is (?<userEmail>[^\n]+)\.\n# currentDate\nToday's date is (?<currentDate>[^\n]+)\.\n\n      IMPORTANT: this context may or may not be relevant to your tasks\. You should not respond to this context unless it is highly relevant to your task\.\n</system-reminder>\n*$
```
