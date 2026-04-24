# Phase 2 P0-A — Context Fill Timeline + Compaction 可视化

> 更新：2026-04-24
> 聚焦：Phase 2 第一梯队 P0-A 独家项。不含实现，只定义路线图供评估。

---

## 一、调研结论

### 1.1 claude-devtools 的 token 归因（不依赖 LLM）

**纯启发式**，不用 LLM judge：

```ts
estimateTokens(text) = Math.ceil(text.length / 4)
```

**6 类 category 靠规则匹配**（`contextTracker.ts` + `contextInjection.ts`）：

| Category | 识别规则 |
|----------|---------|
| `claude-md` | 路径匹配 CLAUDE.md（enterprise / user / project / directory 四级） |
| `mentioned-file` | 用户消息里 `@path` 正则 |
| `tool-output` | 所有 tool_result 的 content，按 toolName 分组 |
| `thinking-text` | assistant.content 的 thinking / text 块 |
| `task-coordination` | 白名单：`SendMessage / TeamCreate / TeamDelete / TaskCreate / TaskUpdate / TaskList / TaskGet` |
| `user-message` | 用户输入 |

**Compaction 事件识别**：Claude JSONL 自带 `isCompactSummary` 字段。

**Token 实测值**：`usage.input_tokens + cache_read + cache_creation`（来自 Claude API 返回）。
- Pre-compaction = 触发 isCompactSummary 时上一条 assistant 的 input_tokens
- Post-compaction = 下一条 assistant 的 input_tokens
- Delta = pre − post（负值 = 释放）

**Per-subagent 独立**：`computeSubagentPhaseBreakdown` 每个子 agent 单独一套 phase 和压缩历史。**证实了"一个 agent 实体一个 context"的模型**。

### 1.2 claude-devtools 的 UI（关键：他们没做 timeline）

| 组件 | 形态 |
|------|------|
| SessionContextPanel | 右侧边栏，按 category 折叠的明细表 |
| ContextBadge | 每个 AI turn 上的小徽章，"this turn 新增 X / Y / Z" |
| CompactBoundary | 压缩点的可展开分隔条 |
| TokenUsageDisplay | hover popover，按类别 total |
| Phase selector | 压缩后切换 Phase 1 / Phase 2 视图 |

**他们没有 x=turn / y=token 的时间序列图**。这是业内空白。

### 1.3 我们的独家机会

| 能力 | claude-devtools | 我们的机会 |
|------|----------------|-----------|
| 6 类归因算法 | ✅ 成熟，3k+ star 验证 | **直接移植**（纯算法，MIT 协议） |
| Compaction 检测 | ✅ | 直接用 isCompactSummary |
| Per-subagent 隔离 | ✅ | 我们已有 `claude.subagent.id`，天然支持 |
| **时间序列可视化** | ❌ **完全没有** | **✅ 这是白地** |
| 事件-状态联动 | ❌ | **✅ Timeline 的核心价值** |

---

## 二、Context Fill Timeline 的定义

**核心观念**：context 不是"当前一张快照"，是"随每个 turn 演化的状态流"。

**x 轴**：turn 序号（或时间）
**y 轴**：累计 token 数
**堆叠**：6 类 category 的颜色面积
**事件叠加**：
- 红色竖线 = compaction 点
- 小标记点 = 新 injection 首次出现的 turn
- 虚线 = context window 上限（200k）

**交互联动**：
- 点某个 turn → 主视图跳到该 turn 的 Span Tree / Timeline 位置
- 点 compaction 线 → 弹出 Compaction Diff Panel（前后对比）
- hover 任意 category 色块 → 显示该类当前所有 injection 明细

---

## 三、数据模型

### 3.1 Per-agent Context State

```ts
type ContextCategory =
  | 'system_prompt'      // 基础 system + CLAUDE.md 等
  | 'claude_md'
  | 'user_message'
  | 'mentioned_file'
  | 'tool_output'
  | 'thinking_text'
  | 'task_coordination';

interface ContextSnapshot {
  agentId: string;           // "main" | subagent id
  agentName: string;         // "claude-code" | "unit-5b-hooks"
  turnIndex: number;         // 0-based within this agent
  timestamp: number;         // ms
  phase: number;             // 1-based; +1 after each compaction

  // 估算值（claude-devtools 风格，char/4）
  tokensByCategory: Record<ContextCategory, number>;
  estimatedTotal: number;

  // 实测值（Claude API usage）
  measuredInputTokens?: number;
  measuredCacheRead?: number;
  measuredCacheCreation?: number;

  // 本 turn 的事件
  newInjections: Array<{
    category: ContextCategory;
    tokens: number;
    label: string;           // 文件名 / 工具名 / 片段预览
  }>;

  // 压缩事件
  isCompactionBoundary?: boolean;
  compactionDelta?: { pre: number; post: number };
  compactionSummary?: string;
}

interface AgentContextTrace {
  agentId: string;
  agentName: string;
  snapshots: ContextSnapshot[];
  totalPhases: number;
  contextLimit: number;       // 通常 200000
}
```

### 3.2 为什么同时保留 estimated + measured

- **measured** 是 ground truth（Claude API 返回），但**不带归因**
- **estimated** 有归因，但误差大（忽略 BPE、cache 等）
- 两者并列展示：如果估算总和 vs 实测相差 >30%，说明归因规则有漏项，可见可改

---

## 四、UI 路线

### 4.1 新增 "Context" tab（与 Timeline / Span Tree / Turns 并列）

### 4.2 三段式布局

```
┌────────────────────────────────────────────────┐
│ [main] [unit-1] [unit-2] ... [unit-7]          │  ← agent 选择 tab
├────────────────────────────────────────────────┤
│ Current: 143k / 200k  ━━━━━━━━━━━━━━━━━━░░░░  │  ← 当前填充条
│         claude-md 12k │ tools 85k │ thinking ..│
├────────────────────────────────────────────────┤
│     ┌─ context 200k limit ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│ 150k│           ████████                       │
│ 100k│        ████████████  ▎ ← compaction       │
│  50k│     █████████████▏▓▓▓▓▓                  │  ← 堆叠面积图
│   0k└──────────────────────────────────────    │
│     turn 0    10    20   30    40    50        │
├────────────────────────────────────────────────┤
│ Hover turn 23:                                 │
│   +5 new injections: Read(3)=12k, @file=2k     │  ← 事件详情
│   Δ from last turn: +14k                       │
└────────────────────────────────────────────────┘
```

### 4.3 Compaction Diff Panel（点 compaction 线弹出）

```
Pre-compaction (Phase 1): 180k tokens
  claude-md    18k  ━━━
  mentioned    22k  ━━━━
  tool-output  95k  ━━━━━━━━━━━━━━━━━━
  thinking     28k  ━━━━━
  ...
              ↓ compaction ↓
Post-compaction (Phase 2): 45k tokens
  summary      45k  ━━━━━━━━━

Delta: -135k (75% freed)
Dropped detail: 42 tool outputs, 18 @files, 15 thinking blocks
```

---

## 五、实现路线（4 步，~3-4 天）

### Step 1: IR 层 — Context 计算模块（~1 天）

**文件**：`packages/agent-viz/src/ir/context.ts`

**API**：
```ts
export function computeAgentContextTraces(
  mainRaw: string,
  subagents: Record<string, SubagentInput>,
  sessionId: string,
): Map<string, AgentContextTrace>;
```

**内部逻辑**：
1. 按 agentId 分区记录（main vs 每个 subagent）
2. 对每个 agent 的 JSONL：
   - 逐条扫描 user/assistant 记录
   - 按 6 类 category 归因（照搬 claude-devtools 规则）
   - 每个 assistant turn 产出一个 `ContextSnapshot`
   - 检测 `isCompactSummary` → 标记 compaction + 计算 delta
   - 累计 newInjections（当前 turn 相对上一 turn 的新增）

**关键函数（移植 claude-devtools 算法）**：
- `estimateTokens(text) = Math.ceil(text.length / 4)`
- `detectClaudeMdFromFilePath(path)` — 匹配 CLAUDE.md 层级
- `extractUserMentionPaths(text)` — @ 提取
- 白名单工具集（task-coordination）

### Step 2: 新增 Context tab 骨架（~0.5 天）

**文件**：
- `client/src/components/ContextTimeline/index.tsx`（主容器，agent tab bar）
- `client/src/components/ContextTimeline/AgentContextPanel.tsx`（单 agent 视图）

**SessionDetail 改造**：加一个 tab，数据从 `computeAgentContextTraces` 来。

### Step 3: 堆叠面积图 + 事件叠加（~1-1.5 天）

**文件**：`client/src/components/ContextTimeline/StackedAreaChart.tsx`

**技术选型**：
- 选项 A: 手写 SVG（~150 行，可控性最强，无新依赖）
- 选项 B: Recharts（~20k bundle，现成 stacked area）
- 选项 C: visx（更底层）

**推荐 A**：chart 逻辑本身不复杂，避免引入大 lib，未来定制容易。

**功能**：
- 6 类 category 堆叠
- 红色 compaction 竖线
- hover 坐标垂直线 + tooltip
- 点击 turn → 回调触发其他视图 scroll to

### Step 4: Compaction Diff Panel（~0.5-1 天）

**文件**：`client/src/components/ContextTimeline/CompactionDiff.tsx`

**触发**：点击 compaction 竖线弹出 modal 或 side sheet。

**展示**：前后成对条形图 + 差异明细列表。

### Step 5: 视图间 selection state 联动（~0.5 天）

- `SessionDetailContext` 共享 `selectedTurn`
- Context 面板点 turn → TraceTimeline 和 Span Tree 都高亮对应位置
- 反向联动同理

---

## 六、验收标准（用 58e6c115 session 验证）

| 项 | 期望 |
|---|------|
| Agent 总数 | 16（main + 15 实际用过 LLM 的 subagent） |
| 每个 agent 有独立的 context trace | ✅ |
| 估算总和 vs 实测 usage.input_tokens | 同量级（±30%） |
| 若任何 agent 触发了 compaction | 红线显示，点击弹出 diff |
| hover 任意 turn | 显示本 turn 新增的 injection 列表 |
| 点击 turn | 其他视图同步跳转 |

**补充**：如果 58e6c115 没有 compaction 事件（研究型 session 通常没触发压缩），另找一个长 session（如 > 50 turns、累计 > 150k tokens）验证压缩路径。

---

## 七、三个需要评估的决策点

1. **估算 + 实测并列 vs 只要估算**：两者都展示增加 UI 复杂度；但能自查归因漏洞。建议都做。
2. **Agent 切换 UI**：tab bar（横向 16 个，可能挤）vs sidebar list（左侧可滚动列表）。建议 tab bar + 溢出折叠。
3. **堆叠面积图**：手写 SVG vs Recharts。建议手写，理由：chart 逻辑简单，避免 20k bundle，未来加交互方便。

---

## 八、不做的事（避免作用域蔓延）

- **不做**全功能 SessionContextPanel 明细表（claude-devtools 已经做了，不是我们的差异化）
- **不做**上下文溯源"某 tool output 为什么还在 context 里"（需要 cache eviction 分析，ROI 低）
- **不做**预测模型"还能跑多久会撞上限"（需要 trend 模型，晚一步再做）
- **不做**跨 session 的 context 模式分析（范围超出单 trace 可视化）

---

## 九、参考实现文件（移植算法时查对）

| 算法 | claude-devtools 位置 |
|------|---------------------|
| estimateTokens | `src/shared/utils/tokenFormatting.ts:67` |
| 归因主函数 | `src/renderer/utils/contextTracker.ts` |
| CLAUDE.md 识别 | `src/renderer/utils/claudeMdTracker.ts` |
| Compaction 检测 | `src/renderer/utils/aiGroupHelpers.ts:140` |
| Subagent phase 算法 | `src/renderer/utils/aiGroupHelpers.ts:108` |
| ContextStats 类型 | `src/renderer/types/contextInjection.ts:230` |

---

## 一句话

Claude-devtools 把"**算法**"做对了（无 LLM，纯规则），但"**形态**"停在 panel+badge 没做 timeline。我们移植他们的归因算法，做出他们没做的 per-agent 时间序列视图，就是业内第一个"事件-状态联动"的 context 观测器。
