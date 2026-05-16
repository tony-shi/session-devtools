# session-devtools

**English** · [简体中文](./README.zh-CN.md)

> **Agents harness the LLM. You harness the agent.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/session-devtools.svg)](https://www.npmjs.com/package/session-devtools)
[![node](https://img.shields.io/node/v/session-devtools.svg)](https://nodejs.org)

---

<!-- HERO: 15s autoplay GIF, 800px wide, <5MB. Frames: session list → turn drilldown → sub-agent boundary. -->

![session-devtools hero demo](./docs/pr/assets/hero.gif)

▶ Watch the full 60s demo → [YouTube](https://youtu.be/REPLACE_ID) · [Bilibili](https://www.bilibili.com/video/REPLACE_ID)

---

**Claude Code is the spaceship. We built the cockpit.**

> "Claude Code has turned into a spaceship with 80% of functionality I have no use for. Basically no harness allows inspecting every aspect of interactions with the model."
>
> — Mario Zechner, [*What I learned building an opinionated and minimal coding agent*](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

`session-devtools` is that harness.

> **Alpha** · Claude Code 2.x · Local-only · Your data never leaves your machine.

---

## The hidden loop

Your terminal shows the final answer. What produced it stays invisible.

A single Claude Code turn often hides:

- multiple **LLM calls**
- a dozen **tool calls**
- **sub-agents** exploring in their own context
- silently injected instructions
- a context compaction

Think of it as browser DevTools — but for LLM interactions.

Click into any call to see the full context window, with every chunk attributed to its source: which system prompt block, which tool result, which prior turn contributed which tokens. Diff two adjacent calls to find exactly what changed. Trace every sub-agent from parent to child and back.

Not just *what Claude said* — but *what it was looking at when it said it*.


---

## One command

```bash
npx session-devtools
```

Node 22+. Opens [http://localhost:5173](http://localhost:5173) automatically. **Nothing is uploaded.**

Or install globally:

```bash
npm i -g session-devtools
session-devtools
```

---

## What you can inspect

| Capability | What you actually see |
|---|---|
| **Full call hierarchy** | Session → Turn → LLM Call → Tool Call → Tool Result. Every layer is a link, not a log line. |
| **Context attribution** | For any LLM call: every chunk in the context window, labeled by source — system prompt block, tool result, injected instruction, prior turn. |
| **Call-to-call diff** | Exactly what was added or dropped between two adjacent LLM calls. Catch silent context injections. |
| **Sub-agent trace** | Full parent → child delegation: what the parent handed off, what the child actually ran, what came back. |
| **Response decomposition** | Which content blocks composed the final answer, and in what order. |

---

## Try it in 60 seconds

First, start `session-devtools`. Then open Claude Code in any repo you want to inspect and run:

```text
Use a subagent to inspect this repository and answer one question:
What are the three files most responsible for turning a raw Claude Code session
into the call-level drilldown UI?

Do not edit files. The subagent should return file paths and one-sentence reasons.
After it returns, summarize the answer in a short table.
```

Once it finishes, switch back to `session-devtools` and look at:

- the LLM call where the parent **decided to delegate**
- the sub-agent's **own tool chain**
- the **handoff** back to the parent
- where the parent's **next call** sourced its context from

One run, and "what a sub-agent really is" stops being abstract.

---

## CLI flags

```
session-devtools --port <n>        # default 5173
                 --data-dir <path> # default ~/.api-dashboard
                 --no-open         # don't open browser
                 --quiet           # suppress logs
                 --no-proxy        # skip MITM proxy install (disables attribution)
```

---

## Context attribution

**Attribution is on by default.** On first launch, `session-devtools` installs a local MITM proxy that captures Claude Code's outbound requests — this is what makes per-chunk attribution possible. The proxy runs locally; nothing leaves your machine.

What it does:

1. Adds a proxy entry to `~/.claude/settings.json`
2. Intercepts request bodies from Claude Code on subsequent sessions
3. Stores them locally alongside session data

**Start a new Claude Code session after first launch** — existing sessions won't have request data and will show `Attribution requires proxy data`.

To opt out:

```bash
session-devtools --no-proxy
```

Attribution will show `Attribution requires proxy data` for all sessions.

---

## Alpha caveats (honest)

- **Claude Code 2.x first.** Codex / Gemini are not supported yet.
- **Attribution** needs the MITM proxy (installed on first launch, opt out with `--no-proxy`).
- **No cloud upload.** Data stays local in `~/.api-dashboard/sessions.db`.

---

## Requirements

- Node.js v22+
- Claude Code (for session data)

Session data is read automatically from `~/.claude/projects/**/*.jsonl`.
Override the data dir with `API_DASHBOARD_DIR=/your/path`.

When a new version is published, `session-devtools` prints an update notice on next launch.
Upgrade with `npm i -g session-devtools@latest`.

---

## Development

```bash
git clone https://github.com/tony-shi/session-devtools
cd session-devtools
npm install
npm run dev          # start server + client with hot reload
npm run build        # production build (server + client)
npx tsc --noEmit     # type check
cd client && npm run lint
```

---

## License

[MIT](LICENSE)

---

> **Agents harness the LLM. You harness the agent.**

If this resonates, **star the repo** — and open a [discussion](https://github.com/tony-shi/session-devtools/discussions) for what you'd want to inspect next.
