---
ruleId: claude-code.system-prompt-prompt-body.v1
slotId: system.main-prompt.section.prompt-body
verifiedFor: "2.1.161"
sourceUnits: []
description: >-
  坍缩壳：ast-builder 的 collapseStaticSections 把相邻的纯静态 system H1 section(开场/Harness/
  会话守则/上下文管理/语气/工具/文本输出/...)合并成单一 prompt-body slot。这些段归因上同质(都是
  "CC 内置·静态·不可控")且逐字匹配脆弱、CC 每版重写,故不再逐段细分 rule,由本条宽松壳兜底,免维护。
  动态段(环境/记忆/Git 状态)不进本壳,仍各自独立 rule 做结构化提取。壳被动态段按物理序隔开时可
  出现多段(各自命中本 rule),显示同名「系统提示词」,符合"物理序不重排"。
stability: static
displayName: "系统提示词"
summary: "CC 内置静态指令(开场/运行框架/会话守则/上下文管理/语气与输出等);跨版本重写,按整段归因不细分"
sourcemapRef: "collapsed shell — see ast-builder.collapseStaticSections"
materialization: shape
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: regex
  mechanism: system_prompt_pattern
  category: system_prompt
---

## 说明

slotId `system.main-prompt.section.prompt-body` 由 ast-builder `collapseStaticSections` 合成
(非 wire 中的真实 H1 slug)。pattern 用 `^[\s\S]*$` 全匹配:壳的 rawText 是多段静态 section 的
物理拼接,内容随版本/会话变,无固定锚点可逐字匹配;安全性由 slotId 索引保证(rule 按 slotId 绑定,
本 pattern 只对 prompt-body 节点生效,不会误命中其它 slot)。

## pattern

```regex
^[\s\S]*$
```
