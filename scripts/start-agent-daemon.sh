#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/runtime/agent"
LOG_DIR="$RUNTIME_DIR/logs"
PID_FILE="$RUNTIME_DIR/daemon.pid"
AUTH_FILE="$RUNTIME_DIR/auth-token.json"
APP_SUPPORT_AUTH_FILE="$HOME/Library/Application Support/WeChatIntelligenceRadarMVP/runtime/agent/auth-token.json"
DAEMON_PORT="${WECHAT_AGENT_DAEMON_PORT:-8797}"
LAUNCH_LABEL="local.looloomi.agent-daemon"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_PLIST="$LAUNCH_AGENT_DIR/$LAUNCH_LABEL.plist"

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
if [[ ! -f "$AUTH_FILE" ]]; then
  node -e 'const fs=require("fs"); const crypto=require("crypto"); const path=process.argv[1]; const payload={schemaVersion:"agent-daemon-auth-token-v1",token:crypto.randomBytes(32).toString("base64url"),audience:"local-swift-client",createdAt:new Date().toISOString()}; fs.mkdirSync(require("path").dirname(path),{recursive:true}); fs.writeFileSync(path, JSON.stringify(payload,null,2)+"\n", {mode:0o600});' "$AUTH_FILE"
  chmod 600 "$AUTH_FILE" 2>/dev/null || true
fi
mkdir -p "$(dirname "$APP_SUPPORT_AUTH_FILE")"
cp "$AUTH_FILE" "$APP_SUPPORT_AUTH_FILE"
chmod 600 "$APP_SUPPORT_AUTH_FILE" 2>/dev/null || true
if [[ ! -d "$ROOT_DIR/agent-runtime/node_modules" || ! -d "$ROOT_DIR/agent-runtime/node_modules/mongodb" ]]; then
  echo "• Installing agent-runtime dependencies (npm install)…"
  (cd "$ROOT_DIR/agent-runtime" && npm install)
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "✗ Docker not found. Local MongoDB is required for Agent sessions/tasks/runs." >&2
  exit 1
fi
echo "• Ensuring local MongoDB is running…"
(cd "$ROOT_DIR" && docker compose up -d mongodb)

ENV_ARGS=()
if [[ -f "$ROOT_DIR/.env" ]]; then
  ENV_ARGS=(--env-file "$ROOT_DIR/.env")
  echo "• Loading secrets from .env"
else
  echo "• No .env found — model providers will report 'not ready'. Copy .env.example to .env and add keys."
fi

# --- Already running? -----------------------------------------------------
health_ok() {
  node -e 'const port=process.argv[1]; fetch(`http://127.0.0.1:${port}/health`).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));' "$DAEMON_PORT" >/dev/null 2>&1
}

wait_for_health() {
  for _ in {1..120}; do
    if health_ok; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

launch_in_terminal() {
  local cmd="cd \"$ROOT_DIR\"; \"$NODE_BIN\""
  if [[ -f "$ROOT_DIR/.env" ]]; then
    cmd="$cmd --env-file \"$ROOT_DIR/.env\""
  fi
  cmd="$cmd agent-runtime/bin/wechat-agent-daemon.mjs"
  local escaped="${cmd//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  osascript -e "tell application \"Terminal\" to do script \"$escaped\"" >/dev/null
}

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid||"")}catch{console.log("")}' "$PID_FILE")"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null && health_ok; then
    echo "wechat-agent-daemon already running pid=$EXISTING_PID"
    exit 0
  fi
fi

# --- Launch ---------------------------------------------------------------
cd "$ROOT_DIR"
NODE_BIN="$(command -v node)"
mkdir -p "$LAUNCH_AGENT_DIR"
ENV_PLIST_ARGS=""
if [[ -f "$ROOT_DIR/.env" ]]; then
  ENV_PLIST_ARGS="    <string>--env-file</string>
    <string>$ROOT_DIR/.env</string>"
fi
cat > "$LAUNCH_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCH_LABEL</string>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
$ENV_PLIST_ARGS
    <string>agent-runtime/bin/wechat-agent-daemon.mjs</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/daemon.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LAUNCH_LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_PLIST"
launchctl kickstart -k "gui/$(id -u)/$LAUNCH_LABEL" >/dev/null 2>&1 || true
if ! wait_for_health; then
  launchctl bootout "gui/$(id -u)/$LAUNCH_LABEL" >/dev/null 2>&1 || true
  echo "• LaunchAgent did not stay healthy; starting daemon in Terminal…"
  launch_in_terminal
fi
if ! wait_for_health; then
  echo "✗ wechat-agent-daemon did not become healthy on 127.0.0.1:$DAEMON_PORT" >&2
  tail -40 "$LOG_DIR/daemon.log" >&2 || true
  exit 1
fi
PID="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid||"")}catch{console.log("")}' "$PID_FILE")"
echo "wechat-agent-daemon started pid=$PID"
echo "log=$LOG_DIR/daemon.log"
