#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/runtime/agent"
LOG_DIR="$RUNTIME_DIR/logs"
PID_FILE="$RUNTIME_DIR/daemon.pid"

# Prefer the project-local Node runtime (installed under .tooling/node) if present.
LOCAL_NODE_BIN="$ROOT_DIR/.tooling/node/bin"
[[ -d "$LOCAL_NODE_BIN" ]] && export PATH="$LOCAL_NODE_BIN:$PATH"

mkdir -p "$LOG_DIR"

# --- Preflight: Node, dependencies, secrets -------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js not found. Install Node >= 22.19.0 first:" >&2
  echo "    nvm install 22   # or download from https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "✗ Node $(node -v) is too old; the runtime needs >= 22.19.0." >&2
  exit 1
fi
if [[ ! -d "$ROOT_DIR/agent-runtime/node_modules" ]]; then
  echo "• Installing agent-runtime dependencies (npm install)…"
  (cd "$ROOT_DIR/agent-runtime" && npm install)
fi

ENV_ARGS=()
if [[ -f "$ROOT_DIR/.env" ]]; then
  ENV_ARGS=(--env-file "$ROOT_DIR/.env")
  echo "• Loading secrets from .env"
else
  echo "• No .env found — model providers will report 'not ready'. Copy .env.example to .env and add keys."
fi

# --- Already running? -----------------------------------------------------
if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid||"")}catch{console.log("")}' "$PID_FILE")"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "wechat-agent-daemon already running pid=$EXISTING_PID"
    exit 0
  fi
fi

# --- Launch ---------------------------------------------------------------
cd "$ROOT_DIR"
nohup node "${ENV_ARGS[@]}" agent-runtime/bin/wechat-agent-daemon.mjs > "$LOG_DIR/daemon.log" 2>&1 &
PID="$!"
disown "$PID" 2>/dev/null || true
sleep 0.5
echo "wechat-agent-daemon started pid=$PID"
echo "log=$LOG_DIR/daemon.log"
