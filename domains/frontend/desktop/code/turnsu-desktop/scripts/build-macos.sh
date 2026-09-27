#!/usr/bin/env bash
set -euo pipefail
DESKTOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$DESKTOP_DIR/../../../../.." && pwd)"
NODE_BIN="$REPO_DIR/.tooling/node/bin/node"
TARGET_DIR="$REPO_DIR/.build/turnsu-desktop"
APP_DIR="$TARGET_DIR/Turnsu.app"
"$NODE_BIN" "$DESKTOP_DIR/scripts/build-ui.mjs"
CARGO_TARGET_DIR="$TARGET_DIR" cargo build --locked --features custom-protocol --manifest-path "$DESKTOP_DIR/src-tauri/Cargo.toml"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources/local-agent-host"
cp "$TARGET_DIR/debug/turnsu-desktop" "$APP_DIR/Contents/MacOS/Turnsu"
cp "$NODE_BIN" "$APP_DIR/Contents/Resources/node"
"$NODE_BIN" "$DESKTOP_DIR/scripts/build-host.mjs" "$APP_DIR/Contents/Resources/local-agent-host"
cp "$DESKTOP_DIR/src-tauri/icons/icon.png" "$APP_DIR/Contents/Resources/icon.png"
cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Turnsu</string>
<key>CFBundleIdentifier</key><string>ai.turnsu.desktop</string>
<key>CFBundleName</key><string>Turnsu</string>
<key>CFBundleDisplayName</key><string>Turnsu</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleIconFile</key><string>icon.png</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP_DIR"
echo "$APP_DIR"
