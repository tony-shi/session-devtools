# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Context fill timeline visualization
- Span tree view for agent tool calls
- Token usage tracking per turn
- Subagent chain visualization

## [0.1.0] - 2025-04-25

### Added
- Initial release
- Session parsing for Claude Code, Codex CLI, and Gemini CLI
- SQLite-backed session storage with incremental sync
- React dashboard with session list, turn timeline, and summary cards
- Daily digest generation via Anthropic-compatible LLM API
- `packages/agent-viz` library for span tree rendering
