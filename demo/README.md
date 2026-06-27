# 离线 Demo（静态分享版 dashboard）

把本地几个真实 session 固化成静态 JSON，构建一个**无后端**的 dashboard，发 GitHub Pages，分享链接即可看到与本地一致的 UI（核心是 attribution 交互）。Demo 用的是同一份 `client/` 代码（`--mode demo`），不是 fork。

## 端口一览

| 进程 | 命令 | 端口 | 接后端? |
|---|---|---|---|
| 后端 API | `npm run server:dev` | 5051 | — |
| 主力 UI（正常 dashboard） | `npm run dev` | 5173 | 接 5051 |
| **Demo UI（离线预览）** | `npm run demo:dev` | **5174** | **不接**，读 `demo/data` 快照 |

三者端口互不冲突，可同时开。

## 本地预览 demo（极简三步）

```bash
# 1) 一次性：后端(5051)在跑时，把 sessions.config.json 里的会话冻结成静态 JSON
npm run demo:freeze

# 2) 起 demo 预览（独立 5174，会自动开浏览器）
npm run demo:dev
#    -> 打开 http://localhost:5174/

# 3) 验证它真的离线：把后端(5051)停掉，刷新 5174，依旧完整可用
```

`demo:dev` 只依赖 `demo/data`，**完全不碰 5051**——这就是"离线"的证明。左侧导航不显示 Proxy（实时流量在 demo 下隐藏）。

## 换展示的会话

编辑 `demo/sessions.config.json`（`sessions[].id` = Claude Code session id，顺序 = 列表顺序），重跑 `npm run demo:freeze`。候选可在主力 UI 列表里按复杂度挑（子代理数 / LLM 调用数）。

## 构建 + 部署（发 Pages）

```bash
npm run build:demo     # 校验数据新鲜度 → 构建 -> dist-demo（含数据 + 404.html，自包含）
npm run deploy:demo    # 推 dist-demo -> gh-pages 分支（GitHub Settings -> Pages 选 gh-pages）
```

自定义域名：把域名写进 `demo/CNAME`（一行），deploy 时自动带入。

## 数据会不会和 UI 错位？

- **UI 改动**（组件/样式/交互/路由）：零错位，重跑 `build:demo` 自动反映（全复用）。
- **数据契约改动**（parser 输出 shape / 新端点）：冻结快照会过期，需**重跑 `demo:freeze`**——和 bump `PARSER_VERSION` 同一套纪律。`demo:check`（已串进 `build:demo`）会在版本不一致时显式告警。

## 注意

- `demo/data` 与 `dist-demo` 已 gitignore，不进 main；站点只通过 gh-pages 分支发布。
- 当前固化为**原样数据**（含真实 email / 路径 / 对话全文）。正式对外分享前需自行脱敏。
