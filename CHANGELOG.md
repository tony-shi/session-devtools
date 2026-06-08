# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.9] - 2026-06-08

### Fixed
- **Ctrl+C 退出卡顿**：关闭时先 `closeAllConnections()` 强制断开所有底层 socket（含 SSE `/api/proxy-traffic/stream` 长连接与 idle keep-alive），并对 `app.close()` 加 2s 兜底超时。此前 Node 的 `server.close()` 会一直等这些连接自然结束，导致 npx 版本按 Ctrl+C 后长时间卡住才退出。

## [0.1.0-alpha.8] - 2026-06-07

### Added
- **归因树 · userContext 结构化拆分**：首条 user 消息的 `<system-reminder>` 按真实物理序拆为 wrapper 前缀 / 项目指令×N / 记忆(MEMORY.md) / 账号 / wrapper 后缀，各段可单独点开；新增 5 条 corpus 规则，并区分三类指令文件（项目 CLAUDE.md / 全局 `~/.claude/CLAUDE.md` / 本地 CLAUDE.local.md）。
- **流式响应重组视图**：raw 标签页对 SSE 流式响应默认展示重组后的完整 message JSON（可切回 SSE 原文）；流未正常结束时显示截断标记。
- **leaf 详情富展示**：工具定义解析为描述+参数表、agent 类型表格、deferred tools 按 MCP server 分组 chips、技能网格、图片输入真实渲染（替代占位符）。
- **统一 raw/render 切换 + 复制组件**（RenderRawCopyActions），接入归因详情 / 事件卡 / AI 回复；AI 回复升级 markdown 渲染。
- 展示分类收敛到后端单源：节点新增 `category`/`group`/`labelKey` 字段；`AttributionTreeLensPanel` 新增受控聚焦 props；归因取数可经 context 注入（默认 apiV2，线上零行为变化）。

### Changed
- **归因面板全面 i18n**（en / zh-CN），分类术语重写；structure lens 细分出 CLAUDE.md / 记忆 / 账号 / 工具发现 / Agent 类型独立桶。
- **配色体系按三层显著度重做**：会话流（饱和）/ 上下文（柔和）/ 脚手架（弱化）；分类 pill 显示占全请求的百分比；同一 `<system-reminder>` 包裹的叶子视觉成组。
- system 静态指令段坍缩为单一「系统提示词」壳（跨 CC 版本免维护）；tool 定义按完整 wire JSON 计量（含 input_schema，charCount 反映真实缓存字节）。
- dev server 端口改为 strictPort，被占用时直接报错不漂移。

### Fixed
- v2 规则（如 user-context.v2）被误归 injection 分类的 bug。
- 未知 event kind 导致界面异常（现走灰色兜底卡片）；FisheyeStrip 在 CSS zoom 环境下条带被裁剪；HoverTip 在滚动容器内反复闪烁（改 portal + fixed 定位）。

### Known issues
- matcher 改为完整 tool JSON 计量后，除 Bash 外的内置 tool 规则暂未升级为 JSON 形态 pattern，相应工具定义节点退化为 wire 级归因展示（功能不受影响，待后续版本扫尾）。

## [0.1.0-alpha.7] - 2026-05-31

### Added
- **rule-corpus**：归因规则迁移为 markdown corpus（frontmatter pattern + 验证元数据），替代散落代码的规则注册。
- 演示 walkthrough（场景 1/2）、ghost attribution、会话 AI 标题。
- jsonl ↔ proxy 全局双向联动；compaction 会话支持；dashboard 状态列 + sticky header。

### Changed
- shadcn/Tailwind 接入；统一 selection token 与颜色语义契约；归因逻辑多轮修正。

## [0.1.0-alpha.6] - 2026-05-19

### Fixed
- **Dev mode 一键启动**：`server/` 加入 npm workspaces；`npm install` 一次装齐 root + client + server，不再需要 `cd server && npm install`。
- **proxy-v2 子进程 spawn 路径**：`runner.ts` 不再硬编码 `server/node_modules/.bin/tsx`；workspaces hoist 后到 `<repo>/node_modules/.bin/tsx`，并保留 `server/.bin` 作为 fallback。

### Changed
- `dev` 脚本去掉 `setup-env.sh`（不再支持 worktree-per-branch 自动 .env 注入）。
- `client:dev` 简化为 `npm run dev --workspace=client`；删除 `wait-server.sh`（vite 自带 API 重试）。
- 所有 npm scripts 里的 `server/node_modules/.bin/tsx` 改为 `tsx`（依赖 hoist 后的 PATH 解析）。
- UI · request 视图重构为统一 lens：来源（永远基底，pill 行）/ Diff / 缓存 / Audit(dev-only) 多 lens 叠加；主 bar 改为 leaf-level provenance 拼色 + section fieldset 框；diff 通过 leaf 下方 5px 色条 + 行级 inline diff 表达；cache lens 用 L1/L2/L3 拓扑条 + 选中 leaf 后在 L 行画"位置小块"做联动。
- `SelectedDetail` 加 **复制原文** 按钮（取 `leaf.rawText` 完整内容）。
- 详情 drawer 默认宽度 `1200 → 1480`，viewport 边距 `200 → 120`。

### Removed
- `scripts/setup-env.sh`、`scripts/wait-server.sh`（用途已收敛到 npm scripts）。
- 11 个一次性分析 / 内部诊断脚本从 git 移除（本地保留）。
- `server/{dev,sessions}.db` 从 git 移除（0 字节空文件，不该 track；`*.db` 加入 .gitignore）。

## [0.1.0-alpha.1] - 2026-05-15

### Added
- First public npm release as `session-devtools`
- Single-binary CLI: `npm i -g session-devtools` then `session-devtools` to launch
- Built-in update notification via `update-notifier` (checks once per 24h)
- Bundled server (`dist/server.js`) + MITM proxy (`dist/proxy-server.js`) via tsup
- Session parsing for Claude Code (Codex / Gemini session list also supported, attribution Claude-only)
- SQLite-backed session storage with incremental sync (`better-sqlite3` as runtime dep)
- React dashboard: session list, turn timeline, summary cards, context attribution tree, diff panel
- Request-side context attribution from proxy capture
- Daily digest generation via Anthropic-compatible LLM API

### Notes
- Alpha: Claude Code 2.x only; attribution requires the proxy dump.
- Requires Node.js >= 22; supports macOS arm64/x64, Linux x64/arm64.
