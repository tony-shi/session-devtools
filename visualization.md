# Agent 可视化 & 竞品全景调研

> 最后更新：2026-04-21  
> 背景：基于 Claude Code / Codex / Gemini 等桌面 Agent 的 JSONL 会话数据，构建本地 AI 会话可视化工具，同时跟踪生态竞品动态。

---

## 一、问题定义

### 核心场景

一个完整的 Agent 会话（session）包含：
- 多轮 human → assistant 交互
- 每轮 assistant 可能调用多个工具（tool_use）
- 工具调用可能触发 subagent（嵌套 session）
- Claude 支持 agent teams（TeamCreate + SendMessage 模式），即多个 agent 并行协作

目标：清晰展示这些层次和流程，类似 Langfuse 的 trace waterfall + span tree；同时支持实时监控多个正在运行的 agent。

---

## 二、六大关键竞品深度对比

> 数据来源：GitHub API，截至 2026-04-21

### 2.0 基本信息速览

| 项目 | Stars | Forks | 主语言 | License | 最近推送 | 活跃度 |
|------|------:|------:|--------|---------|---------|--------|
| [claude-devtools](https://github.com/matt1398/claude-devtools) | **3151** | 229 | TypeScript | MIT | 2026-04-18 | 🟢 活跃 |
| [agent-flow](https://github.com/patoles/agent-flow) | **696** | 76 | TypeScript | Apache-2.0 | 2026-04-13 | 🟢 活跃 |
| [agents-observe](https://github.com/simple10/agents-observe) | **488** | 29 | TypeScript | MIT | 2026-04-21 | 🟢 非常活跃 |
| [agent-prism](https://github.com/evilmartians/agent-prism) | **328** | 17 | TypeScript | MIT | 2026-04-14 | 🟡 活跃 |
| [agtrace](https://github.com/lanegrid/agtrace) | **38** | 3 | Rust | Apache-2.0 | 2026-02-08 | 🔴 停滞 |
| [agentlens](https://github.com/tranhoangtu-it/agentlens) | **2** | 0 | Python | MIT | 2026-04-06 | 🔴 早期 |

---

### 2.1 claude-devtools ⭐ 3151

**定位**：Claude Code 的"缺失的 DevTools"——零侵入读取 `~/.claude/` 日志，还原 Claude 隐藏的一切。

**解决的核心痛点**：Claude Code v2.1.20 之后将详细输出折叠为 `Read 3 files`、`Edited 2 files` 等摘要，社区强烈反弹。claude-devtools 直接读取已有 session 日志，无需任何 wrapper。

**核心功能**：

| 功能 | 说明 |
|------|------|
| Tool Call Inspector | 展开每个工具调用：语法高亮的 Read、内联 diff 的 Edit、Bash 输出 |
| Context 重建 | 7 类 token 归因（CLAUDE.md、skills、@文件、工具 I/O、thinking、team overhead、用户文本） |
| Compaction 可视化 | 可视化 context 填满→压缩→重填的过程，显示压缩丢失了什么 |
| Subagent 执行树 | 嵌套 agent 递归渲染，含 token/cost/duration |
| Thinking 展示 | 完整显示 extended thinking 内容 |
| SSH 远程会话 | 读取远程机器的 `~/.claude/`，支持 agent forwarding |
| 通知触发器 | 自定义正则匹配任意字段，触发系统通知 |
| 多面板布局 | Cmd+K 跨 session 搜索，拖拽 tab 并排查看 |

**安装**：

```bash
# macOS Homebrew（最简）
brew install --cask claude-devtools

# Docker（无 Electron，适合远程部署）
docker compose up
# 访问 http://localhost:3456
# 或：
docker run -p 3456:3456 -v ~/.claude:/data/.claude:ro claude-devtools

# 从源码构建
git clone https://github.com/matt1398/claude-devtools.git
cd claude-devtools && pnpm install && pnpm dev
```

**架构**：纯读取模式，`~/.claude/` 挂载为只读。零出站网络请求，完全离线可用。Electron 桌面 App + Docker standalone 双模式。

**与我们的关系**：**直接竞品，但定位略有差异**。它是"历史回顾 DevTools"，我们有 Digest 日报和多 CLI 聚合。它的 Subagent 执行树和 Context 重建是我们需要追赶的功能。

---

### 2.2 agent-flow ⭐ 696

**定位**：Claude Code agent 编排的实时可视化——让 agent 的思考、分支、协作过程变得可见。起源于 CraftMyGame 游戏平台的 AI agent 调试需求。

**核心功能**：

| 功能 | 说明 |
|------|------|
| 实时节点图 | 交互式 node graph，实时显示工具调用、分支、返回流 |
| 自动发现 session | 自动检测工作区内活跃的 Claude Code session |
| 零延迟 Hooks | 轻量 HTTP hook server 直接接收 Claude Code 事件 |
| 多 session 标签页 | 同时追踪多个并发 agent session |
| Timeline + 文件热图 | 执行时间线、文件关注热力图、消息转录 |
| JSONL 回放 | 指向任意 JSONL 文件，回放或追踪历史 |
| VS Code 集成 | 侧边栏面板，`Cmd+Alt+A` 快捷键，自动配置 hooks |

**安装**：

```bash
# 最简（无需 VS Code）
npx agent-flow-app
# 另开终端运行 claude，事件自动流入

# 从源码
git clone https://github.com/patoles/agent-flow.git
cd agent-flow && pnpm i
pnpm run setup   # 一次性配置 Claude Code hooks
pnpm run dev     # 启动 web app + event relay
# 访问 http://localhost:3000

# VS Code 扩展
# Marketplace 搜索 "Agent Flow"，Cmd+Shift+P → Agent Flow: Open Agent Flow
```

**架构**：Claude Code Hooks → HTTP POST → Next.js event relay → SSE → 浏览器。`pnpm run dev` 同时启动 Next.js dev server 和 event relay。

**与我们的关系**：实时监控方向的参考对象。它的 node graph 可视化和 hooks 接入架构值得直接借鉴，我们目前缺少这个实时推送层。

---

### 2.3 agents-observe ⭐ 488

**定位**：Claude Code multi-agent 的实时可观测性 dashboard，专注 subagent 父子关系和完整事件流。

**核心功能**：

| 功能 | 说明 |
|------|------|
| 全事件捕获 | 覆盖所有 hook 事件类型（PreToolUse/PostToolUse/SubagentStart/Stop 等共 20+ 种） |
| Subagent 层级 | 清晰展示哪个 subagent 由哪个 parent 派生，实时父子关系 |
| 工具调用流 | PreToolUse → PostToolUse 完整 payload，含输入输出 |
| 过滤 & 搜索 | 按 agent、工具类型、内容全文搜索 |
| 事件展开 | 展开任意事件查看完整 payload |
| 跨 session 模式分析 | 捕获多 session 数据，分析 agent 行为规律 |
| Claude Code 插件 | 一键安装，自动配置 hooks，`/observe` 系列 skill |

**安装**：

```bash
# 最简（Claude Code plugin）
claude plugin marketplace add simple10/agents-observe
claude plugin install agents-observe
claude  # 启动后自动开始捕获
open http://localhost:4981

# 调试
> /observe status
> /observe debug
> /observe logs

# 前提：需要 Docker + Node.js
```

**架构**：
```
Claude Code Hooks → observe_cli.mjs → HTTP POST → API Server (SQLite) → WebSocket → React Dashboard
```
Hook 脚本读取 stdin 事件，分发给 agent-class-specific lib，构建包含 `meta.isNotification` 等标志的 envelope，POST 到服务端。服务端保持 agent-class 中立，机械应用标志，通过 WebSocket 转发给所有订阅客户端。React dashboard 从事件流派生全部 agent 状态。

**hooks.json 覆盖的事件**（最全面）：SessionStart/End、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、PermissionRequest/Denied、Stop/StopFailure、SubagentStart/Stop、TeammateIdle、TaskCreated/Completed、Notification、InstructionsLoaded、ConfigChange、CwdChanged、FileChanged、PreCompact/PostCompact、Elicitation/ElicitationResult、WorktreeRemove

**与我们的关系**：**架构最接近我们的补强方向**。它的 hooks 接入层 + WebSocket 推送 + SQLite 存储模式，和我们现有的 Bun + SQLite 架构高度兼容，可以直接参考其 hooks 配置和 observe_cli.mjs 的事件分发逻辑。

---

### 2.4 agent-prism ⭐ 328（Evil Martians）

**定位**：AI agent trace 可视化的 React **组件库**——不含后端，专注 UI 层，shadcn 风格，可直接复制到任何项目。

**核心功能**：

| 组件 | 说明 |
|------|------|
| `<TraceViewer />` | 完整 trace 可视化界面，含 trace 列表 + tree + details |
| `<TreeView />` | 层级 span 树，可折叠，支持搜索高亮，红色标注问题节点 |
| `<Timeline />` | Gantt 式执行流，颜色编码状态，实时 cost 累计 |
| `<DetailsView />` | 单 span 详情：input/output、cost、性能指标、全部属性 |
| `<SequenceDiagram />` | 步骤回放序列图，适合 onboarding 和复杂流程调试 |

**数据格式**：支持 OpenTelemetry spans 和 Langfuse observations，通过 `@evilmartians/agent-prism-data` 转换为 UI-ready 格式。提取 token 数量和 cost 信息。

**安装**：

```bash
# 复制 UI 组件（shadcn 风格，源码可修改）
npx degit evilmartians/agent-prism/packages/ui/src/components src/components/agent-prism

# 安装数据和类型包
npm install @evilmartians/agent-prism-data @evilmartians/agent-prism-types

# 安装 UI 依赖
npm install @radix-ui/react-collapsible @radix-ui/react-tabs classnames lucide-react react-json-pretty react-resizable-panels
```

```tsx
// 最简使用
import { TraceViewer } from "./components/agent-prism/TraceViewer";
import { openTelemetrySpanAdapter } from "@evilmartians/agent-prism-data";

<TraceViewer data={[{
  traceRecord: yourTraceRecord,
  spans: openTelemetrySpanAdapter.convertRawDocumentsToSpans(yourTraceData),
}]} />
```

**前提**：React 19+，Tailwind CSS 3，TypeScript。目前标注为 Alpha，API 可能变化。

**在线体验**：[agent-prism.evilmartians.io](https://agent-prism.evilmartians.io) | [Storybook](https://storybook.agent-prism.evilmartians.io)

**与我们的关系**：**`packages/agent-viz` 的直接参考对象**。它是纯 UI 组件，我们可以参考其 TreeView/Timeline 设计，但需要自己做 Claude JSONL → OTel span 的转换层（agent-prism-data 只处理标准 OTel 格式）。

---

### 2.5 agtrace ⭐ 38（lanegrid）

**定位**：专为 Claude Code / Codex / Gemini CLI 设计的轻量 trace 系统，核心卖点是"零配置自动发现已有日志"，同时提供 MCP 让 agent 查自己的历史。

**核心功能**：

| 功能 | 说明 |
|------|------|
| 自动发现 | 无需配置，自动找到 Claude/Codex/Gemini 的日志文件 |
| Context 窗口可视化 | 颜色条显示 context 使用量，token 趋势，活跃工具调用 |
| TUI Watch | 终端 dashboard，实时显示 context 状态和活动 |
| Session 浏览 | `agtrace session list` 浏览历史 |
| 全文搜索 | `agtrace lab grep "error"` 跨 session 搜索 |
| MCP 集成 | agent 可查询自己的执行历史，学习过去的错误 |
| Rust SDK | `agtrace-sdk` crate，供工具构建者使用 |

**安装**：

```bash
# npm（推荐）
npm install -g @lanegrid/agtrace
cd my-project
agtrace init      # 一次性初始化
agtrace watch     # 启动 TUI dashboard

# Rust crate
cargo install agtrace

# MCP 集成（让 Claude 查自己的历史）
claude mcp add agtrace -- agtrace mcp serve
codex mcp add agtrace -- agtrace mcp serve
```

**注意**：最后一次推送为 2026-02-08，**已停止活跃维护**。Stars 仅 38，社区规模小。Rust 实现，性能好但生态扩展性有限。

**与我们的关系**：功能定位与我们最重叠（多 CLI 聚合 + 本地零配置），但 UI 薄弱，维护停滞。我们的 Digest 日报和 Web UI 是明显优势。

---

### 2.6 agentlens ⭐ 2（tranhoangtu-it）

**定位**：自托管的 AI agent 可观测性平台，定位"Chrome DevTools for AI Agents"，侧重 AI 辅助故障分析和 Replay Sandbox。

**核心功能**：AI Failure Autopsy（AI 分析根因）、MCP Protocol Tracing（零配置追踪 MCP 调用）、Replay Sandbox（时间旅行回放，可编辑中间输入）、LLM-as-Judge 评估、Prompt 版本控制、多语言 SDK（Python/TS/.NET/Go）。

**安装**：

```bash
pip install agentlens-observe
docker compose up   # Dashboard at http://localhost:3000
```

**注意**：Stars 仅 2，**极早期项目**，功能描述较理想化，实际成熟度存疑。与 Claude Code JSONL 无直接集成，需要 SDK 埋点。

**与我们的关系**：定位差异大（需要 SDK 埋点 vs 我们零侵入），参考价值有限，主要关注其 Replay Sandbox 和 AI Autopsy 的产品思路。

---

## 三、六大竞品横向对比矩阵

| 能力维度 | claude-devtools | agent-flow | agents-observe | agent-prism | agtrace | agentlens |
|---------|:--------------:|:----------:|:--------------:|:-----------:|:-------:|:---------:|
| **数据接入** | | | | | | |
| 零侵入读 JSONL | ✅ | 部分 | ❌ | ❌ | ✅ | ❌ |
| Claude Code Hooks 实时流 | ❌ | ✅ | ✅ | N/A | ❌ | ❌ |
| SDK 埋点 | ❌ | ❌ | ❌ | N/A | ❌ | ✅ |
| 多 CLI（Codex/Gemini） | ❌ | ❌ | 部分 | N/A | ✅ | 部分 |
| **可视化** | | | | | | |
| Tool call 详情（input/output） | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Subagent 父子层级 | ✅ | ✅ | **✅** | ❌ | ❌ | ❌ |
| Context 窗口分析 | **✅** | ❌ | ❌ | ❌ | ✅ | ❌ |
| Thinking 内容展示 | **✅** | ❌ | ❌ | ❌ | ❌ | ❌ |
| Timeline/Gantt | ❌ | ✅ | ❌ | **✅** | ❌ | ❌ |
| Node Graph 可视化 | ❌ | **✅** | ❌ | ❌ | ❌ | ❌ |
| Compaction 可视化 | **✅** | ❌ | ❌ | ❌ | ❌ | ❌ |
| **实时性** | | | | | | |
| WebSocket/SSE 推送 | ❌ | ✅（SSE） | ✅（WS） | N/A | ❌ | ❌ |
| 实时 agent 状态卡片 | ❌ | ✅ | ✅ | N/A | 部分 | ❌ |
| **部署** | | | | | | |
| 桌面 App（Electron/Tauri） | **✅** | ❌ | ❌ | ❌ | ❌ | ❌ |
| Docker standalone | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| VS Code 扩展 | ❌ | **✅** | ❌ | ❌ | ❌ | ✅ |
| 零配置本地 | ✅ | 部分 | 需 Docker | ❌ | ✅ | ❌ |
| **特色功能** | | | | | | |
| Digest 日报 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| AI Failure Autopsy | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| MCP（agent 查历史） | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Replay Sandbox | ❌ | 部分 | ❌ | ❌ | ❌ | ✅ |
| SSH 远程 | **✅** | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## 四、与 session-dashboard 的定位对比

| 维度 | **session-dashboard（我们）** | claude-devtools | agents-observe | agent-flow |
|------|------------------------------|----------------|----------------|------------|
| 数据来源 | JSONL 轮询（多 CLI） | JSONL 只读（Claude only） | Hooks 实时流 | Hooks 实时流 |
| 存储 | SQLite（本地） | 内存/文件 | SQLite（Docker） | 内存 |
| 跨 CLI | **Claude/Codex/Gemini** | Claude only | Claude only | Claude only |
| Digest 日报 | **✅（独有）** | ❌ | ❌ | ❌ |
| 实时性 | 轮询（待改进） | 无（历史回顾） | WebSocket 实时 | SSE 实时 |
| Subagent 可视化 | 部分（agent-viz 在做） | ✅ | ✅ | ✅ |
| Context 分析 | ❌ | **✅（最强）** | ❌ | ❌ |
| 部署 | Bun 本地进程 | Electron App / Docker | Docker | npx / VS Code |

**我们的核心差异化**：Digest 日报 + 跨 CLI 统一历史视图是目前所有竞品都没有的功能。

**最紧迫的补强点**：
1. Subagent 父子关系可视化（claude-devtools 和 agents-observe 都已实现）
2. 实时推送（参考 agents-observe 的 Hooks + WebSocket 架构）
3. Context 窗口分析（claude-devtools 的核心卖点，我们完全缺失）

---

## 五、Claude Code JSONL 数据结构分析

基于本项目 `server/src/parsers/claude.ts`，Claude Code 会话包含以下层次：

```
Session (JSONL 文件)
  └── Turn (parentUuid 链式引用)
        ├── user: tool_result blocks (工具返回值)
        └── assistant: content blocks
              ├── text
              ├── thinking / redacted_thinking
              └── tool_use[]  ← 可多个并行
                    ├── Bash / Read / Edit / Write ...
                    ├── Agent (spawn subagent → 新 session)
                    ├── TeamCreate (创建 agent team)
                    ├── SendMessage (向 teammate 发消息)
                    └── TaskCreate / TaskUpdate ...
```

**Subagent 在文件系统层面**：Claude Code 将 subagent 会话存储在 `subagents/` 子目录，当前 `sync.ts` 中已明确过滤（`!p.includes('/subagents')`）。

**当前 dashboard 未利用的字段**：
- `tool_use.input`（工具参数）
- `tool_use.id` ↔ `tool_result.tool_use_id`（请求/响应对应关系）
- `thinking` 块
- `durationMs`（系统记录）
- subagents 目录

---

## 六、可视化模块设计方向

### 6.1 分层架构

```
┌─────────────────────────────────────────────────────┐
│                   Visualization Layer                │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │  Span Tree   │  │  Waterfall   │  │  Team DAG │  │
│  │  (hierarchy) │  │  (timeline)  │  │  (graph)  │  │
│  └──────────────┘  └──────────────┘  └───────────┘  │
├─────────────────────────────────────────────────────┤
│                 Unified IR / Data Model              │
│  Session → Trace → Span → Event (OTel-inspired)      │
├─────────────────────────────────────────────────────┤
│                    Parser / Adapter Layer            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │  Claude  │  │  Codex   │  │  Gemini  │  ...       │
│  │  JSONL   │  │  JSONL   │  │  JSONL   │           │
│  └──────────┘  └──────────┘  └──────────┘           │
└─────────────────────────────────────────────────────┘
```

### 6.2 核心 IR（Intermediate Representation）

**定位**：OTel `gen_ai` semantic conventions 的**超集**，而非仅"inspired by"。核心字段严格对齐 OTel，Claude/Codex/Gemini 专属信号放 vendor namespace。这样 UI 只认 IR，导入侧（JSONL / Hooks / 未来 OTLP receiver）各写 adapter，导出侧可反向生成 OTLP 接入 Langfuse / Phoenix（工程化迁移退路）。

```typescript
interface AgentSpan {
  // —— OTel 核心字段 ——
  id: string               // = span_id
  traceId: string          // session 根 ID
  parentId?: string        // 父 span（turn 或 tool_use）
  name: string             // e.g., "chat gpt-5", "execute_tool Bash"
  kind: 'session' | 'turn' | 'tool_call' | 'tool_result' | 'message'
  startTime: number        // ms, epoch
  endTime?: number
  status: 'ok' | 'error' | 'pending'

  // —— OTel gen_ai semconv 对齐字段（放在 attributes 里，这里列出约定 key）——
  // gen_ai.system           : "claude" | "codex" | "gemini"
  // gen_ai.operation.name   : "chat" | "execute_tool" | "create_agent" | "invoke_agent"
  // gen_ai.request.model    : e.g., "claude-opus-4-7"
  // gen_ai.usage.input_tokens / output_tokens / cache_read_tokens
  // gen_ai.tool.name / gen_ai.tool.call.id
  // gen_ai.agent.id / gen_ai.agent.name

  // —— Vendor namespace（Claude 专属，不污染标准字段）——
  // claude.thinking.text / claude.thinking.redacted
  // claude.compaction.before_tokens / after_tokens / dropped
  // claude.subagent.parent_session_id
  // claude.jsonl.parent_uuid
  agentId?: string         // 便于索引，等价于 attributes['gen_ai.agent.id']
  attributes: Record<string, unknown>
  events: AgentEvent[]
}
```

**不做的事**：不把 `thinking`、`compaction`、`parentUuid` 硬塞进 OTel 标准字段。semconv 还在变动，为稳定性让渡产品能力得不偿失。

### 6.3 可视化组件拆分

**P0 直接用 agent-prism**（`<TraceViewer />` 内已含 TreeView + Timeline + DetailsView + SequenceDiagram），我们不自建：

| 组件 | 来源 | 说明 |
|------|------|------|
| `<TraceViewer />` / `<TreeView />` / `<Timeline />` / `<DetailsView />` | **agent-prism** | 直接 degit + OTel span 喂入 |

**P1+ 我们自建**（agent-prism 不覆盖的差异化能力）：

| 组件 | 功能 | 优先级 |
|------|------|-------|
| `<LiveAgentGrid />` | 多 agent 实时进度卡片网格 | P1 |
| `<TeamGraph />` | Agent team 拓扑图（SendMessage 流向，ReactFlow） | P1 |
| `<ContextWindowPanel />` | Context 7 类归因 + compaction 前后对比 | P1 |
| `<TokenSummary />` | 全局 token / cost 统计 | P1 |
| `<LiveStream />` | 实时追加 span（session 进行中） | P2 |

### 6.4 实时推送补强方案

当前轮询方案升级路径（参考 `agents-observe` 已验证架构）：

```
Claude Code Hooks (PostToolUse / Stop) 
  → POST /api/hooks/event 
  → SQLite 写入 + WebSocket broadcast 
  → 前端实时更新
```

改动范围：server 增加一个 hook 接收 endpoint + WebSocket 支持，前端 `api.ts` 增加 WS 订阅，与现有 JSONL 轮询并存，互为补充。

---

## 七、工作拆解（含竞品参考）

### Phase 0：规范与原型（已完成基础）
- [x] 定义 AgentSpan IR 规范
- [x] Claude JSONL 解析器（`server/src/parsers/claude.ts`）
- [x] `packages/agent-viz` 子包初始化，SpanTree 基础实现

### Phase 1：直接引入 agent-prism，最小路径跑通（当前阶段）

**策略**：不自建 SpanTree / Timeline / Details 组件。`agent-prism` 已是 React 19 + Tailwind + shadcn 风格，和我们现有栈完全一致，直接 degit 进 `packages/agent-viz`，把精力全部放在"Claude JSONL → OTel spans"的 adapter 层。

- [ ] **引入 agent-prism**
  - `npx degit evilmartians/agent-prism/packages/ui/src/components packages/agent-viz/src/prism`
  - `bun add @evilmartians/agent-prism-data @evilmartians/agent-prism-types`
  - 补齐 peer 依赖（`@radix-ui/react-collapsible` / `react-tabs` / `react-json-pretty` / `react-resizable-panels` / `lucide-react` / `classnames`）
  - 在 `SessionDetail` 里挂 `<TraceViewer />`，先用一条真实 session 的假数据验证渲染

- [ ] **IR 对齐 OTel gen_ai semconv（超集）**
  - 定义 `AgentSpan`（见 §6.2），核心字段严格遵循 OTel gen_ai，Claude 专属放 `claude.*` vendor namespace
  - 写 `toOtelSpans(span: AgentSpan[]): OTelSpan[]` 导出函数，直接喂 `openTelemetrySpanAdapter.convertRawDocumentsToSpans`，避免为 agent-prism 写私有格式

- [ ] **Claude JSONL → AgentSpan adapter**
  - 现有 `server/src/parsers/claude.ts` 只拆出 turn/message，补一层把 `tool_use` / `tool_result` 按 `tool_use.id ↔ tool_use_id` 配对成一个 span（含 input / output / durationMs）
  - 把 `parentUuid` 链转成 `parentId`，`thinking` 块单独作为 event 或 `claude.thinking.*` attribute
  - 输出放在新文件 `server/src/ir/claude-to-span.ts`，与 parser 解耦

- [ ] **扩展 DB schema 存储 span 级数据**
  - 新增 `spans` 表（`id, session_id, parent_id, kind, name, start_ms, end_ms, status, attributes_json`）
  - `sync.ts` 在写入 message 时同步 upsert spans，保证 `/api/sessions/:id/spans` 可直接喂前端

- [ ] **Subagent 跨 session 关联**
  - 识别 `subagents/` 目录下文件，通过 `Agent` tool_use 的返回或目录命名推断父 session
  - 在 IR 里设置 `claude.subagent.parent_session_id`，agent-prism 的 TreeView 能递归渲染

- [ ] **API**：`GET /api/sessions/:id/trace` 返回该 session 的 `AgentSpan[]`（已按 agent-prism 期望格式组织）

**验收**：打开某个 Claude session 详情页，能看到 agent-prism 的 TreeView + Timeline + Details 三件套，工具调用可展开看到 input/output，subagent 可递归下钻。不自己写一行树形/甘特图 UI。

### Phase 2：实时监控
- [ ] 增加 Claude Code Hooks 接收 endpoint（参考 agents-observe hooks.json，覆盖 20+ 事件类型）
- [ ] WebSocket 推送到前端（参考 agents-observe 架构：Hooks → SQLite → WebSocket → React）
- [ ] `<LiveAgentGrid />` 多 agent 实时进度卡片

### Phase 3：高级可视化
- [ ] Context 窗口分析（参考 claude-devtools 7 类 token 归因 + compaction 可视化）——这是 agent-prism 没覆盖的、且 claude-devtools 的核心壁垒，必须自建
- [ ] TeamGraph DAG 视图（ReactFlow + dagre，agent-prism 不覆盖 team 拓扑）
- [ ] Codex / Gemini JSONL 适配器（复用 Phase 1 的 IR，只写新 adapter）
- [ ] 若 agent-prism 的 TreeView/Timeline 在大型 session 下有性能或定制瓶颈，再 fork 或局部替换（默认不动）

### Phase 4：生态
- [ ] 控件发布为独立 npm 包（`@session-viz/react`）

---

## 八、关键风险

1. **Schema 不稳定**：Claude Code JSONL 格式可能随版本变化，需要版本适配层
2. **Subagent 关联复杂**：跨 session 的 traceId 关联依赖未公开的 session 命名规则
3. **Agent team 数据不完整**：TeamCreate/SendMessage 的对端 session 文件可能不在同一目录
4. **性能**：大型 session（1000+ spans）的渲染需要虚拟化（react-virtuoso 等）
5. **竞争**：Anthropic 官方可能推出类似工具；vibe-kanban 已有 23k stars，市场认知度高

---

## 九、附录：通用 LLM 可观测性平台

定位生产监控，对本地 CLI 会话场景太重，但作为参考标准有价值。

| 项目 | Stars | 核心定位 | Claude CLI 支持 | 部署 |
|------|-------|---------|----------------|------|
| [Langfuse](https://github.com/langfuse/langfuse) | ~25k | LLM 工程平台，trace + eval + prompt 管理 | 无原生，靠 OTLP | Docker 自托管 |
| [OpenLIT](https://github.com/openlit/openlit) | ~2.4k | OTel-native，50+ provider 集成 | 无 | Docker/K8s，ClickHouse |
| [Opik (Comet)](https://github.com/comet-ml/opik) | 中等 | trace + eval + 成本追踪 | **有 Claude Code 插件** | Docker/Helm |
| [Arize Phoenix](https://github.com/Arize-ai/phoenix) | ~9.3k | ML+LLM 观测，embedding 可视化 | 无，OTLP 接入 | 自托管 |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) | **23,200+** | Kanban 管控 10+ coding agents | Claude/Codex/Gemini/Copilot 等 | npx 本地 |

---

## 十、参考资料

- [claude-devtools](https://github.com/matt1398/claude-devtools) — ⭐ 3151，最成熟的 Claude Code 历史查看工具
- [agent-flow](https://github.com/patoles/agent-flow) — ⭐ 696，实时 node graph 可视化，VS Code 扩展
- [agents-observe](https://github.com/simple10/agents-observe) — ⭐ 488，最干净的 Hooks + WebSocket 架构
- [agent-prism](https://github.com/evilmartians/agent-prism) — ⭐ 328，最精美的 React 组件库，shadcn 风格
- [agtrace](https://github.com/lanegrid/agtrace) — ⭐ 38，多 CLI 自动发现，MCP 集成，但已停止维护
- [Langfuse Tracing Concepts](https://langfuse.com/docs/tracing)
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)
- 本项目解析器：`server/src/parsers/claude.ts`
- 本项目 DB schema：`server/src/db.ts`
