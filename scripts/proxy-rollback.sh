#!/usr/bin/env bash
# 紧急回滚脚本：还原 ~/.claude/settings.json + 停代理 + 清 ~/.api-dashboard/proxy/。
# 用法：bash scripts/proxy-rollback.sh                  （交互式选择最新备份）
#       bash scripts/proxy-rollback.sh <备份路径>        （直接还原指定备份）
#
# API_DASHBOARD_DIR=/path 可改写默认目录（与代理本身保持一致）。
set -euo pipefail

API_DASHBOARD_DIR="${API_DASHBOARD_DIR:-$HOME/.api-dashboard}"
BACKUP_DIR="$API_DASHBOARD_DIR/backups"
SETTINGS="$HOME/.claude/settings.json"
PROXY_HOME="$API_DASHBOARD_DIR/proxy"

# 兼容旧路径（早期手测残留）：~/.ourtool* — 仅用作 fallback 备份源 / 清理目标。
LEGACY_BACKUP_DIR="$HOME/.ourtool-backups"
LEGACY_PROXY_HOME="$HOME/.ourtool"

if [ "${1:-}" != "" ]; then
  pick="$1"
else
  pick=""
  for dir in "$BACKUP_DIR" "$LEGACY_BACKUP_DIR"; do
    [ -d "$dir" ] || continue
    candidate=$(ls -t "$dir"/settings.json.before-mitm-* 2>/dev/null | head -1 || true)
    if [ -n "$candidate" ]; then pick="$candidate"; break; fi
  done
  if [ -z "$pick" ]; then
    echo "× 未找到任何 settings 备份。手动检查 $BACKUP_DIR / $LEGACY_BACKUP_DIR"
    exit 1
  fi
fi

if [ ! -f "$pick" ]; then
  echo "× 备份不存在: $pick"
  exit 1
fi

echo "↩ 选择备份: $pick"

# 1. 停掉代理（如有 pid 文件，新旧路径都看一眼）
for ph in "$PROXY_HOME" "$LEGACY_PROXY_HOME"; do
  if [ -f "$ph/proxy.pid" ]; then
    pid=$(cat "$ph/proxy.pid" || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "↩ 停止代理 pid=$pid (from $ph)"
      kill "$pid" || true
      sleep 1
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" || true
    fi
  fi
done

# 2. 还原 settings（先存一份当前状态做"回滚的回滚"）
mkdir -p "$BACKUP_DIR"
if [ -f "$SETTINGS" ]; then
  cp -p "$SETTINGS" "$BACKUP_DIR/settings.json.pre-rollback-$(date +%Y%m%d-%H%M%S)"
fi
cp -p "$pick" "$SETTINGS"
echo "✓ 已还原 settings.json"

# 3. 清 proxy 目录（CA + 私钥 + 日志），新旧路径都清
for ph in "$PROXY_HOME" "$LEGACY_PROXY_HOME"; do
  if [ -d "$ph" ]; then
    rm -rf "$ph"
    echo "✓ 已删除 $ph"
  fi
done

echo
echo "回滚完成。重启 Claude Code 后即恢复原状。"
