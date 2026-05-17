---
layout: default
title: session-devtools
---

# session-devtools

**Local devtools UI for AI coding sessions. Claude Code first.**

→ **[Product Walkthrough / 产品说明](./walkthrough)** — what you are seeing in the demo, feature by feature

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/tony-shi/session-devtools/blob/main/LICENSE)
[![npm](https://img.shields.io/npm/v/session-devtools)](https://www.npmjs.com/package/session-devtools)

> **Alpha** — Tested on Claude Code 2.x. Attribution requires the local proxy.

---

## What is this?

session-devtools is a local web dashboard that reads your Claude Code session files (`~/.claude/projects/**/*.jsonl`) and gives you visibility into what happened — token usage, tool calls, sub-agents, context size, and more.

No data leaves your machine.

---

## Quick start

**Run without installing:**

```bash
npx session-devtools
```

Or install globally:

```bash
npm install -g session-devtools
session-devtools
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Features

| Feature | Description |
|---|---|
| **Session list** | All Claude Code sessions with token usage, tool calls, sub-agents |
| **Session detail** | Turn-by-turn timeline, LLM call breakdown, context attribution |
| **Search** | Filter sessions by ID, name, working directory, or first message |
| **Proxy capture** | Local MITM proxy to capture exact request bodies for attribution |

---

## How attribution works

Context attribution shows exactly which prior messages contributed to the context window of each LLM call. It requires capturing the actual request body via a local proxy.

**To enable:**

1. Open the **Proxy** tab in the UI
2. Click **Install** — this adds the proxy to `~/.claude/settings.json`
3. Start a new Claude Code session — requests are captured automatically

Without the proxy, session list and turn timeline still work fully. Attribution shows a placeholder.

---

## Requirements

- Node.js v22+
- Claude Code (for session data)

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `API_DASHBOARD_DIR` | `~/.api-dashboard` | Directory for the local SQLite database |
| `PORT` | `3000` | Port the server listens on |

Session JSONL files are read from `~/.claude/projects/**/*.jsonl` automatically.

---

## Development

```bash
git clone https://github.com/tony-shi/session-devtools
cd session-devtools
npm install
npm run dev      # server + client with hot reload
```

---

## License

[MIT](https://github.com/tony-shi/session-devtools/blob/main/LICENSE)
