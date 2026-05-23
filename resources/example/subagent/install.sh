#!/usr/bin/env bash
# 把 code-reviewer subagent 符号链接到 .claude/agents/
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$REPO_ROOT/resources/example/subagent"

AGENT_DEST="$REPO_ROOT/.claude/agents/code-reviewer.md"

mkdir -p "$REPO_ROOT/.claude/agents"

link_or_skip() {
  local target="$1" src="$2"
  if [ -L "$target" ]; then
    echo "[skip] $target (already a symlink)"
  elif [ -e "$target" ]; then
    echo "[warn] $target exists and is not a symlink — leaving alone"
  else
    ln -s "$src" "$target"
    echo "[link] $target -> $src"
  fi
}

link_or_skip "$AGENT_DEST" "$SRC/agents/code-reviewer.md"

echo
echo "Done."
echo "重启 Claude Code 后："
echo "  · 委派任务：让 code-reviewer 审一下 <某个文件>"
echo "  · 主 Claude 会调用 Agent 工具，subagent_type=code-reviewer"
