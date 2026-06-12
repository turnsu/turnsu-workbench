#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

rm -rf \
  "$ROOT_DIR/.build/debug/WeChatIntelligenceRadar.app" \
  "$ROOT_DIR/.build/arm64-apple-macosx/debug/WeChatIntelligenceRadar.app"

# Use the default .build dir (incremental — fast when nothing changed).
swift build

BUILD_DIR="$(swift build --show-bin-path)"
APP_DIR="$ROOT_DIR/.build/debug-app/WeChatIntelligenceRadar.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
EXECUTABLE="$BUILD_DIR/WeChatIntelligenceRadar"
RESOURCE_BUNDLE="$BUILD_DIR/WeChatIntelligenceRadarMVP_WeChatIntelligenceRadarApp.bundle"
ICON_FILE="$ROOT_DIR/Sources/WeChatIntelligenceRadarApp/Resources/AppIcon.icns"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
cp -p "$EXECUTABLE" "$MACOS_DIR/WeChatIntelligenceRadar"
chmod +x "$MACOS_DIR/WeChatIntelligenceRadar"

if [[ -d "$RESOURCE_BUNDLE" ]]; then
  rm -rf "$RESOURCES_DIR/$(basename "$RESOURCE_BUNDLE")"
  cp -R "$RESOURCE_BUNDLE" "$RESOURCES_DIR/"
fi

if [[ -f "$ICON_FILE" ]]; then
  cp -p "$ICON_FILE" "$RESOURCES_DIR/AppIcon.icns"
fi

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>looloomi</string>
  <key>CFBundleExecutable</key>
  <string>WeChatIntelligenceRadar</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>local.wechat-intelligence-radar.mvp</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>looloomi</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

if [[ -x /usr/libexec/PlistBuddy ]]; then
  /usr/libexec/PlistBuddy -c "Add :LooloomiProjectRoot string $ROOT_DIR" "$CONTENTS_DIR/Info.plist" >/dev/null 2>&1 || true
fi

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_DIR" >/dev/null
fi

echo "$APP_DIR"
