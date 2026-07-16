#!/usr/bin/env bash
# Preflight: report whether the agent backend is fully configured to run.
# Prints only key PRESENCE (set / EMPTY), never the secret values.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_HINT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_NODE_BIN="$REPO_HINT/.tooling/node/bin"
[ -d "$LOCAL_NODE_BIN" ] && export PATH="$LOCAL_NODE_BIN:$PATH"
NODE_BIN="$(command -v node 2>/dev/null || true)"
RUNTIME_PATHS_MODULE="$REPO_HINT/domains/agent/code/agent-runtime/lib/runtime-paths.mjs"
if [ -n "$NODE_BIN" ]; then
  ROOT_DIR="$("$NODE_BIN" "$RUNTIME_PATHS_MODULE" --print repoRoot)"
else
  ROOT_DIR="$REPO_HINT"
fi
ENV_FILE="$ROOT_DIR/.env"
DAEMON_PORT="${WECHAT_AGENT_DAEMON_PORT:-8797}"

# Prefer the project-local Node runtime if present.
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
if [ -d "$ROOT_DIR/domains/agent/code/agent-runtime/node_modules/@earendil-works" ]; then
  echo "$ok agent-runtime dependencies installed"
else
  echo "$bad dependencies missing — run: (cd domains/agent/code/agent-runtime && npm install)"
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
if [ -n "$NODE_BIN" ]; then
  if "$NODE_BIN" -e '
    fetch(`http://127.0.0.1:${process.argv[1]}/health`).then(async response => {
      if (!response.ok) process.exit(1);
      const daemon=(await response.json()).daemon || {};
      process.exit(daemon.owner==="looloomi-agent-runtime" && daemon.runtimeOwner==="repository-runtime-agent-v1" ? 0 : 1);
    }).catch(() => process.exit(1));
  ' "$DAEMON_PORT" >/dev/null 2>&1; then
    echo "$ok daemon responding on 127.0.0.1:$DAEMON_PORT"
  else
    echo "$warn owned daemon not running — start: scripts/start-agent-daemon.sh"
  fi
fi

echo "-------------------------------------------"
echo "When all required rows are $ok, the Swift app's 后台服务 will show connected."
