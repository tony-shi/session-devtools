# Claude Code 官方文档 example 覆盖盘点

> 输入：https://code.claude.com/docs/en（共 **154 页**，按文档站 sitemap 统计）
> 输出：每页 → 我们 `resources/example/` 这种"装文件 + 实操 + 解读"模式能不能演 + 怎么演。
>
> 我们的"演示能力"定义：
> 1. 可以往 `.claude/{skills,agents,hooks,...}` 放配置文件（通过 install.sh 符号链接）
> 2. 可以打包 shell / python 脚本作为可执行物
> 3. 可以预埋 fixture 让现场有数据可看
> 4. 可以用 README + mermaid 图做教学脚本

## 总览

| 类别 | 文档数 | 描述 |
|------|-------|------|
| **A · 已做** | 2 | `skill/` + `compact/`（草案） |
| **B · 装文件可演**（**最适合扩展**） | 21 | 我们的核心模式能覆盖 —— 装配置/插件/agent/hook，配实操脚本 |
| **C · 纯 CLI 交互演示** | 14 | 不需要装文件，靠操作演示即可，可写"演示话术 + 截图"型 demo |
| **D · 环境绑定，本仓库内不可演** | 27 | 需要 AWS/GCP/GitHub Enterprise/OAuth/CI 等外部依赖，需 mock 化才能 demo |
| **E · 纯参考/科普类** | 21 | 词典/总览/常见问题，本身不需要演示 |
| **F · Agent SDK** | 27 | 独立产品（Python/TS 库），不在 Claude Code CLI example 范畴 |
| **G · 平台 IDE 类** | 8 | VSCode/JetBrains/Desktop/Chrome/Mobile/Web，平台特有交互 |
| **H · whats-new 周报** | 9 | 8 周新闻汇总，无演示价值 |
| **I · 部署运维** | 25 | 见 D 类细分 |

---

## A · 已做（2 / 154）

| 文档 | 我们的实现 | 状态 |
|------|-----------|------|
| `skills.md` | `resources/example/skill/` 7 幕教学 demo | ✅ 完成 |
| `skills.md` § skill-content-lifecycle + `how-claude-code-works.md` § auto-compact | `resources/example/compact/README.md` | 🟡 草案，待实测 |

---

## B · 装文件可演（21 / 154）—— 扩展优先级最高

按"演示价值 / 工程量 / 与已有 demo 的连贯性"打优先级。

### B1 · 强烈推荐（与 skill demo 系列直接连贯）

| 文档 | 演示设计 | 工程量 | 优先级 |
|------|---------|--------|--------|
| `sub-agents.md` | `agents/code-reviewer.md` + `agents/test-runner.md` 两个自定义 subagent，演示 frontmatter 字段（tools/skills 字段）+ 委派调用 + 与 skill 联动 | 中 | ★★★ |
| `hooks.md` + `hooks-guide.md` | 装一个 PostToolUse hook（如 Edit 后跑 prettier）+ 一个 Notification hook（提示音）+ 一个 UserPromptSubmit hook（输入校验） | 中 | ★★★ |
| `output-styles.md` | 装一个自定义 output style（如 `.claude/output-styles/strict-tech-writer.md`），演示风格切换前后输出对比 | 小 | ★★★ |
| `memory.md` | 演示 CLAUDE.md 加载 + auto memory（已经在用）+ 路径范围规则（path-specific rules） | 小 | ★★★ |
| `commands.md` | 已被 `skills.md` 替代（旧 .claude/commands/*.md 仍兼容），可在 skill demo 里加一句 deprecated 说明 | 极小 | ★（合并入 skill demo） |

### B2 · 推荐（独立性强，价值高）

| 文档 | 演示设计 | 工程量 | 优先级 |
|------|---------|--------|--------|
| `plugins.md` + `plugins-reference.md` | 把现有 `todo-scan` 系列打包成一个 plugin（plugin.json + skills/ + agents/），演示 `/plugin install` | 大 | ★★ |
| `plugin-marketplaces.md` | 在 `resources/example/marketplace/` 起一个本地 marketplace 索引（json），演示 add + install 流程 | 大 | ★★ |
| `mcp.md` | 装一个最小 MCP server（如 echo server 或本地 fs 查询），演示 `.mcp.json` 配置 + 调用 | 中 | ★★ |
| `managed-mcp.md` | 在 MCP demo 基础上加 allowlist/denylist 配置 | 小 | ★（合并入 mcp demo） |
| `statusline.md` | 装一个自定义 statusline 脚本（如显示 git branch + token 用量） | 小 | ★★ |
| `keybindings.md` | 装一份自定义 keybindings 文件，演示快捷键覆盖 | 小 | ★ |
| `routines.md` | 装一份 routine（如每日 9 点跑代码 review 提醒），演示 schedule + webhook trigger | 中 | ★★ |
| `channels.md` + `channels-reference.md` | 装一个最小 MCP server 把外部 webhook 推进 session | 中 | ★★ |

### B3 · 可演但偏运维

| 文档 | 演示设计 | 工程量 | 优先级 |
|------|---------|--------|--------|
| `settings.md` | 演示 `.claude/settings.json` 各字段（permissions / env / model 等） | 小 | ★ |
| `permission-modes.md` + `permissions` | 装一份 permissions 规则集 + 演示 4 种模式切换 | 小 | ★★ |
| `auto-mode-config.md` | 装一份 auto-mode 配置（trustedRepos / buckets / domains） | 小 | ★ |
| `worktrees.md` | 演示 worktree 创建 + 多 session 隔离 | 小 | ★★ |
| `claude-directory.md` | 一份 `.claude/` 目录结构地图（每个子目录用途 + 何时加载） | 小 | ★（可做成 cheat sheet） |
| `env-vars.md` | 列举关键环境变量 + 在 install.sh 里 demo 设置生效 | 小 | ★ |
| `terminal-config.md` | 演示终端配置（Shift+Enter、Vim mode 等） | 小 | ★（IDE 依赖） |
| `prompt-caching.md` | 难以独立演（自动机制）—— 可做"如何观察 cache hit/miss"的脚本，用 `/cost` + `/context` | 中 | ★ |

---

## C · 纯 CLI 交互演示（14 / 154）

这些不需要装文件，**演示模式 = "演示话术 + GIF/截图"**，可以做成 `resources/example/cli-demo/<feature>.md`。

| 文档 | 演示要点 |
|------|----------|
| `goal.md` | `/goal <condition>` → 任意任务挂目标 hook → 直到满足前不停 |
| `scheduled-tasks.md` | `/loop` 自驱循环 + `cron` 工具 |
| `fast-mode.md` | `/fast` 切换前后响应速度对比 |
| `fullscreen.md` | 进入全屏 + 鼠标支持演示 |
| `deep-links.md` | 构造 `claude-cli://` URL 拉起会话 |
| `voice-dictation.md` | hold-to-record / tap-to-record |
| `remote-control.md` | 手机/平板/浏览器接管本地 session |
| `sessions.md` | `--continue` / `--resume` / `--name` |
| `checkpointing.md` | rewind + summarize |
| `code-review.md` | `/review` 自动审 PR |
| `ultraplan.md` | CLI 起 plan → web 草拟 → 远端执行 |
| `ultrareview.md` | `/ultrareview` 多 agent 云端审查（用户触发，计费） |
| `agent-view.md` + `agent-teams.md` + `agents.md` | 一屏管多 session / 多 agent 协作 |
| `interactive-mode.md` | 快捷键参考（cheat sheet 形式） |
| `model-config.md` | `/model`、`opusplan` alias、effort 切换 |

> **建议输出形态**：每个 feature 一份 ≤50 行的 `cli-demo/<name>.md`，包含「触发命令 / 预期效果 / 一句话解读」三块。

---

## D · 环境绑定，本仓库内不可"原生"演（27 / 154）

需要外部账号/CI/云资源。**演的方式**：要么提供配置模板，要么 mock 化关键交互。

### D1 · 云供应商

| 文档 | 不可演的原因 | 改造路径 |
|------|-------------|---------|
| `amazon-bedrock.md` | 需 AWS 账号 + IAM | 提供 `.env` 模板 + bedrock 切换的 settings 片段 |
| `google-vertex-ai.md` | 需 GCP 项目 + 服务账号 | 同上，GCP 版 |
| `microsoft-foundry.md` | 需 Microsoft Foundry 账号 | 同上 |
| `claude-platform-on-aws.md` | 同上 + 需 IAM 管理 | 提供 IAM policy 模板 |
| `llm-gateway.md` | 需 gateway 部署 | 起一个本地 mock gateway（轻量 fastapi） |

### D2 · GitHub / GitLab / Slack 集成

| 文档 | 改造路径 |
|------|---------|
| `github-actions.md` | 提供 `.github/workflows/claude-code.yml` 模板，演示触发字段 |
| `gitlab-ci-cd.md` | 同上，GitLab 版 |
| `github-enterprise-server.md` | 需 GHE 实例；提供配置片段 + 解读 |
| `slack.md` | 提供 Slack app manifest 模板；真演需 workspace |

### D3 · 部署/安全/合规

| 文档 | 改造路径 |
|------|---------|
| `admin-setup.md` | 写一份"管理员部署决策树"flowchart |
| `authentication.md` | 演示 `claude auth` 几种登录路径（OAuth 演示需配账号） |
| `secure-deployment.md` | 提供"零信任"checklist + 配置模板 |
| `server-managed-settings.md` | 提供 managed settings 示例文件 + 解读 |
| `network-config.md` | 提供 proxy / mTLS / CA 配置片段模板 |
| `sandbox-environments.md` + `sandboxing.md` | 提供 4 种沙盒（Bash / runtime / dev container / Docker / VM）配置对比 + 各自一份 Dockerfile/compose |
| `devcontainer.md` | 提供 `.devcontainer/devcontainer.json` 模板 |
| `claude-code-on-the-web.md` + `web-quickstart.md` | 提供 cloud env 配置 + setup.sh |
| `zero-data-retention.md` | 文档对照表（适用条件 + 配置） |
| `legal-and-compliance.md` | 无需演示 |
| `third-party-integrations.md` | 索引文档，无需演示 |

### D4 · 监控/分析/成本

| 文档 | 改造路径 |
|------|---------|
| `costs.md` | 写一个 jsonl 解析器统计 token 用量（**可复用本项目 session-dashboard 能力**） |
| `analytics.md` | 同上，做团队级聚合 |
| `monitoring-usage.md` | 起一个本地 OTLP collector（jaeger compose）+ Claude Code env 配置 |
| `data-usage.md` | 文档对照表 |

### D5 · 其他

| 文档 | 改造路径 |
|------|---------|
| `headless.md` | 提供 `claude -p "..."` 脚本示例 + CI 集成模板 |
| `desktop-scheduled-tasks.md` | 平台特有，平台 demo |

---

## E · 纯参考/科普类（21 / 154）

无需演示，但可以做**索引页 / cheat sheet**。

`overview.md`, `quickstart.md`, `how-claude-code-works.md`, `setup.md`, `cli-reference.md`, `platforms.md`, `features-overview.md`, `glossary.md`, `tools-reference.md`, `errors.md`, `troubleshoot-install.md`, `troubleshooting.md`, `debug-your-config.md`, `best-practices.md`, `common-workflows.md`, `prompt-library.md`, `champion-kit.md`, `communications-kit.md`, `changelog.md`, `context-window.md`, `computer-use.md`

> **建议**：做一张 `resources/example/CHEATSHEET.md`，把 `cli-reference` / `tools-reference` / `glossary` 提取关键 50 项做索引。

---

## F · Agent SDK（27 / 154）

独立产品（Python/TypeScript 库），**不属于 Claude Code CLI 的 example 范畴**。如果要做：另起一个 `resources/example-sdk/` 目录，做 SDK quickstart。

涉及：`agent-sdk/{overview,quickstart,agent-loop,python,typescript,...}` 等 27 个文档。

> **建议**：本轮不投入。需要时单独立项。

---

## G · 平台 IDE 类（8 / 154）

`vs-code.md`, `jetbrains.md`, `desktop.md`, `desktop-quickstart.md`, `desktop-changelog.md`, `chrome.md`, `claude-code-on-the-web.md`, `web-quickstart.md`

> **特点**：平台特有 UI 交互，本地仓库 example 难以承载。**建议**：每个写一份 1 页"功能差异速查"。

---

## H · whats-new 周报（9 / 154）

`whats-new/index.md` + `2026-w13` ~ `w20` 8 周新闻。

> **建议**：不演示。如果做也只做"feature → 详细文档"的反向索引。

---

## I · 部署运维（25 / 154，与 D 重叠）

见 D 类拆分。

---

## 优先级建议（如果要做下一批 example）

按"对教学最有价值 / 工程量小 / 与已有 demo 连贯"排：

### 第一批（应做）

1. **`example/subagent/`** —— 自定义 subagent（与 skill 系列天然衔接），演示 frontmatter + 委派调用
2. **`example/hooks/`** —— PostToolUse / Notification / UserPromptSubmit 三种 hook 各装一个
3. **`example/output-styles/`** —— 装一个自定义风格，演示输出对比
4. **`example/cli-demo/goal.md`** + **`scheduled-tasks.md`** + **`fast-mode.md`** —— 短文话术型

### 第二批（值得做）

5. **`example/mcp/`** —— 起一个最小 MCP server
6. **`example/permissions/`** —— 4 种模式 + 规则集对照
7. **`example/statusline/`** —— 自定义 statusline 脚本
8. **`example/routines/`** —— 装一份 routine 配置
9. **`example/worktrees/`** —— worktree + 多 session 演示

### 第三批（工程量大或需外部依赖）

10. **`example/plugin/`** —— 把 todo-scan 系列打包为 plugin
11. **`example/marketplace/`** —— 本地 marketplace 演示
12. **`example/costs/`** —— 用 session-dashboard 本身的 jsonl 解析做 token 用量统计

### 不在本轮范围

- D 类需要云/外部依赖的（除非做 mock）
- F 类 Agent SDK
- G 类平台 IDE
- H 类周报

---

## 不可演项的优化路径（如何让"不可演"变"可演"）

> 用户原命题："不满足的，进行分析，我们如何优化才可以满足可视化+解读。"

按"为什么不可演"分三类，每类给一条改造路径。

### 优化路径 1 · "需要外部账号" → mock 化关键交互

**适用**：amazon-bedrock / vertex-ai / GitHub Enterprise / Slack / OAuth 登录

**改造**：
- 提供一份"假账号 + mock server"组合：本地起一个 fastapi 模拟目标 API
- example 脚本变成 `bash install.sh && bash start-mock.sh && claude --base-url http://localhost:xxxx`
- 演示价值：能看清"配置文件长什么样 + 切换时实际发生了什么"
- 局限：不能体现真账号的权限/计费行为

### 优化路径 2 · "需要 CI 环境" → 单测模拟 + 截图

**适用**：github-actions / gitlab-ci-cd / scheduled-tasks 真触发

**改造**：
- 提供 workflow YAML 模板 + 本地用 `act` (GitHub Actions 本地 runner) 跑一次
- 用 `act` 输出截图作为 demo 证据
- 演示价值：让人理解 CI 集成的最小可行单元

### 优化路径 3 · "需要 UI/平台" → 录制 GIF + 配置截图

**适用**：vs-code / jetbrains / desktop / chrome / mobile / voice / fullscreen / fast-mode

**改造**：
- 把"实操步骤 + 关键截图 GIF"打包成 `cli-demo/<feature>/`
- 每份带一段 30 秒的实操 GIF + 一段"功能定位"的文字说明
- 演示价值：以最小成本让远程观众理解"长什么样、什么时候用"
- 局限：截图随版本老化，需要维护

---

## 关联

- 已做 demo：[`skill/README.md`](skill/README.md), [`compact/README.md`](compact/README.md)
- 官方 sitemap：https://code.claude.com/docs/llms.txt
- 官方文档根：https://code.claude.com/docs/en
