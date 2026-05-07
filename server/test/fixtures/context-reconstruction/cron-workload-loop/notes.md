# cron-workload-loop

## Purpose

验证 `cc_workload=cron` billing header 的识别路径。
用户在 session a681e441 中执行 `/loop 1m are you there? what can you do?`，
Claude Code 调用 `CronCreate` 创建 cron job（`*/1 * * * *`），
此后每分钟触发一次 LLM call，billing header 中带 `cc_workload=cron`。

本 fixture 取第 **1 次** cron 触发的请求（loop 创建后约 60s，ts=2026-05-07T11:29:28.769Z）。

## Billing Header

```
x-anthropic-billing-header: cc_version=2.1.132.665; cc_entrypoint=cli; cch=ade84; cc_workload=cron;
```

- `cc_workload=cron`：标识此次 LLM call 是由定时任务（CronCreate）触发，而非用户直接交互
- 对比普通 main session call（如 call #1/2）billing header 中无 `cc_workload` 字段，或值为空

## Session 结构

| turn | role | 内容摘要 |
|------|------|---------|
| msg[0] | user | `/loop` skill 指令 + system-reminder |
| msg[1] | assistant | "I'll schedule this loop" + CronCreate tool_use |
| msg[2] | user | CronCreate tool_result |
| msg[3] | assistant | 调度确认文本 + 第1次回答 |
| msg[4] | user | "are you there? what can you do?"（cron 触发） |

## System Prompt 结构

| seg | chars | cache | 内容 |
|-----|-------|-------|------|
| system[0] | 99 | none | billing noise，含 `cc_workload=cron` |
| system[1] | 57 | ephemeral/1h | identity（"You are Claude Code..."） |
| system[2] | 28271 | ephemeral/1h | 主 system prompt（tools list、CLAUDE.md 等） |

## Expected Features

- `system[0]`：billing noise header，`claude-code.billing-noise.v1` rule 识别为 `presence`
  - 关键点：text 中含 `cc_workload=cron`，可用于识别 cron workload
- `system[1]`：identity，`claude-code.system-prompt-identity.v1` rule exact_text
- `system[2]`：主 system prompt，`attribution_only`（内容过大，无对应 rule）
- `messages[4]`（最后 user）：`are you there? what can you do?`，cache_control=ephemeral/1h

## Query Type

`main_session`（非 side_query），由 cron 定时触发：
- 有完整 tools[]（40 个）
- 有 session 历史（msg[0-3] 是 loop 创建过程）
- msg[4] 是 cron 触发的实际 prompt

## Known Gaps

- `cc_workload=cron` 目前无专用识别 rule，仅作为 billing noise 的一部分
- `system[2]` 主 system prompt 约 28271 chars，内容庞大，无对应 rule

## Source

- session: `a681e441-4146-4842-97e6-719c327eda62`
- session dir: `-Users-shihuashen-Documents-session-dashboard`
- traffic file: `traffic.jsonl`（当前活跃文件，line 12253）
- proxy ts: `2026-05-07T11:29:28.769Z`
- CLI version: `2.1.132`
