#!/usr/bin/env bash
# Manager acceptance gate for LoopOps closeout.
# Read-only, shell-only, and intentionally does not open apps, browsers, or system automation surfaces.
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
RECORD_DIR="$RESEARCH_DIR/review-records"
SESSION_DIR="$RESEARCH_DIR/review-sessions"
NATIVE_PACKET_DIR="$RESEARCH_DIR/native-review-packets"
DEFAULT_DESIGN_EVIDENCE_PATH="$RESEARCH_DIR/human-review-gallery.html"
DESIGN_EVIDENCE_PATH="${LOOPOPS_DESIGN_EVIDENCE_PATH:-$DEFAULT_DESIGN_EVIDENCE_PATH}"
GATE_MODE="${LOOPOPS_MANAGER_GATE_MODE:-full}"

if [[ "$DESIGN_EVIDENCE_PATH" != /* ]]; then
  DESIGN_EVIDENCE_PATH="$ROOT_DIR/$DESIGN_EVIDENCE_PATH"
fi

failures=0
review_ready_failures=0
human_approval_failures=0

relpath() {
  local path="$1"
  if [[ "$path" == "$ROOT_DIR/"* ]]; then
    printf '%s' "${path#$ROOT_DIR/}"
  else
    printf '%s' "$path"
  fi
}

note() {
  printf '%s\n' "$*"
}

pass() {
  printf 'pass %s\n' "$*"
}

fail_review_ready() {
  printf 'fail review-ready %s\n' "$*" >&2
  failures=$((failures + 1))
  review_ready_failures=$((review_ready_failures + 1))
}

fail_human_approval() {
  if [[ "$GATE_MODE" == "review-ready" ]]; then
    printf 'skip human-approved %s\n' "$*" >&2
  else
    printf 'fail human-approved %s\n' "$*" >&2
  fi
  failures=$((failures + 1))
  human_approval_failures=$((human_approval_failures + 1))
}

require_nonempty_path() {
  local path="$1"
  local label="$2"
  if [[ -f "$path" ]]; then
    if [[ -s "$path" ]]; then
      pass "$label non-empty file: $(relpath "$path")"
    else
      fail_review_ready "$label is empty: $(relpath "$path")"
    fi
  elif [[ -d "$path" ]]; then
    local count
    count="$(find "$path" -type f -size +0c | wc -l | tr -d '[:space:]')"
    if [[ "$count" -gt 0 ]]; then
      pass "$label non-empty directory: $(relpath "$path") files=$count"
    else
      fail_review_ready "$label directory has no non-empty files: $(relpath "$path")"
    fi
  else
    fail_review_ready "$label missing: $(relpath "$path")"
  fi
}

require_contains() {
  local path="$1"
  local needle="$2"
  local label="$3"
  if [[ ! -s "$path" ]]; then
    fail_review_ready "$label source missing or empty: $(relpath "$path")"
    return
  fi
  if grep -Fq "$needle" "$path"; then
    pass "$label contains '$needle'"
  else
    fail_review_ready "$label missing '$needle': $(relpath "$path")"
  fi
}

require_text_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$label contains '$needle'"
  else
    fail_review_ready "$label missing '$needle'"
  fi
}

latest_file() {
  local dir="$1"
  local pattern="$2"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi
  find "$dir" -maxdepth 1 -type f -name "$pattern" | sort | tail -n 1
}

json_string_value() {
  local key="$1"
  local path="$2"
  sed -nE "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\\1/p" "$path" | head -n 1
}

trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

is_placeholder_notes() {
  local value
  value="$(trim_value "$1")"
  case "$value" in
    ""|"<review notes>"|"review notes"|"<manual review notes>"|"manual review notes"|"<reviewer notes>"|"reviewer notes")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

json_status_zero_count() {
  local path="$1"
  grep -Ec '"status"[[:space:]]*:[[:space:]]*0' "$path" || true
}

assert_no_misrepresented_native_boundary() {
  local record_json="$1"
  local record_md="$2"
  local misrep_pattern='(native_appkit_clicks_verified=false.*(full human approval|human-approved|human approved|fully approved)|((full human approval|human-approved|human approved|fully approved).*native_appkit_clicks_verified=false))'
  if grep -Eiq "$misrep_pattern" "$record_json" "$record_md" 2>/dev/null; then
    fail_human_approval "latest record presents native_appkit_clicks_verified=false as full human approval"
  else
    pass "native_appkit_clicks_verified=false is not used as a full human-approval claim"
  fi
}

assert_no_system_automation_command() {
  local path="$1"
  local label="$2"
  local line_number=0
  local trimmed
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_number=$((line_number + 1))
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
    [[ "$trimmed" == echo\ * || "$trimmed" == printf\ * || "$trimmed" == note\ * ]] && continue
    [[ "$trimmed" == *"open\\ *"* && "$trimmed" == *"osascript\\ *"* && "$trimmed" == *")" ]] && continue
    case "$trimmed" in
      open\ *|osascript\ *|screencapture\ *|*"; open "*|*"&& open "*|*"| open "*|*" open -a "*|*"osascript "*|*"System Events"*|*"tell application"*|*"AXUIElement"*|*"CGWindowList"*)
        fail_review_ready "$label system automation command in $(relpath "$path"):$line_number"
        return
        ;;
    esac
  done < "$path"
  pass "$label no system automation command: $(relpath "$path")"
}

note "LoopOps manager acceptance gate"
note "This command only reads local files. It does not call open, AppleScript, Accessibility, screen recording, Chrome/Safari, or browser automation."
note "loopops_manager_gate_mode=$GATE_MODE"
note

case "$GATE_MODE" in
  full|review-ready)
    ;;
  *)
    fail_review_ready "unsupported manager gate mode '$GATE_MODE'; expected full or review-ready"
    ;;
esac

note "== Review-ready evidence =="
require_nonempty_path "$DESIGN_EVIDENCE_PATH" "actual_design_evidence_path"
require_nonempty_path "$RESEARCH_DIR/16-human-review-gallery.md" "human_review_gallery_doc"
require_nonempty_path "$RESEARCH_DIR/product-design-audit-web" "desktop_design_evidence"
require_nonempty_path "$RESEARCH_DIR/product-design-audit-web-mobile" "mobile_design_evidence"

require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "loopops_objective_audit=pass" "goal_completion_gate"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "review-ready" "goal_completion_gate"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "native_appkit_clicks_verified=false" "goal_completion_gate"
require_contains "$RESEARCH_DIR/08-evidence-receipts.md" "loopops_objective_audit=pass" "evidence_receipts"
require_contains "$RESEARCH_DIR/08-evidence-receipts.md" "native_appkit_clicks_verified=false" "evidence_receipts"
require_contains "$RESEARCH_DIR/08-evidence-receipts.md" "loopops_action_typed_run_result_state=true" "evidence_receipts"
require_contains "$RESEARCH_DIR/08-evidence-receipts.md" "loopops_action_typed_run_result_isolation=true" "evidence_receipts"
require_contains "$RESEARCH_DIR/final-audit.md" "LoopOpsRunResultState" "final_audit"
require_contains "$RESEARCH_DIR/loopops-product-iteration-state.md" "LoopOpsRunResultState" "product_iteration_state"
require_contains "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsModels.swift" "struct LoopOpsRunResultState" "native_run_result_state_model"
require_contains "$ROOT_DIR/domains/frontend/app/code/Tests/WeChatIntelligenceRadarAppTests/LoopOpsV2ModelStoreTests.swift" "checkLoopOpsRunResultStateAggregatesSelectedRunEvidence" "native_run_result_state_test"
require_contains "$RESEARCH_DIR/09-no-permission-review-runbook.md" 'Accessibility' "no_permission_runbook"

CURRENT_SERVER_HANDOFF_REL="$(sed -nE 's/^Latest no-permission server handoff:[[:space:]]*(.*)$/\1/p' "$RESEARCH_DIR/16-human-review-gallery.md" | head -n 1)"
if [[ -n "$CURRENT_SERVER_HANDOFF_REL" ]]; then
  if [[ "$CURRENT_SERVER_HANDOFF_REL" == /* ]]; then
    CURRENT_SERVER_HANDOFF_MD="$CURRENT_SERVER_HANDOFF_REL"
  else
    CURRENT_SERVER_HANDOFF_MD="$RESEARCH_DIR/$CURRENT_SERVER_HANDOFF_REL"
  fi
  CURRENT_SERVER_HANDOFF_JSON="${CURRENT_SERVER_HANDOFF_MD%.md}.json"
  note "loopops_manager_gate_server_handoff=$(relpath "$CURRENT_SERVER_HANDOFF_MD")"
  require_nonempty_path "$CURRENT_SERVER_HANDOFF_MD" "manual_review_server_handoff"
  require_nonempty_path "$CURRENT_SERVER_HANDOFF_JSON" "manual_review_server_handoff_json"
  require_contains "$CURRENT_SERVER_HANDOFF_MD" "HTTP/1.1 200 OK" "manual_review_server_handoff"
  require_contains "$CURRENT_SERVER_HANDOFF_MD" "browser_opened=false" "manual_review_server_handoff"
  require_contains "$CURRENT_SERVER_HANDOFF_MD" "native_app_opened=false" "manual_review_server_handoff"
  require_contains "$CURRENT_SERVER_HANDOFF_MD" "system_automation=false" "manual_review_server_handoff"
  require_contains "$CURRENT_SERVER_HANDOFF_MD" "tracked_exec_session_running=false" "manual_review_server_handoff"
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"webReviewURL": "http://127.0.0.1:5188/"' "manual_review_server_handoff_json"
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"result": "HTTP/1.1 200 OK"' "manual_review_server_handoff_json"
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"browserOpened": false' "manual_review_server_handoff_json"
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"nativeAppOpened": false' "manual_review_server_handoff_json"
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"systemAutomation": false' "manual_review_server_handoff_json"
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"trackedExecSessionRunning": false' "manual_review_server_handoff_json"
else
  fail_review_ready "16-human-review-gallery.md does not declare Latest no-permission server handoff"
fi

CURRENT_NATIVE_VISUAL_GALLERY_REL="$(sed -nE 's/^Native visual gallery:[[:space:]]*(.*)$/\1/p' "$RESEARCH_DIR/16-human-review-gallery.md" | head -n 1)"
if [[ -n "$CURRENT_NATIVE_VISUAL_GALLERY_REL" ]]; then
  if [[ "$CURRENT_NATIVE_VISUAL_GALLERY_REL" == /* ]]; then
    CURRENT_NATIVE_VISUAL_GALLERY="$CURRENT_NATIVE_VISUAL_GALLERY_REL"
  else
    CURRENT_NATIVE_VISUAL_GALLERY="$RESEARCH_DIR/$CURRENT_NATIVE_VISUAL_GALLERY_REL"
  fi
  CURRENT_NATIVE_VISUAL_DIR="$(dirname "$CURRENT_NATIVE_VISUAL_GALLERY")"
  CURRENT_NATIVE_VISUAL_ID="$(basename "$CURRENT_NATIVE_VISUAL_DIR")"
  note "loopops_manager_gate_current_native_visual=$CURRENT_NATIVE_VISUAL_ID"
  require_nonempty_path "$CURRENT_NATIVE_VISUAL_GALLERY" "human_review_native_visual_gallery"
  require_nonempty_path "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" "human_review_native_visual_manifest"
  require_nonempty_path "$CURRENT_NATIVE_VISUAL_DIR/01-workbench.png" "human_review_native_visual_workbench"
  require_nonempty_path "$CURRENT_NATIVE_VISUAL_DIR/02-loop-library.png" "human_review_native_visual_library"
  require_nonempty_path "$CURRENT_NATIVE_VISUAL_DIR/03-skill-os.png" "human_review_native_visual_skill_os"
  require_nonempty_path "$CURRENT_NATIVE_VISUAL_DIR/04-knowledge.png" "human_review_native_visual_knowledge"
  require_nonempty_path "$CURRENT_NATIVE_VISUAL_DIR/05-chat.png" "human_review_native_visual_chat"
  require_nonempty_path "$CURRENT_NATIVE_VISUAL_DIR/06-studio.png" "human_review_native_visual_studio"
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"captureCount" : 6' "human_review_native_visual_manifest"
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"nonBlankCount" : 6' "human_review_native_visual_manifest"
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"noSystemPermissions" : true' "human_review_native_visual_manifest"
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"externalUIAutomation" : false' "human_review_native_visual_manifest"
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"nativeAppKitClicksVerified" : false' "human_review_native_visual_manifest"
  require_contains "$RESEARCH_DIR/human-review-gallery.html" "$CURRENT_NATIVE_VISUAL_ID" "human_review_gallery_html"
else
  fail_review_ready "16-human-review-gallery.md does not declare Native visual gallery"
fi

LATEST_SESSION_JSON="$(latest_file "$SESSION_DIR" "loopops-session-*.json")"
if [[ -n "$LATEST_SESSION_JSON" && -s "$LATEST_SESSION_JSON" ]]; then
  LATEST_SESSION_ID="$(basename "$LATEST_SESSION_JSON" .json)"
  LATEST_WEB_LOG="$SESSION_DIR/$LATEST_SESSION_ID-web.log"
  LATEST_NATIVE_LOG="$SESSION_DIR/$LATEST_SESSION_ID-native.log"
  note "loopops_manager_gate_latest_session=$(relpath "$LATEST_SESSION_JSON")"
  if [[ "$(json_status_zero_count "$LATEST_SESSION_JSON")" -ge 2 ]]; then
    pass "latest review session has web/native status 0"
  else
    fail_review_ready "latest review session does not show web/native status 0: $(relpath "$LATEST_SESSION_JSON")"
  fi
  require_contains "$LATEST_WEB_LOG" "web_no_permission_review=pass" "latest_web_review_log"
  require_contains "$LATEST_WEB_LOG" "web_no_permission_review_dom_smoke=true" "latest_web_review_log"
  require_contains "$LATEST_WEB_LOG" "web_no_permission_review_dom_smoke_source=local-http" "latest_web_review_log"
  require_contains "$LATEST_WEB_LOG" "web_dom_library_primary_row_run=true" "latest_web_review_log"
  require_contains "$LATEST_WEB_LOG" "web_dom_multi_run_queue=true" "latest_web_review_log"
  require_contains "$LATEST_WEB_LOG" "web_dom_run_chat_isolated=true" "latest_web_review_log"
  require_contains "$LATEST_WEB_LOG" "web_dom_stack_drag_add=true" "latest_web_review_log"
  require_contains "$LATEST_WEB_LOG" "web_dom_stack_drag_reorder=true" "latest_web_review_log"
  require_contains "$LATEST_WEB_LOG" "web_dom_create_tool_flow=true" "latest_web_review_log"
  require_contains "$LATEST_WEB_LOG" "web_dom_knowledge_attach_updates_run=true" "latest_web_review_log"
  require_contains "$LATEST_WEB_LOG" "web_dom_builder_patch_receipt=true" "latest_web_review_log"
  if grep -Fq "web_dom_no_browser_permissions=true" "$LATEST_WEB_LOG" \
    || { grep -Fq "web_no_permission_review_auto_open=false" "$LATEST_WEB_LOG" \
      && grep -Fq "web_no_permission_review_system_automation=false" "$LATEST_WEB_LOG"; }; then
    pass "latest_web_review_log confirms no browser/system automation"
  else
    fail_review_ready "latest_web_review_log missing no-permission browser evidence: $(relpath "$LATEST_WEB_LOG")"
  fi
  require_contains "$LATEST_NATIVE_LOG" "loopops_native_activation=pass" "latest_native_review_log"
  require_contains "$LATEST_NATIVE_LOG" "loopops_native_activation_no_system_permissions=true" "latest_native_review_log"
  require_contains "$LATEST_NATIVE_LOG" "loopops_native_activation_native_appkit_clicks_verified=false" "latest_native_review_log"
else
  LATEST_SESSION_ID=""
  LATEST_WEB_LOG=""
  LATEST_NATIVE_LOG=""
  fail_review_ready "no latest review session JSON found in $(relpath "$SESSION_DIR")"
fi

LATEST_NATIVE_PACKET_JSON="$(latest_file "$NATIVE_PACKET_DIR" "loopops-native-review-*.json")"
if [[ -n "$LATEST_NATIVE_PACKET_JSON" && -s "$LATEST_NATIVE_PACKET_JSON" ]]; then
  LATEST_NATIVE_PACKET_ID="$(basename "$LATEST_NATIVE_PACKET_JSON" .json)"
  LATEST_NATIVE_PACKET_MD="$NATIVE_PACKET_DIR/$LATEST_NATIVE_PACKET_ID.md"
  note "loopops_manager_gate_latest_native_packet=$(relpath "$LATEST_NATIVE_PACKET_JSON")"
  require_nonempty_path "$LATEST_NATIVE_PACKET_JSON" "latest_native_packet_json"
  require_nonempty_path "$LATEST_NATIVE_PACKET_MD" "latest_native_packet_markdown"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"activationResult": "pass"' "latest_native_packet_json"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"nativeAppKitClicksVerified": false' "latest_native_packet_json"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"nativeAppKitClickVerifiedCount": 0' "latest_native_packet_json"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"activationTargets": 26' "latest_native_packet_json"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"stateBackedTargets": 26' "latest_native_packet_json"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"noPermissionTargets": 26' "latest_native_packet_json"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"visualResult": "pass"' "latest_native_packet_json"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"visualCaptures": 6' "latest_native_packet_json"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"nonBlankVisualCaptures": 6' "latest_native_packet_json"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"visualManifest":' "latest_native_packet_json"
  require_contains "$LATEST_NATIVE_PACKET_MD" 'Native Visual Captures' "latest_native_packet_markdown"
  require_contains "$LATEST_NATIVE_PACKET_MD" 'Native AppKit/XCUITest clicks verified: `false`' "latest_native_packet_markdown"
  LATEST_NATIVE_VISUAL_MANIFEST="$(json_string_value "visualManifest" "$LATEST_NATIVE_PACKET_JSON")"
  if [[ -n "$LATEST_NATIVE_VISUAL_MANIFEST" ]]; then
    require_nonempty_path "$LATEST_NATIVE_VISUAL_MANIFEST" "latest_native_visual_manifest"
    require_contains "$LATEST_NATIVE_VISUAL_MANIFEST" '"captureCount" : 6' "latest_native_visual_manifest"
    require_contains "$LATEST_NATIVE_VISUAL_MANIFEST" '"nonBlankCount" : 6' "latest_native_visual_manifest"
    require_contains "$LATEST_NATIVE_VISUAL_MANIFEST" '"noSystemPermissions" : true' "latest_native_visual_manifest"
    require_contains "$LATEST_NATIVE_VISUAL_MANIFEST" '"externalUIAutomation" : false' "latest_native_visual_manifest"
    require_contains "$LATEST_NATIVE_VISUAL_MANIFEST" '"nativeAppKitClicksVerified" : false' "latest_native_visual_manifest"
  else
    fail_review_ready "latest native packet has no visualManifest path"
  fi
else
  fail_review_ready "no latest native review packet JSON found in $(relpath "$NATIVE_PACKET_DIR")"
fi

note
note "== Human-approved record =="
LATEST_RECORD_JSON="$(latest_file "$RECORD_DIR" "loopops-review-*.json")"
if [[ -z "$LATEST_RECORD_JSON" || ! -s "$LATEST_RECORD_JSON" ]]; then
  fail_human_approval "no latest manual review JSON found in $(relpath "$RECORD_DIR")"
  latest_status=""
  latest_blockers=""
else
  LATEST_RECORD_ID="$(basename "$LATEST_RECORD_JSON" .json)"
  LATEST_RECORD_MD="$RECORD_DIR/$LATEST_RECORD_ID.md"
  latest_status="$(json_string_value "status" "$LATEST_RECORD_JSON")"
  latest_blockers="$(json_string_value "blockers" "$LATEST_RECORD_JSON")"
  latest_notes="$(json_string_value "notes" "$LATEST_RECORD_JSON")"
  note "loopops_manager_gate_latest_review_record=$(relpath "$LATEST_RECORD_JSON")"
  note "loopops_manager_gate_latest_review_status=$latest_status"
  require_nonempty_path "$LATEST_RECORD_JSON" "latest_review_json"
  require_contains "$DESIGN_EVIDENCE_PATH" "$LATEST_RECORD_ID" "human_review_gallery_latest_record"
  require_contains "$LATEST_RECORD_JSON" '"humanReviewGallery":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"nativeVisualGallery":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"noPermissionServerHandoff":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"noPermissionServerHandoffJSON":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"objectiveAuditLogs":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"swiftTestLog":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"managerGate":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"evidence":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"latestReviewSessionId":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"latestNoPermissionServerHandoff":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"latestNoPermissionServerHandoffJSON":' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"webDomSmokeSource": "local-http"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"webDomLibraryPrimaryRowRun": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"webDomMultiRunQueue": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"webDomRunChatIsolated": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"webDomStackDragAdd": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"webDomStackDragReorder": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"webDomCreateToolFlow": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"webDomKnowledgeAttachUpdatesRun": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"webDomBuilderPatchReceipt": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"manualPassRequiresReviewerNotes": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"manualPassRejectsBlockers": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"manualNonPassRequiresConcreteBlockers": "true"' "latest_review_json"
  require_contains "$LATEST_RECORD_JSON" '"manualGuardrailProbesCoveredByObjectiveAudit": "true"' "latest_review_json"
  if [[ -s "$LATEST_RECORD_MD" ]]; then
    pass "latest review Markdown exists: $(relpath "$LATEST_RECORD_MD")"
  else
    fail_human_approval "latest review Markdown missing or empty: $(relpath "$LATEST_RECORD_MD")"
  fi
  assert_no_misrepresented_native_boundary "$LATEST_RECORD_JSON" "$LATEST_RECORD_MD"

  CLOSEOUT_HELPER="$ROOT_DIR/scripts/print-loopops-review-closeout.command"
  require_nonempty_path "$CLOSEOUT_HELPER" "manual_review_closeout_helper"
  assert_no_system_automation_command "$CLOSEOUT_HELPER" "manual_review_closeout_helper"
  set +e
  CLOSEOUT_OUTPUT="$("$CLOSEOUT_HELPER" 2>&1)"
  CLOSEOUT_STATUS=$?
  set -e
  if (( CLOSEOUT_STATUS == 0 )); then
    pass "manual_review_closeout_helper executed"
  else
    fail_review_ready "manual_review_closeout_helper exited $CLOSEOUT_STATUS"
  fi
  require_text_contains "$CLOSEOUT_OUTPUT" "loopops_review_closeout=ready" "manual_review_closeout_helper"
  require_text_contains "$CLOSEOUT_OUTPUT" "permission_model=no open, AppleScript, browser automation, Accessibility, or screen recording" "manual_review_closeout_helper"
  require_text_contains "$CLOSEOUT_OUTPUT" "$LATEST_RECORD_ID" "manual_review_closeout_helper"
  if [[ -n "${CURRENT_NATIVE_VISUAL_ID:-}" ]]; then
    require_text_contains "$CLOSEOUT_OUTPUT" "$CURRENT_NATIVE_VISUAL_ID" "manual_review_closeout_helper"
  else
    fail_review_ready "manual_review_closeout_helper cannot verify current native visual id"
  fi
  require_text_contains "$CLOSEOUT_OUTPUT" "LOOPOPS_REVIEW_STATUS=pass" "manual_review_closeout_helper"
  require_text_contains "$CLOSEOUT_OUTPUT" "LOOPOPS_REVIEW_STATUS=needs-work" "manual_review_closeout_helper"
  require_text_contains "$CLOSEOUT_OUTPUT" "LOOPOPS_MANAGER_GATE_MODE=review-ready" "manual_review_closeout_helper"
  require_text_contains "$CLOSEOUT_OUTPUT" "scripts/manager-loopops-acceptance-gate.command" "manual_review_closeout_helper"
  note "loopops_manager_gate_closeout_helper=pass"

  case "$latest_status" in
    pass)
      if [[ -n "$latest_blockers" ]]; then
        fail_human_approval "latest pass record still has blockers: $latest_blockers"
      elif is_placeholder_notes "$latest_notes"; then
        fail_human_approval "latest pass record requires explicit reviewer notes"
      else
        pass "latest manual review record is pass with no blockers and explicit reviewer notes"
      fi
      ;;
    pending|pending-manual-review|*pending*)
      fail_human_approval "latest manual review record is pending; review-ready is not human-approved"
      ;;
    needs-work|needs_work|blocked|fail|failed)
      if [[ -z "$(trim_value "$latest_blockers")" ]]; then
        fail_human_approval "latest manual review record is '$latest_status' but has no blockers text"
      else
        fail_human_approval "latest manual review record is '$latest_status': $latest_blockers"
      fi
      ;;
    "")
      fail_human_approval "latest manual review record has no status"
      ;;
    *)
      fail_human_approval "latest manual review record has unsupported status '$latest_status'; expected pass or needs-work"
      ;;
  esac
fi

note
note "== Gate summary =="
if (( review_ready_failures == 0 )); then
  note "loopops_manager_gate_review_ready=pass"
else
  note "loopops_manager_gate_review_ready=fail"
fi

if (( human_approval_failures == 0 )); then
  note "loopops_manager_gate_human_approved=true"
else
  note "loopops_manager_gate_human_approved=false"
fi

note "loopops_manager_gate_review_ready_failures=$review_ready_failures"
note "loopops_manager_gate_human_approval_failures=$human_approval_failures"
note "loopops_manager_gate_no_system_permissions=true"
note "loopops_manager_gate_external_ui_automation=false"
note "loopops_manager_gate_native_appkit_clicks_verified=false"

if [[ "$GATE_MODE" == "review-ready" ]]; then
  if (( review_ready_failures > 0 )); then
    note "loopops_manager_gate=fail"
    note "loopops_manager_gate_failures=$review_ready_failures"
    exit 1
  fi
  note "loopops_manager_gate=pass"
  note "loopops_manager_gate_failures=0"
  exit 0
fi

if (( failures > 0 )); then
  note "loopops_manager_gate=fail"
  note "loopops_manager_gate_failures=$failures"
  exit 1
fi

note "loopops_manager_gate=pass"
note "loopops_manager_gate_failures=0"
