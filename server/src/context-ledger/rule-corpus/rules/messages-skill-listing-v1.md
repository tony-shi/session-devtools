---
ruleId: claude-code.messages.skill-listing.v1
slotId: messages.inline.system-reminder
verifiedFor: null
sourceUnits: []
description: >-
  system-reminder 的 skill_listing 子类：cli.js uMY 每轮根据已发送 skill Set 计算 delta，包成 SR
  注入 messages[0]/[N]。header 与外层 SR 标签是硬编码，正文（每行 '- name: desc'）随会话动态。本 rule 用
  header signature 锚定，正文作为单个 skillsBlock 命名组留给下游解析。
stability: dynamic
sourcemapRef: >-
  restored-src/src/utils/attachments.ts:2745 (skill_listing attachment) +
  restored-src/src/utils/messages.ts:3728 (normalizeAttachmentForAPI
  skill_listing) + restored-src/src/tools/SkillTool/prompt.ts:65
  (formatCommandDescription)
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: skill_listing
  captureGroups:
    skillsBlock: >-
      skill 清单正文：N 行 '- name: description'（description 可能以 \u2026 截断，极端预算下整行可能只剩
      '- name'）。下游按行解析；解析失败的行保留 raw。
---
## pattern

```regex
^<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n(?<skillsBlock>[\s\S]+?)\n</system-reminder>\n*$
```
