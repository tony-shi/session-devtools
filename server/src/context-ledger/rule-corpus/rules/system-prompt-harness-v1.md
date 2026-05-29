---
ruleId: claude-code.system-prompt-harness.v1
slotId: system.main-prompt.section.harness
verifiedFor: "2.1.150"
appliesTo: { minCcVersion: "2.1.150" }
sourceUnits:
  - unitId: system-prompt-harness-instructions
    relation: partial
description: >-
  Claude Code 2.1.150 起新增的 # Harness section。位于 system[2] body,描述 harness 行为约定(markdown 渲染 / permission mode / system-reminder 注入 / 工具优先级 / 不可逆操作确认 / 诚实汇报等)。content 含 mode 列表与项目设置等少量动态,正文相对稳定。
stability: static
displayName: "运行框架"
summary: "Harness 运行环境说明:终端渲染、工具权限模式、hook 行为"
sourcemapRef: "Piebald v2.1.150 system-prompt-harness-instructions"
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: prefix
  mechanism: system_prompt_pattern
  category: system_prompt
---

## 说明

slotId `system.main-prompt.section.harness` 由 ast-builder `slugifyHeader("Harness")` fallback
派生(template 未枚举此 H1)。MVP 阶段用 prefix 锚定 H1 头,正文不抠捕获组(留待后续升级
为 regex + captureGroups,提取 mode 列表等)。

## pattern

```text
# Harness
```
