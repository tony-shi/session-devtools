#!/usr/bin/env bash
# 在 tmp/skill-demo-todos/ 下生成几个含 TODO/FIXME/XXX/HACK 的样本文件
# 让 demo 现场必有内容可扫，不会冷场
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
DEST="$REPO_ROOT/tmp/skill-demo-todos"

mkdir -p "$DEST"

cat > "$DEST/auth.ts" <<'EOF'
// TODO: 切到 OAuth2，PRD-1421
export function login(user: string) {
  // FIXME: 这里有 race condition，登录并发会丢 session
  return validate(user);
}

// XXX: validate 函数还没实现
function validate(_user: string) {
  return true;
}
EOF

cat > "$DEST/cache.ts" <<'EOF'
// HACK: 临时把缓存 TTL 改成 1 秒做调试，记得改回 300
const TTL = 1;

// TODO: 接入 Redis cluster
export const ttl = TTL;
EOF

cat > "$DEST/parser.ts" <<'EOF'
// TODO: 支持新的 streaming chunk 格式
// FIXME: 错误处理路径会吞掉原始 stack
export function parseChunk(input: string) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}
EOF

cat > "$DEST/utils.go" <<'EOF'
package utils

// TODO: 把这个工具方法挪到 internal/strings
func Reverse(s string) string {
    runes := []rune(s)
    for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
        runes[i], runes[j] = runes[j], runes[i]
    }
    return runes
}
EOF

echo "Seeded demo TODOs in: $DEST"
echo "Cleanup: rm -rf $DEST"
