#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/runtime/agent/daemon.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "wechat-agent-daemon not running"
  exit 0
fi

PID="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid||"")}catch{console.log("")}' "$PID_FILE")"
if [[ -z "$PID" ]]; then
  echo "daemon pid missing"
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "wechat-agent-daemon stopped pid=$PID"
else
  echo "wechat-agent-daemon pid=$PID not active"
fi
