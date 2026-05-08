# Contributing

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Stable releases. Protected — merge via PR only. |
| `develop` | Active development. Daily iteration happens here. |
| `feature/*` | Feature branches cut from `develop`. |
| `fix/*` | Bug fix branches. |

**Flow:** `feature/xyz` → PR → `develop` → PR → `main` (tagged release)

## Getting Started

```bash
git clone https://github.com/tony-shi/session-dashboard
cd session-dashboard
npm install
npm run dev
```

## Making Changes

1. Cut a branch from `develop`: `git checkout -b feature/my-feature develop`
2. Make your changes
3. Verify type check: `npx tsc --noEmit` and `cd client && npm run lint`
4. Open a PR against `develop`

## Commit Style

```
type: short description in imperative mood

feat:     new feature
fix:      bug fix
refactor: code restructure without behavior change
style:    formatting only
chore:    tooling, deps, config
docs:     documentation only
```

## Parser Development

Each parser lives in `server/src/parsers/` and must export a function matching:

```ts
(filePath: string) => Promise<{ session: Session; turns: Turn[] }>
```

After modifying a parser, force re-sync to test:
```
GET /api/sessions/sync?date=YYYY-MM-DD
```

## Reporting Issues

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include your OS, Node.js version, and the relevant CLI tool.
