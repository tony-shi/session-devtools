# /loop + cron · 让 Claude 按时间或周期跑

> 来源：docs/en/scheduled-tasks.md

## 是什么

两种"定时"机制，颗粒度不同：

| 机制 | 适合 | 触发方式 |
|------|------|---------|
| `/loop` | 自驱循环，每次自己决定下次何时再跑 | session 内 ScheduleWakeup |
| `cron` 工具 | 真定时（如每天 9 点） | CronCreate / CronList / CronDelete |

## 怎么演

### 演 `/loop`（自驱）

```text
/loop 监控 CI，每次 fail 时自动修
```

观察：Claude 检查 CI → 没 fail 就睡到合适的时间再来 → 一直循环。

### 演 cron（定时）

```text
帮我设置每天早 9 点跑一次 /code-review main..origin/feature
```

Claude 会调 CronCreate，配出一个真 cron entry。`CronList` 查看，`CronDelete` 清除。

## 预期看到

- `/loop` 启动后，session 不会"完成"——而是按自己的节奏间歇苏醒
- cron 则**完全独立于当前 session**——下次到点 Claude Code 会拉起新 session 执行

## 一句话解读

`/loop` = **任务自带节奏**（轮询 / 重试 / 守望型）
cron = **业务有节奏**（每日报告 / 周报告 / 定时清理）

## 易踩坑

- `/loop` 选 `delaySeconds` 要避开 300（缓存 TTL 临界点，最贵）：要么 < 270（缓存内）要么 > 1200（一次 miss 买大段等待）
- cron 时区按服务器/本地，要确认
- 两者都会**自动消耗 token**，部署前算好月度预算

## 关联

- 配合 `/goal` 用：cron 起 session，session 内挂 goal 自驱跑通某指标
