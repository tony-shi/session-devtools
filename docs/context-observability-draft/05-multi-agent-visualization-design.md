# 多 agent 执行域可视化 —— 设计决策记录

> 状态：2026-06-11。Workflow 可视化（后端 + 前端 B 案）已落地；Teams 部分为预研设计，
> 本机无任何真值样本（~/.claude/teams 为空目录），所有 Teams 结论在拿到第一份真实工件前
> 均视为假设。本文记录已确立的设计原则与取舍过程，供后续模式（Teams 等）适配时复用，
> 避免重新发明或偏离已拍板的方向。

## 1. 对象：三种多 agent 模式的谱系

Claude Code 的多 agent 执行有三种形态，差异的本质在**控制结构**这一根轴上：

| | Task subagent | Workflow | Teams |
|---|---|---|---|
| 控制结构 | 单次同步调用 | 脚本编排的 DAG（拓扑先验存在于脚本） | 自主通信（拓扑事后涌现，无先验） |
| 成员寿命 | 一次性 | 一次性（resume 是前缀回放 + 续跑，非续命） | 长寿命，可被 SendMessage 续聊 |
| 结果通道 | 内联 tool_result（富对象含 agentId/usage） | async 回执 + 工件（wf json / journal / agent 转录） | 持续消息流 + 共享任务板（推断） |
| 转录位置 | `subagents/agent-<id>.jsonl` 平铺 | `subagents/workflows/<runId>/agent-<id>.jsonl` | 未知 |
| 回链键 | meta.toolUseId（≥2.1.144；旧版 (promptId,prompt) 匹配） | runId 三处互锁 + journal agentId | 未知 |
| 自然可视化 | 一条 fork-join 边 | phase 甘特 / 拓扑 | 通信时序 + 任务板 |

关键认知：**workflow 的拓扑是"写在脚本里的承诺"，teams 的拓扑是"消息流里涌现的事实"。**
前者适合甘特（对照计划与执行），后者只能从消息序列重建。Task 是两者的退化形态（单边）。

统一抽象：**执行域（execution domain）**。三种模式共享同一外壳——
主时间线的锚点卡（发起处）+ 域面板（成员列表 + 域特定可视化）+ 成员转录下钻
（SubAgentSessionPanel 三模式通吃，已被 workflow 适配验证）。域面板的中间区是唯一
按模式分化的件：Task 无（直接进转录）、Workflow 是甘特 + Script/Result、Teams 是
通信时序 + 任务板。

## 2. 已拍板的设计原则

以下原则在 workflow 适配过程中由维护者明确拍板，对后续模式同样生效：

1. **只渲染完结态。** 不追实时性，换稳定性与正确性。Workflow 的完结判据 = wf json
   存在（终止时一次性写出）；进行中的 run 不可见。Teams 适配时需要先找到等价的
   "完结性锚点"再动手。
2. **正确性第一，简洁性第二；不确定的 case 明确不支持，不伪造、不兜底。**
   让问题直接暴露。落地形态：显式"不支持"文案（多次执行的甘特）、显式禁用态
   （无转录的 agent 行）、显式"锚点未找到"（launch 反查失败）。
3. **坏链用显式错误面板，不静默回退。** 旧惯例（subagent 坏链静默退 session 总览）
   被判定为坏策略；workflow-run 的坏 runId 渲染 WorkflowRunNotFoundPanel（列出已知
   runId + 成因说明）。后续新增导航层级沿用此惯例。
4. **按真实物理序呈现，不重排。** 主时间线严格按主 JSONL 行序；异步事件（launch、
   回执）在其真实物理位置渲染，靠跳链表达逻辑关联，不把 agent 内容内联进主时间线。
5. **旁路模块 + 最小侵入。** 新能力做成平行件（新目录 / 新 nav 层级 / 特化分支），
   核心解析与主干组件零结构改动。诚实区分抽象与 glue。
6. **只用确定性键，禁用启发式匹配。** runId / taskId / agentId / toolUseId /
   request-id 是强键；promptId 在 workflow 下是 run 级键（同 run 全 agent 同值），
   做 agent 级匹配会静默错配，已显式禁用。时间窗匹配仅作为 cached agent 归属的
   辅助（cached=false 走确定性"末次执行"规则）。
7. **口径必须分开标注。** wf json 的 durationMs/totalTokens/taskId 是"末次物理执行"
   口径，agentCount/workflowProgress 是"逻辑 run"口径（含 cached 回放）——并排展示
   不标注会自相矛盾。
8. **纯文字不用 emoji；展示元数据走后端 corpus，不前端硬编码。**

## 3. 信息架构：git 隐喻的取舍（grill 结论）

维护者最初构思"git fork-merge 树"。逐点评估后的结论：**骨架采纳，落点收缩**——

- 成立：workflow 在数据层确实是 fork-join（launch = fork，notification = join 信号，
  主干独立推进）。
- 失真一：分支粒度必须是 **run 不是 agent**（agent 多而短，5~19 个，19 条 lane 不可读；
  git graph 的可读性建立在分支少而长上）。agent 拓扑放 run 面板内部。
- 失真二：**join 是"回执"不是"merge"**。notification 只是截断句柄；真实内容并入是
  主 agent 事后选择性读取（实测 bd5d3dd7：DOC+verify 进了主上下文，recon 段 58% 从未
  进入）。画成 merge 会误导 token 对账直觉。回执点与"内容并入"要分开标注。
- 失真三：resume 没有 git 隐喻（不是 rebase 不是新分支），表达为同一 run 节点的
  多个 launch 边 + 徽章。
- 幸运点：launch / 回执在主 JSONL 有真实物理位置，fork/join 点天然落在物理序上，
  与原则 4 不冲突。
- 前瞻：teams 的自主通信是**图**不是树，git 隐喻到 teams 会塌——不要把"分支"做成
  跨模式统一抽象。

落地路径：**B 案（纯旁路 run 域，已落地）→ A 案（左导航 turn 列表旁的 branch
gutter，run = branch，未做）**。gutter 画在 turn 列表旁（即 IDE commit list 旁
git graph 列的形态），fork/join 粒度天然是 turn 级；多 run 并行 = 多列 lane，
join 后释放列位，超阈值折叠 "+N"。C 案（独立 graph canvas 全景图）被否：新交互
范式、与 turn 导航重复、违背"核心结构不大动"。

层级结论：run 面板插入后比 Task 型多一层，可接受（run 面板自身是平铺单页）；
真正的堆叠感来自继承的 subagent session-in-session 视图在单 turn 转录下的退化
内层导航——缓解方向是"agent 转录仅 1 turn 时折叠内层 turn 导航"（对 Task /
workflow 同时生效，已立项未做）。

## 4. 已落地的 Workflow UI 形态（2026-06-11）

- 左导航：turns 列表底部独立 `WORKFLOWS (N)` 小节（拍板：不占 tab 位；未来整体
  位置可微调）。
- 导航：`workflow/:runId` URL 层级；agent 下钻复用 `subagent/:agentFileId` 三级，
  复合 id `<runId>__<agentId>`（Nest 路由参数不能含斜杠）。
- run 面板四 tab：Agents（phase 分组 + cached/live 状态点 + 转录统计 + 下钻）/
  甘特（CSS 条、真实墙钟、phase 同色、cached 半透明）/ 脚本（懒加载端点 + args
  JSON 块 + CodeBlock 全文）/ 结果（per-agent journal result，JSON 美化或
  markdown 渲染）。
- 主时间线两张卡：launch 特化卡（ToolCallRow 第三个特化分支，先例 Skill/Bash；
  run 摘要 + run 面板/回执 chips；未完结 run 中性标注）；AsyncReceiptNode 替换
  notification turn 的 USER INPUT 节点（紫系回执卡 + 回 launch / run 面板跳链 +
  原文折叠；对 background Agent 回执天然兼容——锚到 Agent tool_use，无 run chip）。
- 色彩域：sub-agent 紫系（Agent #a855f7），Workflow 加深（#7e22ce），回执节点同
  紫系淡化——同域不同件。
- 关键文件：`client/src/v2/session-detail/workflow/`（WorkflowRunPanel / PhaseGantt /
  runJoin 纯函数）、session-nav.ts、SessionNavRail.tsx、call-chain-rows.tsx、
  server/src/workflow-runs.ts（旁路读取）、session-drilldown-parser.ts（workflow
  agent 平铺 + launch 锚 + turn openerSource）。

## 5. 数据契约要点（前端消费视角）

- 三层数据：主 session JSONL（句柄 + 回执）/ session 目录 workflow 工件（真值核心：
  wf json + journal + agent 转录）/ proxy traffic（请求原文，request-id 1:1 join）。
- resume 语义：runId = 逻辑 run，taskId = 一次物理执行；wf json 被末次执行整体覆盖
  （last-write-wins）；回放是"最长不变前缀"，断点之后全部实跑（含作废旧成功）。
  **查看已完结 run 不需要 resume——工件全在盘上。** 实际触发场景几乎都是中断恢复
  （限流/进程死），"改脚本再跑"理论存在但少见。**全缓存 resume**（未改脚本、上次
  全成功）的行为：脚本 JS 重新执行、全部 agent() 瞬时命中缓存，零新 agent 工件
  （无新转录/journal 行，实测），但 return 值重新组装、wf json 被覆盖（新 taskId、
  durationMs 秒级、totalTokens 推断≈0）、notification 照常发——"有结果、零新执行"。
- **attempt 槽位模型（2026-06-11 定为方向）**：journal key（链式哈希）是"agent()
  调用槽位"的跨执行稳定身份；同 key 的多个 started 行 = 同一槽位的多次尝试
  （attempt 链，物理行序即时间序），每次尝试一个 agentId、一份转录；最终
  workflowProgress 引用的 agentId = 胜出 attempt，其余即 superseded。UI 终态：
  agent 行可展开尝试历史（"尝试 1：上一轮失败 → 尝试 2：本轮成功"，各自转录可下钻），
  superseded 不再是游离计数而是各槽位的 attempt 历史——语义即"成本的一部分，体现
  脚本可重入"。需要后端下发 journal 的 key→agentId 序列。
- superseded 转录：目录里存在、但不被最终 workflowProgress 引用的转录。只有两种
  来源，全是 resume 副产品：上一轮失败的（journal 有 started 无 result）、被前缀
  规则作废重跑的旧成功。单次执行恒为 0。归宿见 attempt 槽位模型。
- 结果格式无统一形状：带 schema 的 agent 返回脚本作者现场定义的任意 JSON，无 schema
  返回纯文本（`findings` 等字段名只是某些脚本的选择，不是系统约定）。
- 脚本诞生：inline 调用的脚本是 launch 那次 LLM call 的输出（input.script 在该
  assistant 消息的 tool_use 块里）——provenance 可经 launches[0] 锚点确定性跳转。
  例外：scriptPath（来自文件）、resume（诞生于第一次 launch）。
- 结果收束是**脚本确定性控制**的（await agent() → 变量 → 代码组装），主循环 LLM
  只感知截断通知 + 自己主动读取的部分。"注入"有两个位置，性质不同：
  - workflow 内 agent→agent：注入本身 100% 确定（脚本 JSON.stringify 内联进下游
    prompt）。事后查看者没有脚本执行 trace，验证手段是文本包含检查——但因注入逐
    字节，**命中即 100% 确定，是确定性验证而非概率归因**；脚本若加工过（slice/
    摘要）则验证不命中，如实显示"无法确认数据流"，不猜。
  - 回流主线：两个环节要分清。notification 的截断是 **CC 代码确定性行为**（约 8k
    字符预览 + truncated 标注），不涉及 LLM、无需判断；其后主 agent 自己决定用
    Bash 读 wf json / tmp 文件，读取常带 jq/python/head 加工（LLM 自由行为），
    所以"主线 tool_result ↔ journal result"只能事后部分验证，须标可信度。
  - message 级 come-from link（call 里某段内容标注"来自 run X 的 agent Y"）：
    需要给 LLM call 消息加跨域 provenance 状态、动归因主干——**hold**，远期方向。

## 6. 明确不支持清单（含理由）

| 项 | 理由 |
|---|---|
| 进行中 run | 无 wf json，完结性原则 |
| superseded 转录下钻 | 后端不下发条目（只计数）；归宿是 attempt 槽位模型（§5），后端先行 |
| 调用形态徽章（inline/scriptPath/named 区分） | 后端未暴露 tool_use input 形态 |
| Monitor 型回执跳链 | 通知无 <tool-use-id>，显式标注"无回链锚点" |
| run 级 result 展示 | 后端未暴露 wf json result 字段；per-agent journal result 已覆盖主要场景 |
| 脚本语义分类（调研型/对抗型） | 只能靠猜 phase 名/关键词；结构事实（phase 数/并行度）可展示，语义标签不做 |
| message 级 come-from link | 动 LLM call 归因主干，hold（§5） |

已撤销的"不支持"（2026-06-11 修订）：
- ~~多次执行 run 的甘特~~：维护者裁定"gap 本身就是事实，相隔甚远本身就反映问题"——
  改为**全量 agent 按真实墙钟忠实绘制**，跨执行 gap 如实呈现，超阈值 gap 用断轴
  压缩并标注时长（断轴是标准手法，非篡改）。曾先后考虑"整体禁用"与"只画末次执行"，
  均被否——两者都在替用户掩盖事实。
- ~~schema-aware 结果渲染做不了~~：措辞过于绝对。两条可行路径：(a) 脚本静态提取
  （schema 通常是顶层 const 纯字面量，可"字面量提取、非字面量退化"，任意 JS 不保证）；
  (b) **proxy dump 真值**——agent 请求的 tools[] 含发送到 API 的完整 StructuredOutput
  schema，requestId join 已通，逐字节确定。(b) 更干净。收益主要是 description 当
  字段 label，优先级低，挂远期。

## 7. Teams 设计（2026-06-12 真值已采集——本节预研假设已被首跑样本大幅修正，
## 修正后的结论见 §7.5；完整解剖在 tmp/teams-truth/ 与 memory
## project_agent_teams_groundtruth）

### 7.5 首跑真值后的修正结论（覆盖本节其余预研内容）

**三条被推翻/大幅修正的预判**：
1. ~~"teammate 需要 SubAgentSessionPanel 式 session-in-session 下钻 + episode
   分段导航"~~ → teammate 是 `projects/{slug}/{uuid}.jsonl` **平级完整 session**
   （isSidechain=false，每行带 agentName+teamName），**已被 sync-v2 自动入库**
   （llm_call_count/嵌套 subagent 计数全正确）——现有 session 视图全部直接可用，
   teams 的 UI 成本远低于 workflow。episode 难点不存在（就是普通 turns）。
2. ~~"完结性锚点比预想棘手、事后查看数据源堪忧"~~ → 编排层（config/任务板/
   inboxes）确实易失（cleanup 删；任务板更是**全部完成时就自动 compact**，早于
   cleanup），但**转录层完整且持久**：消息双侧留痕（发送 = SendMessage tool_use，
   接收 = `<teammate-message>` user 行）、spawn prompt 就是 teammate 转录首行、
   idle/shutdown 结构化 JSON 在 lead 转录。事后重建能力远好于预期。
3. ~~"proxy 归属待验证"~~ → teammate 请求带**自己的** session_id（实测 135/63/144
   条各归各）——与 workflow agent 复用父 session 相反，无幽灵流量问题；team 级
   token 聚合是跨 session 求和。

**attribution 输入的确定性键**：行级 `teamName`（lead+teammate 都有）+
`agentName`（仅 teammate）是发现/归组强键；消息配对键 =（teammate_id, summary,
正文逐字）；任务板终态不可得但 TaskCreate/TaskUpdate 的 tool_use 在转录里可重放
事件流（待逐行验证）。

**已知的确定性坑**：入站 `<teammate-message>` user 行**没有 origin.kind /
promptSource / isMeta**（不同于 task-notification）——isHumanInput 现状把它们
全数误判为人类输入（实测 teammate 会话 human_input_count=6/8/10 全是消息）；
修法与 v15 notification 同构：teamName 字段 + 内容前缀判别，openerSource 加
"teammate-message" 第三枚举。SendMessage 回执行（带 toolUseResult）已被
tool_result 排除逻辑天然处理。

**teams 域 UI 形态修正**：不是 session-in-session，而是 **session 分组 + 关联层**
——team 总览（成员列表从 agentName 扫描重建、消息时序图从双侧转录重建、任务板
显式标注"终态已 compact，仅事件流/快照"）+ 成员行直接跳转既有 session 视图。
纵向时序图与任务板侧栏的设计意图保留，数据源全部换为转录重建。

**2026-06-12 已落地（后端 B1-B3 + 前端 T1-T3）**：
- B1 meta：team_name/team_agent_name 列（PARSER_VERSION 16；agentName 只认与
  teamName 同行——type:"agent-name" 会话命名事件误标坑已修；human_input_count
  排除入站消息 + 顺带修存量 compact summary 误计）。
- B2 turn 切分：openerSource "teammate-message" + openerTeammateId；mid-turn
  入站消息不进 midTurnInjections；user:teammate-message 事件 kind（青系域色）。
- B3 GET /sessions/:id/team（team-domain.ts 旁路）：成员发现按 meta 列；时间线 =
  发送侧 SendMessage tool_use + teammate 首行 spawn + lead 接收侧结构化 idle
  JSON；接收侧普通文本为发送侧冗余跳过。**真值修正：shutdown_approved/
  teammate_terminated 在 lead JSONL 无落盘留痕**（早前记录基于运行时/inboxes
  观察），解析器保留形态支持、实测 0 条。
- T1-T3 前端：左导航 TEAM 小节（WORKFLOWS 之上，成员行跨 session 跳转）+
  navLevel="team"（URL /team，非 team 深链显式 TeamNotFoundPanel）+
  TeamOverviewPanel（成员条 + 两条显式不支持文案）+ TeamSequenceChart（纵向
  lifeline 时序图，完整样式不简化：spawn/message/shutdown_request 箭头、idle
  空心虚线、行点击展开全文 + 打开留痕会话、idle 可折叠）+ TeammateMessageNode
  opener 节点（青系，替换 USER INPUT，跳 team 总览）。
- 验证：契约测试 team-domain.test.ts 4 条（258 全过）；wf-review 实跑冒烟——
  4 成员角色正确、49 事件、teammate 7 turns 全部 teammate-message opener、
  human openers=0、列表 team 字段、非 team 404。

——以下为原预研内容（部分已被上述修正覆盖，保留作决策过程记录）——

## 7.x Teams 预研设计（首跑前的假设，历史记录）

已确认的机制事实（2026-06-12 更新：来自官方文档 code.claude.com/docs/en/agent-teams，
仍非本地工件）：lead + teammates（每个是完整独立 Claude Code session，载入项目
CLAUDE.md/MCP/skills，不继承 lead 对话史）；成员间 SendMessage 直接通信（自动投递，
不轮询；这是与 subagent 的本质差异）；共享任务板（pending/in-progress/completed +
依赖，文件锁防认领竞争）；plan approval 门控（teammate 只读规划→lead 审批）；
TeammateIdle/TaskCreated/TaskCompleted 三个 hook；实验性 flag
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS，要求 ≥2.1.32；单 lead 单 team、不可嵌套、
lead 不可转移。

**对 dashboard 的关键发现（官方原文）**：`~/.claude/teams/{name}/config.json` 与
`~/.claude/tasks/{name}/` **只在 team 活跃期间存在——cleanup 或 session 结束即删除**。
即 teams 没有 workflow 的 "wf json 落盘即完结" 等价物，config/任务板是**易失工件**。
事后查看的数据源只能寄望于：lead 与各 teammate 的 session JSONL（teammate 是完整
session，理应落 ~/.claude/projects/，待验证）、SendMessage 在双方转录里的留痕形态
（待验证）、以及 proxy dump（持久）。这把"先跑样本解剖"从建议升级为硬前提——
且解剖时要在 cleanup 前抓 teams/tasks 目录快照。

设计假设（按执行域抽象展开）：

1. **完结性锚点待定且比预想更棘手**：官方确认运行态工件易失（上段）。适配第一步
   是跑真实样本确认：teammate 转录的落盘位置与持久性、消息留痕、cleanup 后还剩
   什么，之后才谈 UI。
2. **主视图：纵向时序图**（经典 sequence diagram 形态——参与者为顶部列头/lifeline
   竖线，时间向下流，消息为列间横向箭头）。与 turn 时间线的纵向同构。理由：我们是
   事后查看器，运行结束时通信拓扑已锁死，可离线算最优布局（边聚合 m1→m2 ×5、阶段
   折叠、密集段降采样）。横向泳道被否（与全站纵向时间轴冲突）。
3. **任务板侧栏**随滚动位置同步状态快照；**群聊转录 tab** 作为细读视图（消息按
   时间交错，本质上 teams 转录就是一场群聊回放）。
4. **成员下钻复用 SubAgentSessionPanel**，但有真实新难度：成员长寿命 + 续聊意味着
   转录可能多段 episode，现面板假设一段式转录——需要 episode 分段导航。这比通信图
   更难，是 teams 相对 workflow 的本质增量。
5. 锚点卡 / 回执节点 / 显式错误面板 / 确定性键等原则直接沿用。

## 8. 终态信息架构草图（2026-06-11 对齐）

合并解决两个问题：**入口缺失**（原来进 agent 必须 turn → call → sub-agent 块三跳）
+ **堆叠感**（agent 下钻的 session-in-session 内层导航在单 turn 转录下纯冗余）。

```
左导航 (200px)                          主画布：agent 下钻（单 turn 扁平化）
────────────────────────────           ─────────────────────────────────────────
 Overview                               ◀ wf_ca00a61b run 面板   ◀ Turn 2 (launch)
 [用户轮次 4] [后台请求 7]              ─────────────────────────────────────────
 Turn 1      │                          recon:frontend  Explore  [Recon]  ● live
 Turn 2     ●┐ ←launch                    9 calls · 16 tools · 130s · 峰值 86.9k
 Turn 3      ◇ ←回执                    ─────────────────────────────────────────
 Turn 4      │                          PROMPT（首条 user，折叠预览 3 行）
 ────────────┤                          [Call #1] 24.1k · 3 tools
 WORKFLOWS (1)                            └ Tool Use: Read / Grep …
  ▾ wf_ca00a61b   completed · 5         [Call #2] …
      recon:frontend     86.9k          …
      recon:ingest       51.0k          [Call #9]
      recon:groundtruth  32.0k          FINAL: StructuredOutput（JSON 树）
      synthesize:doc     42.8k          ─────────────────────────────────────────
      verify:doc         60.0k         （单 turn：无内层 200px 导航、无 turn 层；
 SUBAGENTS (2)                           多 turn agent 保留 session-in-session）
   Explore · 调研 X
   general-purpose · 跑 Y
```

要点：
1. **WORKFLOWS run 条目可展开 agent 子行**——交互与"turn 展开 call"同构（复用
   NavItem indent 模式），agent 子行一跳直达下钻；run 行点击进 run 面板。
2. **SUBAGENTS 小节**列 Task 型（含 background Agent），label 用 description——
   Task 型 agent 第一次有 session 级直接入口。
3. **单 turn 扁平化**：agent 转录仅 1 turn 时（workflow agent 几乎总是），去掉
   内层 nav rail 与 turn 层，header 压成一行身份条（label/agentType/phase/状态点）
   + 一行统计，主画布直接 call 链。多 turn 保留现状。数据无损，纯展示降维。
4. **面包屑双父级**：workflow agent 同时给"所属 run 面板"与"launch 所在 turn"
   两个返回路径；attempt 槽位模型落地后此处加尝试切换。
5. 左侧 ●/◇ 为 A 案 gutter 的 lane 示意，与本草图兼容、分期落地。

## 9. 待办与远期方向

近期小改（已与维护者对齐方向；2026-06-11 修订）：
- A. 甘特改"忠实墙钟全量绘制"——全部 agent（含 cached）按真实墙钟画，跨执行 gap
  如实呈现，超阈值 gap 断轴压缩并标注时长。（推翻早先"只画末次执行"方案）
- B. Script tab 加"诞生于 Turn N · Call M"跳链（scriptPath/resume 例外如实标注）
- C. superseded 收纳进 resume 徽章详情（过渡态；终态归宿是 K 的槽位模型）
- D. 结果字段级渲染启发式（顶层超长 string 字段单独 markdown 折叠块——按值类型
  分流，不猜语义）

立项另排：
- ~~E. 终态信息架构落地~~（2026-06-11 已落地：SUBAGENTS 小节 + WORKFLOWS 选中态
  展开 agent 子行 + 单 turn 扁平化（去内层 nav，turn crumb 隐去、call crumb 保留）
  + 双父级面包屑（run 面板紫系按钮在前、launch turn 在后）。URL/路由零改动，
  纯展示降维。）
- ~~F. workflow 内 agent→agent 数据流验证~~（2026-06-12 已落地：GET workflows/
  :runId/dataflow——journal result ⊆ 下游 prompt 逐字节包含 + journal 行序因果
  约束（result 行 < started 行）+ <100 字符跳过防误命中；run 面板"数据流" tab。
  bd5d3dd7 实测完整还原菱形拓扑（3 recon → synthesize → verify 四条边全确认）。）
- ~~G. 结果回流主线的标注~~（2026-06-12 已落地：同 dataflow 端点的 mainline 段——
  exact（result 全文在主线 tool_result）/ field（顶层 string 字段全文，覆盖 jq
  提取场景）两级置信，前缀/模糊匹配不做；前端跳链经 intervalEvents.lineIdx 反查
  call。bd5d3dd7 实测：DOC 全文回流 #91 exact、verify 以 verdict 字段回流 #87、
  recon 三份确认从未回流——与当初"58% 未进主上下文"的手工调研逐项吻合。）
- ~~H. A 案 rail gutter~~（2026-06-12 已落地：gutterLanes.ts 纯函数（fork=launch
  anchor turn ●，join=openerToolUseId 回执 turn ◇，贪心列分配、span 结束释放、
  同 turn 边界不复用）+ GutterCell 每行渲染 lane 段（行高可变不断线）+
  SessionNavRail turn/call/compact 三类行包裹。无 workflow session 零渲染。
  数据边界如实：失锚 launch 不产 fork、mid-turn 回执无结构化锚不画 join、
  fork/join 同 turn 时 fork 优先。实测 3915787e 4 串行 run 复用单列、合成并行
  场景 2 列正确。"+N 折叠"未做（实际并发 ≤2，YAGNI）。）
- ~~I. 归因层补规则~~（2026-06-12 已落地，四条新规则 + 一处管线修复：
  system-prompt-workflow-subagent-v1（sys[2] 1552B 静态前缀 prefix 锚，跨项目/
  跨 2.1.167-168 验证；slotId 绑 prompt-body 壳 slot + priority 10 先于壳）、
  system-prompt-task-agent-v1（general-purpose 2205B；Explore 等其他 type 待样本）、
  tool-structuredoutput-v1（desc 178B session-static；input_schema 动态不入 pattern）、
  tool-workflow-v2（2.1.170 全文 18519 chars；2.1.158→170 六处语义变更含触发词
  workflow→ultracode；首变版本无样本，minCcVersion 保守钉 2.1.170，v1 不加上界）；
  tool-agent-v2 重钉 verifiedFor 2.1.170（逐字节一致）。**顺手修复存量管线 bug**：
  matcher 把 tools 节点 rawText 改为完整 tool JSON 后，evaluator 仍拿 pattern 与
  整个 JSON exact 比对 → 全部 corpus tool 规则静默退 wire 兜底；修复 = tools_schema
  规则在 tools.builtin.* 节点以 parse 出的 description 为匹配域，matchedRange 映射
  回 JSON 转义字面区间（部分覆盖诚实表达）。契约测试 subagent-system-prompt.test.ts
  （真实 proxy 快照 fixture）+ 版本路由验证（158→v1 / 170→v2 / 跨版本→wire）。）
- ~~J. 全局 exception filter~~（2026-06-12 已落地：status-error.filter.ts 全局
  @Catch()——HttpException 沿用自带码、{status} 标注映射 4xx/5xx、其余 500 并留
  message；实测 subagent/run 404、白名单 400、正常 200 全对。）
- ~~K. attempt 槽位模型~~（2026-06-11 已落地：server readJournal 解析 started 序列
  → WorkflowRunAgent.attempts（仅多尝试下发）；AgentsTab "尝试 ×N" 展开历史，
  三态 chip（失败/中断、成功但被作废、胜出），非胜出转录可下钻（subAgentByFileId
  注册 stub 使深链可达）。真实对账：c3cb152e 9 槽位双尝试且 C11/C12 正确判"作废"，
  69e7b62f 3 槽位各 7 尝试、superseded 18=3×6 闭合。superseded 计数与 resume chip
  的"残留 N"保留为聚合入口（C 的过渡态），槽位历史是明细视图。）
- ~~L. schema-aware 结果渲染~~（2026-06-12 已落地：GET /sessions/:id/workflows/
  :runId/schemas —— per-agent 转录任一 requestId → proxy join → reqBody.tools
  [StructuredOutput].input_schema（发送到 API 的逐字节真值）；取不到显式 reason
  （no-request / proxy-missing / no-structured-output），不伪造。前端 Result tab
  懒加载，长字段标题旁灰字 schema description；加载失败一行说明不阻塞内容。
  实测 bd5d3dd7：3 recon + verify 取回 schema 与字段 description，synthesize
  正确 null reason=no-structured-output。）
- M. message 级 come-from link（§5，hold——动 LLM call 归因主干）

## 10. 决策日志

| 决策 | 结论 | 备注 |
|---|---|---|
| git 树隐喻 | 骨架采纳、粒度收缩到 run、gutter 落位 turn 列表 | grill 过程见第 3 节 |
| B→A 渐进 vs 直接 A | B 先落地，gutter 后置 | A 包含 B，面板原样复用 |
| 左导航位置 | turns 列表底部独立小节，不占 tab 位 | 未来整体位置可微调 |
| 坏链处理 | 显式错误面板，废弃静默回退惯例 | 适用后续全部新导航层级 |
| resume 的 UI 权重 | 降级：徽章 + launches 跳链 + agent 状态点 | "对查看视角不重要"；attempt 维度由 K 槽位模型承接 |
| 回执 turn 切分 | 保留切分（否则后续 call 孤儿化），openerSource 换语义 | 服务端 v15 |
| teams 通信视图 | 纵向时序图为主、群聊为辅；事后确定性布局可行 | 横向泳道被否 |
| 多次执行甘特（2026-06-11） | 忠实墙钟全量绘制，gap 如实呈现 + 断轴标注 | "gap 本身就是事实"；推翻"禁用"与"只画末次"两版 |
| superseded 语义（2026-06-11） | 接受为"成本的一部分，体现脚本可重入"；终态消解进 attempt 槽位 | journal key = 槽位身份 |
| schema 渲染（2026-06-11） | 从"不支持"改判"可做、低优先"（proxy tools[] 真值路径） | 维护者纠正"做不了"的绝对表述 |
| 数据流"匹配"措辞（2026-06-11） | 是确定性验证非概率归因（注入逐字节，命中即 100%） | 不命中=脚本加工过，如实显示 |
| message 级 come-from（2026-06-11） | hold | 动 LLM call 归因主干 |
