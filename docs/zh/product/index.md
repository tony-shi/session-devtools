---
layout: default
title: 产品能力
parent: 中文文档
nav_order: 1
has_children: true
permalink: /zh/product/
---

# 产品能力

本节介绍session-devtools的核心功能，每个页面对应一个主要模块，包含截图与功能说明。

| 模块 | 说明 |
|---|---|
| [会话列表](./session-list) | Agent会话概览 |
| [会话详情](./session-detail) | 单个会话详情，以聊天框风格，展示用户整个session的轮次信息 |
| [轮次详情](./turn-detail) | 单个轮次详情，通过分析Agent的事件列表，可视化完整的执行链路 |
| [请求详情](./llm-detail) | 在开启了Proxy的前提下，展示单个LLM调用详情，包含原始数据以及归因后的来源、Diff和Cache |

# 名次解释


| 术语 | 说明 |
|---|---|
| session/会话 | 打开一个Claude/Codex/Gemini，不断和其对话，对应一个session或者说会话。 |