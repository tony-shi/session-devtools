# Agent Loop Visualization 控件调研报告

> 日期：2026-04-18  
> 背景：基于 Claude Code / Codex / Gemini 等桌面 Agent 的 JSONL 会话数据，构建一个中立的、可复用的 Agent Loop 可视化控件，参考 Langfuse 的 trace 视图。

---

## 一、问题定义

### 核心场景

一个完整的 Agent 会话（session）包含：
- 多轮 human → assistant 交互
- 每轮 assistant 可能调用多个工具（tool_use）
- 工具调用可能触发 subagent（嵌套 session）
- Claude 支持 agent teams（TeamCreate + SendMessage 模式），即多个 agent 并行协作

目标控件需要清晰展示这些层次和流程，类似 Langfuse 的 trace waterfall + span tree。

---

## 二、竞品调研

### 2.1 Claude Code 专属工具

| 工具 | Stars | 语言 | 能力 | 缺陷 |
|------|-------|------|------|------|
| **claude-code-trace** | 215 | Rust + React | JSONL 解析、MCP tool 展示、多平台 GUI | 无 subagent/team 支持 |
| **tail-claude** | 131 | Go | TUI 实时查看 JSONL | 纯 CLI，无可视化 |
| **ccstat** | 17 | - | CLI 时间线统计 | 无交互 |
| **claude-sessions-dashboard** | 7 | - | 本地 session 浏览 | 功能极简 |

**结论**：Claude 专属工具都停留在"查看单条 session"层面，无一支持 subagent 层次或 agent team 协作流程的可视化。

### 2.2 通用 LLM 可观测性平台

| 工具 | Stars | 定位 | Multi-Agent 支持 | 开源协议 |
|------|-------|------|-----------------|---------|
| **Phoenix (Arize)** | 9.3k | OTel-based AI 可观测 | 有（OTel span 树） | Elastic 2.0 |
| **Langfuse** | - | LLM 应用可观测 | 有（trace/span/generation 层次） | MIT（自托管） |
| **LangSmith** | - | LangChain 生态 | 强（LangGraph 深度集成） | 商业 |
| **OpenInference** | 924 | OTel GenAI 规范 | 规范层（非 UI） | Apache 2.0 |

**结论**：Phoenix 和 Langfuse 是目前最接近目标的开源工具，但它们都假设数据通过 OpenTelemetry SDK 主动上报，无法直接消费 Claude Code 的 JSONL 文件。

### 2.3 Multi-Agent 框架自带 UI

| 工具 | Stars | 框架 | 可视化形式 |
|------|-------|------|-----------|
| **AutoGen UI** | 994 | Microsoft AutoGen | Web UI，agent team 协作流 |
| **Claude Swarm** | 115 | Anthropic Claude | Rich terminal dashboard，并行执行 |
| **LangGraph Studio** | - | LangGraph | DAG 编辑器 + 实时执行 |
| **AgentScope Studio** | 513 | AgentScope | DAG 可视化 + OTel 集成 |

**结论**：这些工具都与特定框架深度绑定，无法作为中立控件复用。

---

## 三、现有工具对复杂 Agent 流程的支持评估

### 3.1 Claude Code 的复杂结构

基于本项目的 JSONL 分析（`server/src/parsers/claude.ts`），Claude Code 会话包含以下层次：

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

**Subagent 在文件系统层面**：Claude Code 将 subagent 会话存储在 `subagents/` 子目录中，当前 `sync.ts` 中已明确过滤掉这部分（`!p.includes('/subagents')`）。

### 3.2 社区工具的支持现状

| 能力 | claude-code-trace | Phoenix | Langfuse | LangSmith |
|------|:---:|:---:|:---:|:---:|
| 单 session 展示 | ✅ | ✅ | ✅ | ✅ |
| Turn 层次 | ✅ | ✅ | ✅ | ✅ |
| 工具调用详情 | 部分 | ✅ | ✅ | ✅ |
| 并行 tool_use 可视化 | ❌ | ✅ | ✅ | ✅ |
| Subagent 嵌套层次 | ❌ | ❌ | ❌ | 部分 |
| Agent team 协作流 | ❌ | ❌ | ❌ | ❌ |
| 直接消费 JSONL | ✅ | ❌ | ❌ | ❌ |
| 多 Agent 框架中立 | ❌ | 部分 | 部分 | ❌ |

**核心结论**：目前没有任何工具能完整支持 Claude agent teams 的多 agent 协作可视化。这是明确的空白。

---

## 四、可行性分析

### 4.1 数据层可行性

Claude Code JSONL 已包含足够信息重建完整的 agent loop：

- `parentUuid` 链 → 重建 turn 树
- `tool_use.name` + `tool_use.input` → 工具调用详情
- `tool_result.content` → 工具返回值
- `timestamp` → 时间轴
- `usage` → token 统计
- `sessionId` + subagents 目录结构 → 跨 session 关联

**当前 dashboard 未利用的字段**：
- `tool_use.input`（工具参数）
- `tool_use.id` ↔ `tool_result.tool_use_id`（请求/响应对应关系）
- `thinking` 块
- `durationMs`（系统记录）
- subagents 目录

### 4.2 技术可行性

**前端渲染**：
- Waterfall/Gantt：`d3.js` 或 `@nivo/timeline`
- Tree/Hierarchy：`react-arborist` 或 `@xyflow/react`（ReactFlow）
- DAG（agent team）：`@xyflow/react`（有良好的 dagre 布局支持）

**数据模型**：可参考 OpenTelemetry Span 模型，设计统一的中间层 IR（Intermediate Representation），将 Claude JSONL、Codex、Gemini 的数据统一转换。

### 4.3 复杂度评估

| 模块 | 复杂度 | 说明 |
|------|-------|------|
| JSONL → IR 转换层 | 中 | 需处理多版本格式差异 |
| 单 session waterfall 视图 | 低 | 成熟方案，参考 Langfuse |
| Subagent 嵌套展示 | 中 | 跨文件关联，需 session 索引 |
| Agent team DAG 视图 | 高 | 需解析 SendMessage 消息流，重建拓扑 |
| 多框架适配（Codex/Gemini） | 中-高 | 各框架 JSONL schema 差异大 |
| 实时/流式更新 | 中 | WebSocket 或 SSE 推送 |

---

## 五、模块化设计方向

### 5.1 分层架构

```
┌─────────────────────────────────────────────────────┐
│                   Visualization Layer                │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │  Turn Tree   │  │  Waterfall   │  │  Team DAG │  │
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

### 5.2 核心 IR（Intermediate Representation）

参考 OTel Span 模型，定义统一数据结构：

```typescript
interface AgentSpan {
  id: string
  traceId: string          // session 根 ID
  parentId?: string        // 父 span（turn 或 tool_use）
  agentId?: string         // 所属 agent（team 场景）
  kind: 'session' | 'turn' | 'tool_call' | 'tool_result' | 'message'
  name: string             // e.g., "Bash", "SendMessage", "user_input"
  startTime: number        // ms
  endTime?: number
  status: 'ok' | 'error' | 'pending'
  attributes: Record<string, unknown>  // tool input, token counts, etc.
  events: AgentEvent[]
}

interface AgentEvent {
  time: number
  name: string
  attributes: Record<string, unknown>
}
```

### 5.3 可视化组件拆分

| 组件 | 功能 | 优先级 |
|------|------|-------|
| `<SpanTree />` | 可折叠树形 span 层次 | P0 |
| `<WaterfallChart />` | Gantt 式时间轴，span 并行展示 | P0 |
| `<SpanDetail />` | 单个 span 的详情面板（input/output/tokens） | P0 |
| `<TeamGraph />` | Agent team 拓扑图（SendMessage 流向） | P1 |
| `<TokenSummary />` | 全局 token / cost 统计 | P1 |
| `<SearchFilter />` | 按 span 类型、agent、工具名过滤 | P1 |
| `<LiveStream />` | 实时追加 span（session 进行中） | P2 |

---

## 六、工作拆解（不含实现）

### Phase 0：规范与原型（1-2 周）

1. 定义 AgentSpan IR 规范（参考 OTel GenAI semantic conventions）
2. 手工标注 3-5 个真实 Claude JSONL 样本，覆盖：单 agent、subagent 嵌套、agent team
3. 确定 UI 框架选型（ReactFlow vs d3 vs nivo）
4. 竞品 UI 截图对比（Langfuse waterfall、LangSmith trace、Phoenix span tree）

### Phase 1：数据层（2-3 周）

5. 实现 Claude JSONL → AgentSpan IR 转换器
6. 扩展 DB schema 存储 span 级数据（tool input/output、duration、parentId）
7. 实现 subagent session 关联（跨文件 traceId 链接）
8. 实现 agent team 消息流重建（SendMessage → 拓扑边）

### Phase 2：核心 UI（3-4 周）

9. `<SpanTree />` 组件（可折叠，支持搜索高亮）
10. `<WaterfallChart />` 组件（Gantt 时间轴，并行 span 泳道）
11. `<SpanDetail />` 面板（tool input/output、token、thinking）
12. 集成到当前 SessionDetail 页面，替换现有 turn 列表

### Phase 3：高级功能（4-6 周）

13. `<TeamGraph />` DAG 视图（ReactFlow + dagre 布局）
14. Codex CLI JSONL 适配器
15. Gemini CLI JSONL 适配器
16. 控件发布为独立 npm 包（`@session-viz/react` 或类似）

---

## 七、社区价值与影响力评估

### 7.1 为什么现在是时机

- Claude Code 在 2025-2026 年快速普及，用户量爆发
- Agent teams / subagent 功能是 2026 年新能力，社区工具尚未跟上
- OpenTelemetry GenAI semantic conventions 正在成型，可借势
- Langfuse 等工具需要主动埋点，而 Claude JSONL 是天然的"零侵入"数据源

### 7.2 差异化定位

| 维度 | 本控件 | Langfuse/LangSmith |
|------|-------|-------------------|
| 数据来源 | 零侵入，读取已有 JSONL | 需要 SDK 埋点 |
| 框架中立性 | 高（多 Agent 框架适配） | 中（有框架偏好） |
| 部署模式 | 本地优先，离线可用 | 云端为主 |
| Agent team 支持 | 目标核心能力 | 缺失 |
| 开源协议 | MIT（建议） | MIT/商业混合 |

### 7.3 潜在社区影响

- **目标用户**：Claude Code 重度用户、AI agent 开发者、企业 AI 工程团队
- **参考案例**：claude-code-trace 以 215 stars 证明了市场需求，但功能停留在基础层
- **可预期的生态价值**：
  - 作为独立控件被其他 dashboard 项目引用
  - 成为 Claude agent 调试的标准工具
  - 推动社区对 agent JSONL schema 的规范讨论

---

## 八、关键风险

1. **Schema 不稳定**：Claude Code 的 JSONL 格式可能随版本变化，需要版本适配层
2. **Subagent 关联复杂**：跨 session 的 traceId 关联依赖 Anthropic 未公开的 session 命名规则
3. **Agent team 数据不完整**：TeamCreate/SendMessage 的对端 session 文件可能不在同一目录
4. **性能**：大型 session（1000+ spans）的渲染需要虚拟化（react-virtuoso 等）
5. **竞争**：Anthropic 官方可能推出类似工具

---

## 九、参考资料

- [Langfuse Tracing Concepts](https://langfuse.com/docs/tracing)
- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OpenInference Specification](https://github.com/Arize-ai/openinference)
- [claude-code-trace (GitHub)](https://github.com/anthropics/claude-code-trace) *(215 stars)*
- [Phoenix by Arize](https://github.com/Arize-ai/phoenix) *(9.3k stars)*
- [ReactFlow / xyflow](https://reactflow.dev/)
- 本项目 JSONL 解析器：`server/src/parsers/claude.ts`
- 本项目 DB schema：`server/src/db.ts`
