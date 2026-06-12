#!/usr/bin/env bash
# Build the latest release app bundle and replace the desktop installer DMG.
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$SOURCE_DIR/$SOURCE"
done

SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$ROOT_DIR/.build/release-app/WeChatIntelligenceRadar.app"
DMG_PATH="${1:-$HOME/Desktop/looloomi-0.1.0.dmg}"

cd "$ROOT_DIR"

echo "Building latest release app bundle..."
"$ROOT_DIR/scripts/build-release-app-bundle.sh"

if [[ ! -d "$APP_DIR" ]]; then
  echo "release app bundle missing: $APP_DIR" >&2
  exit 1
fi

echo "Creating desktop installer: $DMG_PATH"
hdiutil create -volname looloomi -srcfolder "$APP_DIR" -ov -format UDZO "$DMG_PATH"
hdiutil verify "$DMG_PATH"
echo "$DMG_PATH"
