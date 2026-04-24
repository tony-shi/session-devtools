# Token Tracking & Context Provenance

> 更新：2026-04-24  
> 基于 session `14abf7cd` / turn 382 的实测数据

---

## 一、核心问题

Claude Code 每次 LLM API 调用的 context 由多个来源拼装而成。`usage.input_tokens + cache_read + cache_creation` 是 ground truth（Anthropic 返回的实测值），但这个总量背后"每一段 prompt 从哪来"——即**溯源**——需要多个数据源联合才能还原。

---

## 二、数据来源层级

### 2.1 三个数据源

| 数据源 | 覆盖内容 | 精度 | 获取方式 |
|--------|---------|------|---------|
| **JSONL** (`~/.claude/projects/.../*.jsonl`) | messages[] 的内容（tool_result / user_text / assistant_text）+ attachment 注入 | char/4 估算，误差 ~5% | 现有 sync 逻辑 |
| **Proxy dump** (`~/.api-dashboard/proxy-dumps/`) | system[] 完整内容 + tools[] 名单 + usage ground truth | system/tools 精确；messages 同 JSONL | internal-proxy 旁路捕获 |
| **Claude Code 逆向** (source map) | tools[] JSON schema 全文、base system prompt | 精确，但静态（版本绑定） | 离线分析，不实时 |

### 2.2 各来源覆盖的 context 部分

```
POST /v1/messages 请求体
├── system[]                    ← Proxy dump 捕获（完整文本）
│   ├── block[0] billing header     20 tokens  每次变化（cch= 计数器）
│   ├── block[1] base identity      14 tokens  静态
│   └── block[2] main system prompt 7,521 tokens  静态（版本绑定）
│
├── tools[]                     ← Proxy dump 捕获名单+估算；JSONL 无
│   └── ~100 工具的 JSON Schema     ~28,000 tokens  基本静态，deferred_tools_delta 时变化
│
└── messages[]                  ← JSONL 可重建；Proxy dump 有摘要
    ├── user turns
    │   ├── tool_result blocks      ← JSONL tool_result 记录
    │   └── human_input text        ← JSONL user 记录
    └── assistant turns
        ├── text blocks             ← JSONL assistant 记录
        ├── tool_use blocks         ← JSONL assistant 记录
        └── thinking blocks         ← JSONL thinking 记录
```

---

## 三、Turn 382 实测溯源（基准案例）

**Session**: `14abf7cd-57fe-42f0-be4c-cbdcab2a9c3e`  
**Proxy call**: `sess-90049430349d1a3c / 0072.json`  
**时间**: `2026-04-24T12:48:19Z`

### 3.1 实测总量分解

```
measured_total = 298,234 tokens
│
├── cache_read_input_tokens:   298,092  (99.95% — 几乎全部命中缓存)
├── cache_creation_input_tokens:   141  (新写入缓存)
└── input_tokens (fresh):            1  (真正新鲜的 token)
```

### 3.2 按来源归因

| 来源 | tokens | % | 数据源 | 置信度 |
|------|--------|---|--------|--------|
| **tools[] JSON Schema** | ~28,000 | 9.4% | Proxy（名单+估算） | ⚠️ 估算 |
| **main system prompt** | 7,521 | 2.5% | Proxy（完整文本） | ✅ 精确 |
| **tool_output / Bash** | 50,265 | 16.9% | JSONL | ✅ 精确 |
| **tool_output / Read** | 28,915 | 9.7% | JSONL | ✅ 精确 |
| **tool_output / other** | 6,175 | 2.1% | JSONL | ✅ 精确 |
| **assistant_text** | 9,120 | 3.1% | JSONL | ✅ 精确 |
| **messages[] 其他** | 169,995 | 57.0% | JSONL + Proxy摘要 | ✅ 精确 |
| **skill_listing** | 1,103 | 0.4% | JSONL attachment | ✅ 精确 |
| **billing header** | 20 | <0.1% | Proxy | ✅ 精确 |
| **base identity** | 14 | <0.1% | Proxy | ✅ 精确 |
| **char/4 估算误差** | ~1,106 | 0.4% | — | 残差 |

### 3.3 Turn 382 新增内容（Δ = +141 tokens，+2 messages）

| 新增内容 | 类型 | tokens | 来源 |
|---------|------|--------|------|
| `(Bash completed with no output)` | tool_result | ~7 | JSONL user record |
| 总结文本（全部修复…） | assistant text | ~146 | JSONL assistant record |
| billing header 更新 | system[0] diff | 0（替换） | Proxy system diff |

**system diff 说明**：`block[0]` 的 `cch=` 从 2823 → 2824，是 Claude Code 的计费追踪计数器，每次 API 调用递增，**不携带语义内容**，是噪音，在 UI 中应标灰或折叠。

---

## 四、Gap 分析

### 4.1 tools[] gap 统计（119 次调用）

```
min = 24,710 tokens
max = 32,134 tokens  
avg = 28,464 tokens
std = ±1,990 tokens
```

gap 不完全稳定的原因：
1. `deferred_tools_delta` attachment 会动态增减工具（新 skill 安装时）
2. char/4 估算 vs BPE tokenization 的精度差（约 ±2k tokens）

### 4.2 tools[] 为什么之前"不可见"

`dump.py` 设计时错误地假设 tools[] 是静态的并主动丢弃。**Proxy 完整拿到了请求体**，tools[] 一直在里面。已修复：现在每个 call 记录 `tools_count`、`tools_tokens_estimate`、`tools_names`。

### 4.3 真正不可见的部分

**无**。所有 context 来源都可以通过以下方式之一获取：
- Proxy dump：system[] + tools[] 
- JSONL：messages[] 的全部内容
- 两者 usage 字段：ground truth 总量

---

## 五、数据模型：ContextProvenance

```ts
interface TurnProvenance {
  // 身份
  sessionId: string;
  turnIndex: number;          // JSONL 里的 assistant 序号
  timestamp: string;
  proxyCallIndex?: number;    // 对应 proxy dump 的 call index（可选）

  // Ground truth（来自 usage 字段）
  measuredTotal: number;
  cacheRead: number;
  cacheCreation: number;
  freshTokens: number;

  // System[] — 来自 Proxy dump（精确）
  systemBlocks: Array<{
    index: number;
    label: string;            // "billing_header" | "base_identity" | "main_system_prompt" | ...
    tokens: number;
    text: string;
    hasCache: boolean;
    changed: boolean;         // 相比上一次 call 是否变化
  }>;

  // Tools[] — 来自 Proxy dump（精确名单，估算 tokens）
  tools: {
    count: number;
    tokensEstimate: number;
    names: string[];
    changed: boolean;
  };

  // Messages[] — 来自 JSONL（精确内容）
  messages: Array<{
    role: "user" | "assistant";
    tokensEstimate: number;
    // user turn
    toolName?: string;        // 如果是 tool_result
    toolResultPreview?: string;
    humanText?: string;
    // assistant turn
    toolCalls?: string[];     // tool_use 的工具名列表
    textPreview?: string;
    hasThinking?: boolean;
  }>;

  // 动态注入 — 来自 JSONL attachment 记录
  injections: Array<{
    type: "skill_listing" | "task_reminder" | "command_permissions" | "deferred_tools" | "away_summary";
    tokensEstimate: number;
    changed: boolean;         // 相比上一次是否变化
  }>;

  // Delta（相比上一次 turn）
  delta: {
    measuredDelta: number;
    newMessages: number;      // 通常 +2（tool_result + assistant）
    systemChanged: boolean;
    toolsChanged: boolean;
    newInjections: string[];
  };
}
```

---

## 六、TurnProvenanceView UI 设计

### 6.1 布局

```
┌─────────────────────────────────────────────────────────────────┐
│  Turn 382  ·  298,234 tokens  ·  +141 Δ  ·  99.95% cached      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  SANKEY / FLOW VIEW                                              │
│                                                                   │
│  来源层                    分类层              context 占比       │
│  ─────                    ─────              ──────────         │
│                                                                   │
│  main_system_prompt ──────► System prompt ──► ████  7.5k  2.5%  │
│  billing_header ──────────►               ──► (折叠)             │
│                                                                   │
│  tools schema ────────────► Tools schema  ──► ██████ 28k   9.4% │
│                                                                   │
│  Bash ×177 ───────────────►               ──►                   │
│  Read ×18  ───────────────► Tool outputs  ──► ████████ 85k 28.5%│
│  Edit ×56  ───────────────►               ──►                   │
│  other ×...───────────────►               ──►                   │
│                                                                   │
│  assistant turns ─────────► Assistant     ──► ██ 9k     3.1%   │
│                                                                   │
│  user messages ───────────► User          ──► █ 4k      1.3%   │
│                                                                   │
│  skill_listing ───────────►               ──►                   │
│  task_reminder ───────────► Injections    ──► █ 1.1k    0.4%   │
│                                                                   │
│  [messages 其他 169k] ─────► Prior context──► █████████ 57%     │
│                                                                   │
├─────────────────────────────────────────────────────────────────┤
│  本轮新增（Δ +141 tokens）                                        │
│  ├── tool_result: "(Bash completed with no output)"  ~7 tok     │
│  └── assistant:   "全部修复。总结两个问题的根因..."   ~146 tok    │
│      system[0] billing header 更新（cch 计数器，无语义）          │
├─────────────────────────────────────────────────────────────────┤
│  缓存状态                                                         │
│  cache_read  ████████████████████████████████████████  298,092  │
│  cache_write ░  141                                              │
│  fresh       ·  1                                                │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 数据源置信度标记

| 视觉标记 | 含义 |
|---------|------|
| 实色填充 | 来自 JSONL 或 Proxy，精确值 |
| 斜线填充 | char/4 估算，误差 ±5% |
| 灰色虚线边框 | 未安装 Proxy，完全估算 |
| 🔴 红点 | 本轮新增内容 |
| 🔄 图标 | 相比上一轮有变化 |

### 6.3 交互

- **点击任意色块** → 展开该来源的详细列表（每个 tool_result 的内容预览、每个 assistant turn 的文本）
- **点击 tool 名称** → 跳转到 Timeline / Span Tree 中对应的 tool_call span
- **hover 桑基流线** → 显示该段 prompt 的完整文本（system prompt 块、skill 内容等）
- **"仅看新增"开关** → 折叠 prior context，只展示本轮 Δ

### 6.4 与现有视图的联动

```
Context Timeline（已有）
  ↕ 双向：点击 turn → TurnProvenanceView 展开详情
  ↕ 双向：TurnProvenanceView 里点 tool → Span Tree 高亮

TurnProvenanceView（新增）
  → 独立面板，可作为 Context tab 的子视图
  → 点击 turn bar 时从右侧滑入
```

---

## 七、实现路线

### Step 1：数据层（server）
- `GET /api/sessions/:id/provenance/:turnIndex`
- 合并三个来源：JSONL 重建 + Proxy dump（如存在）+ 静态 tools schema 估算
- 返回 `TurnProvenance` 对象

### Step 2：前端组件
- `client/src/components/ContextTimeline/TurnProvenanceView.tsx`
- 输入：`TurnProvenance`
- 输出：桑基图 + Delta 面板 + 缓存状态条

### Step 3：联动
- `SessionDetail` 共享 `selectedTurnIndex` state
- Context Timeline 点击 turn → 触发 TurnProvenanceView 展开

### Step 4：Proxy 数据集成（增强模式）
- 当 `proxy-dumps/<session-id>` 存在时，用 proxy 数据替换估算值
- system[] 精确文本可展示；tools[] 名单可精确列出

---

## 八、当前已实现 vs 待实现

| 功能 | 状态 |
|------|------|
| JSONL tool_output 按工具名细分 | ✅ context.ts `toolOutputByTool` |
| system_overhead 灰色区域 | ✅ StackedAreaChart |
| attachment 注入（skill/task/permissions）| ✅ context.ts |
| Proxy dump system[] 捕获 | ✅ dump.py |
| Proxy dump tools[] 捕获 | ✅ 刚修复 |
| process_session_id 关联 | ✅ dump.py + meta.json |
| proxy restart 不覆盖 call 文件 | ✅ call_index 从磁盘恢复 |
| TurnProvenance API | ❌ 待实现 |
| TurnProvenanceView 组件 | ❌ 待实现 |
| 桑基图渲染 | ❌ 待实现 |
| Context Timeline ↔ TurnProvenance 联动 | ❌ 待实现 |
