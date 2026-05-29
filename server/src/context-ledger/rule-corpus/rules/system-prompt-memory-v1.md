---
ruleId: claude-code.system-prompt-memory.v1
slotId: system.main-prompt.section.memory
verifiedFor: "2.1.150"
appliesTo: { minCcVersion: "2.1.150" }
sourceUnits:
  - unitId: system-prompt-memory-instructions
    relation: partial
  # agent-memory-instructions 是独立单元(内容 ≠ # Memory),不在本 rule 范围;
  # 若将来 # Memory 在 2.1.150+ 真合并了 agent-memory,可加回 partial
description: >-
  Claude Code 2.1.150 起 # Memory section,合并并取代旧 # auto memory。包含 persistent file-based memory 使用指南、frontmatter schema(name/description/metadata.type)、链接语法 [[name]]、不该保存什么的判断、MEMORY.md 索引文件约定。memoryPath / 用户名 是动态字段。
stability: static
displayName: "记忆"
summary: "持久化记忆(CLAUDE.md / MEMORY.md)的存在与读写规则"
sourcemapRef: "Piebald v2.1.150 system-prompt-memory-instructions + agent-memory-instructions"
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: prefix
  mechanism: system_prompt_pattern
  category: memory_injection
---

## 说明

slotId `system.main-prompt.section.memory` 由 ast-builder `slugifyHeader("Memory")` fallback
派生。在 2.1.150 取代了 2.1.126 的 `# auto memory`(后者已加 `appliesTo: maxCcVersion 2.1.149`)。
MVP 阶段 prefix 锚定 H1 头,后续可升级 regex 抠 memoryPath / 索引文件名等动态字段。

## pattern

```text
# Memory
```
