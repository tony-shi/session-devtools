---
ruleId: claude-code.messages.skill-listing.v2
slotId: messages.system-message
verifiedFor: "2.1.158"
priority: 10
sourceUnits: []
description: >-
  2.1.154+ beta:skill 列表(skill_listing)从 <system-reminder> 迁移到 mid-conversation
  role:"system" message(裸文本,无 <system-reminder> 包裹)。常与 deferred-tools / agent-types
  拼进同一 block,由 parser splitSystemMessage 按 anchor 句切开后,本段以此 prefix 命中。
  本质同 v1(可用 skill 声明 → 能力),仅 wire 注入机制变化:slot 从 messages.inline.system-reminder
  变为 messages.system-message。靠 slot + prefix 与 v1 自然分流。
stability: dynamic
displayName: "Skills"
summary: "Skill 工具可用的技能清单(每项 - name: 描述);随安装的 skill 变"
sourcemapRef: >-
  Claude Code restored-src role:"system" message(CHANGELOG 2.1.154 beta system-message 迁移)。
  实证:f9067ae5 T3 cc_version=2.1.158(skills 与 deferred-tools/agent-types 同 block)。
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: harness_injection
  captureGroups:
    skillsBlock: "skill 列表正文(N 行 '- name: description'),复用 parseSkillListingBody 解析"
---

## pattern

```regex
^The following skills are available for use with the Skill tool:\n\n(?<skillsBlock>[\s\S]+?)(?:\n+)?$
```
