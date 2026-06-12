#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_SUPPORT_ROOT="$HOME/Library/Application Support/WeChatIntelligenceRadarMVP"

if [[ "${1:-}" != "--hard" || "${2:-}" != "--yes" ]]; then
  echo "usage: scripts/reset-local-runtime.sh --hard --yes" >&2
  echo "This hard-deletes local generated runtime data and resets the local MongoDB database." >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required for local MongoDB reset." >&2
  exit 1
fi

cd "$ROOT_DIR"

echo "Stopping local daemon if running..."
"$ROOT_DIR/scripts/stop-agent-daemon.sh" || true

echo "Starting local MongoDB..."
docker compose up -d mongodb

echo "Resetting MongoDB workbench collections..."
MONGODB_DB="${MONGODB_DB:-looloomi_agent}" node agent-runtime/bin/wechat-agent-daemon.mjs --admin-runtime-reset

echo "Hard-deleting generated runtime directories..."
rm -rf "$ROOT_DIR/runtime" "$APP_SUPPORT_ROOT/runtime"
mkdir -p "$ROOT_DIR/runtime/agent/logs"

echo "Restarting local daemon..."
"$ROOT_DIR/scripts/start-agent-daemon.sh"

echo "local_runtime_reset=pass"
