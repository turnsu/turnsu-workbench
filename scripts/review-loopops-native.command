#!/usr/bin/env bash
# Local LoopOps native review entry that builds and verifies without opening the macOS app.
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECKLIST="$ROOT_DIR/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/13-native-manual-review-checklist.md"
RESEARCH_DIR="$ROOT_DIR/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research"
PACKET_DIR="$RESEARCH_DIR/native-review-packets"
TIMESTAMP="$(date '+%Y-%m-%d-%H%M%S')"
PACKET_ID="${LOOPOPS_NATIVE_REVIEW_PACKET_ID:-loopops-native-review-$TIMESTAMP}"
PACKET_MARKDOWN="$PACKET_DIR/$PACKET_ID.md"
PACKET_JSON="$PACKET_DIR/$PACKET_ID.json"
ACTIVATION_LOG="$PACKET_DIR/$PACKET_ID-activation.log"
VISUAL_LOG="$PACKET_DIR/$PACKET_ID-visual.log"

cd "$ROOT_DIR"

export XDG_CACHE_HOME="$ROOT_DIR/.build/xdg-cache"
export CLANG_MODULE_CACHE_PATH="$ROOT_DIR/.build/clang-module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT_DIR/.build/swiftpm-module-cache"
mkdir -p "$XDG_CACHE_HOME" "$CLANG_MODULE_CACHE_PATH" "$SWIFTPM_MODULECACHE_OVERRIDE" "$PACKET_DIR"

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

last_metric_value() {
  local key="$1"
  grep -E "^${key}=" "$ACTIVATION_LOG" | tail -n 1 | cut -d= -f2- || true
}

last_visual_metric_value() {
  local key="$1"
  grep -E "^${key}=" "$VISUAL_LOG" | tail -n 1 | cut -d= -f2- || true
}

echo "Building latest LoopOps native review bundle."
echo "This command does not call open, AppleScript, Accessibility, screen recording, or browser automation."
"$ROOT_DIR/scripts/build-debug-app-bundle.sh"
APP_DIR="$ROOT_DIR/.build/debug-app/WeChatIntelligenceRadar.app"

echo "Running native no-permission action wiring check."
set +e
swift run --disable-sandbox WeChatIntelligenceRadar --loopops-native-activation-check 2>&1 | tee "$ACTIVATION_LOG"
NATIVE_STATUS="${PIPESTATUS[0]}"
set -e

echo "Rendering native no-permission visual captures."
set +e
swift run --disable-sandbox WeChatIntelligenceRadar --loopops-native-visual-capture 2>&1 | tee "$VISUAL_LOG"
VISUAL_STATUS="${PIPESTATUS[0]}"
set -e

ACTIVATION_RESULT="$(last_metric_value "loopops_native_activation")"
TARGET_COUNT="$(last_metric_value "loopops_native_activation_target_count")"
STATE_BACKED_COUNT="$(last_metric_value "loopops_native_activation_state_backed_count")"
NO_PERMISSION_COUNT="$(last_metric_value "loopops_native_activation_no_system_permission_count")"
APPKIT_CLICK_COUNT="$(last_metric_value "loopops_native_activation_native_appkit_click_verified_count")"
VISUAL_RESULT="$(last_visual_metric_value "loopops_native_visual")"
VISUAL_MANIFEST="$(last_visual_metric_value "loopops_native_visual_manifest")"
VISUAL_MARKDOWN="$(last_visual_metric_value "loopops_native_visual_markdown")"
VISUAL_OUTPUT_DIR="$(last_visual_metric_value "loopops_native_visual_output_directory")"
VISUAL_CAPTURE_COUNT="$(last_visual_metric_value "loopops_native_visual_capture_count")"
VISUAL_NONBLANK_COUNT="$(last_visual_metric_value "loopops_native_visual_nonblank_count")"
if [[ -z "$APPKIT_CLICK_COUNT" ]]; then
  APPKIT_CLICK_COUNT="0"
fi
if [[ -z "$VISUAL_CAPTURE_COUNT" ]]; then
  VISUAL_CAPTURE_COUNT="0"
fi
if [[ -z "$VISUAL_NONBLANK_COUNT" ]]; then
  VISUAL_NONBLANK_COUNT="0"
fi

{
  printf '# LoopOps Native Review Packet\n\n'
  printf '%s\n' "- Packet ID: \`$PACKET_ID\`"
  printf '%s\n' "- Created: \`$TIMESTAMP\`"
  printf '%s\n' "- App bundle: \`$APP_DIR\`"
  printf '%s\n' "- Checklist: \`$CHECKLIST\`"
  printf '%s\n' "- Activation log: \`$ACTIVATION_LOG\`"
  printf '%s\n' "- Visual log: \`$VISUAL_LOG\`"
  printf '%s\n' "- Visual manifest: \`${VISUAL_MANIFEST:-missing}\`"
  printf '%s\n' "- Visual gallery: \`${VISUAL_MARKDOWN:-missing}\`"
  printf '%s\n' "- Permission model: no \`open\`, AppleScript, Accessibility, screen recording, Chrome/Safari, browser automation, or external AppKit click automation."
  printf '%s\n\n' "- Native AppKit/XCUITest clicks verified: \`false\`"
  printf '## Summary\n\n'
  printf '%s\n' "- Activation result: \`${ACTIVATION_RESULT:-unknown}\`"
  printf '%s\n' "- Activation targets: \`${TARGET_COUNT:-0}\`"
  printf '%s\n' "- State-backed targets: \`${STATE_BACKED_COUNT:-0}\`"
  printf '%s\n' "- No-permission targets: \`${NO_PERMISSION_COUNT:-0}\`"
  printf '%s\n' "- Visual capture result: \`${VISUAL_RESULT:-unknown}\`"
  printf '%s\n' "- Visual captures: \`$VISUAL_CAPTURE_COUNT\`"
  printf '%s\n' "- Nonblank visual captures: \`$VISUAL_NONBLANK_COUNT\`"
  printf '%s\n\n' "- Native AppKit click verified count: \`$APPKIT_CLICK_COUNT\`"
  printf '## Native Visual Captures\n\n'
  printf '| Surface | Workspace | File | Evidence |\n'
  printf '| --- | --- | --- | --- |\n'
  while IFS= read -r line; do
    capture="${line#loopops_native_visual_capture=}"
    IFS='|' read -r capture_id capture_title workspace file evidence_bytes evidence_colors <<< "$capture"
    printf '| `%s` | `%s` | `%s` | `%s %s` |\n' "$capture_title" "$workspace" "$file" "$evidence_bytes" "$evidence_colors"
  done < <(grep -E '^loopops_native_visual_capture=' "$VISUAL_LOG" || true)
  printf '\n'
  printf '## Activation Targets\n\n'
  printf '| Surface | Interaction ID | State Evidence |\n'
  printf '| --- | --- | --- |\n'
  while IFS= read -r line; do
    target="${line#loopops_native_activation_target=}"
    IFS='|' read -r surface interaction evidence <<< "$target"
    printf '| `%s` | `%s` | `%s` |\n' "$surface" "$interaction" "$evidence"
  done < <(grep -E '^loopops_native_activation_target=' "$ACTIVATION_LOG" || true)
  printf '\n## Manual Review Boundary\n\n'
  printf '%s\n' 'This packet proves in-process SwiftUI action wiring and state-backed activation for the listed targets.'
  printf '%s\n' 'The PNGs are rendered from the native SwiftUI DashboardView through an offscreen NSHostingView and provide no-permission native visual evidence.'
  printf '%s\n' 'It does not claim external AppKit/XCUITest pixel-click coverage. Use the native manual checklist for human visual review.'
} > "$PACKET_MARKDOWN"

{
  printf '{\n'
  printf '  "packetId": "%s",\n' "$(json_escape "$PACKET_ID")"
  printf '  "created": "%s",\n' "$(json_escape "$TIMESTAMP")"
  printf '  "appBundle": "%s",\n' "$(json_escape "$APP_DIR")"
  printf '  "checklist": "%s",\n' "$(json_escape "$CHECKLIST")"
  printf '  "activationLog": "%s",\n' "$(json_escape "$ACTIVATION_LOG")"
  printf '  "visualLog": "%s",\n' "$(json_escape "$VISUAL_LOG")"
  printf '  "visualManifest": "%s",\n' "$(json_escape "${VISUAL_MANIFEST:-}")"
  printf '  "visualMarkdown": "%s",\n' "$(json_escape "${VISUAL_MARKDOWN:-}")"
  printf '  "visualOutputDirectory": "%s",\n' "$(json_escape "${VISUAL_OUTPUT_DIR:-}")"
  printf '  "permissionModel": "no open, AppleScript, Accessibility, screen recording, Chrome/Safari, browser automation, or external AppKit click automation",\n'
  printf '  "activationResult": "%s",\n' "$(json_escape "${ACTIVATION_RESULT:-unknown}")"
  printf '  "visualResult": "%s",\n' "$(json_escape "${VISUAL_RESULT:-unknown}")"
  printf '  "activationTargets": %s,\n' "${TARGET_COUNT:-0}"
  printf '  "stateBackedTargets": %s,\n' "${STATE_BACKED_COUNT:-0}"
  printf '  "noPermissionTargets": %s,\n' "${NO_PERMISSION_COUNT:-0}"
  printf '  "visualCaptures": %s,\n' "$VISUAL_CAPTURE_COUNT"
  printf '  "nonBlankVisualCaptures": %s,\n' "$VISUAL_NONBLANK_COUNT"
  printf '  "nativeAppKitClicksVerified": false,\n'
  printf '  "nativeAppKitClickVerifiedCount": %s,\n' "$APPKIT_CLICK_COUNT"
  printf '  "visualCaptureLines": [\n'
  first_capture=true
  while IFS= read -r line; do
    capture="${line#loopops_native_visual_capture=}"
    if [[ "$first_capture" == "true" ]]; then
      first_capture=false
    else
      printf ',\n'
    fi
    printf '    "%s"' "$(json_escape "$capture")"
  done < <(grep -E '^loopops_native_visual_capture=' "$VISUAL_LOG" || true)
  printf '\n  ],\n'
  printf '  "targetLines": [\n'
  first_target=true
  while IFS= read -r line; do
    target="${line#loopops_native_activation_target=}"
    if [[ "$first_target" == "true" ]]; then
      first_target=false
    else
      printf ',\n'
    fi
    printf '    "%s"' "$(json_escape "$target")"
  done < <(grep -E '^loopops_native_activation_target=' "$ACTIVATION_LOG" || true)
  printf '\n  ]\n'
  printf '}\n'
} > "$PACKET_JSON"

echo "Native manual review app: $APP_DIR"
echo "Native manual review checklist: $CHECKLIST"
echo "Native review packet: $PACKET_MARKDOWN"
echo "Native review packet json: $PACKET_JSON"
echo "Native visual manifest: ${VISUAL_MANIFEST:-missing}"
echo "Native visual gallery: ${VISUAL_MARKDOWN:-missing}"
echo "Open the app manually only when you are ready to review."

if [[ "$NATIVE_STATUS" -ne 0 ]]; then
  exit "$NATIVE_STATUS"
fi
if [[ "$VISUAL_STATUS" -ne 0 ]]; then
  exit "$VISUAL_STATUS"
fi
