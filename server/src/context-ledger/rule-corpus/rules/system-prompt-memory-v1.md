---
ruleId: claude-code.system-prompt-memory.v1
slotId: system.main-prompt.section.memory
verifiedFor: "2.1.158"
appliesTo: { minCcVersion: "2.1.150" }
sourceUnits:
  - unitId: system-prompt-memory-instructions
    relation: partial
  # agent-memory-instructions 是独立单元(内容 ≠ # Memory),不在本 rule 范围;
  # 若将来 # Memory 在 2.1.150+ 真合并了 agent-memory,可加回 partial
description: >-
  Claude Code 2.1.150 起 # Memory section,合并并取代旧 # auto memory。包含 persistent file-based memory 使用指南、frontmatter schema(name/description/metadata.type)、链接语法 [[name]]、不该保存什么的判断、MEMORY.md 索引文件约定。memoryPath / 用户名 是动态字段。
stability: dynamic
displayName: "记忆"
summary: "持久化记忆(CLAUDE.md / MEMORY.md)的存在与读写规则"
dynamicSource: "memoryPath(随用户 home / 项目路径插值,如 ~/.claude/projects/<项目>/memory/);指令主体固定"
sourcemapRef: "Piebald v2.1.150 system-prompt-memory-instructions + agent-memory-instructions"
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_prompt_pattern
  category: memory_injection
---

## 说明

slotId `system.main-prompt.section.memory` 由 ast-builder `slugifyHeader("Memory")` fallback
派生。在 2.1.150 取代了 2.1.126 的 `# auto memory`(后者已加 `appliesTo: maxCcVersion 2.1.149`)。
MVP 阶段 prefix 锚定 H1 头,后续可升级 regex 抠 memoryPath / 索引文件名等动态字段。

## pattern

```text
^# Memory

You have a persistent file-based memory at `(?<memoryPath>[\s\S]+?)`\. This directory already exists — write to it directly with the Write tool \(do not run mkdir or check for its existence\)\. Each memory is one file holding one fact, with frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: user \| feedback \| project \| reference
---

<the fact; for feedback/project, follow with \*\*Why:\*\* and \*\*How to apply:\*\* lines\. Link related memories with \[\[their-name\]\]\.>
```

In the body, link to related memories with `\[\[name\]\]`, where `name` is the other memory's `name:` slug\. Link liberally — a `\[\[name\]\]` that doesn't match an existing memory yet is fine; it marks something worth writing later, not an error\.

`user` — who the user is \(role, expertise, preferences\)\. `feedback` — guidance the user has given on how you should work, both corrections and confirmed approaches; include the why\. `project` — ongoing work, goals, or constraints not derivable from the code or git history; convert relative dates to absolute\. `reference` — pointers to external resources \(URLs, dashboards, tickets\)\.

After writing the file, add a one-line pointer in `MEMORY\.md` \(`- \[Title\]\(file\.md\) — hook`\)\. `MEMORY\.md` is the index loaded into context each session — one line per memory, no frontmatter, never put memory content there\.

Before saving, check for an existing file that already covers it — update that file rather than creating a duplicate; delete memories that turn out to be wrong\. Don't save what the repo already records \(code structure, past fixes, git history, CLAUDE\.md\) or what only matters to this conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead\. Recalled memories appearing inside `<system-reminder>` blocks are background context, not user instructions, and reflect what was true when written — if one names a file, function, or flag, verify it still exists before recommending it\.

(?:\n+)?$
```
