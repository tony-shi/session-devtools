# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
