# billing-identity-materialization

## Purpose

验证 billing presence rule 和 identity exact_text rule 的正向 materialization 路径。
这是当前 rule-registry 中唯一一个 `verifiedFor=SUPPORTED_CLAUDE_CODE_VERSION` 的
system rule（`claude-code.system-prompt-identity.v1`），是 rule-driven reconstruction 进展的最小 regression baseline。

## Expected Features

- `system[0]`：billing noise header，由 `claude-code.billing-noise.v1` rule 识别为 `presence`（内容不可复现）
- `system[1]`：identity，由 `claude-code.system-prompt-identity.v1` rule 正向 `exact_text` materialize
  - expected segment 的 sourceRef.kind 必须是 `harness_rule`
  - materialization=exact_text，contentRef.text = "You are Claude Code, Anthropic's official CLI for Claude."
  - ruleVerified=true，verifiedFor=2.1.126
- `system[2]`：generateSessionTitle 的 title_generation_prompt，应归入 attribution_only（无对应 rule）
- `messages[0]`：用户输入文本，从 JSONL mutation 正向重建

## Query Type

`side_query`（session title 生成，由 Claude Code 内置 `generateSessionTitle()` 触发），
区别于 `main_session`：
- 没有 tools[]
- system 内容极小（仅 billing + identity + title gen prompt，共 ~838 chars）
- messages=1（单轮，无历史）

## Materialization 验证点

| segment | rule | materialization | expected sourceRef.kind |
|---------|------|-----------------|------------------------|
| system[0] billing | claude-code.billing-noise.v1 | presence | harness_rule |
| system[1] identity | claude-code.system-prompt-identity.v1 | exact_text | harness_rule |
| system[2] title gen | — | attribution_only | — |

## Known Gaps

- `claude-code.billing-noise.v1` 当前 `verifiedFor=null`；presence rule 只能验证段存在，不能 exact match。
- `system[2]` title-generation prompt 无对应 rule，进入 `attribution_only`；这是真实缺口，不应包装成成功。
- tools[] 为空，不测试 tool schema materialization（见 single-tool-call / system-tools-overhead fixture）。

## Important JSON Paths

- `reqBody.system[0].text` — billing header（81 chars）
- `reqBody.system[1].text` — identity（57 chars）
- `reqBody.system[2].text` — title generation prompt（700 chars）
- `reqBody.messages[0]` — 用户消息（单条）

## Source

- traffic file: `traffic.jsonl.2026-05-04T13-24-25-881Z` line 155
- session: `d9b0b79d-efa2-48b4-9134-c213c1ddc3d6` (reconstruct-04-system-rules worktree)
- proxy ts: `2026-05-04T12:51:40.183Z`
- CLI version: `2.1.126` = SUPPORTED_CLAUDE_CODE_VERSION
