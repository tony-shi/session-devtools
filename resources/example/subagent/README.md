# Subagent example · `code-reviewer`

B 类"装文件可演"的最小完整样本：一份自定义 subagent，演示 `.claude/agents/*.md` 的 frontmatter 用法 + 与 skill 的协作。

> 来源：docs/en/sub-agents.md

## 目录结构

```
resources/example/subagent/
├── README.md                          ← 你正在看的
├── agents/
│   └── code-reviewer.md               ← 自定义 subagent
├── install.sh
└── uninstall.sh
```

## 安装

```bash
bash resources/example/subagent/install.sh
# 重启 Claude Code
```

之后 `Agent` 工具的 `subagent_type` 多一个选项 `code-reviewer`。

## 演示脚本（约 3 分钟）

### 第 1 幕 · subagent 是什么（30 秒）

打开 `agents/code-reviewer.md`，展示 frontmatter：

```yaml
---
description: 严格的代码审查员，关注安全性、可维护性、性能
tools: [Read, Grep, Bash]
model: claude-opus-4-7
---
```

> 解说：
> - **description** 是别人/主 Claude 决定要不要委派给它的依据
> - **tools** 限定它能用哪些工具——subagent 不像主 Claude 默认全开
> - **model** 可以为这个 subagent 单独指定模型

### 第 2 幕 · 委派任务（1 分钟）

在主对话：

> **委派 code-reviewer 审一下 client/src/components/ProxyTraffic.tsx**

预期：主 Claude 调用 `Agent` 工具，传 `subagent_type: "code-reviewer"` + 任务描述 → subagent 在独立 context 中执行 → 返回评审报告。

> 解说："**subagent 有自己的上下文**——它看不到主对话历史，只看到主 Claude 给它的委派消息和它自己加载的 SKILL.md（如果有）。"

### 第 3 幕 · 与 skill 的协作（1 分钟）

如果已经装了 `todo-scan` skill（见 `../skill/`），改委派：

> **委派 code-reviewer 审一下整个 client/src/，先用 todo-scan 摸清债务再评审**

预期：subagent **自主调用** `todo-scan` skill（subagent 默认能看到所有全局 skill），再做评审。

> 解说："**skill 是宿主无关的**——主 Claude 能用的，subagent 也能用。这就是 skill 和 subagent 的天然组合。"

### 收尾 · 何时该自定义 subagent（30 秒）

| 场景 | 用主 Claude | 用 subagent |
|------|------------|------------|
| 一次性问答 | ✓ | |
| 需要隔离上下文（避免污染） | | ✓ |
| 需要不同的 tools / model 限制 | | ✓ |
| 需要并发跑多份 | | ✓ |
| 需要可复用的"角色"（如 reviewer / debugger） | | ✓ |

## 卸载

```bash
bash resources/example/subagent/uninstall.sh
```

## 设计要点

- **不重做 skill 那一套** —— skill demo 已经讲过"装文件 + 实操 + 解读"流程，本 demo 借 frontmatter 字段差异区分 subagent 跟 skill 的不同
- **第 3 幕证明"宿主无关"** —— 与主 skill demo 形成回环引用，强化"skill / agent 是正交维度"
- **没演 task tool 直接调用** —— 那是 SDK 范畴，CLI 体验里 Agent 工具就是主要入口

## 关联

- 主 skill demo：[`../skill/README.md`](../skill/README.md)
- 覆盖盘点：[`../COVERAGE.md`](../COVERAGE.md)
