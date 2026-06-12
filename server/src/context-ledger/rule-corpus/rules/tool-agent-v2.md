---
ruleId: claude-code.tool.Agent.v2
slotId: tools.builtin
verifiedFor: "2.1.170"
appliesTo:
  minCcVersion: "2.1.158"
priority: 10
sourceUnits: []
description: "Claude Code 工具：Agent。2.1.158 模板，exact 全文锚定（static，可复现）。desc 1227B。"
stability: static
displayName: "Agent"
summary: "工具定义：Agent（2.1.158 版固定描述）"
sourcemapRef: 'proxy:9e1ba147 T3C2 (2.1.158.d60); 重钉 proxy:req_011CbtoeoZ2ErDuDs31d8oys (2.1.170.005) 逐字节一致; ref: claude-code-system-prompts tool-description-agent'
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: exact
  mechanism: tools_schema_pattern
  category: tools_schema
---
## pattern

```exact
Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.

Available agent types are listed in <system-reminder> messages in the conversation.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.

## When to use

Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.
- Use SendMessage with the agent's ID or name to continue a previously spawned agent with its context intact; a new Agent call starts fresh.
- `isolation: "worktree"` gives the agent its own git worktree (auto-cleaned if unchanged).
- `run_in_background: true` runs the agent asynchronously; you'll be notified when it completes.
```
