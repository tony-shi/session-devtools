#!/usr/bin/env bash
# 把所有 demo skill 符号链接到 .claude/skills/ 让 Claude Code 加载
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$REPO_ROOT/resources/example/skill"

mkdir -p "$REPO_ROOT/.claude/skills"

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

# 基础两幕
link_or_skip "$REPO_ROOT/.claude/skills/todo-scan"       "$SRC/todo-scan"
link_or_skip "$REPO_ROOT/.claude/skills/todo-scan-fork"  "$SRC/todo-scan-fork"

# 进阶三幕
link_or_skip "$REPO_ROOT/.claude/skills/todo-scan-args"  "$SRC/todo-scan-args"
link_or_skip "$REPO_ROOT/.claude/skills/todo-scan-html"  "$SRC/todo-scan-html"

echo
echo "Done."
echo "重启 Claude Code 后："
echo "  · 基础 · 资料模式：人话「扫一下 TODO」"
echo "  · 基础 · 任务模式：/todo-scan-fork"
echo "  · 进阶 · 参数 + 预批准：/todo-scan-args tmp/skill-demo-todos go"
echo "  · 进阶 · 打包脚本：/todo-scan-html tmp/skill-demo-todos"
echo
echo "可选：bash resources/example/skill/fixtures/seed-todos.sh  # 预埋演示样本"
