#!/usr/bin/env bash
# Runs when Claude Code removes a worktree.
# Prints a cleanup hint for the isolated DB directory — does NOT auto-delete.
set -euo pipefail

WORKTREE_PATH="${CLAUDE_WORKTREE_PATH:-}"
ENV_FILE="$WORKTREE_PATH/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  exit 0
fi

DB_DIR=$(grep '^API_DASHBOARD_DIR=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d ' ')

if [[ -n "$DB_DIR" && -d "$DB_DIR" ]]; then
  echo "[worktree-remove] DB directory left on disk: $DB_DIR"
  echo "[worktree-remove] To delete it: rm -rf $DB_DIR"
fi
