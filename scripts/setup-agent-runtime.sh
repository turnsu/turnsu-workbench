#!/usr/bin/env bash
# Preflight: report whether the agent backend is fully configured to run.
# Prints only key PRESENCE (set / EMPTY), never the secret values.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
DAEMON_PORT="8797"

# Prefer the project-local Node runtime if present.
LOCAL_NODE_BIN="$ROOT_DIR/.tooling/node/bin"
[ -d "$LOCAL_NODE_BIN" ] && export PATH="$LOCAL_NODE_BIN:$PATH"
ok="✓"; bad="✗"; warn="•"

echo "WeChat x On-chain Agent Runtime — preflight"
echo "-------------------------------------------"

# Node
if command -v node >/dev/null 2>&1; then
  NV="$(node -v)"; MAJ="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$MAJ" -ge 22 ]; then echo "$ok Node $NV"; else echo "$bad Node $NV (need >= 22.19.0)"; fi
else
  echo "$bad Node.js not installed — run: nvm install 22  (or https://nodejs.org)"
fi

# Dependencies
if [ -d "$ROOT_DIR/agent-runtime/node_modules/@earendil-works" ]; then
  echo "$ok agent-runtime dependencies installed"
else
  echo "$bad dependencies missing — run: (cd agent-runtime && npm install)"
fi

# .env + keys (presence only)
key_status() {
  local k="$1" v
  v="$(grep -E "^$k=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  [ -n "$v" ] && echo "set" || echo "EMPTY"
}
if [ -f "$ENV_FILE" ]; then
  echo "$ok .env present"
  echo "    DEEPSEEK_API_KEY: $(key_status DEEPSEEK_API_KEY)  (required for reasoning)"
  echo "    KIMI_API_KEY:     $(key_status KIMI_API_KEY)  (optional, image analysis)"
else
  echo "$bad .env missing — run: cp .env.example .env  then add keys"
fi

# Daemon health
if command -v curl >/dev/null 2>&1; then
  if curl -sf --max-time 2 "http://127.0.0.1:$DAEMON_PORT/health" >/dev/null 2>&1; then
    echo "$ok daemon responding on 127.0.0.1:$DAEMON_PORT"
  else
    echo "$warn daemon not running — start: scripts/start-agent-daemon.sh"
  fi
fi

echo "-------------------------------------------"
echo "When all required rows are $ok, the Swift app's 后台服务 will show connected."
