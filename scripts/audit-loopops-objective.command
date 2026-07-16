#!/usr/bin/env bash
# Executable LoopOps objective audit for no-permission review readiness.
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
AUDIT_DIR="$ROOT_DIR/.build/loopops-objective-audit"
NATIVE_PACKET_DIR="$RESEARCH_DIR/native-review-packets"
NATIVE_VISUAL_DIR="$RESEARCH_DIR/native-visual-audit"

mkdir -p "$AUDIT_DIR"

export XDG_CACHE_HOME="$ROOT_DIR/.build/xdg-cache"
export CLANG_MODULE_CACHE_PATH="$ROOT_DIR/.build/clang-module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$ROOT_DIR/.build/swiftpm-module-cache"
mkdir -p "$XDG_CACHE_HOME" "$CLANG_MODULE_CACHE_PATH" "$SWIFTPM_MODULECACHE_OVERRIDE"

failures=0

note() {
  printf '%s\n' "$*"
}

pass() {
  printf 'pass %s\n' "$*"
}

fail() {
  printf 'fail %s\n' "$*" >&2
  failures=$((failures + 1))
}

require_file() {
  local path="$1"
  if [[ -e "$path" ]]; then
    pass "file exists: ${path#$ROOT_DIR/}"
  else
    fail "missing file: ${path#$ROOT_DIR/}"
  fi
}

require_contains() {
  local path="$1"
  local needle="$2"
  if grep -Fq "$needle" "$path"; then
    pass "contains '$needle': ${path#$ROOT_DIR/}"
  else
    fail "missing '$needle': ${path#$ROOT_DIR/}"
  fi
}

require_output_contains() {
  local path="$1"
  local needle="$2"
  if grep -Fq "$needle" "$path"; then
    pass "output contains '$needle': ${path#$ROOT_DIR/}"
  else
    fail "output missing '$needle': ${path#$ROOT_DIR/}"
  fi
}

require_metric_at_least() {
  local path="$1"
  local key="$2"
  local minimum="$3"
  local value
  value="$(grep -E "^${key}=" "$path" | tail -n 1 | cut -d= -f2 || true)"
  if [[ "$value" =~ ^[0-9]+$ ]] && (( value >= minimum )); then
    pass "$key=$value >= $minimum"
  else
    fail "$key expected >= $minimum, got '${value:-missing}' in ${path#$ROOT_DIR/}"
  fi
}

json_string_value() {
  local key="$1"
  local path="$2"
  sed -nE "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\\1/p" "$path" | head -n 1
}

require_capture_manifest() {
  local label="$1"
  local dir="$2"
  local expected_count=15
  local output="$AUDIT_DIR/capture-manifest-${label}.txt"

  require_file "$dir/README.md"
  require_file "$dir/screenshot-manifest.json"
  require_file "$dir/03-workbench-run-result.png"
  require_file "$dir/05a-skill-os-create-tool-import.png"
  require_file "$dir/05b-skill-os-tool-logs-validation.png"
  require_file "$dir/06a-studio-builder-patch-receipt.png"
  require_file "$dir/08-knowledge-setup-panel.png"
  require_file "$dir/08b-knowledge-source-detail.png"

  if python3 - "$dir/screenshot-manifest.json" "$expected_count" >"$output" 2>&1 <<'PY'
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
expected_count = int(sys.argv[2])
data = json.loads(manifest_path.read_text())
shots = data.get("shots", [])
overflow = [shot for shot in shots if shot.get("hasHorizontalOverflow")]
has_06a = any(
    shot.get("step") == "06a"
    and shot.get("name") == "Studio Builder patch receipt"
    and str(shot.get("file", "")).endswith("06a-studio-builder-patch-receipt.png")
    for shot in shots
)
has_08 = any(
    shot.get("step") == "08"
    and shot.get("name") == "Knowledge setup panel"
    and str(shot.get("file", "")).endswith("08-knowledge-setup-panel.png")
    for shot in shots
)
has_08b = any(
    shot.get("step") == "08b"
    and shot.get("name") == "Knowledge source detail"
    and str(shot.get("file", "")).endswith("08b-knowledge-source-detail.png")
    for shot in shots
)
has_05a = any(
    shot.get("step") == "05a"
    and shot.get("name") == "Skill OS Create Tool import modal"
    and str(shot.get("file", "")).endswith("05a-skill-os-create-tool-import.png")
    for shot in shots
)
has_05b = any(
    shot.get("step") == "05b"
    and shot.get("name") == "Skill OS Tool logs validation"
    and str(shot.get("file", "")).endswith("05b-skill-os-tool-logs-validation.png")
    for shot in shots
)
print(f"capture_manifest_count={len(shots)}")
print(f"capture_manifest_overflow_count={len(overflow)}")
print(f"capture_manifest_has_05a={str(has_05a).lower()}")
print(f"capture_manifest_has_05b={str(has_05b).lower()}")
print(f"capture_manifest_has_06a={str(has_06a).lower()}")
print(f"capture_manifest_has_08={str(has_08).lower()}")
print(f"capture_manifest_has_08b={str(has_08b).lower()}")
if len(shots) != expected_count:
    raise SystemExit(f"expected {expected_count} shots, got {len(shots)}")
if overflow:
    steps = ", ".join(str(shot.get("step", "?")) for shot in overflow)
    raise SystemExit(f"horizontal overflow in steps: {steps}")
if not has_05a:
    raise SystemExit("missing Skill OS Create Tool import modal step 05a")
if not has_05b:
    raise SystemExit("missing Skill OS Tool logs validation step 05b")
if not has_06a:
    raise SystemExit("missing Studio Builder patch receipt step 06a")
if not has_08:
    raise SystemExit("missing Knowledge setup panel step 08")
if not has_08b:
    raise SystemExit("missing Knowledge source detail step 08b")
print("capture_manifest=pass")
PY
  then
    pass "$label capture manifest"
  else
    local status=$?
    fail "$label capture manifest exited $status; see ${output#$ROOT_DIR/}"
    sed -n '1,120p' "$output" >&2 || true
  fi

  require_output_contains "$output" "capture_manifest=pass"
  require_output_contains "$output" "capture_manifest_count=$expected_count"
  require_output_contains "$output" "capture_manifest_overflow_count=0"
  require_output_contains "$output" "capture_manifest_has_05a=true"
  require_output_contains "$output" "capture_manifest_has_05b=true"
  require_output_contains "$output" "capture_manifest_has_06a=true"
  require_output_contains "$output" "capture_manifest_has_08=true"
  require_output_contains "$output" "capture_manifest_has_08b=true"
}

run_capture() {
  local label="$1"
  local output="$2"
  shift 2
  note "== $label =="
  if "$@" >"$output" 2>&1; then
    pass "$label"
  else
    local status=$?
    fail "$label exited $status; see ${output#$ROOT_DIR/}"
    sed -n '1,120p' "$output" >&2 || true
  fi
}

run_expect_failure() {
  local label="$1"
  local output="$2"
  local expected="$3"
  shift 3
  note "== $label =="
  set +e
  "$@" >"$output" 2>&1
  local status=$?
  set -e
  if (( status == 0 )); then
    fail "$label unexpectedly succeeded; see ${output#$ROOT_DIR/}"
    sed -n '1,120p' "$output" >&2 || true
  elif grep -Fq "$expected" "$output"; then
    pass "$label rejected invalid input with '$expected'"
  else
    fail "$label failed without expected '$expected'; see ${output#$ROOT_DIR/}"
    sed -n '1,120p' "$output" >&2 || true
  fi
}

require_file_absent() {
  local path="$1"
  if [[ -e "$path" ]]; then
    fail "unexpected file exists: ${path#$ROOT_DIR/}"
  else
    pass "file absent: ${path#$ROOT_DIR/}"
  fi
}

assert_script_has_no_system_automation_command() {
  local path="$1"
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
        fail "system automation command in ${path#$ROOT_DIR/}:$line_number"
        return
        ;;
    esac
  done < "$path"
  pass "no system automation command: ${path#$ROOT_DIR/}"
}

note "LoopOps objective audit"
note "This command uses local CLI checks only. It does not call open, AppleScript, Accessibility, screen recording, or system browser automation."
note

note "== Evidence files =="
docs=(
  "00-research-index.md"
  "01-marketplace-template-library.md"
  "02-knowledge-toast-system.md"
  "03-tool-creation-logs.md"
  "04-triple-chat-quick-gui.md"
  "05-implementation-acceptance-spec.md"
  "06-completion-audit.md"
  "07-agent-team-final-audit.md"
  "08-evidence-receipts.md"
  "09-no-permission-review-runbook.md"
  "10-objective-completion-matrix.md"
  "11-browser-clickthrough-review.md"
  "12-remaining-decision-contract.md"
  "13-native-manual-review-checklist.md"
  "14-agent-team-traceability-matrix.md"
  "15-goal-completion-gate.md"
  "16-human-review-gallery.md"
)
for doc in "${docs[@]}"; do
  require_file "$RESEARCH_DIR/$doc"
done

goal_artifacts=(
  "loopops-product-iteration-roadmap.md"
  "loopops-product-iteration-state.md"
  "modules/marketplace-loop-library.md"
  "modules/knowledge-toast.md"
  "modules/skill-os-tool-builder-logs.md"
  "modules/triple-chat-quick-gui.md"
  "modules/workbench-run-result.md"
  "final-audit.md"
)
for artifact in "${goal_artifacts[@]}"; do
  require_file "$RESEARCH_DIR/$artifact"
done

screenshots=(
  "01-relevanceai-marketplace-workforce.png"
  "02-relevanceai-marketplace-listing-detail.png"
  "03-relevanceai-app-entry-auth-state.png"
  "04-relevanceai-knowledge-empty.png"
  "05-relevanceai-knowledge-new-modal.png"
  "06-relevanceai-tools-list.png"
  "07-relevanceai-tools-new-menu.png"
  "08-relevanceai-tool-builder.png"
  "09-relevanceai-tool-logs-tab.png"
  "10-relevanceai-tasks-monitor.png"
)
for screenshot in "${screenshots[@]}"; do
  require_file "$RESEARCH_DIR/screenshots/$screenshot"
done

note
note "== Product Design screenshot manifests =="
require_capture_manifest "desktop" "$RESEARCH_DIR/product-design-audit-web"
require_capture_manifest "mobile" "$RESEARCH_DIR/product-design-audit-web-mobile"
require_file "$RESEARCH_DIR/human-review-gallery.html"

require_file "$WEB_DIR/src/App.jsx"
require_file "$WEB_DIR/src/loopopsModel.js"
require_file "$WEB_DIR/src/styles.css"
require_file "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsInteractionContracts.swift"
require_file "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsAcceptanceHarness.swift"
require_file "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsNativeActivationHarness.swift"
require_file "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/BlocksWorkbenchView.swift"
require_file "$ROOT_DIR/domains/frontend/app/code/Tests/WeChatIntelligenceRadarAppTests/LoopOpsV2ModelStoreTests.swift"

note
note "== Typed Run Result state anchors =="
require_contains "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsModels.swift" "struct LoopOpsRunResultState"
require_contains "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsModels.swift" "struct LoopOpsRunResultAttempt"
require_contains "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsModels.swift" "enum LoopOpsRunResultReadiness"
require_contains "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsLocalStore.swift" "func runResultState(runID: String)"
require_contains "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsLocalStore.swift" "func runResultStates()"
require_contains "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/BlocksWorkbenchView.swift" "LoopOpsRunTypedStatePanel"
require_contains "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/BlocksWorkbenchView.swift" "runResultState: selectedTask.flatMap"
require_contains "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsAcceptanceHarness.swift" "typed_run_result_state=true"
require_contains "$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsAcceptanceHarness.swift" "typed_run_result_isolation=true"
require_contains "$ROOT_DIR/domains/frontend/app/code/Tests/WeChatIntelligenceRadarAppTests/LoopOpsV2ModelStoreTests.swift" "checkLoopOpsRunResultStateAggregatesSelectedRunEvidence"
require_contains "$ROOT_DIR/domains/frontend/app/code/Tests/WeChatIntelligenceRadarAppTests/AgentRuntimeTests.swift" "checkLoopOpsRunResultStateAggregatesSelectedRunEvidence()"
require_contains "$RESEARCH_DIR/loopops-product-iteration-state.md" "LoopOpsRunResultState"
require_contains "$RESEARCH_DIR/final-audit.md" "LoopOpsRunResultState"
require_contains "$RESEARCH_DIR/08-evidence-receipts.md" "loopops_action_typed_run_result_state=true"

note
note "== Review contract anchors =="
require_contains "$RESEARCH_DIR/loopops-product-iteration-roadmap.md" "Marketplace / Loop Library"
require_contains "$RESEARCH_DIR/loopops-product-iteration-roadmap.md" "Knowledge / Toast"
require_contains "$RESEARCH_DIR/loopops-product-iteration-roadmap.md" "Skill OS / Tool Builder / Logs"
require_contains "$RESEARCH_DIR/loopops-product-iteration-roadmap.md" "Triple-style Chat / Quick GUI"
require_contains "$RESEARCH_DIR/loopops-product-iteration-roadmap.md" "Workbench / Run Result"
require_contains "$RESEARCH_DIR/loopops-product-iteration-roadmap.md" "Manager Acceptance"
require_contains "$RESEARCH_DIR/loopops-product-iteration-state.md" "Latest human review handoff"
require_contains "$RESEARCH_DIR/modules/marketplace-loop-library.md" "## Acceptance"
require_contains "$RESEARCH_DIR/modules/knowledge-toast.md" "## Verification"
require_contains "$RESEARCH_DIR/modules/skill-os-tool-builder-logs.md" "Open Review Chat"
require_contains "$RESEARCH_DIR/modules/triple-chat-quick-gui.md" "Quick controls"
require_contains "$RESEARCH_DIR/modules/workbench-run-result.md" "Run Result"
require_contains "$RESEARCH_DIR/final-audit.md" "Status: not complete"
require_contains "$RESEARCH_DIR/00-research-index.md" "scripts/audit-loopops-objective.command"
require_contains "$RESEARCH_DIR/08-evidence-receipts.md" "loopops_objective_audit=pass"
require_contains "$RESEARCH_DIR/09-no-permission-review-runbook.md" "scripts/audit-loopops-objective.command"
require_contains "$RESEARCH_DIR/09-no-permission-review-runbook.md" "review-sessions/loopops-session-*.md"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "Executable objective audit"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "review-sessions/loopops-session-*.md/.json"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "web_dom_review_record_handoff=true"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "web_dom_review_record_preview=true"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "web_dom_review_state_persistence=true"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "workbench_evidence_map_sources=4"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "workbench_review_decision_board=true"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "builder_patch_receipt=true"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "workbench_traceability_modules=8"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "workbench_review_record_handoff=true"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "workbench_review_record_preview=true"
require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "workbench_review_state_persistence=true"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "status=pending-manual-review"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "loopops_objective_audit=pass"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "web_dom_review_state_persistence=true"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "workbench_review_state_persistence=true"
require_contains "$RESEARCH_DIR/13-native-manual-review-checklist.md" "Manual review record"
require_contains "$RESEARCH_DIR/13-native-manual-review-checklist.md" "workbench_review_state_persistence=true"
require_contains "$RESEARCH_DIR/13-native-manual-review-checklist.md" "Evidence map"
require_contains "$RESEARCH_DIR/13-native-manual-review-checklist.md" "Review decision"
require_contains "$RESEARCH_DIR/13-native-manual-review-checklist.md" "Builder patch receipt"
require_contains "$RESEARCH_DIR/13-native-manual-review-checklist.md" "Agent team traceability"
require_contains "$RESEARCH_DIR/14-agent-team-traceability-matrix.md" "trace.marketplace_loop_library"
require_contains "$RESEARCH_DIR/14-agent-team-traceability-matrix.md" "trace.agent_team_process"
require_contains "$RESEARCH_DIR/09-no-permission-review-runbook.md" "scripts/print-loopops-review-closeout.command"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "scripts/print-loopops-review-closeout.command"
require_contains "$RESEARCH_DIR/16-human-review-gallery.md" "scripts/print-loopops-review-closeout.command"
require_contains "$RESEARCH_DIR/08-evidence-receipts.md" "loopops_review_closeout=ready"
require_contains "$RESEARCH_DIR/loopops-product-iteration-state.md" "scripts/print-loopops-review-closeout.command"
require_contains "$RESEARCH_DIR/final-audit.md" "scripts/print-loopops-review-closeout.command"
require_contains "$RESEARCH_DIR/16-human-review-gallery.md" "Latest no-permission server handoff"
require_contains "$RESEARCH_DIR/09-no-permission-review-runbook.md" "loopops-server-handoff-2026-06-27-152603"
require_contains "$RESEARCH_DIR/loopops-product-iteration-state.md" "loopops-server-handoff-2026-06-27-152603"

CURRENT_SERVER_HANDOFF_REL="$(sed -nE 's/^Latest no-permission server handoff:[[:space:]]*(.*)$/\1/p' "$RESEARCH_DIR/16-human-review-gallery.md" | head -n 1)"
if [[ -n "$CURRENT_SERVER_HANDOFF_REL" ]]; then
  if [[ "$CURRENT_SERVER_HANDOFF_REL" == /* ]]; then
    CURRENT_SERVER_HANDOFF_MD="$CURRENT_SERVER_HANDOFF_REL"
  else
    CURRENT_SERVER_HANDOFF_MD="$RESEARCH_DIR/$CURRENT_SERVER_HANDOFF_REL"
  fi
  CURRENT_SERVER_HANDOFF_JSON="${CURRENT_SERVER_HANDOFF_MD%.md}.json"
  require_file "$CURRENT_SERVER_HANDOFF_MD"
  require_file "$CURRENT_SERVER_HANDOFF_JSON"
  require_contains "$CURRENT_SERVER_HANDOFF_MD" "HTTP/1.1 200 OK"
  require_contains "$CURRENT_SERVER_HANDOFF_MD" "browser_opened=false"
  require_contains "$CURRENT_SERVER_HANDOFF_MD" "native_app_opened=false"
  require_contains "$CURRENT_SERVER_HANDOFF_MD" "system_automation=false"
  require_contains "$CURRENT_SERVER_HANDOFF_MD" "tracked_exec_session_running=false"
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"webReviewURL": "http://127.0.0.1:5188/"'
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"result": "HTTP/1.1 200 OK"'
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"browserOpened": false'
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"nativeAppOpened": false'
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"systemAutomation": false'
  require_contains "$CURRENT_SERVER_HANDOFF_JSON" '"trackedExecSessionRunning": false'
else
  fail "16-human-review-gallery.md does not declare Latest no-permission server handoff"
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
  require_file "$CURRENT_NATIVE_VISUAL_GALLERY"
  require_file "$CURRENT_NATIVE_VISUAL_DIR/manifest.json"
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"captureCount" : 6'
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"nonBlankCount" : 6'
  require_contains "$RESEARCH_DIR/10-objective-completion-matrix.md" "$CURRENT_NATIVE_VISUAL_ID"
  require_contains "$RESEARCH_DIR/13-native-manual-review-checklist.md" "$CURRENT_NATIVE_VISUAL_ID"
  require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "$CURRENT_NATIVE_VISUAL_ID"
  require_contains "$RESEARCH_DIR/loopops-product-iteration-state.md" "$CURRENT_NATIVE_VISUAL_ID"
  require_contains "$RESEARCH_DIR/final-audit.md" "$CURRENT_NATIVE_VISUAL_ID"
  require_contains "$RESEARCH_DIR/human-review-gallery.html" "$CURRENT_NATIVE_VISUAL_ID"
else
  fail "16-human-review-gallery.md does not declare Native visual gallery"
fi

CURRENT_REVIEW_RECORD_REL="$(sed -nE 's/^Latest pending record:[[:space:]]*(.*)$/\1/p' "$RESEARCH_DIR/16-human-review-gallery.md" | head -n 1)"
if [[ -n "$CURRENT_REVIEW_RECORD_REL" ]]; then
  if [[ "$CURRENT_REVIEW_RECORD_REL" == /* ]]; then
    CURRENT_REVIEW_RECORD="$CURRENT_REVIEW_RECORD_REL"
  else
    CURRENT_REVIEW_RECORD="$RESEARCH_DIR/$CURRENT_REVIEW_RECORD_REL"
  fi
  CURRENT_REVIEW_RECORD_ID="$(basename "$CURRENT_REVIEW_RECORD" .md)"
  require_file "$CURRENT_REVIEW_RECORD"
  require_file "${CURRENT_REVIEW_RECORD%.md}.json"
  require_contains "$CURRENT_REVIEW_RECORD" "Status: \`pending-manual-review\`"
  require_contains "$CURRENT_REVIEW_RECORD" "Evidence Snapshot"
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"evidence":'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"latestReviewSessionId":'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"webDomSmokeSource": "local-http"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"webDomLibraryPrimaryRowRun": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"webDomMultiRunQueue": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"webDomRunChatIsolated": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"webDomStackDragAdd": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"webDomStackDragReorder": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"webDomCreateToolFlow": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"webDomKnowledgeAttachUpdatesRun": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"webDomBuilderPatchReceipt": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"manualPassRequiresReviewerNotes": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"manualPassRejectsBlockers": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"manualNonPassRequiresConcreteBlockers": "true"'
  require_contains "${CURRENT_REVIEW_RECORD%.md}.json" '"manualGuardrailProbesCoveredByObjectiveAudit": "true"'
  require_contains "$RESEARCH_DIR/loopops-product-iteration-state.md" "$CURRENT_REVIEW_RECORD_ID"
  require_contains "$RESEARCH_DIR/final-audit.md" "$CURRENT_REVIEW_RECORD_REL"
  require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "$CURRENT_REVIEW_RECORD_REL"
else
  fail "16-human-review-gallery.md does not declare Latest pending record"
fi

note
note "== No-permission script scan =="
review_scripts=(
  "$ROOT_DIR/scripts/review-loopops-web.command"
  "$ROOT_DIR/scripts/review-loopops-web-offline.command"
  "$ROOT_DIR/scripts/review-loopops-native.command"
  "$ROOT_DIR/scripts/review-loopops-all.command"
  "$ROOT_DIR/scripts/record-loopops-review.command"
  "$ROOT_DIR/scripts/print-loopops-review-closeout.command"
  "$ROOT_DIR/scripts/verify-loopops-traceability.command"
  "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command"
)
for script in "${review_scripts[@]}"; do
  require_file "$script"
  assert_script_has_no_system_automation_command "$script"
done
require_contains "$ROOT_DIR/scripts/review-loopops-all.command" "loopops_review_session=created"
require_contains "$ROOT_DIR/scripts/review-loopops-all.command" "review-sessions"
require_contains "$ROOT_DIR/scripts/record-loopops-review.command" "pass review records require explicit reviewer notes"
require_contains "$ROOT_DIR/scripts/record-loopops-review.command" "non-pass review records require concrete blockers"
require_contains "$ROOT_DIR/scripts/record-loopops-review.command" "manualPassRequiresReviewerNotes"
require_contains "$ROOT_DIR/scripts/record-loopops-review.command" "manualGuardrailProbesCoveredByObjectiveAudit"
require_contains "$ROOT_DIR/scripts/record-loopops-review.command" "LOOPOPS_REVIEW_RECORD_DIR"
require_contains "$ROOT_DIR/scripts/record-loopops-review.command" "noPermissionServerHandoff"
require_contains "$ROOT_DIR/scripts/record-loopops-review.command" "latestNoPermissionServerHandoff"
require_contains "$ROOT_DIR/scripts/print-loopops-review-closeout.command" "loopops_review_closeout=ready"
require_contains "$ROOT_DIR/scripts/print-loopops-review-closeout.command" "LOOPOPS_REVIEW_STATUS=pass"
require_contains "$ROOT_DIR/scripts/print-loopops-review-closeout.command" "LOOPOPS_REVIEW_STATUS=needs-work"
require_contains "$ROOT_DIR/scripts/print-loopops-review-closeout.command" "LOOPOPS_MANAGER_GATE_MODE=review-ready"
require_contains "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command" "latest pass record requires explicit reviewer notes"
require_contains "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command" "manualPassRequiresReviewerNotes"
require_contains "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command" "web_no_permission_review_dom_smoke_source=local-http"
require_contains "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command" "web_dom_stack_drag_reorder=true"
require_contains "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command" "print-loopops-review-closeout.command"
require_contains "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command" "loopops_manager_gate_closeout_helper=pass"
require_contains "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command" "assert_no_system_automation_command"
require_contains "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command" 'assert_no_system_automation_command "$CLOSEOUT_HELPER" "manual_review_closeout_helper"'
require_contains "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command" "no system automation command"
require_contains "$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command" "latest_web_review_log missing no-permission browser evidence"

note
note "== Manual review closeout helper =="
run_capture "manual review closeout helper" "$AUDIT_DIR/review-closeout-helper.txt" "$ROOT_DIR/scripts/print-loopops-review-closeout.command"
require_output_contains "$AUDIT_DIR/review-closeout-helper.txt" "loopops_review_closeout=ready"
require_output_contains "$AUDIT_DIR/review-closeout-helper.txt" "permission_model=no open, AppleScript, browser automation, Accessibility, or screen recording"
require_output_contains "$AUDIT_DIR/review-closeout-helper.txt" "web_review_url="
if [[ -n "${CURRENT_REVIEW_RECORD_ID:-}" ]]; then
  require_output_contains "$AUDIT_DIR/review-closeout-helper.txt" "$CURRENT_REVIEW_RECORD_ID"
else
  fail "closeout helper check missing CURRENT_REVIEW_RECORD_ID"
fi
if [[ -n "${CURRENT_NATIVE_VISUAL_ID:-}" ]]; then
  require_output_contains "$AUDIT_DIR/review-closeout-helper.txt" "$CURRENT_NATIVE_VISUAL_ID"
else
  fail "closeout helper check missing CURRENT_NATIVE_VISUAL_ID"
fi
require_output_contains "$AUDIT_DIR/review-closeout-helper.txt" "LOOPOPS_REVIEW_STATUS=pass"
require_output_contains "$AUDIT_DIR/review-closeout-helper.txt" "LOOPOPS_REVIEW_STATUS=needs-work"
require_output_contains "$AUDIT_DIR/review-closeout-helper.txt" "LOOPOPS_MANAGER_GATE_MODE=review-ready"
require_output_contains "$AUDIT_DIR/review-closeout-helper.txt" "scripts/manager-loopops-acceptance-gate.command"

note
note "== Manual review recorder guardrails =="
INVALID_PASS_ID="loopops-review-invalid-pass-probe"
INVALID_NEEDS_WORK_ID="loopops-review-invalid-needs-work-probe"
run_expect_failure \
  "invalid pass review record probe" \
  "$AUDIT_DIR/invalid-pass-review-record.txt" \
  "pass review records require explicit reviewer notes" \
  env \
    LOOPOPS_WEB_URL="${LOOPOPS_WEB_URL:-http://127.0.0.1:5187/}" \
    LOOPOPS_REVIEW_ID="$INVALID_PASS_ID" \
    LOOPOPS_REVIEW_STATUS=pass \
    LOOPOPS_REVIEW_BLOCKERS= \
    LOOPOPS_REVIEW_NOTES= \
    "$ROOT_DIR/scripts/record-loopops-review.command"
require_file_absent "$RESEARCH_DIR/review-records/$INVALID_PASS_ID.md"
require_file_absent "$RESEARCH_DIR/review-records/$INVALID_PASS_ID.json"
run_expect_failure \
  "invalid needs-work review record probe" \
  "$AUDIT_DIR/invalid-needs-work-review-record.txt" \
  "non-pass review records require concrete blockers" \
  env \
    LOOPOPS_WEB_URL="${LOOPOPS_WEB_URL:-http://127.0.0.1:5187/}" \
    LOOPOPS_REVIEW_ID="$INVALID_NEEDS_WORK_ID" \
    LOOPOPS_REVIEW_STATUS=needs-work \
    LOOPOPS_REVIEW_BLOCKERS= \
    LOOPOPS_REVIEW_NOTES=Review-probe \
    "$ROOT_DIR/scripts/record-loopops-review.command"
require_file_absent "$RESEARCH_DIR/review-records/$INVALID_NEEDS_WORK_ID.md"
require_file_absent "$RESEARCH_DIR/review-records/$INVALID_NEEDS_WORK_ID.json"

VALID_NEEDS_WORK_ID="loopops-review-valid-needs-work-probe"
VALID_RECORD_PROBE_DIR="$AUDIT_DIR/review-record-probe"
mkdir -p "$VALID_RECORD_PROBE_DIR"
run_capture \
  "valid needs-work review record probe" \
  "$AUDIT_DIR/valid-needs-work-review-record.txt" \
  env \
    LOOPOPS_WEB_URL="${LOOPOPS_WEB_URL:-http://127.0.0.1:5188/}" \
    LOOPOPS_REVIEW_RECORD_DIR="$VALID_RECORD_PROBE_DIR" \
    LOOPOPS_REVIEW_ID="$VALID_NEEDS_WORK_ID" \
    LOOPOPS_REVIEW_STATUS=needs-work \
    LOOPOPS_REVIEW_BLOCKERS=Probe-blocker-for-server-handoff-evidence \
    LOOPOPS_REVIEW_NOTES=Review-probe-valid-record \
    "$ROOT_DIR/scripts/record-loopops-review.command"
require_output_contains "$AUDIT_DIR/valid-needs-work-review-record.txt" "loopops_manual_review_record=created"
require_file "$VALID_RECORD_PROBE_DIR/$VALID_NEEDS_WORK_ID.md"
require_file "$VALID_RECORD_PROBE_DIR/$VALID_NEEDS_WORK_ID.json"
require_contains "$VALID_RECORD_PROBE_DIR/$VALID_NEEDS_WORK_ID.md" "No-permission server handoff"
require_contains "$VALID_RECORD_PROBE_DIR/$VALID_NEEDS_WORK_ID.json" '"noPermissionServerHandoff":'
require_contains "$VALID_RECORD_PROBE_DIR/$VALID_NEEDS_WORK_ID.json" '"latestNoPermissionServerHandoff":'
require_contains "$VALID_RECORD_PROBE_DIR/$VALID_NEEDS_WORK_ID.json" 'loopops-server-handoff-2026-06-27-152603'

note
note "== Agent-team traceability =="
run_capture "traceability verification" "$AUDIT_DIR/traceability.txt" "$ROOT_DIR/scripts/verify-loopops-traceability.command"
require_output_contains "$AUDIT_DIR/traceability.txt" "loopops_traceability=pass"
require_output_contains "$AUDIT_DIR/traceability.txt" "loopops_traceability_modules=8"
require_output_contains "$AUDIT_DIR/traceability.txt" "loopops_traceability_no_system_permissions=true"

note
note "== Web prototype checks =="
run_capture "web smoke" "$AUDIT_DIR/web-smoke.txt" bash -lc "cd '$WEB_DIR' && npm run smoke"
require_output_contains "$AUDIT_DIR/web-smoke.txt" "web_prototype_smoke=pass"
require_metric_at_least "$AUDIT_DIR/web-smoke.txt" "web_prototype_testids" 90
require_output_contains "$AUDIT_DIR/web-smoke.txt" "forbidden_terms=0"

run_capture "web action smoke" "$AUDIT_DIR/web-action-smoke.txt" bash -lc "cd '$WEB_DIR' && npm run action:smoke"
require_output_contains "$AUDIT_DIR/web-action-smoke.txt" "web_action_smoke=pass"
require_output_contains "$AUDIT_DIR/web-action-smoke.txt" "web_action_builder_patch_receipt=true"
require_output_contains "$AUDIT_DIR/web-action-smoke.txt" "web_action_no_browser_permissions=true"

run_capture "web no-permission review" "$AUDIT_DIR/web-review-no-permission.txt" bash -lc "cd '$WEB_DIR' && npm run review:no-permission"
require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_no_permission_review=pass"
require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_no_permission_review_auto_open=false"
require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_no_permission_review_system_automation=false"
if grep -Fq "web_no_permission_review_dom_smoke=true" "$AUDIT_DIR/web-review-no-permission.txt"; then
  note "web_no_permission_review_dom_evidence=current_review_no_permission_run"
  if grep -Eq "web_no_permission_review_server=(available|started)" "$AUDIT_DIR/web-review-no-permission.txt"; then
    require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_no_permission_review_dom_smoke_source=local-http"
  fi
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_review_record_handoff=true"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_review_record_preview=true"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_review_state_persistence=true"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_library_primary_row_run=true"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_multi_run_queue=true"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_run_chat_isolated=true"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_stack_drag_add=true"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_stack_drag_reorder=true"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_create_tool_flow=true"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_knowledge_attach_updates_run=true"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_dom_builder_patch_receipt=true"
else
  note "web_no_permission_review_dom_evidence=latest_review_session_required"
  note "web_no_permission_review_dom_evidence_reason=current run used offline fallback or sandbox-safe file-navigation skip"
  require_output_contains "$AUDIT_DIR/web-review-no-permission.txt" "web_no_permission_review_dom_smoke_source=skipped_sandbox_file_navigation"
fi

note
note "== Swift/native checks =="
run_capture "swift build" "$AUDIT_DIR/swift-build.txt" swift build --disable-sandbox
require_output_contains "$AUDIT_DIR/swift-build.txt" "Build complete"

swift_run() {
  local flag="$1"
  local output="$2"
  run_capture "swift run $flag" "$output" swift run --disable-sandbox WeChatIntelligenceRadar "$flag"
}

swift_run "--contract-check" "$AUDIT_DIR/swift-contract.txt"
require_output_contains "$AUDIT_DIR/swift-contract.txt" "agent_runtime_contracts=pass"

swift_run "--loopops-acceptance-check" "$AUDIT_DIR/swift-acceptance.txt"
require_output_contains "$AUDIT_DIR/swift-acceptance.txt" "loopops_acceptance=pass"
require_output_contains "$AUDIT_DIR/swift-acceptance.txt" "loopops_acceptance_review_packets="

swift_run "--loopops-ui-action-check" "$AUDIT_DIR/swift-ui-action.txt"
require_output_contains "$AUDIT_DIR/swift-ui-action.txt" "loopops_ui_action=pass"
require_metric_at_least "$AUDIT_DIR/swift-ui-action.txt" "loopops_ui_action_required_identifier_count" 83
require_metric_at_least "$AUDIT_DIR/swift-ui-action.txt" "loopops_ui_action_action_summary_count" 33
require_output_contains "$AUDIT_DIR/swift-ui-action.txt" "loopops_ui_action_review_guide_actions=true"
require_output_contains "$AUDIT_DIR/swift-ui-action.txt" "loopops_ui_action_workbench_review_state_persistence=true"
require_output_contains "$AUDIT_DIR/swift-ui-action.txt" "loopops_ui_action_no_system_permissions=true"

swift_run "--loopops-interaction-coverage-check" "$AUDIT_DIR/swift-coverage.txt"
require_output_contains "$AUDIT_DIR/swift-coverage.txt" "loopops_interaction_coverage=pass"
require_metric_at_least "$AUDIT_DIR/swift-coverage.txt" "loopops_interaction_coverage_item_count" 27
require_metric_at_least "$AUDIT_DIR/swift-coverage.txt" "loopops_interaction_coverage_no_system_permission_count" 27

swift_run "--loopops-interaction-replay-check" "$AUDIT_DIR/swift-replay.txt"
require_output_contains "$AUDIT_DIR/swift-replay.txt" "loopops_interaction_replay=pass"
require_metric_at_least "$AUDIT_DIR/swift-replay.txt" "loopops_interaction_replay_step_count" 27
require_output_contains "$AUDIT_DIR/swift-replay.txt" "Review source evidence map"
require_output_contains "$AUDIT_DIR/swift-replay.txt" "Set manual review decision"
require_output_contains "$AUDIT_DIR/swift-replay.txt" "Apply Builder Chat patch receipt"
require_output_contains "$AUDIT_DIR/swift-replay.txt" "Review agent-team traceability"
require_output_contains "$AUDIT_DIR/swift-replay.txt" "Prepare manual review record handoff"

swift_run "--loopops-native-activation-check" "$AUDIT_DIR/swift-native-activation.txt"
require_output_contains "$AUDIT_DIR/swift-native-activation.txt" "loopops_native_activation=pass"
require_metric_at_least "$AUDIT_DIR/swift-native-activation.txt" "loopops_native_activation_target_count" 26
require_output_contains "$AUDIT_DIR/swift-native-activation.txt" "loopops_native_activation_no_system_permissions=true"
require_output_contains "$AUDIT_DIR/swift-native-activation.txt" "workbench_evidence_map_sources=4"
require_output_contains "$AUDIT_DIR/swift-native-activation.txt" "workbench_review_decision_board=true"
require_output_contains "$AUDIT_DIR/swift-native-activation.txt" "workbench_traceability_modules=8"
require_output_contains "$AUDIT_DIR/swift-native-activation.txt" "workbench_review_record_handoff=true"
require_output_contains "$AUDIT_DIR/swift-native-activation.txt" "workbench_review_record_preview=true"
require_output_contains "$AUDIT_DIR/swift-native-activation.txt" "workbench_review_state_persistence=true"

if [[ "${LOOPOPS_OBJECTIVE_AUDIT_REFRESH_NATIVE_VISUAL:-0}" == "1" ]]; then
  swift_run "--loopops-native-visual-capture" "$AUDIT_DIR/swift-native-visual.txt"
  require_output_contains "$AUDIT_DIR/swift-native-visual.txt" "loopops_native_visual=pass"
  require_output_contains "$AUDIT_DIR/swift-native-visual.txt" "loopops_native_visual_no_system_permissions=true"
  require_output_contains "$AUDIT_DIR/swift-native-visual.txt" "loopops_native_visual_external_ui_automation=false"
  require_output_contains "$AUDIT_DIR/swift-native-visual.txt" "loopops_native_visual_native_appkit_clicks_verified=false"
  require_metric_at_least "$AUDIT_DIR/swift-native-visual.txt" "loopops_native_visual_capture_count" 6
  require_metric_at_least "$AUDIT_DIR/swift-native-visual.txt" "loopops_native_visual_nonblank_count" 6
else
  note "== swift run --loopops-native-visual-capture =="
  note "loopops_native_visual_capture=skipped_stable_handoff"
  note "loopops_native_visual_refresh_native_visual=false"
  require_file "$CURRENT_NATIVE_VISUAL_GALLERY"
  require_file "$CURRENT_NATIVE_VISUAL_DIR/manifest.json"
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"captureCount" : 6'
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"nonBlankCount" : 6'
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"noSystemPermissions" : true'
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"externalUIAutomation" : false'
  require_contains "$CURRENT_NATIVE_VISUAL_DIR/manifest.json" '"nativeAppKitClicksVerified" : false'
fi

note
note "== Manual review session and record artifacts =="
LATEST_SESSION_JSON="$(find "$RESEARCH_DIR/review-sessions" -maxdepth 1 -type f -name 'loopops-session-*.json' 2>/dev/null | sort | tail -n 1 || true)"
if compgen -G "$RESEARCH_DIR/review-sessions/loopops-session-*.json" >/dev/null; then
  pass "manual review session JSON exists"
  if [[ -n "$LATEST_SESSION_JSON" ]]; then
    LATEST_SESSION_ID="$(basename "$LATEST_SESSION_JSON" .json)"
    LATEST_WEB_LOG="$RESEARCH_DIR/review-sessions/$LATEST_SESSION_ID-web.log"
    require_contains "$LATEST_SESSION_JSON" '"reviewPacket":'
    require_contains "$LATEST_SESSION_JSON" '"reviewPacketJSON":'
    require_file "$LATEST_WEB_LOG"
    require_contains "$LATEST_WEB_LOG" "web_no_permission_review_dom_smoke=true"
    require_contains "$LATEST_WEB_LOG" "web_no_permission_review_dom_smoke_source=local-http"
    require_contains "$LATEST_WEB_LOG" "web_dom_library_primary_row_run=true"
    require_contains "$LATEST_WEB_LOG" "web_dom_multi_run_queue=true"
    require_contains "$LATEST_WEB_LOG" "web_dom_run_chat_isolated=true"
    require_contains "$LATEST_WEB_LOG" "web_dom_stack_drag_add=true"
    require_contains "$LATEST_WEB_LOG" "web_dom_stack_drag_reorder=true"
    require_contains "$LATEST_WEB_LOG" "web_dom_create_tool_flow=true"
    require_contains "$LATEST_WEB_LOG" "web_dom_knowledge_attach_updates_run=true"
    require_contains "$LATEST_WEB_LOG" "web_dom_builder_patch_receipt=true"
    note "web_no_permission_review_live_dom_evidence=latest_review_session"
    note "web_no_permission_review_live_dom_log=${LATEST_WEB_LOG#$ROOT_DIR/}"
  fi
else
  fail "no manual review session JSON exists; run scripts/review-loopops-all.command"
fi
if compgen -G "$RESEARCH_DIR/review-sessions/loopops-session-*.md" >/dev/null; then
  pass "manual review session Markdown exists"
else
  fail "no manual review session Markdown exists; run scripts/review-loopops-all.command"
fi
if compgen -G "$RESEARCH_DIR/review-records/loopops-review-*.json" >/dev/null; then
  pass "manual review JSON record exists"
else
  fail "no manual review JSON record exists; run scripts/record-loopops-review.command"
fi
if compgen -G "$RESEARCH_DIR/review-records/loopops-review-*.md" >/dev/null; then
  pass "manual review Markdown record exists"
else
  fail "no manual review Markdown record exists; run scripts/record-loopops-review.command"
fi

LATEST_NATIVE_PACKET_JSON="$(find "$NATIVE_PACKET_DIR" -maxdepth 1 -type f -name 'loopops-native-review-*.json' 2>/dev/null | sort | tail -n 1 || true)"
if [[ -n "$LATEST_NATIVE_PACKET_JSON" && -s "$LATEST_NATIVE_PACKET_JSON" ]]; then
  pass "native review packet JSON exists"
  LATEST_NATIVE_PACKET_ID="$(basename "$LATEST_NATIVE_PACKET_JSON" .json)"
  LATEST_NATIVE_PACKET_MD="$NATIVE_PACKET_DIR/$LATEST_NATIVE_PACKET_ID.md"
  require_file "$LATEST_NATIVE_PACKET_MD"
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"activationResult": "pass"'
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"activationTargets": 26'
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"stateBackedTargets": 26'
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"noPermissionTargets": 26'
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"nativeAppKitClicksVerified": false'
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"nativeAppKitClickVerifiedCount": 0'
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"visualResult": "pass"'
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"visualCaptures": 6'
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"nonBlankVisualCaptures": 6'
  require_contains "$LATEST_NATIVE_PACKET_JSON" '"visualManifest":'
  require_contains "$LATEST_NATIVE_PACKET_MD" 'Native Visual Captures'
  require_contains "$LATEST_NATIVE_PACKET_MD" 'Native AppKit/XCUITest clicks verified: `false`'
  LATEST_NATIVE_VISUAL_MANIFEST="$(json_string_value "visualManifest" "$LATEST_NATIVE_PACKET_JSON")"
  if [[ -n "$LATEST_NATIVE_VISUAL_MANIFEST" ]]; then
    require_file "$LATEST_NATIVE_VISUAL_MANIFEST"
    require_contains "$LATEST_NATIVE_VISUAL_MANIFEST" '"captureCount" : 6'
    require_contains "$LATEST_NATIVE_VISUAL_MANIFEST" '"nonBlankCount" : 6'
    require_contains "$LATEST_NATIVE_VISUAL_MANIFEST" '"noSystemPermissions" : true'
    require_contains "$LATEST_NATIVE_VISUAL_MANIFEST" '"externalUIAutomation" : false'
    require_contains "$LATEST_NATIVE_VISUAL_MANIFEST" '"nativeAppKitClicksVerified" : false'
  else
    fail "latest native packet has no visualManifest path"
  fi
else
  fail "no native review packet JSON exists; run scripts/review-loopops-native.command"
fi

note
note "== Optional full Swift tests =="
if [[ "${LOOPOPS_OBJECTIVE_AUDIT_SKIP_SWIFT_TEST:-0}" == "1" ]]; then
  note "swift_test=skipped_by_env"
else
  run_capture "swift test" "$AUDIT_DIR/swift-test.txt" swift test --disable-sandbox
  require_output_contains "$AUDIT_DIR/swift-test.txt" "Build complete"
fi

note
note "== Audit summary =="
note "loopops_objective_audit_logs=$AUDIT_DIR"
note "loopops_objective_audit_no_system_permissions=true"
note "loopops_objective_audit_external_ui_automation=false"
note "loopops_objective_audit_native_appkit_clicks_verified=false"
if (( failures > 0 )); then
  note "loopops_objective_audit=fail"
  note "loopops_objective_audit_failures=$failures"
  exit 1
fi

note "loopops_objective_audit=pass"
note "loopops_objective_audit_failures=0"
