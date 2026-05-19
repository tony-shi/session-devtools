#!/usr/bin/env bash
set -euo pipefail

# scripts/test-release.sh
# 从 GitHub 远程拉指定 ref（默认 main）到 /tmp 下，完整模拟一次发布消费链路：
#   git clone → npm ci → npm run build → npm pack → 在独立目录 npm i 该 tarball
#   → 启动 session-devtools → smoke 测试 server 是否监听端口
#
# 目的：在与本地工作目录完全隔离的环境里，验证发布脚本/产物对普通用户可用。
#
# 用法:
#   scripts/test-release.sh                  # 拉 main
#   scripts/test-release.sh --ref v0.1.0     # 指定 tag/branch/sha
#   scripts/test-release.sh --keep           # 成功后保留临时目录
#   scripts/test-release.sh --repo <url>     # 覆盖默认 repo URL

cd "$(dirname "$0")/.."

REF="main"
KEEP=0
REPO_URL=$(node -p "require('./package.json').repository.url.replace(/^git\\+/, '')")

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)  REF="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help)
      sed -n '3,15p' "$0"; exit 0 ;;
    *) echo "[test-release] 未知参数: $1" >&2; exit 2 ;;
  esac
done

# 选一个空闲端口，避开本地可能在跑的 5173 dev server
TEST_PORT=$(node -e "
const net = require('node:net');
const s = net.createServer();
s.listen(0, () => { const p = s.address().port; s.close(() => console.log(p)); });
")

WORK=$(mktemp -d "/tmp/session-devtools-release.XXXXXX")
SRC="$WORK/src"
INSTALL="$WORK/install"
SERVER_PID=""

cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ $code -eq 0 ] && [ $KEEP -eq 0 ]; then
    rm -rf "$WORK"
    echo "[test-release] ✅ 全链路通过，已清理 $WORK"
  elif [ $code -eq 0 ]; then
    echo "[test-release] ✅ 全链路通过，保留 $WORK (--keep)"
  else
    echo "[test-release] ❌ 失败 (exit=$code)，保留工作目录用于调试:" >&2
    echo "    $WORK" >&2
  fi
}
trap cleanup EXIT

echo "[test-release] repo: $REPO_URL"
echo "[test-release] ref : $REF"
echo "[test-release] work: $WORK"
echo "[test-release] port: $TEST_PORT"
echo

# ── 1. 远程 clone（浅克隆，加速）─────────────────────────────────────────────
echo "[test-release] === 1/6 git clone --depth 1 --branch $REF ==="
git clone --depth 1 --branch "$REF" "$REPO_URL" "$SRC"

# ── 2. 干净环境装依赖 ───────────────────────────────────────────────────────
echo
echo "[test-release] === 2/6 npm ci ==="
cd "$SRC"
npm ci

# ── 3. 完整 build（server tsup + client vite）───────────────────────────────
echo
echo "[test-release] === 3/6 npm run build ==="
npm run build

# 显式校验 build 产物，避免 build 静默成功但路径错位
for required in "dist/server.js" "dist/proxy-server.js" "dist/public/index.html"; do
  if [ ! -e "$SRC/$required" ]; then
    echo "[test-release] ❌ build 产物缺失: $required" >&2
    exit 3
  fi
done
echo "[test-release] build 产物校验通过 (dist/server.js, dist/proxy-server.js, dist/public/index.html)"

# ── 4. 打 tarball（prepack 会再跑一次 build，模拟 publish 真实路径）──────────
echo
echo "[test-release] === 4/6 npm pack ==="
npm pack
TGZ=$(ls -1 session-devtools-*.tgz | head -1)
if [ -z "$TGZ" ]; then
  echo "[test-release] ❌ 未找到 npm pack 产物 session-devtools-*.tgz" >&2
  exit 4
fi
echo "[test-release] tarball: $TGZ ($(du -h "$TGZ" | cut -f1))"

# ── 5. 在独立目录里以普通用户身份安装 tarball ───────────────────────────────
echo
echo "[test-release] === 5/6 npm install <tarball> (clean dir) ==="
mkdir -p "$INSTALL"
cd "$INSTALL"
npm init -y >/dev/null
npm install "$SRC/$TGZ"

BIN="$INSTALL/node_modules/.bin/session-devtools"
if [ ! -x "$BIN" ]; then
  echo "[test-release] ❌ 安装后未找到可执行 bin: $BIN" >&2
  exit 5
fi

# ── 6. smoke 启动 ─────────────────────────────────────────────────────────
echo
echo "[test-release] === 6/6 smoke: 启动 session-devtools --port $TEST_PORT --no-open --quiet ==="
"$BIN" --port "$TEST_PORT" --no-open --quiet >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

# 等 server 在端口上接受 TCP 连接；HTTP 状态码不限（4xx/5xx 也算起来了）
READY=0
for i in $(seq 1 30); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[test-release] ❌ server 进程在启动期间退出，日志:" >&2
    sed 's/^/    /' "$WORK/server.log" >&2 || true
    exit 6
  fi
  if curl -sS --connect-timeout 2 -o /dev/null "http://localhost:$TEST_PORT/" 2>/dev/null; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "[test-release] ❌ server 在 30s 内未监听 :$TEST_PORT，日志:" >&2
  sed 's/^/    /' "$WORK/server.log" >&2 || true
  exit 7
fi

echo "[test-release] ✅ server 在端口 $TEST_PORT 接受连接"
echo "[test-release] 日志: $WORK/server.log"
