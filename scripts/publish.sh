#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# 显式钉住 userconfig + registry，绕开 mnpm/yarn/cnpm 等本地包装层（它们会把
# --userconfig 改到 ~/.mnpmrc，导致读不到 ~/.npmrc 里的 npmjs.org token，
# 表现为 npmjs.org 收到匿名 PUT 返回 404）。
NPMRC="${NPM_PUBLISH_USERCONFIG:-${HOME}/.npmrc}"
REGISTRY="https://registry.npmjs.org/"

if [ ! -f "$NPMRC" ]; then
  echo "[publish] ERROR: userconfig $NPMRC missing —" >&2
  echo "          run \`npm login --registry=$REGISTRY --userconfig=$NPMRC\` first." >&2
  exit 2
fi

if ! grep -q "registry.npmjs.org/:_authToken=" "$NPMRC"; then
  echo "[publish] ERROR: no npmjs.org auth token in $NPMRC —" >&2
  echo "          run \`npm login --registry=$REGISTRY --userconfig=$NPMRC\` first." >&2
  exit 2
fi

VERSION=$(node -p "require('./package.json').version")
echo "[publish] session-devtools $VERSION → $REGISTRY"
echo "[publish]   userconfig: $NPMRC"

# `command` 跳过 shell function；命令行 `--userconfig` + `--registry` 优先级
# 高于 alias 注入的参数，二者叠加足以压住本地任何 mnpm 包装层。
PUBLISH_FROM_SCRIPT=1 command npm publish \
  --userconfig="$NPMRC" \
  --registry="$REGISTRY"

echo "[publish] done."
