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
if [[ "${LOOLOOMI_NO_REBUILD:-0}" == "1" && -d "$ROOT_DIR/.build/release-app/WeChatIntelligenceRadar.app" ]]; then
  echo "跳过重建，复用现有 release app bundle…"
  APP_DIR="$ROOT_DIR/.build/release-app/WeChatIntelligenceRadar.app"
else
  echo "重建当前 release app bundle…"
  if "$ROOT_DIR/scripts/build-release-app-bundle.sh"; then
    APP_DIR="$ROOT_DIR/.build/release-app/WeChatIntelligenceRadar.app"
  else
    echo "release 构建失败，回退到 debug bundle…"
    "$ROOT_DIR/scripts/build-debug-app-bundle.sh"
    APP_DIR="$ROOT_DIR/.build/debug-app/WeChatIntelligenceRadar.app"
  fi
fi

if command -v node >/dev/null 2>&1; then
  echo "启动本地 Agent daemon…"; "$ROOT_DIR/scripts/start-agent-daemon.sh" || true
else
  echo "提示：未找到 Node，daemon 与实时功能不可用（界面仍可打开）。"
fi

if [[ "${LOOLOOMI_NO_OPEN:-0}" == "1" ]]; then
  echo "LOOLOOMI_NO_OPEN=1：已构建到 $APP_DIR，跳过关闭旧进程与 open。"
  echo "需要人工打开时，可在 Finder 或命令行手动打开该 bundle。"
  exit 0
fi

echo "关闭旧应用进程（仅限当前项目构建，不触发 AppleEvents 权限）…"
if [[ "${LOOLOOMI_NO_KILL:-0}" == "1" ]]; then
  echo "LOOLOOMI_NO_KILL=1：跳过旧应用进程清理。"
elif command -v pgrep >/dev/null 2>&1; then
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && kill "$pid" >/dev/null 2>&1 || true
  done < <(pgrep -f "$ROOT_DIR/.build/.*/WeChatIntelligenceRadar.app/Contents/MacOS/WeChatIntelligenceRadar" || true)
fi
sleep 1

echo "打开应用：$APP_DIR"
open "$APP_DIR"
echo "完成。可关闭此终端窗口；daemon 在后台独立运行。停止 daemon：scripts/stop-agent-daemon.sh"
