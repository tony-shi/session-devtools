#!/usr/bin/env bash
# WorktreeRemove hook for Claude Code.
# Input: JSON via stdin with fields: worktree_path, cwd
# Failures are logged but cannot block removal.
set -euo pipefail

INPUT=$(cat)
WORKTREE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['worktree_path'])" 2>/dev/null || echo "")

if [[ -z "$WORKTREE_PATH" ]]; then
  exit 0
fi

ENV_FILE="$WORKTREE_PATH/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  exit 0
fi

DB_DIR=$(grep '^API_DASHBOARD_DIR=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d ' ')

if [[ -n "$DB_DIR" && -d "$DB_DIR" ]]; then
  echo "[worktree-remove] DB directory left on disk: $DB_DIR" >&2
  echo "[worktree-remove] To delete: rm -rf $DB_DIR" >&2
fi
