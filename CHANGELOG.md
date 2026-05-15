# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-alpha.1] - 2026-05-15

### Added
- First public npm release as `session-devtools`
- Single-binary CLI: `npm i -g session-devtools` then `session-devtools` to launch
- Built-in update notification via `update-notifier` (checks once per 24h)
- Bundled server (`dist/server.js`) + MITM proxy (`dist/proxy-server.js`) via tsup
- Session parsing for Claude Code (Codex / Gemini session list also supported, attribution Claude-only)
- SQLite-backed session storage with incremental sync (`better-sqlite3` as runtime dep)
- React dashboard: session list, turn timeline, summary cards, context attribution tree, diff panel
- Request-side context attribution from proxy capture
- Daily digest generation via Anthropic-compatible LLM API

### Notes
- Alpha: Claude Code 2.x only; attribution requires the proxy dump.
- Requires Node.js >= 22; supports macOS arm64/x64, Linux x64/arm64.
