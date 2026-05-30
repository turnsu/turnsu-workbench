#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/runtime/agent"
LOG_DIR="$RUNTIME_DIR/logs"
PID_FILE="$RUNTIME_DIR/daemon.pid"

mkdir -p "$LOG_DIR"

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid||"")}catch{console.log("")}' "$PID_FILE")"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "wechat-agent-daemon already running pid=$EXISTING_PID"
    exit 0
  fi
fi

cd "$ROOT_DIR"
nohup node agent-runtime/bin/wechat-agent-daemon.mjs > "$LOG_DIR/daemon.log" 2>&1 &
PID="$!"
disown "$PID" 2>/dev/null || true
sleep 0.5
echo "wechat-agent-daemon started pid=$PID"
echo "log=$LOG_DIR/daemon.log"
