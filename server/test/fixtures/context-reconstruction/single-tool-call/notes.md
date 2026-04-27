# single-tool-call

## 覆盖机制
一次完整的工具调用往返：assistant 发出 tool_use → user 返回 tool_result → assistant 再次调用。
proxy reqBody 里的 messages[2] 包含 tool_result，是 context window 增长的起点。

## 关键 query
- proxy 捕获的 messages[1]（assistant tool_use）和 messages[2]（tool_result）
  是否与 session JSONL 里对应的 turn 内容一致？
- tool_result 的 content 在 proxy 里完整，在 DB 里是否有损？

## proxy request 和 JSONL 如何对齐
session: `ba3db910` (session-dashboard 主 worktree)
proxy ts: `2026-04-27T10:34:26.141Z`
对齐方式：时间窗口 ±2min，session 里 `10:34:26.037Z` 有 `tool_result` turn，
与 proxy messages[2] 的两条 tool_result 精确对应。

工具调用序列（proxy messages）:
- [1] assistant: tool_use(Bash) + tool_use(Bash)
- [2] user: tool_result + tool_result
这对应 session 里连续的 `assistant→user` turn 对。

## contract 必须能表达什么
- `messages[1].content` 包含至少一个 `type=tool_use`，`name` 为已知工具名
- `messages[2].content` 包含对应数量的 `type=tool_result`
- tool_result 的 `content` 字符数 > 0（非空返回）
- proxy 的 tool_result chars 与 session JSONL 的 tool_result chars 在同一数量级（允许轻微差异）

## 已知缺口
- proxy messages 里的 tool_result content 和 session JSONL 里的 tool_result content
  字符数有轻微差异（proxy: 6842/1705 chars，session: 7012/1843 chars）——
  原因未查明，可能是 JSON 序列化差异或 Claude Code 在写 JSONL 时有额外 wrapper。
- system prompt（28536 chars）未做内容比对，仅确认存在。
