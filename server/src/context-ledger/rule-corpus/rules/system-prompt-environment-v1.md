---
ruleId: claude-code.system-prompt-environment.v1
slotId: system.main-prompt.section.environment
verifiedFor: "2.1.150"
sourceUnits: []
description: >-
  Claude Code system prompt 的 # Environment section。computeSimpleEnvInfo()
  无条件注入。动态字段: cwd, isGit, platform, shell, osVersion, modelDesc, cutoff,
  modelFamily, fastModeModel。用 regex 锚定固定结构（bullet 标签、顺序），通过 captureGroups
  提取各动态字段。
stability: dynamic
displayName: "环境"
summary: "运行环境事实:工作目录 / 平台 / 日期 / git 概况"
dynamicSource: "日期(每天)+ git 分支/状态(每次操作)"
sourcemapRef: 'restored-src/src/constants/prompts.ts:651'
materialization: normalized_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_prompt_pattern
  category: harness_injection
  captureGroups:
    cwd: Primary working directory（getCwd() — 绝对路径）
    isGit: '''true'' 或 ''false''（getIsGit()）'
    platform: '平台标识符（env.platform: ''darwin''/''win32''/''linux''）'
    shell: shell 名称（getShellInfoLine()）
    osVersion: OS 版本字符串（getUnameSR()）
    modelDesc: 模型描述（getMarketingNameForModel(modelId) + modelId）
    cutoff: knowledge cutoff 日期（getKnowledgeCutoff() — 各模型固定常量）
    modelFamily: '最新模型系列说明行（CLAUDE_4_5_OR_4_6_MODEL_IDS — @[MODEL LAUNCH] 更新）'
    fastModeModel: 'Fast mode 模型名（FRONTIER_MODEL_NAME — @[MODEL LAUNCH] 更新）'
  notesTemplate:
    - format: 'cwd={cwd}'
      requireGroup: cwd
    - format: 'platform={platform}'
      requireGroup: platform
    - format: 'shell={shell}'
      requireGroup: shell
    - format: 'osVersion={osVersion}'
      requireGroup: osVersion
    - format: 'model={modelDesc}'
      requireGroup: modelDesc
    - format: 'cutoff={cutoff}'
      requireGroup: cutoff
---
## pattern

```regex
^# Environment
You have been invoked in the following environment: 
 - Primary working directory: (?<cwd>[^\n]+)
(?:  - This is a git worktree[^\n]+
)? {1,2}- Is a git repository: (?<isGit>true|false)
 - Platform: (?<platform>[^\n]+)
 - Shell: (?<shell>[^\n]+)
 - OS Version: (?<osVersion>[^\n]+)
 - (?<modelDesc>You are powered by[^\n]+)
 - Assistant knowledge cutoff is (?<cutoff>[^\n]+).
 - The most recent Claude model family is (?<modelFamily>[^\n]+)
 - Claude Code is available as a CLI in the terminal, desktop app \(Mac/Windows\), web app \(claude\.ai/code\), and IDE extensions \(VS Code, JetBrains\).
 - Fast mode for Claude Code uses (?<fastModeModel>[^\n]+)
[\s\S]*$
```
