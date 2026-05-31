---
ruleId: claude-code.system-prompt-session-guidance.v2
slotId: system.main-prompt.section.session-guidance
verifiedFor: "2.1.158"
appliesTo:
  minCcVersion: "2.1.158"
priority: 10
sourceUnits: []
description: >-
  2.1.158 `# Session-specific guidance` section（splitByH1Headers 经 template 枚举
  "Session-specific guidance" → slot ...session-guidance）。v1 的 pattern 是脆的逐字复刻
  （含畸形的可选反引号 hack），在真实 6291b671/9e1ba147 上不匹配 → 该节点 RULE_GAP。v2 用
  head+tail 锚定（首句 + 末句固定，中段 [\s\S]* 容忍 /schedule、ultrareview 等措辞微调），
  priority 10 压过坏掉的 v1，吃满整节点。内容跨会话静态（!命令 / /skill / /schedule / ultrareview 守则）。
  实证：6291b671 T3C1 session-guidance 节点 1719B，head/tail 见下。
stability: static
displayName: "会话守则"
summary: "本会话特定的行为指引(! 命令 / /<skill> / /schedule 提议 / ultrareview 说明)"
sourcemapRef: 'proxy:6291b671 T3C1 + 9e1ba147 T3C2 (2.1.158)；restored-src/src/constants/prompts.ts:352'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_prompt_pattern
  category: harness_injection
---
## pattern

```regex
^# Session-specific guidance\n - If you need the user to run a shell command themselves[\s\S]*the no-arg form bundles the local branch and does not need a GitHub remote\.\n*$
```
