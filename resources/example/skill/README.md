# Skill 教学 demo — `todo-scan` 全家桶

一份完整的 Claude Code skill 教学链路：从「内置 skill 长什么样」一路讲到「skill 作为可执行能力包」。

## 目录结构

```
resources/example/skill/
├── README.md                          ← 你正在看的这个（演示脚本）
├── todo-scan/SKILL.md                 ← 【基础】资料模式
├── todo-scan-fork/SKILL.md            ← 【基础】任务模式（context: fork）
├── todo-scan-args/SKILL.md            ← 【进阶】参数 + allowed-tools
├── todo-scan-html/                    ← 【进阶】打包脚本
│   ├── SKILL.md
│   └── scripts/render.py
├── fixtures/seed-todos.sh             ← 预埋演示样本
├── docs/mode-diagram.md               ← 两模式认知图（mermaid）
├── install.sh                         ← 符号链接 4 个 skill 到 .claude/skills/
└── uninstall.sh
```

## 安装

```bash
bash resources/example/skill/install.sh
bash resources/example/skill/fixtures/seed-todos.sh    # 必跑，否则现场扫不出东西
```

之后**重启 Claude Code**。

---

## 演示脚本（约 8 分钟，7 幕递进 + 收尾）

教学链路：**「skill 是什么 → 怎么装 → 怎么激活 → 模式（资料 vs 任务）→ 进阶（参数 / 预批准 / 打包脚本）→ 抽象总结」**。

### 第 1 幕 · skill 是什么（1 分钟）

在主对话直接问 Claude：

> **你现在能用的 skill 都有哪些？挑一个最短的展示它的 SKILL.md。**

让 Claude 自己列出内置 skill 清单，并打开一份让观众看到 frontmatter 长什么样。补一句：

```bash
ls ~/.claude/skills/    # 用户级
ls .claude/skills/      # 项目级
```

> 解说："**skill = 一份 markdown + frontmatter，被 Claude Code 自动加载**。frontmatter 描述它自己，正文写它要做的事。"

### 第 2 幕 · 装一个自己的小 skill（1 分钟）

```bash
bash resources/example/skill/install.sh
bash resources/example/skill/fixtures/seed-todos.sh
# 重启 Claude Code
ls -la .claude/skills/   # 看到 4 个符号链接
```

打开 `todo-scan/SKILL.md`，让观众看到它只有 ~30 行。

> 解说："**没改任何配置、没注册任何命令**——丢进 `.claude/skills/` 就行。"

### 第 3 幕 · 资料模式 · 激活机制（1.5 分钟）

**关键：不喊 skill 名字，用人话。**

> **扫一下我们这有哪些 TODO 没做？**

预期：Claude **自主**调用 `todo-scan`。

> 解说："我没说 `/todo-scan`，它根据 `description` 自己决定要用——**激活机制 = description 匹配自然语言意图**。"

**反证**：换一句不相关的话，证明激活有判断。

### 第 4 幕 · 任务模式 · context: fork（1.5 分钟）

并排打开两份 SKILL.md：

```yaml
# todo-scan/SKILL.md                # todo-scan-fork/SKILL.md
---                                 ---
name: todo-scan                     name: todo-scan-fork
description: ...                    description: ...
                                    context: fork        ← 新增
                                    agent: Explore       ← 新增
---                                 ---
（正文一字不差）                       （正文一字不差）
```

触发：

> **/todo-scan-fork**

预期：当场 fork 一个 Explore subagent 执行，主对话只看到结果摘要。

> 解说："**正文完全一样，frontmatter 多两行**，就从资料变成任务——结果回主对话但过程被隔离。"

### 第 5 幕 · 进阶 · 参数 + 工具预批准（1 分钟）

打开 `todo-scan-args/SKILL.md`，看 frontmatter：

```yaml
arguments: [path, ext]
allowed-tools: Bash(grep *)
```

正文里用 `$path` / `$ext` 占位。

触发：

> **/todo-scan-args tmp/skill-demo-todos go**

预期：只扫 `tmp/skill-demo-todos/*.go`，**`grep` 命令不弹出确认对话框**。

> 解说：
> - "**参数化**让一份 skill 适配多个场景，命令模板的关键。"
> - "**`allowed-tools`** 在 skill 激活期间为指定工具预批准——commit / deploy 类 skill 必备，不然每步都要按 yes 太煞风景。"

> 一句进阶："文档里还有 `disable-model-invocation: true`（只允许人触发，Claude 不会自作主张）和 `user-invocable: false`（只 Claude 用，不出现在 `/` 菜单），思路相同。"

### 第 6 幕 · 进阶 · skill 打包可执行脚本（1.5 分钟）

打开 `todo-scan-html/` 目录结构：

```
todo-scan-html/
├── SKILL.md                ← 30 行
└── scripts/render.py       ← Python 脚本，纯 stdlib
```

SKILL.md 核心一行：

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/render.py "${0:-.}"
```

触发：

> **/todo-scan-html tmp/skill-demo-todos**

预期：浏览器打开一个带颜色徽章、按文件分组的 HTML 报告。

> 解说：
> - "**skill 不只是 prompt**——它可以是个目录，里面打包脚本，作为可执行能力包分发。"
> - "**`${CLAUDE_SKILL_DIR}`** 让脚本路径在任何工作目录下都能解析。"
> - "这套机制让 skill 升级为**一种轻量插件**：从 commit message 校验、依赖图渲染、API 文档生成、到任何你想 bundle 的小工具。"

### 第 7 幕 · 配置一览（30 秒）

打开本 README 滚到下面这张表，告诉观众"实际项目里 frontmatter 通常长这样组合"：

| 场景 | 关键 frontmatter |
|------|------------------|
| 资料/规则手册 | （仅 `description`） |
| 命令模板 | `arguments: [...]` + `allowed-tools: ...` |
| 危险动作（deploy） | `disable-model-invocation: true` + `allowed-tools: ...` |
| 重任务隔离 | `context: fork` + `agent: Explore` |
| 可执行能力包 | `arguments: [...]` + 打包 `scripts/` + 用 `${CLAUDE_SKILL_DIR}` |
| 背景知识（Claude 专用） | `user-invocable: false` |

### 收尾 · 认知图（30 秒）

打开 `docs/mode-diagram.md`：

> "**资料 / 任务** 是模式，**参数 / 预批准 / 脚本打包** 是组合维度——任意 skill 都是这两层的乘积。"

---

## 卸载

```bash
bash resources/example/skill/uninstall.sh
rm -rf tmp/skill-demo-todos     # 如跑过 seed-todos.sh
rm -f todo-report.html          # 如跑过 todo-scan-html
```

## 设计要点

- **教学链路递进** —— 7 幕分两段（基础 4 + 进阶 3），不要打乱
- **每个新概念配一份独立 skill** —— `todo-scan-*` 系列让观众看到"变量只动了 frontmatter"
- **第 3 幕用人话触发** —— 激活机制的核心是 description
- **第 4 幕并排展示 SKILL.md** —— 让观众看到"正文一字不差"
- **进阶幕节奏要快** —— 每幕 1-1.5 分钟，避免陷入语法细节，重点是"这种能力存在"
- **配置一览表替代逐字段讲解** —— 让观众带走一张可复用的查表

## 故意没演的能力（提一下即可）

| 能力 | 一句话 | 为什么不演 |
|------|--------|-----------|
| 动态注入 `` !`cmd` `` | SKILL.md 渲染前预跑命令，输出塞进 prompt | 本质是语法糖，能力等价于让 agent 自己跑命令；理解了概念就够 |
| `paths` glob | 编辑匹配文件时自动激活 | 适合实际项目长期使用，不适合一次性 demo |
| `model` / `effort` | skill 期间切换模型/推理档位 | 演示成本高（要切实例），价值低于其他幕 |
| supporting files / 渐进披露 | `reference.md` 按需加载 | 第 6 幕的"打包脚本"已经传递了"目录化"的直觉 |
| `skillOverrides` 设置 | 不改 SKILL.md，从 settings 控可见性 | 偏运维向，离教学主线远 |
| compact 联动 | 长会话压缩时 skill 内容被特殊保留 | 见 [`../compact/README.md`](../compact/README.md)（草案） |
| `/run` `/verify` `/run-skill-generator` | 内置的"跑起来 + 验证"三件套 | 不是自定义 skill 范畴 |

## 关联文档

- 两模式认知图：[`docs/mode-diagram.md`](docs/mode-diagram.md)
- compact × skill 联动草案：[`../compact/README.md`](../compact/README.md)
- 官方文档：https://code.claude.com/docs/en/skills
