---
layout: default
title: 会话列表
parent: 产品能力
grand_parent: 中文文档
nav_order: 1
---

# 会话列表

会话列表是 session-devtools 的入口界面，展示本机所有 Claude Code 会话的关键指标，支持搜索与筛选。

---

## 总览

![会话列表总览](../../assets/screenshots/session-list-overview.png)

<!-- 截图说明：整体界面截图，展示会话列表主视图 -->

每一行对应一个 Claude Code 会话，从左到右展示：会话名称/工作目录、开始时间、Token 用量、LLM 调用次数、工具调用次数、子 agent 数量。

---

## 核心信息卡片

![会话卡片详情](../../assets/screenshots/session-list-card.png)

<!-- 截图说明：单个会话行的放大视图 -->

| 字段 | 说明 |
|---|---|
| 会话名 | 自动从第一条消息提取，便于识别 |
| 工作目录 | 该会话所在的项目路径 |
| Token 用量 | 输入/输出 token 总计（含缓存） |
| LLM 调用 | 该会话共发起多少次 LLM 请求 |
| 工具调用 | 工具使用总次数 |
| 子 agent | 是否有子 agent，以及层级数量 |

---

## 搜索与筛选

![搜索功能](../../assets/screenshots/session-list-search.png)

<!-- 截图说明：搜索框激活状态，展示筛选结果 -->

支持按以下维度过滤：

- **会话 ID** — 精确匹配
- **工作目录** — 路径模糊匹配
- **首条消息** — 关键字搜索

---

## 子 agent 标识

![子 agent 标识](../../assets/screenshots/session-list-subagent.png)

<!-- 截图说明：含子 agent 的会话行，标识高亮 -->

有子 agent 的会话会显示专属标记，点击后进入会话详情可进一步展开 agent 层级结构。
