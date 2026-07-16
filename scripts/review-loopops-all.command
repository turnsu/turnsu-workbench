#!/usr/bin/env bash
# One-command LoopOps review preflight for Web + native, without opening apps or browsers.
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESEARCH_DIR="$ROOT_DIR/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research"
WEB_DIR="$ROOT_DIR/domains/frontend/web/code/web-prototype"
WEB_URL="${LOOPOPS_WEB_URL:-http://127.0.0.1:5184/}"
OFFLINE_HTML="$WEB_DIR/dist/loopops-admin-offline.html"
NATIVE_APP="$ROOT_DIR/.build/debug-app/WeChatIntelligenceRadar.app"
NATIVE_CHECKLIST="$ROOT_DIR/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/13-native-manual-review-checklist.md"
COMPLETION_MATRIX="$ROOT_DIR/domains/frontend/documents/design/2026-06-24-relevanceai-triple-admin-research/10-objective-completion-matrix.md"
SESSION_DIR="$RESEARCH_DIR/review-sessions"
TIMESTAMP="$(date '+%Y-%m-%d-%H%M%S')"
SESSION_ID="${LOOPOPS_REVIEW_SESSION_ID:-loopops-session-$TIMESTAMP}"
SESSION_MARKDOWN="$SESSION_DIR/$SESSION_ID.md"
SESSION_JSON="$SESSION_DIR/$SESSION_ID.json"
WEB_LOG="$SESSION_DIR/$SESSION_ID-web.log"
NATIVE_LOG="$SESSION_DIR/$SESSION_ID-native.log"

mkdir -p "$SESSION_DIR"

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
  local path="$2"
  grep -E "^${key}=" "$path" | tail -n 1 | cut -d= -f2- || true
}

last_prefixed_value() {
  local prefix="$1"
  local path="$2"
  grep -E "^${prefix}" "$path" | tail -n 1 | sed "s/^${prefix}//" || true
}

bind_from_url() {
  local value="$1"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%/}"
  printf '%s' "$value"
}

run_to_log() {
  local log_path="$1"
  shift
  set +e
  "$@" 2>&1 | tee "$log_path"
  local status="${PIPESTATUS[0]}"
  set -e
  return "$status"
}

echo "LoopOps full review preflight"
echo "This command does not call open, AppleScript, Accessibility, screen recording, or browser automation."
echo

echo "== Web no-permission review =="
set +e
run_to_log "$WEB_LOG" bash -lc "cd '$WEB_DIR' && npm run review:no-permission"
WEB_STATUS=$?
set -e
WEB_REVIEW_ENTRY="$(last_metric_value "web_no_permission_review_url" "$WEB_LOG")"
WEB_REVIEW_BIND="$(last_metric_value "web_no_permission_review_bind" "$WEB_LOG")"
WEB_REVIEW_SERVER="$(last_metric_value "web_no_permission_review_server" "$WEB_LOG")"
LIVE_REVIEW_AVAILABLE=false
if command -v curl >/dev/null 2>&1 && curl -fsS --max-time 2 "$WEB_URL" >/dev/null 2>&1; then
  LIVE_REVIEW_AVAILABLE=true
fi

if [[ "$LIVE_REVIEW_AVAILABLE" == "true" ]]; then
  WEB_REVIEW_ENTRY="$WEB_URL"
  WEB_REVIEW_BIND="$(bind_from_url "$WEB_URL")"
  WEB_REVIEW_SERVER="available"
elif [[ -z "$WEB_REVIEW_ENTRY" ]]; then
    WEB_REVIEW_ENTRY="$OFFLINE_HTML"
    WEB_REVIEW_BIND="none"
    WEB_REVIEW_SERVER="offline_fallback"
fi

echo
echo "== Native no-permission review =="
set +e
run_to_log "$NATIVE_LOG" "$ROOT_DIR/scripts/review-loopops-native.command"
NATIVE_STATUS=$?
set -e
NATIVE_REVIEW_PACKET="$(last_prefixed_value "Native review packet: " "$NATIVE_LOG")"
NATIVE_REVIEW_PACKET_JSON="$(last_prefixed_value "Native review packet json: " "$NATIVE_LOG")"

RECORD_COMMAND="LOOPOPS_WEB_URL=\"$WEB_REVIEW_ENTRY\" LOOPOPS_REVIEW_STATUS=pass LOOPOPS_REVIEW_BLOCKERS=\"\" LOOPOPS_REVIEW_NOTES=\"Reviewed Web and native surfaces; no blockers.\" scripts/record-loopops-review.command"

{
  printf '# LoopOps Review Session\n\n'
  printf '%s\n' "- Session ID: \`$SESSION_ID\`"
  printf '%s\n' "- Created: \`$TIMESTAMP\`"
  printf '%s\n' "- Permission model: no \`open\`, AppleScript, Accessibility, screen recording, or browser automation."
  printf '%s\n' "- Web preflight status: \`$WEB_STATUS\`"
  printf '%s\n\n' "- Native preflight status: \`$NATIVE_STATUS\`"
  printf '## Entrypoints\n\n'
  if [[ "$WEB_REVIEW_ENTRY" == http://* || "$WEB_REVIEW_ENTRY" == https://* ]]; then
    printf '%s\n' "- Web review URL: \`$WEB_REVIEW_ENTRY\`"
  else
    printf '%s\n' "- Web review offline HTML: \`$WEB_REVIEW_ENTRY\`"
  fi
  printf '%s\n' "- Web bind: \`$WEB_REVIEW_BIND\`"
  printf '%s\n' "- Web server mode: \`$WEB_REVIEW_SERVER\`"
  printf '%s\n' "- Native app bundle: \`$NATIVE_APP\`"
  printf '%s\n' "- Native checklist: \`$NATIVE_CHECKLIST\`"
  if [[ -n "$NATIVE_REVIEW_PACKET" ]]; then
    printf '%s\n' "- Native review packet: \`$NATIVE_REVIEW_PACKET\`"
  fi
  if [[ -n "$NATIVE_REVIEW_PACKET_JSON" ]]; then
    printf '%s\n' "- Native review packet JSON: \`$NATIVE_REVIEW_PACKET_JSON\`"
  fi
  printf '%s\n\n' "- Completion matrix: \`$COMPLETION_MATRIX\`"
  printf '## Review Order\n\n'
  printf '%s\n' '1. Open the Web entrypoint manually and start at Workbench Review Guide.'
  printf '%s\n' '2. Check Evidence map, Agent team traceability, Review decision, active queue, Run Result and Run Chat.'
  printf '%s\n' '3. Open the native app bundle manually only when ready, then follow the native checklist.'
  printf '%s\n\n' '4. Record final human status with the command below.'
  printf '## Record Command\n\n'
  printf '```bash\n%s\n```\n\n' "$RECORD_COMMAND"
  printf '## Logs\n\n'
  printf '%s\n' "- Web log: \`$WEB_LOG\`"
  printf '%s\n' "- Native log: \`$NATIVE_LOG\`"
} > "$SESSION_MARKDOWN"

{
  printf '{\n'
  printf '  "sessionId": "%s",\n' "$(json_escape "$SESSION_ID")"
  printf '  "created": "%s",\n' "$(json_escape "$TIMESTAMP")"
  printf '  "permissionModel": "no open, AppleScript, Accessibility, screen recording, or browser automation",\n'
  printf '  "web": {\n'
  printf '    "status": %s,\n' "$WEB_STATUS"
  printf '    "entrypoint": "%s",\n' "$(json_escape "$WEB_REVIEW_ENTRY")"
  printf '    "bind": "%s",\n' "$(json_escape "$WEB_REVIEW_BIND")"
  printf '    "server": "%s",\n' "$(json_escape "$WEB_REVIEW_SERVER")"
  printf '    "log": "%s"\n' "$(json_escape "$WEB_LOG")"
  printf '  },\n'
  printf '  "native": {\n'
  printf '    "status": %s,\n' "$NATIVE_STATUS"
  printf '    "appBundle": "%s",\n' "$(json_escape "$NATIVE_APP")"
  printf '    "checklist": "%s",\n' "$(json_escape "$NATIVE_CHECKLIST")"
  printf '    "reviewPacket": "%s",\n' "$(json_escape "$NATIVE_REVIEW_PACKET")"
  printf '    "reviewPacketJSON": "%s",\n' "$(json_escape "$NATIVE_REVIEW_PACKET_JSON")"
  printf '    "log": "%s"\n' "$(json_escape "$NATIVE_LOG")"
  printf '  },\n'
  printf '  "completionMatrix": "%s",\n' "$(json_escape "$COMPLETION_MATRIX")"
  printf '  "recordCommand": "%s"\n' "$(json_escape "$RECORD_COMMAND")"
  printf '}\n'
} > "$SESSION_JSON"

echo
echo "== Manual review entrypoints =="
if [[ "$WEB_REVIEW_ENTRY" == http://* || "$WEB_REVIEW_ENTRY" == https://* ]]; then
  echo "Web review URL: $WEB_REVIEW_ENTRY"
else
  echo "Web review offline HTML: $WEB_REVIEW_ENTRY"
fi
echo "Native app bundle: $NATIVE_APP"
echo "Native checklist: $NATIVE_CHECKLIST"
if [[ -n "$NATIVE_REVIEW_PACKET" ]]; then
  echo "Native review packet: $NATIVE_REVIEW_PACKET"
fi
if [[ -n "$NATIVE_REVIEW_PACKET_JSON" ]]; then
  echo "Native review packet json: $NATIVE_REVIEW_PACKET_JSON"
fi
echo "Completion matrix: $COMPLETION_MATRIX"
echo "Manual review record: scripts/record-loopops-review.command"
echo "Review session markdown: $SESSION_MARKDOWN"
echo "Review session json: $SESSION_JSON"
echo "Web log: $WEB_LOG"
echo "Native log: $NATIVE_LOG"
echo
echo "Open these manually only when you are ready to review."

if [[ "$WEB_STATUS" -ne 0 || "$NATIVE_STATUS" -ne 0 ]]; then
  echo "loopops_review_session=created_with_failures"
  echo "loopops_review_session_markdown=$SESSION_MARKDOWN"
  echo "loopops_review_session_json=$SESSION_JSON"
  exit 1
fi

echo "loopops_review_session=created"
echo "loopops_review_session_markdown=$SESSION_MARKDOWN"
echo "loopops_review_session_json=$SESSION_JSON"
