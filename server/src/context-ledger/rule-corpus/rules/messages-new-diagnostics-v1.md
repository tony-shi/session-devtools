---
ruleId: claude-code.messages.new-diagnostics.v1
slotId: messages.inline.system-reminder
verifiedFor: null
sourceUnits: []
description: >-
  system-reminder 的 new-diagnostics 子类：LSP/诊断注入。内层自带 <new-diagnostics>
  标签，diagnostics 摘要动态。⚠️ 若实际不被 <system-reminder> 包裹，将落到 free-text（死规则风险，待 smoke
  验证）。
stability: dynamic
sourcemapRef: Piebald v2.1.150 system-reminder-new-diagnostics-detected
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_reminder_pattern
  category: harness_injection
  captureGroups:
    diagnostics: 诊断摘要正文（formatDiagnosticsSummary 输出）
---
## pattern

```regex
^<system-reminder>\n<new-diagnostics>The following new diagnostic issues were detected:\n\n(?<diagnostics>[\s\S]*?)</new-diagnostics>\n</system-reminder>$
```
