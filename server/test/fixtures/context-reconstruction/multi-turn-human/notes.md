# multi-turn-human

## 覆盖机制
多轮真实人类输入的对话：messages=7，包含 2 条独立的 human turn（`are you there`、中文任务描述），
以及 2 次 Bash 工具调用往返。
验证 proxy messages 数组里的历史对话如何与 session JSONL 的 turn 序列对齐——
这是 context reconstruction 的核心映射关系。

## 关键 query
- proxy messages[0] 是多个 text block 的拼合（system-reminder、bash 输出、用户输入），
  对应 session JSONL 里哪些 turn？
- proxy messages[2]（第二条 human turn）的 `are you there` 和中文任务描述
  是否能在 session JSONL 里找到对应的 user turn？
- messages 数组的 role 序列（user/assistant/user/assistant...）
  与 session JSONL 的 type 序列（user/assistant/user/assistant...）是否一一对应？

## proxy request 和 JSONL 如何对齐
session: `c8bc69a1` (feature-refine-proxy worktree)
proxy ts: `2026-04-27T09:34:05.576Z`
delta: 0s（精确命中，session 里有同一时刻的 assistant turn 开始）

messages 结构：
- [0] user: 8 个 text block（system-reminder × 2、`are you there` × 3、local-command × 3）
- [1] assistant: text "No response requested."
- [2] user: 4 个 text block（`are you there` × 2、local-command-caveat、中文任务描述）
- [3] assistant: text "Yes, I'm here."
- [4] user: 4 个 text block（local-command-caveat、bash-input/stdout、中文任务 × 1）
- [5] assistant: text + tool_use(Bash) × 2
- [6] user: tool_result × 2

session JSONL 里对应的 turn 序列（±5min 窗口，94 lines）与 proxy messages 的 role 序列一致。

## contract 必须能表达什么
- `messages` 的 role 序列严格交替：user/assistant/user/assistant...
- 每个 user message 的 text block 数量 ≥ 1，且至少有一个 block 包含真实用户输入（非 system-reminder）
- `messages[5]` 包含 `type=tool_use`，name 为 `Bash`
- `messages[6]` 包含对应数量的 `type=tool_result`
- proxy messages 里的 human text 内容（`are you there`、中文任务）
  能在 session JSONL 的 user turn 里找到原始对应

## 已知缺口
- messages[0] 里有 3 条重复的 `are you there\n`（用户多次发送），
  但 session JSONL 里可能只记录了一次——重复消息的合并/去重逻辑需要验证。
- system-reminder block（4517 chars）是 Claude Code 注入的 meta 信息，
  不是用户输入，parser 需要区分并过滤。
- messages[4] 里的 bash-input/stdout block 是 Claude Code 把终端输出注入到 context 里，
  这部分在 session JSONL 里以 `attachment` 或 `system` type 记录，schema 不同。
