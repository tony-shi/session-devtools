# system-tools-overhead

## 覆盖机制
session 第一个 API call：messages=1（只有初始 user message），但已携带完整 system prompt（28536 chars）
和 34 个工具定义。验证 context window 基线开销：在任何实际对话之前，
system + tools 已经占用了多少 token 预算。

## 关键 query
- system prompt 的 28536 chars 对应多少 token？（估算：~7000 tokens）
- 34 个工具定义的 JSON 总大小是多少？
- 这是 session 的第一次 API call 吗？messages[0] 是否就是用户的第一条输入？

## proxy request 和 JSONL 如何对齐
session: `ba3db910` (session-dashboard 主 worktree)
proxy ts: `2026-04-27T10:33:53.953Z`
session min_ts: `2026-04-27T10:32:38.024Z`（session 开始约 75 秒后的第一次 API call）
对齐方式：时间窗口 ±2min，delta=76s。
session 里 `10:33:58.067Z` 是第一个 assistant turn，与 proxy response ts 吻合。

## contract 必须能表达什么
- `body.system` 长度 > 20000 chars（system prompt 存在且非空）
- `body.tools` 数组长度 == 34
- `body.messages` 长度 == 1（第一次调用，无历史）
- `messages[0].role == "user"`，内容是真实的用户输入文本
- req_chars（128833）中，system+tools 占比 > 95%（messages 本身极小）

## 已知缺口
- system prompt 内容未做语义比对，仅确认存在和长度。
- 工具定义列表（34 个）未枚举具体名称，不知道是否与当前 Claude Code 版本一致。
- session JSONL 里 `10:32:38` 的 `system` type records 是 Claude Code 内部初始化记录，
  不是 API messages，两者的 schema 不同，需要区分。
- sse_event_count=20（流式），但 messages=1 的情况下 assistant 回复较短，
  20 events 可能只是一段简短文本，未验证。
