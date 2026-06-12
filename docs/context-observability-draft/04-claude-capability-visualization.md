# Claude Code 配置能力可视化落地方案

> 最后更新：2026-06-10  
> 背景：基于“我的 Claude 文件结构”图片、Claude Code 官方文档和当前 session-devtools 代码现状，定义下一阶段在本项目内落地的配置能力可视化方案。

## 结论

我们应该在当前项目里落地这件事，但落地对象不应该只是“展示 `.claude/` 目录树”。

更准确的产品目标是：

```text
把 Claude Code 的配置能力、运行时生效证据、上下文影响和风险边界放到同一个 DevTools 视图里。
```

当前项目已经具备很强的运行时观测基础：JSONL 解析、MITM proxy、request context attribution、tool schema 解析、Skill 注入识别、sub-agent trace。缺的是一个统一的 **Claude Capability Manifest** 层，负责回答：

- 这个项目配置了哪些 Claude Code 能力？
- 这些能力来自哪个 scope：managed / user / project / local / CLI / env？
- 它们是否真正进入了某次 session / turn / call？
- 进入后影响了 system、tools、messages、hook feedback、sub-agent boundary 里的哪一块？
- 这个配置是否存在安全、成本、缓存、可维护性风险？

这里需要区分两条线：

```text
内部 dogfood 线：先把我们自己的环境配置完整，亲自体验 Claude Code 的所有关键能力。
产品交付线：把这些能力抽象成可扫描、可解释、可验证的项目级 DevTools 能力。
```

所以推荐路线调整为：

1. 先建立当前仓库的 Claude Code dogfood 配置基线，覆盖 Memory、Settings、MCP、Hooks、Skills、Agents、Rules、Output styles、Status line、Plugin demo。
2. 用这套配置跑真实 Claude Code session，形成我们自己的 fixture 和调试 case。
3. 再开发可交付的项目级 capability scanner / manifest / UI。
4. 最后把 manifest 与现有 JSONL/proxy/attribution 结果做关联，证明某个配置是否在某次 session/call 中真实生效。

## 关键依据

### 图片中的结构是有价值的 V0，但不是完整规范

图片覆盖了项目级配置的主要文件：

```text
CLAUDE.md
CLAUDE.local.md
.gitignore
.mcp.json
.claude/hooks/
.claude/commands/
.claude/skills/
.claude/agents/
.claude/output-styles/
.claude/plugins/
.claude/rules/
.claude/statusline
.claude/settings.json
.claude/settings.local.json
```

这些足以作为第一版“项目配置能力”的展示入口。但有几个需要修正：

| 图片项 | 修正判断 |
|---|---|
| `.gitignore` | 不是安全边界。禁止 Claude 读取敏感文件应使用 `permissions.deny`、sandbox、file discovery/exclude 等配置。 |
| `.claude/hooks/` | 只有脚本文件不会触发。真正生效必须在 `settings.json` 的 `hooks` 中注册。 |
| `commands/` | 仍兼容，但官方已经把 custom commands 合并进 skills；新设计应按 skills 统一建模。 |
| `plugins/` | 不是随便放目录就生效。要通过 marketplace/settings 启用，或使用 skills-directory plugin，即 `.claude/skills/<plugin>/.claude-plugin/plugin.json`。 |
| `statusline` | 本质是 `settings.json.statusLine` 指向一个 command；脚本文件可以放任意位置。 |
| `rules/` | 官方是 `.claude/rules/**/*.md`，支持 frontmatter `paths` 做路径级规则加载。 |

### 官方能力面比图片更大

官方文档显示，Claude Code 的配置和扩展能力至少包括：

| 能力面 | 官方入口 | 对 DevTools 的意义 |
|---|---|---|
| Settings scopes | managed / CLI args / local / project / user | 必须展示来源、优先级和覆盖关系。 |
| Permissions | allow / ask / deny / defaultMode / sandbox | 必须展示安全边界和危险配置。 |
| Memory | `CLAUDE.md`、`CLAUDE.local.md`、`.claude/rules/`、auto memory | 必须区分“磁盘存在”和“本次 call 已进入上下文”。 |
| MCP | `.mcp.json`、user MCP、managed MCP、resources、prompts、elicitation、ToolSearch | 必须展示 server、tools、resources、auth、延迟工具加载状态。 |
| Hooks | command / http / mcp_tool / prompt / agent；覆盖大量生命周期事件 | 必须展示配置、触发、阻断、反馈进入上下文的证据。 |
| Skills | `.claude/skills/`、commands 兼容、frontmatter、support files、dynamic context injection | 必须展示 listing、body 注入、工具权限、token 影响。 |
| Subagents | `.claude/agents/`、`--agent`、`agent` setting、background、worktree isolation | 必须展示配置和运行时 parent-child boundary。 |
| Plugins | marketplace、enabledPlugins、skills-directory plugin、hooks/MCP/LSP/monitors/themes | 必须展示插件作为能力包的组成和启用状态。 |
| Output styles | `.claude/output-styles/`、settings `outputStyle` | 会改变 system prompt，应进入 context attribution。 |
| Status line | settings `statusLine` command | 运行在本地，不消耗 tokens，但有 trust 和脚本风险。 |
| OTel / Monitoring | telemetry env、metrics/logs/traces | 可作为第二路观测源，但要注意隐私和 cardinality 成本。 |
| Agent teams / workflows / background / schedules | `Team*`、`Workflow`、`Task*`、`RemoteTrigger`、`ScheduleWakeup` 等工具 | 当前运行时可见性不足，应作为 P2/P3 目标。 |

参考官方文档：

- [Settings](https://code.claude.com/docs/en/settings)
- [Memory](https://code.claude.com/docs/en/memory)
- [Skills](https://code.claude.com/docs/en/skills)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [MCP](https://code.claude.com/docs/en/mcp)
- [Tools reference](https://code.claude.com/docs/en/tools-reference)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Output styles](https://code.claude.com/docs/en/output-styles)
- [Status line](https://code.claude.com/docs/en/statusline)
- [Monitoring](https://code.claude.com/docs/en/monitoring-usage)

## 当前项目现状

### 已经具备的基础

| 当前能力 | 代码/文档证据 | 判断 |
|---|---|---|
| Claude JSONL session 解析 | `server/src/parsers-v2/claude.ts` | 已能解析 session、turn、LLM call、tool call、sub-agent 数量等。 |
| Proxy request 捕获 | `server/src/proxy-v2/` | 已能注入本地 proxy 并捕获 Claude Code 请求/响应。 |
| Context attribution | `server/src/context-ledger/`、`AttributionTreePanel` | 已能把 system/tools/messages 拆成可解释来源。 |
| Tool definition 展示 | `client/src/v2/leaf-detail/ToolDefinitionBody.tsx` | 已能展示 tool JSON schema、参数和其他字段。 |
| Deferred tools / MCP listing | `DeferredToolsBody.tsx` | 已能把 `mcp__server__tool` 分组展示。 |
| Agent types listing | `AgentTypesBody.tsx` | 已能解析 Agent tool 可调度类型。 |
| Skill listing / Skill injection | `SkillListingBody.tsx`、`SkillInjectionInfo` | 已能区分 skill listing 和 skill body 注入。 |
| Sub-agent trace | `SubAgentSummary`、session detail subagent panel | 运行时链路较强。 |
| Compact / permission / worktree 事件 | `IntervalEventKind` | 已有部分 JSONL 事件类型。 |

### 明显缺口

| 缺口 | 当前表现 | 影响 |
|---|---|---|
| 没有配置 manifest | 只能看 session 里发生了什么，不能看项目配置了什么 | 无法回答“为什么这个能力出现/没出现”。 |
| 没有 settings scope 解析 | 只在 proxy 启动时改 `~/.claude/settings.json` | 无法展示 user/project/local/managed 冲突。 |
| 没有 `.mcp.json` scanner | 只能看运行时 deferred MCP tools | 无法展示 MCP server 是否配置、是否启用、为何没连上。 |
| 没有 hooks ingestion | 只能从 JSONL 间接看到部分 hook summary | 无法实时展示 PreToolUse/PostToolUse/ConfigChange/Elicitation 等生命周期。 |
| 没有 agents/skills/output-styles/rules inventory | 只能看进入上下文后的片段 | 无法展示磁盘上存在但未触发的能力。 |
| 内置工具 corpus 不完整 | 已有很多 tool rule，但缺 `Glob/Grep/LSP/PowerShell/ListMcpResourcesTool/ReadMcpResourceTool/ShareOnboardingGuide/TodoWrite/WaitForMcpServers/WebSearch` 等 | 展示层会对新工具解释不足。 |
| 没有插件能力建模 | 无 marketplace / enabledPlugins / plugin manifest scanner | 不适合表达“能力包”。 |
| 没有自测 fixture | 目前测试偏 parser/attribution，缺配置能力端到端验证 | 很难证明新功能真的 work。 |

## 产品定义

### 新增视图：Project Capabilities

在当前产品里新增一个项目能力视图，建议入口：

- Session Detail 顶部：显示当前 session 所属项目的 capability summary。
- 单独 Tab：`Capabilities`。
- 未来 Session List 也可显示 capability badges。

核心展示分三层：

```text
配置层：项目/用户/本地/managed 配置了什么
生效层：当前 session 启动时实际加载了什么
影响层：某次 call 里最终进入 system/tools/messages 的是什么
```

### Capability 分类

第一版建议按以下分类：

| 类别 | 包含能力 |
|---|---|
| Memory & Rules | `CLAUDE.md`、`CLAUDE.local.md`、`.claude/CLAUDE.md`、`.claude/rules/**/*.md`、auto memory 配置 |
| Settings & Permissions | `.claude/settings.json`、`.claude/settings.local.json`、permissions、sandbox、env、model、effort、fallback、advisor、fast mode |
| MCP | `.mcp.json`、user/local MCP、managed MCP、server transport、tools、resources、prompts、elicitation |
| Hooks | settings hooks、plugin hooks、hook type、event、matcher、async、timeout、decision behavior |
| Skills & Commands | `.claude/skills/**/SKILL.md`、`.claude/commands/*.md`、frontmatter、support files、dynamic shell injection |
| Agents & Teams | `.claude/agents/*.md`、agent setting、tools/disallowedTools、background、worktree isolation、Team tools |
| Plugins | enabledPlugins、extraKnownMarketplaces、skills-directory plugin、plugin manifest components |
| Interface | output styles、statusLine、themes、keybindings 相关配置 |
| Observability | proxy 注入、OTel env、trace/log/metric export、devtools hook ingest 状态 |

## 项目维度还是一次性任务

结论：两者都有，但不能混在一起。

| 层次 | 性质 | 目标 | 产物 | 是否交付给用户 |
|---|---|---|---|---|
| 内部 dogfood 配置 | 一次性初始化，后续按需维护 | 让我们自己的项目先完整体验 Claude Code 能力 | 当前仓库的本地配置、reference fixture、测试 session | 不直接交付，只作为研发和演示基线 |
| Capability scanner / manifest | 项目级产品能力 | 读取任意用户项目当前配置，并展示能力、来源、风险和生效证据 | API、UI、manifest snapshot、runtime evidence links | 交付 |
| Hook/plugin 接入 | 可选增强能力 | 用户明确启用后获得更强的实时观测 | 安装向导、配置 diff、恢复机制、事件采集 | 交付，但必须 opt-in |

用户配置是会变化的，所以交付能力不能是“一次性扫描结果”。正确模型是：

```text
scan current project -> produce manifest snapshot -> compare with previous snapshot -> link to runtime evidence
```

第一版可以不是实时 watcher，但必须满足：

- 打开项目 / session 时重新扫描。
- 用户点击 Refresh 时重新扫描。
- manifest 带 `snapshotId`、`scannedAt`、`sourceHash`。
- session 绑定的是“当时最近一次扫描快照”，而不是全局唯一真相。
- UI 明确区分 `configured now`、`configured when session started`、`observed in this call`。

这样才能解释三类常见问题：

| 问题 | 展示方式 |
|---|---|
| 用户刚改了 `.claude/settings.json` | 当前 manifest 变了，上一条 session 的 manifest snapshot 不变。 |
| 某个 skill 当前存在，但旧 session 没用过 | `configured now` 有，runtime evidence 为空。 |
| 某次 call 里出现了旧规则，但当前磁盘上已删除 | runtime evidence 仍保留，current manifest 显示 missing/deleted。 |

## 技术方案对比

### 方案 A：只增强现有 JSONL/proxy 解析

| 项 | 判断 |
|---|---|
| 适用场景 | 只关心“已经发生过的 session”。 |
| 优点 | 复用当前架构，改动小，准确性高。 |
| 缺点 | 看不到磁盘配置、未触发能力、配置冲突。 |
| 复杂度 | 低。 |
| 风险 | 会继续把“未出现”误判成“未配置”。 |
| 演进性 | 不够，无法成为配置可视化。 |

结论：不推荐作为主路线，只能作为现有能力继续增强。

### 方案 B：配置扫描 Manifest + 运行时证据关联

| 项 | 判断 |
|---|---|
| 适用场景 | 当前项目最合适。先把配置能力建模，再和运行时 attribution 对齐。 |
| 优点 | 低侵入、可测试、能解释“配置了但没生效”和“生效但没进入本 call”。 |
| 缺点 | 第一版不是实时；managed/user scope 读取需要注意权限和隐私。 |
| 复杂度 | 中。 |
| 风险 | scope 合并规则可能与官方细节有偏差，需要保留 raw/source。 |
| 演进性 | 强，可继续接 hooks、plugins、OTel。 |

结论：推荐。

### 方案 C：直接打包 Claude Code plugin + hooks 实时接入

| 项 | 判断 |
|---|---|
| 适用场景 | 已明确要追实时监控、hook 全事件流。 |
| 优点 | 能实时看到 hook、subagent、config change、elicitation。 |
| 缺点 | 安全边界更复杂，需要改用户 Claude 配置，失败时影响用户正常使用。 |
| 复杂度 | 高。 |
| 风险 | hook 命令权限高；HTTP hook endpoint 要处理鉴权、端口、版本兼容、退出恢复。 |
| 演进性 | 强，但不适合作为第一步。 |

结论：作为 P1/P2，不建议跳过 manifest 直接做。

## 推荐落地路径

### P-1：当前仓库 Dogfood 配置基线

目标：先让我们自己的环境“全面支持”，用真实 Claude Code 行为驱动产品开发，而不是凭目录想象能力。

推荐拆成两个产物：

```text
devtools-fixtures/claude-capabilities/full-project/
  CLAUDE.md
  .mcp.json
  .claude/
    settings.json
    hooks/
    commands/
    skills/
    agents/
    output-styles/
    rules/
    statusline.sh

.claude/
  settings.json
  settings.local.json
  hooks/
  skills/
  agents/
  output-styles/
  rules/
```

两者职责不同：

| 产物 | 用途 | 为什么需要 |
|---|---|---|
| `devtools-fixtures/claude-capabilities/full-project/` | 可提交、可测试、可复现的完整样例项目 | 让 scanner 和 UI 有稳定 fixture，不依赖某个人本地配置。 |
| 当前仓库 `.claude/` 本地配置 | 我们自己每天 dogfood，真实体验 hooks/skills/agents/statusLine 等能力 | 让产品判断来自真实使用，而不是只看静态文件。 |

Dogfood 配置至少覆盖：

| 能力 | 当前仓库要准备什么 | 自测要证明什么 |
|---|---|---|
| Memory | `CLAUDE.md`、可选 `CLAUDE.local.md` | project instructions 是否进入 context。 |
| Settings | `.claude/settings.json`、`.claude/settings.local.json` | scope、override、permissions、model/outputStyle/statusLine 是否可扫描。 |
| MCP | fixture 中提供安全只读 `.mcp.json` | MCP server 配置、连接状态、deferred tools 是否可展示。 |
| Hooks | 注册最小 `SessionStart`、`PostToolUse`、`PreCompact` | hook 是否触发，payload 是否能进入 hook event log。 |
| Skills / Commands | 至少 2 个 skill，1 个 legacy command | listing、body injection、commands 兼容路径是否能观测。 |
| Agents | code-reviewer / researcher / log-analyzer | Agent tool 可调度类型和 sub-agent trace 是否能关联。 |
| Rules | `.claude/rules/api.md` 带 `paths` frontmatter | 路径级规则是否能扫描和解释。 |
| Output styles | `.claude/output-styles/terse.md` | outputStyle 是否改变 system prompt attribution。 |
| Status line | `statusLine.command` 指向本地脚本 | 本地 UI 能力存在但不进入 model context。 |
| Plugin demo | skills-directory plugin fixture | plugin 作为能力包如何展示。 |

这一阶段不是先给用户交付，而是给我们自己建立研发事实。验收标准是：

- 我们能用这套配置真实启动 Claude Code。
- 至少产生 3 条可复现 session：memory/rules、skill/agent、hook/MCP。
- 当前 devtools 能看到这些 session 的 JSONL/proxy/attribution 基础证据。
- 后续 scanner 开发时，所有能力都能在 fixture 中被测到。

### P0：Capability Manifest Scanner

目标：把 P-1 中验证过的能力抽象成产品能力，不改变用户 Claude 配置，只读扫描当前项目，生成统一 manifest。

后端新增：

```text
server/src/claude-capabilities/
  index.ts
  scanner.ts
  settings.ts
  skills.ts
  agents.ts
  mcp.ts
  hooks.ts
  rules.ts
  plugins.ts
  types.ts
```

API：

```text
GET /api/v2/projects/:projectId/claude-capabilities
GET /api/v2/sessions/:sessionId/claude-capabilities
```

第一版也可以只做：

```text
GET /api/v2/claude-capabilities?cwd=<project-path>
```

建议返回结构：

```ts
interface ClaudeCapabilityManifest {
  projectRoot: string;
  snapshotId: string;
  scannedAt: string;
  sourceHash: string;
  sources: CapabilitySource[];
  capabilities: Capability[];
  summary: {
    memoryFiles: number;
    settingsFiles: number;
    mcpServers: number;
    hooks: number;
    skills: number;
    commands: number;
    agents: number;
    rules: number;
    outputStyles: number;
    plugins: number;
    risks: number;
  };
}

interface CapabilitySource {
  id: string;
  kind:
    | "managed-settings"
    | "user-settings"
    | "project-settings"
    | "local-settings"
    | "project-file"
    | "user-file"
    | "env"
    | "cli"
    | "runtime";
  path?: string;
  readable: boolean;
  ignoredByGit?: boolean;
  error?: string;
}

interface Capability {
  id: string;
  category:
    | "memory"
    | "settings"
    | "permissions"
    | "mcp"
    | "hook"
    | "skill"
    | "command"
    | "agent"
    | "plugin"
    | "output-style"
    | "status-line"
    | "observability";
  name: string;
  sourceId: string;
  status: "configured" | "disabled" | "active" | "unknown" | "error";
  scope: "managed" | "user" | "project" | "local" | "runtime" | "unknown";
  summary: string;
  details: unknown;
  risks: CapabilityRisk[];
  evidence?: RuntimeEvidence[];
}

interface CapabilityRisk {
  severity: "info" | "warn" | "danger";
  code: string;
  message: string;
  recommendation?: string;
}

interface RuntimeEvidence {
  kind: "jsonl" | "proxy" | "attribution" | "hook-event";
  sessionId?: string;
  turnId?: number;
  callId?: number;
  nodeId?: string;
  lineIdx?: number;
  requestId?: number;
  summary: string;
}
```

Manifest 是项目维度的动态快照，不是一次性任务。后端至少需要支持：

```text
GET  /api/v2/claude-capabilities?cwd=<project-path>
POST /api/v2/claude-capabilities/refresh
GET  /api/v2/sessions/:sessionId/claude-capabilities
GET  /api/v2/sessions/:sessionId/claude-capabilities/diff-current
```

`diff-current` 用来回答“用户配置后来变了，当前配置和 session 当时配置有什么差异”。

前端新增：

```text
client/src/v2/project-capabilities/
  ProjectCapabilitiesPanel.tsx
  CapabilitySummaryCards.tsx
  CapabilitySourceTable.tsx
  CapabilityRiskList.tsx
  CapabilityDetailDrawer.tsx
```

验收标准：

- 在当前仓库能看到：
  - `CLAUDE.md`
  - `.claude/settings.json`
  - `.claude/settings.local.json`
  - `.claude/hooks/worktree-create.sh`
  - `.claude/hooks/worktree-remove.sh`
  - `.claude/skills/find-skills/SKILL.md`
  - `.claude/skills/found-ground-info/SKILL.md`
- 能明确显示 `.claude/settings.json` 里 `hooks: {}` 为空，所以 hook 脚本“存在但未注册”。
- 能明确显示 `.claude/settings.local.json` 中 `skillOverrides.find-skills = off`，所以 `find-skills` 是本地禁用。
- 不修改任何用户配置。

### P1：Manifest 与运行时证据关联

目标：证明配置不只是“磁盘上存在”，还要能看到是否进入真实 session。

关联策略：

| 配置能力 | 运行时证据 |
|---|---|
| `CLAUDE.md` / rules | attribution tree 中 `messages.context.claude-md`、project instructions、memory contents |
| skills | skill listing、Skill tool use、`SkillInjectionInfo` |
| agents | Agent tool use、subagent JSONL、agent types listing |
| MCP | `.mcp.json` server name、deferred tools、`mcp__server__tool`、ToolSearch |
| hooks | JSONL `stop_hook_summary`、未来 hook-event table |
| outputStyle | system prompt intro/output-style 规则匹配 |
| permissions | JSONL `permission-mode`、tool denial、settings permissions |
| statusLine | 配置存在即可；运行时不进入 model context |
| proxy/OTel | settings env、proxy status、proxy_requests rows |

验收标准：

- 一个 capability detail 能跳到 session/call/attribution leaf。
- 对于“配置了但没生效”的能力，显示明确原因或 unknown，而不是静默缺失。
- 对于“不应进入 context”的能力，比如 statusLine，显示“local UI only，不消耗 token”。

### P2：Hook Ingestion

目标：补齐实时生命周期事件，尤其是 JSONL/proxy 不完整覆盖的事件。

新增服务端 endpoint：

```text
POST /api/claude-hooks/event
GET  /api/claude-hooks/events?sessionId=<id>
```

第一批 hook events：

```text
SessionStart
InstructionsLoaded
UserPromptSubmit
PreToolUse
PostToolUse
PostToolUseFailure
PostToolBatch
SubagentStart
SubagentStop
PreCompact
PostCompact
ConfigChange
CwdChanged
Elicitation
ElicitationResult
SessionEnd
```

存储建议：

```sql
CREATE TABLE claude_hook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  session_id TEXT,
  transcript_path TEXT,
  cwd TEXT,
  hook_event_name TEXT NOT NULL,
  matcher TEXT,
  tool_name TEXT,
  tool_use_id TEXT,
  payload_json TEXT NOT NULL,
  source TEXT NOT NULL
);
```

配置建议不要直接写宽泛 hooks。先提供“复制用配置”，由用户确认：

```json
{
  "allowedHttpHookUrls": ["http://127.0.0.1:5051/*"],
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:5051/api/claude-hooks/event"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:5051/api/claude-hooks/event"
          }
        ]
      }
    ]
  }
}
```

验收标准：

- 启动 Claude Code 后出现 `SessionStart`。
- 执行一次 `Read` 后出现 `PreToolUse` / `PostToolUse`。
- 触发一次 sub-agent 后出现 `SubagentStart` / `SubagentStop`。
- hook event 能与 JSONL call chain 做弱关联：session_id、tool_use_id、timestamp。

### P3：session-devtools Claude Code Plugin

目标：把 hooks、skills、agent、MCP demo、statusLine demo 打包成能力包。

建议采用 skills-directory plugin：

```text
.claude/skills/session-devtools/
  .claude-plugin/plugin.json
  skills/
    inspect-capabilities/
      SKILL.md
    generate-capability-fixture/
      SKILL.md
  agents/
    capability-auditor.md
  hooks/
    hooks.json
```

这样做的好处：

- 适合 dogfooding。
- 不污染项目根 `.claude/hooks`。
- 可以清晰展示 plugin 自身的 components。
- 后续可迁移到 marketplace。

不建议第一步就做 marketplace，因为发布、安装、启用和版本管理会增加组织成本。

## 自测方案

### 自测目标

我们要证明的不是“目录存在”，而是：

```text
配置被扫描出来
配置能被解释
配置能关联到真实 session 证据
配置风险能被提示
```

自测顺序必须分两段：

| 阶段 | 目的 | 通过标准 |
|---|---|---|
| 先测 dogfood 配置 | 证明我们的 Claude Code 环境真的覆盖这些能力 | Claude Code 能正常启动，hooks/skills/agents/MCP/statusLine 等至少各有一个可观察事件或配置证据。 |
| 再测 DevTools 支持 | 证明 session-devtools 能解释这些能力 | Capabilities UI 能扫描出来，并能关联到 JSONL/proxy/attribution/hook evidence。 |

### Fixture A：当前仓库无侵入扫描

操作：

```bash
npm run dev
```

打开 Capabilities 页面，选择当前项目。

预期：

- 显示 `CLAUDE.md`。
- 显示 `.claude/settings.json`。
- 显示 `.claude/settings.local.json`。
- 显示两个 hook shell 文件，但状态是 `configured-file-only` 或 risk：`script exists but not registered in settings hooks`。
- 显示 `find-skills` skill，但状态是 `disabled by local skillOverrides`。
- 显示 `found-ground-info` skill，状态是 configured。

### Fixture B：最小 Claude session

Prompt：

```text
请读取当前仓库的 CLAUDE.md，并告诉我里面列出的测试命令是什么。不要修改文件。
```

预期：

- JSONL 中出现 `Read`。
- proxy 中出现对应 request。
- attribution 中出现 CLAUDE.md 或 project instructions 相关片段。
- Capability detail 中 `CLAUDE.md` 出现 runtime evidence。

### Fixture C：Skill 触发

Prompt：

```text
使用 found-ground-info 的能力说明，告诉我如果我要调查某个 session Turn 2 C1，需要提供哪些参数。不要运行脚本。
```

预期：

- skill listing 或 skill body 进入上下文。
- `found-ground-info` capability 能关联到 `Skill` tool use 或 skill injection evidence。

### Fixture D：MCP demo

可选新增临时 `.mcp.json`，使用只读/本地安全 MCP demo。

预期：

- Manifest 显示 MCP server。
- 如果 Claude Code session 加载成功，deferred tools 中出现 `mcp__...`。
- 如果未加载，显示 configured but no runtime evidence。

### Fixture E：Hook demo

只在 P2 后执行。

配置一个最小 HTTP hook，只采集 `SessionStart` 和 `PostToolUse`。

预期：

- 后端 `claude_hook_events` 有数据。
- 前端 hook timeline 显示事件。
- `PostToolUse` 能和 JSONL tool_use/tool_result 通过 `tool_use_id` 关联。

## 风险与边界

### 1. 不要把 `.gitignore` 当安全边界

`.gitignore` 只影响 Git，不保证 Claude 不读取。UI 里应明确提示：

```text
Git ignored != Claude denied.
Use permissions.deny or sandbox policies for access control.
```

### 2. 区分内部 dogfood 写配置和用户侧自动写配置

我们自己的 dogfood 环境可以主动配置 `.claude/`、hooks、skills、agents、statusLine，因为这是研发环境的一部分。

但交付给用户的 capabilities 功能第一阶段必须只读。当前 proxy 已经需要写 `~/.claude/settings.json`，这是必要但高敏操作，新增能力不能继续扩大默认写入面。

任何 hooks/plugin/statusLine 自动安装都应：

- 显示 diff。
- 备份原配置。
- 支持恢复。
- 明确哪些命令会以用户权限执行。

### 3. Managed/user/local scope 不一定可完整读取

DevTools 可能读不到 managed server settings 或某些 OS policy。UI 要显示 `unreadable` 或 `unknown`，不要伪装确定。

### 4. 运行时证据不是配置全量

某个能力没出现在 session 中，不代表没配置；可能只是未触发。Manifest 与 runtime evidence 必须分层展示。

### 5. Hook 事件可能包含敏感内容

Hook payload 可能包含 prompt、tool input、tool output、路径、环境信息。默认本地存储可以接受，但导出/分享必须做脱敏策略。

## 不做什么

用户交付的第一阶段不做：

- 自动安装 hooks。
- 自动启用 plugin。
- 自动修改 `.mcp.json`。
- 自动生成宽泛 allow permissions。
- 把 managed policy 视作可覆盖配置。
- 把所有官方工具写死到静态 rule corpus 里。

内部 dogfood 阶段可以配置 hooks、plugin、MCP demo，但必须限定在我们自己的本地环境或可复现 fixture 中。

用户交付的第一阶段也不追求复刻 Claude Code 的完整配置合并逻辑。我们应保留 raw source 和 best-effort effective view，避免过度承诺。

## 实施任务拆解

### 后端

1. 新增 `claude-capabilities` 模块。
2. 实现 settings scanner：project/local/user，可选 managed path 检测。
3. 实现 skills/commands scanner：解析 frontmatter、body size、support files。
4. 实现 agents scanner：解析 frontmatter、tools、model、background、isolation。
5. 实现 MCP scanner：解析 `.mcp.json` 和 server transport。
6. 实现 rules/output-styles/statusLine scanner。
7. 实现 risk analyzer。
8. 暴露 API。
9. 增加 fixtures 和 vitest。

### 前端

1. 新增 Capabilities tab/panel。
2. Summary cards：memory/settings/MCP/hooks/skills/agents/plugins/risks。
3. Source table：path、scope、readable、gitignored、本地/入库。
4. Capability table：category、name、status、source、risk。
5. Detail drawer：raw config、parsed fields、runtime evidence links。
6. Risk list：危险配置、未注册脚本、local override、敏感读取风险。

### 文档

1. README 增加一句：session-devtools can inspect both runtime context and Claude Code project capabilities。
2. 产品文档补 Capabilities 页面说明。
3. 增加自测 walkthrough。

## 推荐优先级

| 优先级 | 内容 | 理由 |
|---|---|---|
| P-1 | 当前仓库 dogfood 配置基线 + full-project fixture | 先让我们自己完整体验 Claude Code 能力，用真实 case 驱动产品，而不是直接设计用户态能力。 |
| P0 | Manifest scanner + Capabilities UI | 把 dogfood 能力抽象成只读项目扫描能力，解决用户配置会变化的问题。 |
| P1 | Runtime evidence linking | 让 devtools 从“配置浏览器”升级为“配置是否生效”的调试工具。 |
| P2 | HTTP hook ingestion | 补实时生命周期，覆盖 JSONL/proxy 不完整部分。 |
| P3 | Claude Code plugin pack / opt-in installer | 形成可复用能力包和演示环境，但必须让用户确认安装 diff。 |
| P4 | OTel / cloud / agent teams 深度支持 | 需要更多样本和稳定边界，不宜第一阶段做。 |

## 最终判断

现在值得做，而且应该在当前项目上 dogfood。

但第一步应改成 **我们自己的环境先配置完整 + 形成可复现 fixture**。在这个前提下，再做只读扫描、可视化和自测闭环。

对用户交付时，能力必须是项目维度的动态快照，而不是一次性任务。用户配置变化时，我们通过 refresh、snapshot、diff-current 和 runtime evidence 来解释“当前配置”和“当时 session 生效配置”的差异。

这件事做完后，session-devtools 的定位会从：

```text
看 Claude Code session 发生了什么
```

升级为：

```text
看 Claude Code 为什么会这样运行，以及哪些配置能力真实影响了这次模型调用
```
