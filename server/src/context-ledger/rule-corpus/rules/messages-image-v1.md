---
ruleId: claude-code.messages.image.v1
slotId: messages.block.image
verifiedFor: 2.1.126
sourceUnits: []
description: >-
  用户上传的 image content block（Anthropic API 协议类型）。rawText 为完整 JSON 字面量，含
  source.{type,media_type,data|url}。内容动态（base64 data 不可重建），用 captureGroups 提取
  sourceType / mediaType。
stability: dynamic
sourcemapRef: Anthropic API content block schema (image type)
materialization: presence
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: messages_content_block_pattern
  category: user_image
  captureGroups:
    sourceType: image source 类型：base64 | url
    mediaType: image MIME type（base64 形态必有；url 形态可选）
  notesTemplate:
    - format: 'sourceType={sourceType}'
      requireGroup: sourceType
    - format: 'mediaType={mediaType}'
      requireGroup: mediaType
---
## pattern

```regex
^\{"type":"image","source":\{"type":"(?<sourceType>base64|url)",(?:"media_type":"(?<mediaType>[^"]+)",)?[\s\S]*\}\s*\}\s*$
```
