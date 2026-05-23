#!/usr/bin/env bash
# 仅清理 install.sh 建立的符号链接
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
AGENT_DEST="$REPO_ROOT/.claude/agents/code-reviewer.md"

remove_if_symlink() {
  local target="$1"
  if [ -L "$target" ]; then
    rm "$target"
    echo "[removed] $target"
  elif [ -e "$target" ]; then
    echo "[skip] $target exists but is not a symlink — leaving alone"
  else
    echo "[skip] $target not found"
  fi
}

remove_if_symlink "$AGENT_DEST"

echo
echo "卸载完成。"
