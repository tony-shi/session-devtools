#!/usr/bin/env bash
# 仅清理 install.sh 建立的符号链接，不会动你自己的 skill
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

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

remove_if_symlink "$REPO_ROOT/.claude/skills/todo-scan"
remove_if_symlink "$REPO_ROOT/.claude/skills/todo-scan-fork"
remove_if_symlink "$REPO_ROOT/.claude/skills/todo-scan-args"
remove_if_symlink "$REPO_ROOT/.claude/skills/todo-scan-html"

echo
echo "卸载完成。如执行过 seed-todos.sh，记得：rm -rf tmp/skill-demo-todos"
