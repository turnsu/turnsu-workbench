#!/usr/bin/env bash
# Deterministic launcher: rebuild the current app bundle, start the local agent daemon,
# then open the latest bundle. This avoids stale .app bundles showing old UI.
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

echo "WeChat Intelligence Radar — latest launch"
echo "重建当前 release app bundle…"
if "$ROOT_DIR/scripts/build-release-app-bundle.sh"; then
  APP_DIR="$ROOT_DIR/.build/release-app/WeChatIntelligenceRadar.app"
else
  echo "release 构建失败，回退到 debug bundle…"
  "$ROOT_DIR/scripts/build-debug-app-bundle.sh"
  APP_DIR="$ROOT_DIR/.build/debug-app/WeChatIntelligenceRadar.app"
fi

if command -v node >/dev/null 2>&1; then
  echo "启动本地 Agent daemon…"; "$ROOT_DIR/scripts/start-agent-daemon.sh" || true
else
  echo "提示：未找到 Node，daemon 与实时功能不可用（界面仍可打开）。"
fi

echo "关闭旧应用窗口（仅限同 bundle / 当前项目构建）…"
osascript -e 'tell application id "local.wechat-intelligence-radar.mvp" to quit' >/dev/null 2>&1 || true
sleep 1
if command -v pgrep >/dev/null 2>&1; then
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && kill "$pid" >/dev/null 2>&1 || true
  done < <(pgrep -f "$ROOT_DIR/.build/.*/WeChatIntelligenceRadar.app/Contents/MacOS/WeChatIntelligenceRadar" || true)
fi

echo "打开应用：$APP_DIR"
open "$APP_DIR"
echo "完成。可关闭此终端窗口；daemon 在后台独立运行。停止 daemon：scripts/stop-agent-daemon.sh"
