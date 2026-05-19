#!/usr/bin/env bash
# 等待本地 server 健康后再启动 client
PORT=${PORT:-5051}
MAX_WAIT=30
elapsed=0

echo "[wait-server] waiting for server on port $PORT..."
until curl -sf "http://localhost:$PORT/api/v2/summary" > /dev/null 2>&1; do
  if [ $elapsed -ge $MAX_WAIT ]; then
    echo "[wait-server] timeout after ${MAX_WAIT}s, starting client anyway"
    break
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "[wait-server] server ready (${elapsed}s), starting client"
cd client && npm run dev
