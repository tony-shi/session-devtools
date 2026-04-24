# Agent 可视化 Phase 2 — 能力对齐与空白分析

> 更新：2026-04-24
> 上游：`visualization.md` Phase 1 已落地（agent-prism TreeView + Timeline swimlane + OTel gen_ai 超集 IR + subagent 链路）
> 本文目的：在动手做 Phase 2 之前，**先完成能力地图和白地识别**，供评估排序。不含实现。

---

## 一、当前能力快照

| 视图 | 回答的问题 | 本质 | 来源 |
|------|----------|------|------|
| Span Tree (waterfall) | "谁是谁的子？调用栈多深？" | 按**调用关系**组织 | agent-prism |
| Timeline (swimlane) | "哪些 agent 并行？哪个时间段密集？" | 按**执行者**组织 | 自建 |
| 对话视图 | "人和 AI 说了什么？" | 按**消息语义**组织 | 既有 |

数据底座：
- OTel gen_ai semconv 超集 IR（`AgentSpan`）
- Claude JSONL + subagent 嵌套 → IR → OpenTelemetryDocument → agent-prism
- 单 session 已验证到 1427 spans 全量保留

---

## 二、Tree 视图的缩进分析

**结论：浅层合理，深层是 antipattern。**

- 每层吃 ~20px 横向。subagent 嵌套 4-5 层后，内容起点在 100px+，右侧时间条可用空间被压缩
- 纯 indent 不能 scale：Jaeger 早年放弃了，改用**左侧 depth color bar + 固定内容起点**
- claude-devtools 走得更激进：**focus-into 子树**，点击某节点让它成为新根，祖先收到顶部 breadcrumb

**短期判断**：当前 session 规模（~1.4k spans, 深度 5）还能用。**到 5k+ spans 或者深度 8+ 时必须改**，改造方向：
1. 虚拟化（agent-prism issue #15）
2. Depth-based auto-collapse（默认折叠 depth > 3）
3. Focus-in 子树（点击进入）

**当前优先级：P2**。还没到这个规模上限。

---

## 三、OTLP 领域我们缺的"大面"功能

按 "OTLP 是否原生概念 + 是否 LLM 特异" 分类：

### 3.1 OTLP 原生（尺度问题）

| 功能 | 触发条件 | 优先级 |
|------|---------|-------|
| Minimap / 时间轴缩放 | trace > 500 spans | P2 |
| Critical Path 高亮 | 找瓶颈 | P2 |
| Flame graph / icicle | trace > 1000 spans | P3 |
| Service/dependency graph | 看 agent 调用拓扑 | P2 |
| Span 相似度聚类（50 个 Read 合一卡） | 降噪 | P2 |
| Error-only 过滤 / replay | 调试 | P2 |
| Trace 对比 (diff) | 同 prompt 不同模型 | P3 |
| 全文搜索 input/output | 跨 span 查 keyword | P2 |
| Attribute facets (BubbleUp) | 异常维度发现 | P3 |

**这些都是"尺度上去了才需要"的功能**。数据已经在 IR 里，不是白地，是 backlog。

### 3.2 LLM 特异（OTLP 不覆盖）

OTLP/Prometheus/Jaeger 这一整套是 CPU/IO 时代产物，**完全不覆盖 LLM agent 的核心资源——context**。这才是白地。见第四节。

---

## 四、Context 监控 — LLM 领域的独家白地

### 4.1 为什么特殊

Context 是 LLM agent 独有资源：
- 像 RAM（有容量上限）
- 像 CPU cache（会被主动驱逐 = compaction）
- 但驱逐策略不完全可控
- 驱逐后行为跳变看不见（这是 agent "健忘" / 行为突变的根源）

**没有任何现有的 OTLP 工具覆盖这个维度。**

### 4.2 业内现状

| 项目 | 做法 | 可借鉴度 |
|------|------|---------|
| **claude-devtools** ⭐3151 | **7 类 token 归因**（CLAUDE.md / skills / @files / tool I/O / thinking / team overhead / user text），堆叠条 | ★★★★★ |
| **claude-devtools** | **Compaction 可视化**：压缩前后对比，显示"丢了什么" | ★★★★★ 业内独家 |
| agtrace | TUI 色条显示 context 使用率 | ★★ |
| Langfuse / Opik | 每 span 的 input/output tokens 数值，不归因 | ★ |
| Anthropic Console | 累计 token 计数器，无分类 | 零 |

### 4.3 最佳视图设计（提案）

**Context Fill Timeline**
- x = turn 序号（或时间）
- y = 堆叠柱，按 source 分色：
  - system prompt（基础 + CLAUDE.md + skills）
  - @files 注入
  - tool outputs
  - thinking
  - user messages
- **红色竖线标 compaction 事件**
- 效果：一张图同时回答"token 都去哪了" + "什么时候压缩了" + "压缩前后结构有何变化"

**Compaction Diff Panel**
- 压缩前 vs 压缩后的 token 归因
- 桑基图或成对条形图
- 展示"丢了哪些 category 的哪些 span"

**Growth Rate 曲线**
- Token 增长斜率
- 捕捉 runaway 增长（常见 bug 模式）

### 4.4 实现难度评估

- Token 总数：已有（IR `gen_ai.usage.*` 字段）
- 按 source 归因：**难点在识别**。Claude JSONL 里有 `system` 类型消息、`attachment` 类型消息，但 system prompt 的组成来源（CLAUDE.md vs skills vs @files）是拼接在一起的，需要启发式拆分
- Compaction 事件：Claude JSONL 里有 `isCompactSummary` 字段 / `PreCompact` hook 事件，可识别
- 工程量：**中**（2-3 天）

---

## 五、Agent Loop 的观测维度 — 你的 5 维 + 被忽略的

### 5.1 你列的 5 维

1. Prompt 动态注入
2. 循环控制
3. Context 用量 + 压缩
4. Tool 调用耗时
5. Tool 返回结果

### 5.2 被忽略但同样关键的 10 维

| # | 维度 | 为什么关键 | 最佳可视化 | 业内最好 |
|---|------|----------|----------|----------|
| 1 | **决策溯源 (thinking→action)** | 解释"为什么选这个 tool" | thinking 文本 hover 高亮触发的 tool_call | claude-devtools 部分 |
| 2 | **Prompt 注入层次追踪** | 每 turn 的 system prompt 是动态拼的（CLAUDE.md + skills + todo state + permissions + @files），看不到这层永远不理解行为 | Layered diff view：每 turn prompt 分层着色，逐 turn 折叠显示新增/删除 | **完全空白** |
| 3 | **Plan vs Execution 对齐度** | 越来越多 agent 先 TodoWrite 再执行，是否照做、是否跑偏 | Todo checklist + 每项链到执行 span（Gantt milestone 标记） | **完全空白** |
| 4 | **Permission / 审批流** | 这些是用户感知等待源，经常占 perceived latency 50%+ | 特殊 block-style 时间条，和 tool_call 分层 | **完全空白** |
| 5 | **重试 / 自纠模式** | 失败 Bash → 读错误 → 改正 → 重试，理解 agent robustness 关键 | Graph/DAG 视图里的自循环边；Timeline 上虚线连 retry 簇 | LangGraph Studio 部分 |
| 6 | **成本归因** | 每 subagent / 每 tool / 累计 $；预算告警 | 累计预算条 + 分 agent 饼图 | Langfuse / Opik |
| 7 | **失败模式分类** | 幻觉 / 工具错 / 权限拒 / 超时，占比和频次 | 错误密度热图 + 按类型分组 | Datadog Error Tracking |
| 8 | **Sub-agent I/O 边界** | 父发什么 prompt、子返回什么、是否被父真用上 | 父子之间消息泡泡图（像 Slack thread） | **完全空白** |
| 9 | **Skill / 插件加载状态** | 哪些 skill 被 trigger、加载了 tool 集、消耗了多少 context | Sidebar 环境 panel | Cursor 边缘做了一点 |
| 10 | **记忆 / 知识演化** | 哪些文件被创建、CLAUDE.md 被改、memory 写入 | 时间轴上的 "state mutation" 事件流 | **完全空白** |
| 11 | **时间密度异常** | "2s 10 个 tool 然后 60s 静默"——要么是 bug 要么是用户等待 | Histogram heatmap（x=时间 bucket，y=事件密度） | APM 工具标配 |

---

## 六、白地排名（价值 × 空白程度 × 可做性）

### 第一梯队（差异化护城河 / 空白 / 高价值）

**P0-A. Context Fill Timeline + Compaction 可视化**
- 业内最有壁垒的差异化
- claude-devtools 做了但是独立 app，**没有任何可复用组件**
- Context 是 LLM 独有，OTLP 完全不覆盖
- **做了就是本项目的独立身份**
- 工程量：中（2-3 天）

**P0-B. Prompt 注入层次追踪**
- 你列的"prompt 动态变化"的具体形式
- **完全空白**，没有参照
- 关键是识别 `system` 类型记录 + 识别 CLAUDE.md / skills / @files 注入边界
- ROI 高
- 工程量：中（2 天）

**P0-C. Plan vs Execution (TodoWrite 映射)**
- 当前 Claude Code 大量用 TodoWrite
- Todo checklist 可视化 + 映射到 timeline milestone
- "理解 agent 在做什么" 的最佳工具
- **完全空白**
- 工程量：小（1 天）

### 第二梯队（深化现有结构）

**P1-D. Timeline 加权限块可视化（Permission flow）**
- Claude JSONL 有 `permission-mode` 记录，已在源数据里
- 添加到 swimlane 里作为特殊块
- 工程量：小（0.5 天）

**P1-E. 决策溯源 thinking→tool**
- Thinking text hover 高亮触发的 tool_call
- 数据已有（thinking block 和后续 tool_use 在同一 assistant message）
- 工程量：小（0.5 天）

**P1-F. Sub-agent I/O bubble 视图**
- 父 agent 发给子的 prompt + 子返回给父的结果
- 从"结构"到"语义"的跃升
- 工程量：中（1-2 天）

**P1-G. Retry 簇识别**
- 检测"连续失败→成功"模式
- Timeline 加视觉分组
- 工程量：中（需要 loop detection 算法，1-2 天）

### 第三梯队（OTLP 尺度问题，等 trace 再长再做）

- Minimap / 虚拟化 / Critical path（当 trace > 5k spans 再做）
- Trace 对比 / 全文搜索
- Error 聚类 / BubbleUp

### 次要（简单但不紧急）

- 成本归因（数据都在 IR 里，一天完工）
- 失败模式分类（error span 统计）
- 时间密度 heatmap

---

## 七、决策框架

传统 OTLP 体系回答 **"哪慢、哪错"**；
agent loop 观测的真正差异化在回答 **"它为什么这么想、它携带了什么状态、状态如何被动态改变"**。

**Context 监控 + Prompt 注入追踪是这个问题域的两块最大空白，做了就是项目的独立身份。**

---

## 八、给评估的三个问题

1. 第一梯队（P0-A/B/C）三选一还是都做？顺序？
2. 如果资源有限，宁可做深 P0-A (context)，还是做广 P1 几个小功能？
3. 第三梯队（OTLP 尺度功能）暂时搁置的判断是否同意？

---

## 九、附：参考项目定位（Phase 1 已调研，补充关于本 Phase 的）

| 项目 | 对本 Phase 的参考价值 |
|------|---------------------|
| claude-devtools | Context 归因 + Compaction 可视化的**唯一**参考实现，直接对标 |
| Langfuse | 成本归因、input/output tokens 数值面板 |
| LangGraph Studio | Graph/DAG 视图（subagent I/O bubble 可参考） |
| Datadog APM | 时间密度 heatmap、error clustering |
| Perfetto | Flame graph（P3 尺度上去后再参考） |
| Honeycomb | BubbleUp 异常维度发现（P3） |
