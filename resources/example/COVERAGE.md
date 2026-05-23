# Session-Dashboard · 挖掘地图

> **本文件 = 挖掘路线图**。逐文档精读档案在 [`COVERAGE-DETAILED.md`](COVERAGE-DETAILED.md)（按官方 sitemap 章节，仅供查阅）。

## 0 · 项目定位再校准（"harness 故事"方法论）

**session-dashboard 的核心差异化不是"教学 Claude Code"，是"挖掘 harness 演化、文档没写的真相"。**

### 三层定位

| 层 | 角色 | 谁能拥有 |
|----|------|---------|
| **文档** | 公开知识 | 所有人，没差异化 |
| **源码** | 机制线索 / 假设池 | **版本快照、是历史**；最新版可能已变 |
| **proxy + jsonl** | 当下真相 / 演化证据 | **只有 session-dashboard 能持续提取** |

**核心循环**：源码挖出假设 → dashboard 在最新流量上验证 → 产出"harness 故事是否还成立"的演化记录。

这是**别人复制不出来的位置**——光读文档没线索，光读源码是历史，光跑 Claude Code 看不见内部，**只有 source + proxy + jsonl 三合一**才能持续验证 harness 演化。

> 📍 **context × memory 维度的源码假设清单（专题挖掘）**：[`CONTEXT-MEMORY-MAP.md`](CONTEXT-MEMORY-MAP.md)

### 数据源能力域

| 数据源 | 能挖什么 | 文档不写的原因 |
|--------|---------|---------------|
| **客户端代码**（`@anthropic-ai/claude-code` dist + sourcemap restored） | prompt 模板、CLAUDE.md 渲染顺序、tool def 注入逻辑、jsonl 剪裁规则、**默认参数/魔法常量/feature flag** | 实现细节不暴露 |
| **proxy + 真实 API call** | 服务端动态行为、未文档化机制、模型实际反应、**子 agent 调用**（`querySource`） | 服务端在动态演化，文档跟不上 |
| **客户端 × proxy 对照** | transformation 链条、信息丢失点地图、**源码假设 vs 当下真相** | 跨层视角不存在 |
| jsonl（已有） | session 抽象 / 用户操作痕迹 / token 用量 | 文档够用但缺洞察密度 |

**判断"非翻译"的三准则**：
1. 官方文档没写过的内容占 ≥ 30%
2. 有"我们的 dashboard / 我们的 jsonl / 我们的 proxy"作为锚点
3. 读者能**先看到 dashboard 现象，再用文章反推官方机制**

## 槽位规范

每个挖掘点统一四槽位 + 状态：

- 🔮 **假设**：要验证什么（可证伪）
- 🔬 **验证方法**：怎么取数、怎么对照
- 🖼️ **View 展示**：dashboard 怎么呈现
- 📜 **演示输出**：`resources/example/` 下放什么（文章 + view 原型）
- 📊 状态：⬜ 待启动 · 🟡 进行中 · ✅ 完成

---

## A · proxy 类挖掘点（服务端真相，文档最不可靠）

### A1 · fast / effort × thinking 实际长度 ⬜

- 🔮 **假设**：`/fast` 让 thinking 显著减少（量化目标：≥ 30% 缩减）；`effort=high/xhigh` 让 thinking 翻倍；客户端切换不重启 session
- 🔬 **验证方法**：proxy 截两组 session（fast on/off × effort 5 档），对比 raw response 的 thinking content block 总长 / 数量 / 平均 chunk 长度
- 🖼️ **View 展示**：
  - 时间线上每个 turn 用 stacked bar 显示 `thinking / text / tool_use` token 分布
  - 切换点高亮（fast on→off、effort 变档）
  - 跨 session 对比看板（同 prompt、不同 mode）
- 📜 **演示输出**：`example/proxy-mining/fast-effort-thinking/`
  - `README.md` 配 raw API 样本 + 实测数据 + 反推
  - 一个最小可运行的对比 view 原型

### A2 · prompt cache 真实命中模式 ⬜

- 🔮 **假设**：文档说 5min/1h TTL，**实际命中策略远复杂**（依赖 prompt 前缀 + cache_creation segment + 用量）；同 session 内多 turn 命中率随时间衰减
- 🔬 **验证方法**：proxy 监控 `cache_read_input_tokens` / `cache_creation_input_tokens` 随 turn 增长的曲线；故意做"5 分钟后回来 / 1 小时后回来"对照
- 🖼️ **View 展示**：
  - cache hit rate 折线（turn 维度 + 时间维度）
  - cache segment 可视化（`ephemeral_5m` vs `ephemeral_1h` 桶）
  - 异常下跌的"cache miss"事件标注
- 📜 **演示输出**：`example/proxy-mining/cache-truth/`

### A3 · streaming chunk 节奏 ⬜

- 🔮 **假设**：`/fast` 模式下 chunk 更大、间隔更短（解码策略激进）；不同 effort 档可能影响 chunk pattern
- 🔬 **验证方法**：proxy 记录每个 SSE event 的时间戳 + payload 长度，做密度图
- 🖼️ **View 展示**：
  - 单 turn 的 chunk 时间线热力图
  - fast vs normal 的中位 chunk size + p99 间隔对比
- 📜 **演示输出**：`example/proxy-mining/streaming-rhythm/`

### A4 · server-side tool 隐式触发 ⬜

- 🔮 **假设**：`web_search` / `web_fetch` 有未文档化的自动触发规则（如包含 URL 时）；客户端不主动声明也会被服务端调用
- 🔬 **验证方法**：proxy 收集所有出现 `server_tool_use` 的样本，归类 prompt pattern
- 🖼️ **View 展示**：
  - server tool 调用事件流（区别于客户端 tool call）
  - 触发条件 → 调用类型 mapping 表
- 📜 **演示输出**：`example/proxy-mining/server-tool-triggers/`

### A5 · 多 turn cache 衰减 ⬜

- 🔮 **假设**：cache 在 long-running session 里有 silent 淘汰；优先淘汰的内容类型可推断
- 🔬 **验证方法**：长 session 持续监控 cache 字段，找"前面命中、后来突然 miss"的转折点
- 🖼️ **View 展示**：cache lifetime 直方图 + 淘汰类型分布
- 📜 **演示输出**：`example/proxy-mining/cache-decay/`（可与 A2 合并发布）

### A6 · service tier 差异 ⬜

- 🔮 **假设**：`standard` vs `priority` 在 latency / cache 行为 / 队列排队上有可观察差异
- 🔬 **验证方法**：分别用两种 tier 跑同样 prompt 集，统计 first-token / total 时间
- 🖼️ **View 展示**：tier 对比卡片
- 📜 **演示输出**：`example/proxy-mining/service-tier/`

### A7 · ultrathink / extended thinking 触发条件 ⬜

- 🔮 **假设**：prompt 含特定关键词（`ultrathink` / `think harder` 等）会让服务端进入 extended 模式，thinking 长度跳变
- 🔬 **验证方法**：构造关键词 × prompt 模板矩阵，proxy 观察 thinking 长度分布
- 🖼️ **View 展示**：触发词 → thinking 长度倍数 散点图
- 📜 **演示输出**：`example/proxy-mining/ultrathink-triggers/`

---

## B · 客户端代码类挖掘点（客户端机制，源码可读但散）

> 数据来源：`~/.claude/local/node_modules/@anthropic-ai/claude-code/` 或对应安装路径下的 dist 源码。

### B1 · CLAUDE.md 多层加载顺序与冲突解决 ⬜

- 🔮 **假设**：文档说"enterprise > personal > project"，但实际可能是 merge + 冒泡（不是 override）
- 🔬 **验证方法**：读 claude code 源码找 CLAUDE.md 加载函数；构造三层冲突样本观察 dashboard 显示
- 🖼️ **View 展示**：CLAUDE.md 层级树 + 每条规则的来源标注 + 冲突高亮
- 📜 **演示输出**：`example/client-mining/claude-md-layers/`

### B2 · tool def 注入逻辑 ⬜

- 🔮 **假设**：哪些 tool 一直在 system prompt 里、哪些条件加载有客户端代码规则（如 `ENABLE_TOOL_SEARCH` 阈值是 hard-coded 数字）
- 🔬 **验证方法**：读源码找 tool def 注入函数；proxy 对照实际 request 的 tools 数组
- 🖼️ **View 展示**：每 turn 的 tool def 列表 + 各 tool 的"是否新增/移除"diff
- 📜 **演示输出**：`example/client-mining/tool-injection/`

### B3 · system prompt 模板差异 ⬜

- 🔮 **假设**：主 agent / Explore / Plan / 自定义 subagent 各自的 system prompt 完整文本结构可逆向
- 🔬 **验证方法**：proxy 截各 agent type 的 raw request，diff 出固定模板部分
- 🖼️ **View 展示**：agent type → system prompt 模板浏览器；可对照 diff
- 📜 **演示输出**：`example/client-mining/system-prompts/`

### B4 · jsonl 剪裁规则 ⬜（**这已经在做** —— 找出"thinking 为空"那类全部剪裁项）

- 🔮 **假设**：除 thinking 外，jsonl 还剪裁了若干 metadata / debug 字段
- 🔬 **验证方法**：proxy raw response × jsonl 同 message diff
- 🖼️ **View 展示**：信息丢失点表 + 每个被剪字段的样本对照
- 📜 **演示输出**：`example/client-mining/jsonl-pruning/`

### B5 · skill activation 决策细节 ⬜

- 🔮 **假设**：客户端把 skill description 拼进 system prompt 时有特定格式 + 排序；多 skill 时如何控字数（1536 字符截断 + 25000 总预算）
- 🔬 **验证方法**：源码找 skill listing 渲染函数；proxy 对照实际 system prompt 中 skill 段
- 🖼️ **View 展示**：skill listing budget 实时进度条 + 哪些 skill 被压缩 / 丢弃
- 📜 **演示输出**：`example/client-mining/skill-activation/`

### B6 · compact 算法实现 ⬜（**与 C1 联动**）

- 🔮 **假设**：文档说"5000/25000 token"，但实际填充顺序、保留策略可能更细
- 🔬 **验证方法**：源码找 compact 函数；proxy 对照 compact 前后 request 差异
- 🖼️ **View 展示**：compact 前后消息一一对照 + 哪些被摘要 / 哪些 skill 被保留
- 📜 **演示输出**：升级现有 `compact/README.md` 草案 → 实测版

---

## C · 对照类挖掘点（跨层信息流，最有视觉冲击力）

### C1 · 完整渲染流转图 ⬜（**项目的开篇之作**）

- 🔮 **假设**：用户输入 → 客户端处理 → API request → API response → jsonl 落盘 → dashboard 展示，**每一跳都有信息加工**，没人画过完整流程
- 🔬 **验证方法**：一条 session 的完整数据全采集（用户原文 / 客户端预处理 prompt / proxy raw req+resp / jsonl 落盘 / dashboard 渲染），五份样本配对
- 🖼️ **View 展示**：
  - 一张大流程图（每跳一个节点，节点点开看真实数据）
  - 数据流播放器：拖动时间轴看每跳同步演变
- 📜 **演示输出**：`example/cross-mining/render-pipeline/`
  - 配大图 + 5 份配对样本 + 解读

### C2 · 信息丢失点地图 ⬜

- 🔮 **假设**：每跳都有信息丢失（thinking 在 jsonl 丢、metadata 在 dashboard 丢、原始 prompt 在 client 处理后丢）
- 🔬 **验证方法**：基于 C1 的数据，做每跳的"输入 - 输出"diff
- 🖼️ **View 展示**：丢失点表 + 每个丢失点的实例 + 影响评估
- 📜 **演示输出**：`example/cross-mining/loss-map/`

### C3 · 同 prompt 在不同 agent type 下的差异 ⬜

- 🔮 **假设**：主 / Explore / Plan / 自定义 subagent 接到"同一个任务"时，客户端发出的 request 实际差异巨大
- 🔬 **验证方法**：proxy 截"分析这段代码"在 4 种 agent 下的 raw request，diff
- 🖼️ **View 展示**：四列对照 + 差异高亮
- 📜 **演示输出**：`example/cross-mining/agent-prompt-diff/`

---

## D · jsonl session 抽象（基础设施挖掘，已在做）

| # | 文档 | 槽位状态 |
|---|------|---------|
| D1 | sessions（continue/resume/branch/fork 识别） | View: `SessionListV2` 已有；test case 待补；演示文章 ⬜ |
| D2 | checkpointing（编辑时间线） | View ⬜ / test ⬜ / 演示 ⬜ |
| D3 | memory（CLAUDE.md / auto memory 来源显示） | View ⬜ / test ⬜ / 演示 ⬜ |
| D4 | debug-your-config（`/context` `/doctor` 可视化） | View ⬜ / test ⬜ / 演示 ⬜ |

> D 类不是"挖真相"，是"做基础设施扎实"。优先级低于 A/B/C，但是底座。

---

## E · 跨数据源产品级 view（不是 example，是产品方向）

### E1 · costs-dashboard（团队级 token / 成本聚合）⬜

- 复用 jsonl 解析 + proxy 信号
- 用户 / 会话 / 模型维度聚合
- cache hit rate 反推 prompt 设计质量

### E2 · context-review（session 内省）⬜

- 把 `/context` 输出可视化
- 与 A 类挖掘结果（fast/effort 影响 thinking）耦合显示
- 实质是 C1 的产品化形态

### E3 · agent-view 对比定位 ⬜

- 官方 agent-view = 实时调度
- 我们的 dashboard = 事后 review + 跨层挖掘
- 差异矩阵文章

---

## 中优 · 教学完整性（与挖掘弱相关）

| 文档 | 简要 |
|------|------|
| `hooks` + `hooks-guide` | hook 是 session 内事件源，**与 B5/B6 联动时有挖掘价值** |
| `permission-modes` + permissions | 决定 tool 调用批准，与 dashboard 的 tool 用量视图相关 |
| `output-styles` | 影响输出，与挖掘弱相关 |
| `agent-sdk/session-storage` + `agent-sdk/sessions` | SDK 抽象，若 dashboard 扩展到 SDK 域有参考 |
| `skills` + `sub-agents` | 已做（教学 demo） |

---

## 低优 · 与项目定位无关（明确降级）

整组与挖掘无关，详见前一版本归类（详细见 `COVERAGE-DETAILED.md`）：

- `devcontainer` / `headless` / `plugins` 类 / 云供应商 / CI 集成 / 平台 UI / 终端交互 / `mcp` / 运维类 / 终端配置 / 业务集成 / 周报 / 参考类

可等 A/B/C 三档铺开后再视情况补。

---

## 已完成的存量

| Example | 状态 | 重新归类 |
|---------|------|---------|
| `skill/` 7 文件 | ✅ | 教学 demo，等 B5 挖掘出来后**会有一份"实测版"对照**（"文档怎么说"vs"客户端怎么做"） |
| `subagent/` 4 文件 | ✅ | 教学 demo，B3 挖出 system prompt 模板后**可升级为"原理 + 实测"双层** |
| `cli-demo/` 4 文件 | ⚠️ **质量不达标** | 按本文档准则全是翻译，建议挖完 A1（fast×thinking）后用同模板**重写 fast-mode.md 作为非翻译标杆**，再决定其他 3 篇删/改 |
| `compact/README.md` | 🟡 草案 | 与 B6 合并升级 |

---

## 推进顺序（建议）

挖掘地图就位后，每挖一个相当于"原创发现 + view + 文章"三连。建议顺序：

1. **A1 · fast × thinking**（**最快出标杆**，1-2 天，proxy 数据现成）
2. **C1 · 渲染流转图**（**项目门面**，1 周，需要采集完整 pipeline 样本）
3. **B6 + compact 升级**（与现有草案合并）
4. **A2 · prompt cache 真实命中**（高产品化潜力）
5. **B3 · system prompt 模板**（与 subagent demo 联动）
6. 其余 A/B/C 按需穿插

---

## 不可演项的优化路径（保留）

不在挖掘地图内的环境绑定类，如果要演，三条路径：
1. mock 化关键交互（云供应商）
2. `act` 本地跑 CI
3. GIF + 配置截图（IDE / 平台）

详见各文档 `COVERAGE-DETAILED.md` 中的"演示设计"字段。

---

## 关联

- 逐文档精读档案：[`COVERAGE-DETAILED.md`](COVERAGE-DETAILED.md)
- 已有 demo：[`skill/`](skill/), [`subagent/`](subagent/), [`cli-demo/`](cli-demo/), [`compact/`](compact/)
- 官方 sitemap：https://code.claude.com/docs/llms.txt
- 项目 ProxyTraffic 入口（数据源）：`client/src/components/ProxyTraffic.tsx`
