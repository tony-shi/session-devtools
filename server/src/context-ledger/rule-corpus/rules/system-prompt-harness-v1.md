---
ruleId: claude-code.system-prompt-harness.v1
slotId: system.main-prompt.section.harness
verifiedFor: "2.1.158"
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
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_prompt_pattern
  category: system_prompt
---

## 说明

slotId `system.main-prompt.section.harness` 由 ast-builder `slugifyHeader("Harness")` fallback
派生(template 未枚举此 H1)。MVP 阶段用 prefix 锚定 H1 头,正文不抠捕获组(留待后续升级
为 regex + captureGroups,提取 mode 列表等)。

## pattern

```text
^# Harness
 - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal\.
 - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim\.
 - `<system-reminder>` tags in messages and tool results are injected by the harness, not the user\. Hooks may intercept tool calls; treat hook output as user feedback\.
 - Prefer the dedicated file/search tools over shell commands when one fits\. Independent tool calls can run in parallel in one response\.
 - Reference code as `file_path:line_number` — it's clickable\.(?:\n+)?$
```
