#!/bin/zsh
set -euo pipefail

PROJECT_DIR="/Users/wuge/Desktop/open"
NODE_BIN="/opt/homebrew/bin/node"
LOG_DIR="$PROJECT_DIR/logs"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"

if [ ! -x "$NODE_BIN" ]; then
  echo "node not found at $NODE_BIN" >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/dist/server.js" ]; then
  echo "dist/server.js not found; run npm run build first" >&2
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOST="127.0.0.1"
export PORT="5728"

exec "$NODE_BIN" "$PROJECT_DIR/dist/server.js"
