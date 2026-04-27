# large-tool-output

## 覆盖机制
单个 tool_result 内容达 26133 chars（Read 工具返回大文件内容）。
验证 context window 在大 tool_result 场景下的结构：
messages[6] 有两条 tool_result，最大一条 26133 chars，是 context 膨胀的典型来源。

## 关键 query
- 大 tool_result（26133 chars）在 proxy reqBody 里是否完整？
- 这条 tool_result 对应 session JSONL 里哪个 turn？chars 是否对齐？
- 大 tool_result 是否触发任何截断或 binary 检测？

## proxy request 和 JSONL 如何对齐
session: `206e9383` (feature-context-sample-pack worktree)
proxy ts: `2026-04-27T11:16:17.532Z`
对齐方式：时间窗口 ±3min。
session 里 `11:16:16.989Z` 有 `tool_result` turn（27488 chars），
对应 proxy messages[6] 的第二条 tool_result（26133 chars）。
chars 差异约 5%，与 single-tool-call 的差异模式一致。

工具调用序列（proxy messages[3]-[6]）:
- [3] assistant: tool_use(Bash) × 2
- [4] user: tool_result(6842) + tool_result(1705)
- [5] assistant: tool_use(Read) × 2
- [6] user: tool_result(13031) + tool_result(26133)  ← 关键大输出

## contract 必须能表达什么
- `messages[6].content[1].content` 长度 > 20000 chars
- 内容是合法 UTF-8 文本（非 binary），`safeBody()` 不触发 `[binary N bytes]`
- proxy 和 session 的 tool_result chars 差异 < 10%
- sse_event_count == 58（流式响应，assistant 回复是增量 delta）

## 已知缺口
- proxy 里 messages[0] 是 5 个 text block（system 注入的多段 context），
  与 session JSONL 里 user turn 的 content 结构不完全对应——
  session 里 user turn 只有一条 text，但 proxy 里 messages[0] 有 6 个 block，
  说明 Claude Code 在发送时会把 system context 注入到第一个 user message。
- 26133 chars 的 tool_result 在 DB 里 `turns.content` 字段是否完整存储，未验证。
