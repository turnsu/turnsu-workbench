#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$SOURCE_DIR/$SOURCE"
done

SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$ROOT_DIR/.build/debug-app/WeChatIntelligenceRadar.app"
HEALTH_URL="http://127.0.0.1:8797/health"

cd "$ROOT_DIR"

echo "WeChat x On-chain Agent Research OS Launcher"
echo "Project: $ROOT_DIR"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required to run the local agent daemon."
  exit 1
fi

echo "Rebuilding Research OS app bundle..."
"$ROOT_DIR/scripts/build-debug-app-bundle.sh"
echo

echo "Starting local agent daemon..."
"$ROOT_DIR/scripts/start-agent-daemon.sh"
echo

if command -v curl >/dev/null 2>&1; then
  echo "Checking daemon health..."
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    echo "Daemon health: ok"
  else
    echo "Daemon health: not ready yet. The app will still open; check runtime/agent/logs/daemon.log if needed."
  fi
  echo
fi

echo "Opening Research OS desktop app..."
if [[ "${WECHAT_RADAR_RESEARCH_OS_NO_OPEN:-0}" == "1" ]]; then
  echo "Skipped open because WECHAT_RADAR_RESEARCH_OS_NO_OPEN=1"
else
  open "$APP_DIR"
fi
echo

echo "Review hints:"
echo "- The launcher rebuilds the debug app bundle before opening, so stale UI bundles are not reused."
echo "- Open Agent 操作台 from the left sidebar for the Agent workspace."
echo "- Daemon log: $ROOT_DIR/runtime/agent/logs/daemon.log"
echo "- Runtime artifacts: $ROOT_DIR/runtime/agent"
echo "- Stop daemon: $ROOT_DIR/scripts/stop-agent-daemon.sh"
echo
echo "You can close this Terminal window after the app opens. The daemon is started independently."
