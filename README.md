# Session Dashboard

A local desktop dashboard for visualizing AI coding agent sessions. Parses conversation logs from Claude Code, Codex CLI, and Gemini CLI, stores them in SQLite, and presents them in a React UI.

![CI](https://github.com/tony-shi/session-dashboard/actions/workflows/ci.yml/badge.svg)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Features

- **Multi-agent support** — parses Claude Code, Codex CLI, and Gemini CLI session files
- **Session timeline** — turn-by-turn view with tool calls, token usage, and timing
- **Span tree** — nested agent/subagent call visualization via `packages/agent-viz`
- **Context fill timeline** — tracks how context window fills up across a session
- **Daily digest** — LLM-generated summaries of your daily coding sessions
- **Incremental sync** — background file watcher, only re-parses changed files

## Requirements

- [Bun](https://bun.sh) v1.1+
- One or more of: Claude Code, Codex CLI, Gemini CLI (for session data)

## Quick Start

```bash
git clone https://github.com/tony-shi/session-dashboard
cd session-dashboard
bun install
cd client && bun install && cd ..
bun run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Configuration

Session data is read automatically from the default CLI locations:

| Tool | Path |
|------|------|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` |
| Gemini CLI | `~/.gemini/tmp/session-*.json` |

The database is stored at `~/.api-dashboard/sessions.db`. Override with `API_DASHBOARD_DIR`.

### Daily Digest (optional)

Copy `digest.cfg.example` to `digest.cfg` and fill in your API key:

```bash
cp digest.cfg.example digest.cfg
# edit digest.cfg: set token and enabled = true
```

`digest.cfg` is gitignored and never committed. You can also use environment variables:

```bash
ANTHROPIC_API_KEY=sk-... ANTHROPIC_BASE_URL=https://api.anthropic.com bun run start
```

## Architecture

```
session-dashboard/
├── server/                 Bun HTTP server
│   └── src/
│       ├── db.ts           SQLite schema + write serialization
│       ├── sync.ts         File discovery + incremental sync
│       ├── parsers/        JSONL parsers (claude / codex / gemini)
│       ├── digest.ts       Daily digest generation
│       └── routes.ts       REST API routes
├── client/                 React 19 + Tailwind v4 frontend
│   └── src/
│       ├── App.tsx         Root state management
│       ├── api.ts          Fetch wrapper
│       └── components/     UI components
└── packages/
    └── agent-viz/          Span tree visualization library
```

**Tech stack:** Bun · React 19 · Tailwind v4 · Vite · SQLite (bun:sqlite)

## Development

```bash
bun run dev          # start server + client with hot reload
bun run build        # production build of client
bun run start        # run server only (serves built client)
```

After modifying a parser, force a re-sync for a specific date:

```
GET /api/sessions/sync?date=YYYY-MM-DD
```

## Roadmap

- [ ] Electron packaging for true desktop app
- [ ] TurnProvenance view — per-turn context attribution (system / tools / messages)
- [ ] Proxy dump integration for exact token accounting
- [ ] Export sessions to CSV / JSON
- [ ] Multi-machine sync via optional remote SQLite

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs are welcome — please open an issue first for significant changes.

## License

[MIT](LICENSE)
