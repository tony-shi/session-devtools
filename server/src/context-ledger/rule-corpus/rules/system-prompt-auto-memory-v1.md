---
ruleId: claude-code.system-prompt-auto-memory.v1
slotId: system.main-prompt.section.auto-memory
verifiedFor: null
appliesTo: { maxCcVersion: "2.1.149" }
sourceUnits: []
description: >-
  Claude Code system prompt 的 # auto memory section。buildMemoryLines()
  产出，唯一动态字段为 memoryDir（本地路径，用户私有）。其余全部为固定常量（TYPES_SECTION、WHAT_NOT_TO_SAVE 等）。
stability: dynamic
sourcemapRef: 'restored-src/src/memdir/memdir.ts:419 + restored-src/src/memdir/memoryTypes.ts'
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_prompt_pattern
  category: harness_injection
  captureGroups:
    memoryDir: >-
      用户的 auto memory 本地路径（getAutoMemPath()
      返回值），格式：~/.claude/projects/{sanitized-cwd}/memory/
  notesTemplate:
    - format: 'memoryDir={memoryDir}'
      requireGroup: memoryDir
---
## pattern

```regex
^# auto memory\n\nYou have a persistent, file-based memory system at `(?<memoryDir>[^`]+)`\. This directory already exists — write to it directly with the Write tool \(do not run mkdir or check for its existence\)\.[\.\s\S]*$
```
