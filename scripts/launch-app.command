#!/usr/bin/env bash
# Fast quick-launch (no rebuild): start the local agent daemon, then open the app.
# Prefers the optimized release bundle, falls back to debug.
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"; SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

LOCAL_NODE_BIN="$ROOT_DIR/.tooling/node/bin"
[[ -d "$LOCAL_NODE_BIN" ]] && export PATH="$LOCAL_NODE_BIN:$PATH"

REL="$ROOT_DIR/.build/release-app/WeChatIntelligenceRadar.app"
DBG="$ROOT_DIR/.build/debug-app/WeChatIntelligenceRadar.app"
APP_DIR="$REL"; [[ -d "$APP_DIR" ]] || APP_DIR="$DBG"

echo "WeChat Intelligence Radar — quick launch"
if [[ ! -d "$APP_DIR" ]]; then
  echo "未找到 .app，请先构建：scripts/build-release-app-bundle.sh（或 build-debug-app-bundle.sh）"
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  echo "启动本地 Agent daemon…"; "$ROOT_DIR/scripts/start-agent-daemon.sh" || true
else
  echo "提示：未找到 Node，daemon 与实时功能不可用（界面仍可打开）。"
fi

echo "打开应用：$APP_DIR"
open "$APP_DIR"
echo "完成。可关闭此终端窗口；daemon 在后台独立运行。停止 daemon：scripts/stop-agent-daemon.sh"
