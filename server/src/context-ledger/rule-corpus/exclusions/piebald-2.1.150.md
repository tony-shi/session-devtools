---
ccVersion: "2.1.150"
piebaldRef: "Piebald-AI/claude-code-system-prompts@v2.1.150"
handled_elsewhere: []
out_of_scope: []
unsupported: []
---

# Piebald 2.1.150 — UnitAccounting Exclusions

本文件登记 Piebald v2.1.150 中**未被任何 corpus rule covered** 的 sourceUnits,
并显式给出 status + reason。drift 脚本(Phase 4)按此判定"未解释单元"。

## 现状(Phase 3 — minimal)

frontmatter 三个数组**故意暂留为空**。原因:Piebald v2.1.150 共 313 个 .md 单元
(`system-prompt-*` 66 / `system-reminder-*` 39 / `tool-*` 83 / `agent-prompt-*` 47 /
`skill-*` 37 / `data-*` 41),逐个登记需先跑 Phase 4 drift 脚本拿到精确未覆盖清单。

Phase 4 实施完成后,本文件应填充为:

### handled_elsewhere(走 wire/jsonl/inline 等非 rule attribution 路径)

- 所有 `system-reminder-*`(39 个):我们用 `messages.inline.system-reminder` 槽 +
  独立 reminder rule(已在 rule-registry.ts Batch1 完成,后续 Phase 6 迁入 corpus)
- 部分 `tool-*` 子单元(`bash-*` 共 40+ 个子单元):合并到 `tool.Bash.v1` 一条 rule

### out_of_scope(故意不管,我们的 session 永不出现)

- 所有 `data-*`(41):参考资料 / API 文档 / 引用模板,不被注入到 prompt
- 大部分 `agent-prompt-*`(47):subagent prompts,仅在使用对应 agent 时出现
- 大部分 `skill-*`(37):skill 内容,仅在 skill 触发时出现
- 功能门控 `system-prompt-*`(~30):auto-mode / learning-mode / insights / chrome /
  powershell / wsl / fork / scratchpad / minimal-mode 等,本 session 不开启

### unsupported(承认应支持但暂未做)

- (留待 Phase 4 drift 脚本运行后,根据真实"orphan units"列表填充)

## 工作流(Phase 4 完成后)

```sh
tsx server/scripts/check-piebald-drift.ts
# → 列出三差集:孤儿规则 / 未解释单元 / 漂移
# 把"未解释单元"逐项分类到上述三个数组,直到差集为空(= 100% 应对)
```
