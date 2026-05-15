# session-devtools

session-devtools is a local devtools UI for AI coding sessions.
It currently focuses on Claude Code sessions and request-side context attribution.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Alpha** — Claude Code 2.x only. Attribution requires proxy dump.

## Install

```bash
npm i -g session-devtools
session-devtools
```

Opens [http://localhost:5173](http://localhost:5173) automatically. Requires Node.js >= 22.

CLI flags:

```
session-devtools --port <n>        # default 5173
                 --data-dir <path> # default ~/.api-dashboard
                 --no-open         # don't open browser
                 --quiet           # suppress logs
```

When a new version is published, `session-devtools` prints an update notice on next launch.
Upgrade with `npm i -g session-devtools@latest`.

## What it does

- **Session list** — reads local Claude Code JSONL files, aggregates by date
- **Session detail** — turn timeline with tool calls and token usage
- **Context attribution** — per-request attribution coverage (requires proxy dump)
- **Proxy management** — install/uninstall the local MITM proxy, view captured traffic

## Proxy setup (required for attribution)

Attribution is based on the actual request body captured by a local MITM proxy.
Without it, the session list and turn timeline still work, but attribution shows:

> Attribution requires proxy dump.

To enable:

1. Open the **代理管理** (Proxy Setup) tab in the UI
2. Click **Install** to configure the proxy in `~/.claude/settings.json`
3. Start a new Claude Code session — requests are captured automatically

## Alpha limitations

- Claude Code first (Codex/Gemini session list works, attribution not yet supported)
- Attribution requires proxy dump
- Request-side attribution only (response attribution not yet supported)
- Codex/Gemini attribution not yet supported
- No cloud upload; data stays local

## Requirements

- Node.js v22+
- Claude Code (for session data)

## Configuration

Session data is read automatically from `~/.claude/projects/**/*.jsonl`.

The database is stored at `~/.api-dashboard/sessions.db`. Override with `API_DASHBOARD_DIR`.

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

## License

[MIT](LICENSE)
