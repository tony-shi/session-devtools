---
ruleId: claude-code.system-prompt-gitstatus.v1
slotId: system.main-prompt.section.context
verifiedFor: "2.1.150"
sourceUnits: []
description: >-
  Claude Code system prompt 末尾 gitStatus 块（动态 git 信息，对应 slot
  system.main-prompt.section.context）。2.1.142 binary 里函数名 x98（sourcemap 旧名
  getGitStatusContext）。非 git 仓库时整个 slot 缺失。gitUser 是条件字段。
stability: dynamic
sourcemapRef: 'binary:x98 (2.1.142) | restored-src getGitStatusContext (2.1.88)'
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_prompt_pattern
  category: harness_injection
  captureGroups:
    currentBranch: 当前 git 分支名（git branch --show-current）
    mainBranch: PR base 分支名（origin/main 或 origin/master 等探测结果）
    gitUser: git config user.name（可选，未配置时缺失）
    status: git status --short 输出（空表示 clean，>2000 chars 时截断附提示）
    recentCommits: git log --oneline -n 5 输出（最近 5 条提交）
  notesTemplate:
    - format: 'currentBranch={currentBranch}'
      requireGroup: currentBranch
    - format: 'mainBranch={mainBranch}'
      requireGroup: mainBranch
    - format: 'gitUser={gitUser}'
      requireGroup: gitUser
---
## pattern

```regex
^gitStatus: This is the git status at the start of the conversation\. Note that this status is a snapshot in time, and will not update during the conversation\.\n\nCurrent branch: (?<currentBranch>[^\n]+)\n\nMain branch \(you will usually use this for PRs\): (?<mainBranch>[^\n]+)(?:\n\nGit user: (?<gitUser>[^\n]+))?\n\nStatus:\n(?<status>[\s\S]*?)\n\nRecent commits:\n(?<recentCommits>[\s\S]+)$
```
