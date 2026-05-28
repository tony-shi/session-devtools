---
ruleId: claude-code.messages.image-placeholder.v1
slotId: messages.inline.image-placeholder
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  CLI 在 user message 里注入的图片占位文本。形态：`[Image: source: <path>]`、`[Image #<N>:
  source: <path>]`、`[Image #<N>]`。对应同 user message 内同时存在的 messages.block.image
  真实 base64 块。
stability: dynamic
sourcemapRef: claude-code CLI image upload placeholder (cli text injection)
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: messages_content_block_pattern
  category: user_image_placeholder
  captureGroups:
    imageIndex: 1-based 图片序号（多图或回引时存在）
    path: '上传时的本地文件路径（回引形态 `[Image #N]` 无此字段）'
---
## pattern

```regex
^\[Image(?:\s*#(?<imageIndex>\d+))?(?:\s*:\s*source:\s*(?<path>[^\]\n]+))?\]$
```
