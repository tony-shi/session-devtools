# Walkthrough(教学视频画板)

`/demo/:storyId` 上的全屏「视频播放」式教学画板:复用真实会话数据,按"幕(act)"
逐步演示 Claude Code 的 agent loop。本机录制用,主导航无入口。

**仅 dev 可达**:`App.tsx` 用 `import.meta.env.DEV` + `lazy()` 门控,生产构建里这段是
死分支,动态 import 被剥离 → npm 包 / 线上 app **完全不含 walkthrough**。代码照常进 git。

## 整体流程

```
App.tsx  ──route /demo/:storyId──▶  DemoStage
                                       │
   ┌───────────────────────────────────┼───────────────────────────────────┐
   │ 1. 取 story                         │ STORIES[storyId]  (stories/agent-loop.ts)
   │ 2. 解析每一幕的数据(启动时一次性)    │ resolveForAct(act) 按 STAGE_CONFIG(config.ts)
   │      sessionId→drilldown→turn→call  │ 结果存 byAct,drilldown 按 sessionId 缓存
   │ 3. 步进 + 键盘                       │ useWalkthrough(步索引) + keydown
   │      ← / →  切幕                     │
   │      Space  播放/暂停(playing)       │
   │      R      重播(restartNonce)       │
   │      Esc    退出                     │
   │ 4. 渲染当前幕                        │ ActContent(act) → 对应 view
   │ 5. 字幕带                            │ NarrationBox 播 step.lines(逐行打字+上滚)
   └─────────────────────────────────────┴───────────────────────────────────┘

ActContent 按 act 分发:
  conversation → ConversationView(turns)        第一幕:多轮对话(打字→Markdown)
  turn-io      → AgentLoopView(turn)             第二幕:Agent loop 链(复用真实行)
  llm-call     → LlmCallDetailPanel(call)        第三幕:真实 call 详情面板
```

布局:全屏 `fixed inset:0` = `[内容区 flex:1]` + `[底部字幕带]`,内容不进字幕带。
`playing` / `restartNonce` 由 DemoStage 键盘统一驱动,作为 props 传给前两幕的 view。

## 文件职责

| 文件 | 作用 |
|---|---|
| `config.ts` | **`STAGE_CONFIG`**:每一幕用哪条 session / 哪个 turn / 哪次 call(留空=自动) |
| `types.ts` | `ActId` / `Step`(act + 字幕 `lines`)/ `Story` |
| `stories/agent-loop.ts` | 具体 story:每幕的 `act` + **字幕脚本 `lines`**,以及 `STORIES` 注册表 |
| `useWalkthrough.ts` | 纯步进状态机(index / next / prev) |
| `DemoStage.tsx` | 编排器:数据解析 + 键盘 + 全屏布局 + 字幕 `NarrationBox` + 分发到各幕 |
| `views/ConversationView.tsx` | 第一幕:对话播放(左右气泡 + 思考 + 打字机,打完转 Markdown) |
| `views/AgentLoopView.tsx` | 第二幕:纵向 agent-loop 链(请求/结果/批准/执行 + 左缘 actor 轨,复用 `ToolCallRow`/`ChainNarrativeNode`) |
| (第三幕) | 直接复用 `../session-detail/call/LlmCallDetailPanel` |

## 改 X 去哪改

- **换某幕的会话 / turn / call** → `config.ts` 的 `STAGE_CONFIG`(`stage: { sessionId, turnId?, callId? }`)。
- **改字幕文案 / 行数** → `stories/agent-loop.ts` 各幕的 `lines`。
- **改节奏** → 顶部常量:
  - 字幕每行停顿:`DemoStage.tsx` 的 `LINE_HOLD_MS`
  - 第一幕打字/思考/轮停:`ConversationView.tsx` 的 `USER_HOLD` / `THINK_MS` / `TYPE_TICK` / `CHARS_PER_TICK` / `DONE_HOLD` / `MAX_ASSISTANT`
  - 第二幕节点揭示/展开轮数:`AgentLoopView.tsx` 的 `STEP_MS` / `MAX_CALLS`
- **改键位** → `DemoStage.tsx` 里的 `keydown` 处理。
- **加新一幕** → `types.ts` 加 `ActId` → 写新 view → `ActContent` 里分发 → story 里用。
- **加新 story** → 新建 `stories/xxx.ts`,加进 `STORIES`,访问 `/demo/xxx`。

## 与真实组件的关系

真实 UI 当"不可变舞台":只复用其**叶子组件**(`ToolCallRow` / `ChainNarrativeNode` /
`LlmCallDetailPanel`),布局自己编排;对核心的侵入仅 App.tsx 一行路由。
`useAttributionGraph` 无 provider 时返回默认值(不抛),故复用的行天然关掉跳转/高亮链接 chrome。
