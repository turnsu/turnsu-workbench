#!/usr/bin/env bash
# Build an OPTIMIZED release .app bundle (smaller, faster than debug).
set -euo pipefail

if [[ "${LOOLOOMI_ENABLE_LEGACY_NATIVE_CLIENT:-0}" != "1" ]]; then
  echo "legacy_native_client_disabled: the current product uses the Product API + web frontend; this Swift bundle is historical test-only" >&2
  exit 64
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export XDG_CACHE_HOME="$ROOT_DIR/.build/xdg-cache"
export CLANG_MODULE_CACHE_PATH="$ROOT_DIR/.build/clang-module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT_DIR/.build/swiftpm-module-cache"
mkdir -p "$XDG_CACHE_HOME" "$CLANG_MODULE_CACHE_PATH" "$SWIFTPM_MODULECACHE_OVERRIDE"

echo "Building release (optimized)…"
swift build --disable-sandbox -c release

BUILD_DIR="$(swift build --disable-sandbox -c release --show-bin-path)"
APP_DIR="$ROOT_DIR/.build/release-app/WeChatIntelligenceRadar.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
EXECUTABLE="$BUILD_DIR/WeChatIntelligenceRadar"
RESOURCE_BUNDLE="$BUILD_DIR/WeChatIntelligenceRadarMVP_WeChatIntelligenceRadarApp.bundle"
ICON_FILE="$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Resources/AppIcon.icns"

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
cp -p "$EXECUTABLE" "$MACOS_DIR/WeChatIntelligenceRadar"
chmod +x "$MACOS_DIR/WeChatIntelligenceRadar"
# Strip symbols to shrink the binary (release only).
strip -rSTx "$MACOS_DIR/WeChatIntelligenceRadar" 2>/dev/null || true

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
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>looloomi</string>
  <key>CFBundleExecutable</key><string>WeChatIntelligenceRadar</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>local.wechat-intelligence-radar.mvp</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>looloomi</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

if [[ -x /usr/libexec/PlistBuddy ]]; then
  /usr/libexec/PlistBuddy -c "Add :LooloomiUseAppSupportRuntime bool true" "$CONTENTS_DIR/Info.plist" >/dev/null 2>&1 || true
  if [[ "${LOOLOOMI_EMBED_PROJECT_ROOT:-0}" == "1" ]]; then
    /usr/libexec/PlistBuddy -c "Set :LooloomiUseAppSupportRuntime false" "$CONTENTS_DIR/Info.plist" >/dev/null 2>&1 || true
    /usr/libexec/PlistBuddy -c "Add :LooloomiProjectRoot string $ROOT_DIR" "$CONTENTS_DIR/Info.plist" >/dev/null 2>&1 || true
  fi
fi

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "$APP_DIR"
