---
ruleId: claude-code.side-query.session-title.v1
slotId: side-query.system
verifiedFor: null
sourceUnits: []
description: >-
  Claude Code 自动生成会话标题的 side query（generateSessionTitle）。通过 queryHaiku() 发送给
  Haiku 模型，tools=0，messages=1（主 session
  第一条用户消息），output_config=json_schema({title})，system=[billing, identity,
  SESSION_TITLE_PROMPT]。无 JSONL——不写 sessionStorage，pipeline 以 attribution-only
  模式处理。queryScope=side_query 严格约束，主请求不会命中。
stability: static
sourcemapRef: >-
  restored-src/src/utils/sessionTitle.ts:56 +
  restored-src/src/services/api/claude.ts:3241 +
  restored-src/src/bridge/initReplBridge.ts:336
queryScope: side_query
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_prompt_pattern
  category: system_prompt
---
## pattern

```regex
^Generate a concise, sentence-case title \(3-7 words\) that captures the main topic or goal of this coding session\. The title should be clear enough that the user recognizes the session in a list\. Use sentence case: capitalize only the first word and proper nouns\.\n\nReturn JSON with a single "title" field\.\n\nGood examples:\n\{"title": "Fix login button on mobile"\}\n\{"title": "Add OAuth authentication"\}\n\{"title": "Debug failing CI tests"\}\n\{"title": "Refactor API client error handling"\}\n\nBad \(too vague\): \{"title": "Code changes"\}\nBad \(too long\): \{"title": "Investigate and fix the issue where the login button does not respond on mobile devices"\}\nBad \(wrong case\): \{"title": "Fix Login Button On Mobile"\}
```
