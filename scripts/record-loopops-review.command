#!/usr/bin/env bash
# Generate a timestamped manual LoopOps review record without opening apps or browsers.
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
RECORD_DIR="${LOOPOPS_REVIEW_RECORD_DIR:-$RESEARCH_DIR/review-records}"

TIMESTAMP="$(date '+%Y-%m-%d-%H%M%S')"
REVIEW_ID="${LOOPOPS_REVIEW_ID:-loopops-review-$TIMESTAMP}"
STATUS="${LOOPOPS_REVIEW_STATUS:-pending-manual-review}"
REVIEWER="${LOOPOPS_REVIEWER:-${USER:-manual-reviewer}}"
SURFACES="${LOOPOPS_REVIEW_SURFACES:-web,native}"
BLOCKERS="${LOOPOPS_REVIEW_BLOCKERS-not-reviewed-yet}"
NOTES="${LOOPOPS_REVIEW_NOTES:-}"
WEB_URL="${LOOPOPS_WEB_URL:-http://127.0.0.1:5184/}"
OFFLINE_HTML="$WEB_DIR/dist/loopops-admin-offline.html"
NATIVE_APP="$ROOT_DIR/.build/debug-app/WeChatIntelligenceRadar.app"
NATIVE_CHECKLIST="$RESEARCH_DIR/13-native-manual-review-checklist.md"
COMPLETION_MATRIX="$RESEARCH_DIR/10-objective-completion-matrix.md"
COMPLETION_GATE="$RESEARCH_DIR/15-goal-completion-gate.md"
HUMAN_REVIEW_GALLERY="$RESEARCH_DIR/human-review-gallery.html"
HUMAN_REVIEW_GALLERY_DOC="$RESEARCH_DIR/16-human-review-gallery.md"
OBJECTIVE_AUDIT_DIR="$ROOT_DIR/.build/loopops-objective-audit"
SWIFT_TEST_LOG="$OBJECTIVE_AUDIT_DIR/swift-test.txt"
MANAGER_GATE_SCRIPT="$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command"
SESSION_DIR="$RESEARCH_DIR/review-sessions"
NATIVE_PACKET_DIR="$RESEARCH_DIR/native-review-packets"

latest_file() {
  local dir="$1"
  local pattern="$2"
  if [[ ! -d "$dir" ]]; then
    return 0
  fi
  find "$dir" -maxdepth 1 -type f -name "$pattern" | sort | tail -n 1
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

last_metric_value() {
  local key="$1"
  local path="$2"
  if [[ -s "$path" ]]; then
    grep -E "^${key}=" "$path" | tail -n 1 | cut -d= -f2- || true
  fi
}

NORMALIZED_STATUS="$(printf '%s' "$STATUS" | tr '[:upper:]' '[:lower:]')"
TRIMMED_BLOCKERS="$(trim_value "$BLOCKERS")"
if [[ "$NORMALIZED_STATUS" == "pass" ]]; then
  if [[ -n "$TRIMMED_BLOCKERS" ]]; then
    printf 'loopops_manual_review_record=invalid\n' >&2
    printf 'error=pass review records must not include blockers\n' >&2
    exit 2
  fi
  if is_placeholder_notes "$NOTES"; then
    printf 'loopops_manual_review_record=invalid\n' >&2
    printf 'error=pass review records require explicit reviewer notes\n' >&2
    exit 2
  fi
elif [[ "$NORMALIZED_STATUS" == "needs-work" || "$NORMALIZED_STATUS" == "needs_work" || "$NORMALIZED_STATUS" == "blocked" || "$NORMALIZED_STATUS" == "fail" || "$NORMALIZED_STATUS" == "failed" ]]; then
  if [[ -z "$TRIMMED_BLOCKERS" || "$TRIMMED_BLOCKERS" == "<specific blockers>" || "$TRIMMED_BLOCKERS" == "specific blockers" ]]; then
    printf 'loopops_manual_review_record=invalid\n' >&2
    printf 'error=non-pass review records require concrete blockers\n' >&2
    exit 2
  fi
fi

NATIVE_VISUAL_GALLERY_REL="$(sed -nE 's/^Native visual gallery:[[:space:]]*(.*)$/\1/p' "$HUMAN_REVIEW_GALLERY_DOC" 2>/dev/null | head -n 1 || true)"
if [[ -n "$NATIVE_VISUAL_GALLERY_REL" ]]; then
  if [[ "$NATIVE_VISUAL_GALLERY_REL" == /* ]]; then
    NATIVE_VISUAL_GALLERY="$NATIVE_VISUAL_GALLERY_REL"
  else
    NATIVE_VISUAL_GALLERY="$RESEARCH_DIR/$NATIVE_VISUAL_GALLERY_REL"
  fi
else
  NATIVE_VISUAL_DIR="$(find "$RESEARCH_DIR/native-visual-audit" -maxdepth 1 -type d -name 'loopops-native-visual-*' 2>/dev/null | sort | tail -n 1 || true)"
  if [[ -n "$NATIVE_VISUAL_DIR" ]]; then
    NATIVE_VISUAL_GALLERY="$NATIVE_VISUAL_DIR/README.md"
  else
    NATIVE_VISUAL_GALLERY="$RESEARCH_DIR/native-visual-audit"
  fi
fi

SERVER_HANDOFF_REL="$(sed -nE 's/^Latest no-permission server handoff:[[:space:]]*(.*)$/\1/p' "$HUMAN_REVIEW_GALLERY_DOC" 2>/dev/null | head -n 1 || true)"
if [[ -n "$SERVER_HANDOFF_REL" ]]; then
  if [[ "$SERVER_HANDOFF_REL" == /* ]]; then
    SERVER_HANDOFF_MD="$SERVER_HANDOFF_REL"
  else
    SERVER_HANDOFF_MD="$RESEARCH_DIR/$SERVER_HANDOFF_REL"
  fi
  SERVER_HANDOFF_JSON="${SERVER_HANDOFF_MD%.md}.json"
else
  SERVER_HANDOFF_MD=""
  SERVER_HANDOFF_JSON=""
fi

LATEST_SESSION_JSON="$(latest_file "$SESSION_DIR" "loopops-session-*.json")"
if [[ -n "$LATEST_SESSION_JSON" ]]; then
  LATEST_SESSION_ID="$(basename "$LATEST_SESSION_JSON" .json)"
  LATEST_SESSION_MD="$SESSION_DIR/$LATEST_SESSION_ID.md"
  LATEST_WEB_LOG="$SESSION_DIR/$LATEST_SESSION_ID-web.log"
  LATEST_NATIVE_LOG="$SESSION_DIR/$LATEST_SESSION_ID-native.log"
else
  LATEST_SESSION_ID=""
  LATEST_SESSION_MD=""
  LATEST_WEB_LOG=""
  LATEST_NATIVE_LOG=""
fi
LATEST_NATIVE_PACKET_JSON="$(latest_file "$NATIVE_PACKET_DIR" "loopops-native-review-*.json")"
if [[ -n "$LATEST_NATIVE_PACKET_JSON" ]]; then
  LATEST_NATIVE_PACKET_ID="$(basename "$LATEST_NATIVE_PACKET_JSON" .json)"
  LATEST_NATIVE_PACKET_MD="$NATIVE_PACKET_DIR/$LATEST_NATIVE_PACKET_ID.md"
else
  LATEST_NATIVE_PACKET_MD=""
fi
WEB_REVIEW_SERVER="$(last_metric_value "web_no_permission_review_server" "$LATEST_WEB_LOG")"
WEB_DOM_SMOKE_SOURCE="$(last_metric_value "web_no_permission_review_dom_smoke_source" "$LATEST_WEB_LOG")"
WEB_DOM_LIBRARY_PRIMARY_ROW_RUN="$(last_metric_value "web_dom_library_primary_row_run" "$LATEST_WEB_LOG")"
WEB_DOM_MULTI_RUN="$(last_metric_value "web_dom_multi_run_queue" "$LATEST_WEB_LOG")"
WEB_DOM_RUN_CHAT_ISOLATED="$(last_metric_value "web_dom_run_chat_isolated" "$LATEST_WEB_LOG")"
WEB_DOM_STACK_DRAG_ADD="$(last_metric_value "web_dom_stack_drag_add" "$LATEST_WEB_LOG")"
WEB_DOM_STACK_DRAG_REORDER="$(last_metric_value "web_dom_stack_drag_reorder" "$LATEST_WEB_LOG")"
WEB_DOM_CREATE_TOOL="$(last_metric_value "web_dom_create_tool_flow" "$LATEST_WEB_LOG")"
WEB_DOM_KNOWLEDGE_ATTACH="$(last_metric_value "web_dom_knowledge_attach_updates_run" "$LATEST_WEB_LOG")"
WEB_DOM_BUILDER_PATCH="$(last_metric_value "web_dom_builder_patch_receipt" "$LATEST_WEB_LOG")"
MANUAL_PASS_REQUIRES_REVIEWER_NOTES=true
MANUAL_PASS_REJECTS_BLOCKERS=true
MANUAL_NON_PASS_REQUIRES_CONCRETE_BLOCKERS=true
MANUAL_GUARDRAIL_PROBES_COVERED_BY_OBJECTIVE_AUDIT=true

mkdir -p "$RECORD_DIR"

MARKDOWN_PATH="$RECORD_DIR/$REVIEW_ID.md"
JSON_PATH="$RECORD_DIR/$REVIEW_ID.json"

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

{
  printf '# LoopOps Manual Review Record\n\n'
  printf '%s\n' "- Review ID: \`$REVIEW_ID\`"
  printf '%s\n' "- Status: \`$STATUS\`"
  printf '%s\n' "- Reviewer: \`$REVIEWER\`"
  printf '%s\n' "- Created: \`$TIMESTAMP\`"
  printf '%s\n' "- Surfaces: \`$SURFACES\`"
  printf '%s\n\n' '- Permission model: no `open`, AppleScript, browser automation, Accessibility, or screen recording required by this recorder.'
  printf '## Entrypoints\n\n'
  printf '%s\n' "- Web review URL: \`$WEB_URL\`"
  printf '%s\n' "- Web offline artifact: \`$OFFLINE_HTML\`"
  printf '%s\n' "- Human review gallery: \`$HUMAN_REVIEW_GALLERY\`"
  printf '%s\n' "- Human review route: \`$HUMAN_REVIEW_GALLERY_DOC\`"
  printf '%s\n' "- Native app bundle: \`$NATIVE_APP\`"
  printf '%s\n' "- Native checklist: \`$NATIVE_CHECKLIST\`"
  printf '%s\n' "- Native visual gallery: \`$NATIVE_VISUAL_GALLERY\`"
  if [[ -n "$SERVER_HANDOFF_MD" ]]; then
    printf '%s\n' "- No-permission server handoff: \`$SERVER_HANDOFF_MD\`"
    printf '%s\n' "- No-permission server handoff JSON: \`$SERVER_HANDOFF_JSON\`"
  fi
  printf '%s\n' "- Completion matrix: \`$COMPLETION_MATRIX\`"
  printf '%s\n' "- Completion gate: \`$COMPLETION_GATE\`"
  printf '%s\n' "- Objective audit logs: \`$OBJECTIVE_AUDIT_DIR\`"
  printf '%s\n' "- Swift test log: \`$SWIFT_TEST_LOG\`"
  printf '%s\n\n' "- Manager gate: \`$MANAGER_GATE_SCRIPT\`"
  printf '## Evidence Snapshot\n\n'
  if [[ -n "$LATEST_SESSION_JSON" ]]; then
    printf '%s\n' "- Latest review session: \`$LATEST_SESSION_MD\`"
    printf '%s\n' "- Latest review session JSON: \`$LATEST_SESSION_JSON\`"
    printf '%s\n' "- Latest Web review log: \`$LATEST_WEB_LOG\`"
    printf '%s\n' "- Latest native review log: \`$LATEST_NATIVE_LOG\`"
  fi
  if [[ -n "$LATEST_NATIVE_PACKET_JSON" ]]; then
    printf '%s\n' "- Latest native review packet: \`$LATEST_NATIVE_PACKET_MD\`"
    printf '%s\n' "- Latest native review packet JSON: \`$LATEST_NATIVE_PACKET_JSON\`"
  fi
  if [[ -n "$SERVER_HANDOFF_MD" ]]; then
    printf '%s\n' "- Latest no-permission server handoff: \`$SERVER_HANDOFF_MD\`"
    printf '%s\n' "- Latest no-permission server handoff JSON: \`$SERVER_HANDOFF_JSON\`"
  fi
  printf '%s\n' "- Review-ready gate command: \`LOOPOPS_MANAGER_GATE_MODE=review-ready scripts/manager-loopops-acceptance-gate.command\`"
  printf '%s\n' "- Full gate command: \`scripts/manager-loopops-acceptance-gate.command\`"
  if [[ -n "$WEB_REVIEW_SERVER" ]]; then
    printf '%s\n' "- Web review server: \`$WEB_REVIEW_SERVER\`"
  fi
  if [[ -n "$WEB_DOM_SMOKE_SOURCE" ]]; then
    printf '%s\n' "- Web DOM smoke source: \`$WEB_DOM_SMOKE_SOURCE\`"
  fi
  printf '%s\n' "- Web Library primary row run: \`${WEB_DOM_LIBRARY_PRIMARY_ROW_RUN:-unknown}\`"
  printf '%s\n' "- Web multi-run queue: \`${WEB_DOM_MULTI_RUN:-unknown}\`"
  printf '%s\n' "- Web Run Chat isolated: \`${WEB_DOM_RUN_CHAT_ISOLATED:-unknown}\`"
  printf '%s\n' "- Web stack drag add: \`${WEB_DOM_STACK_DRAG_ADD:-unknown}\`"
  printf '%s\n' "- Web stack drag reorder: \`${WEB_DOM_STACK_DRAG_REORDER:-unknown}\`"
  printf '%s\n' "- Web Create Tool flow: \`${WEB_DOM_CREATE_TOOL:-unknown}\`"
  printf '%s\n' "- Web Knowledge attach updates run: \`${WEB_DOM_KNOWLEDGE_ATTACH:-unknown}\`"
  printf '%s\n' "- Web Builder patch receipt: \`${WEB_DOM_BUILDER_PATCH:-unknown}\`"
  printf '%s\n' "- Manual pass requires reviewer notes: \`$MANUAL_PASS_REQUIRES_REVIEWER_NOTES\`"
  printf '%s\n' "- Manual pass rejects blockers: \`$MANUAL_PASS_REJECTS_BLOCKERS\`"
  printf '%s\n' "- Manual non-pass requires concrete blockers: \`$MANUAL_NON_PASS_REQUIRES_CONCRETE_BLOCKERS\`"
  printf '%s\n\n' "- Manual guardrail probes covered by objective audit: \`$MANUAL_GUARDRAIL_PROBES_COVERED_BY_OBJECTIVE_AUDIT\`"
  printf '## Checklist\n\n'
  printf '%s\n' '- [ ] Human review gallery opens and points at the current pending record.'
  printf '%s\n' '- [ ] Web Workbench active queue and selected Run Result are visible.'
  printf '%s\n' '- [ ] Web Loop Library can start one loop and multiple selected loops.'
  printf '%s\n' '- [ ] Web Skill OS create-tool, tool drawer, and logs are reachable without hidden runtime/provider/gate labels.'
  printf '%s\n' '- [ ] Web Knowledge attach flow updates scope and evidence context.'
  printf '%s\n' '- [ ] Web Chat panel can seed prompts from command chips and review/chat scopes stay clear.'
  printf '%s\n' '- [ ] Native Workbench Review Guide paths route to Loop Library, Skill OS, Knowledge, and Chat.'
  printf '%s\n' '- [ ] Native Loop Library run actions and Run Result panel are visible.'
  printf '%s\n' '- [ ] Native Studio skill execution path supports visible add/remove/order review.'
  printf '%s\n' '- [ ] Native Review Packet keeps external action boundaries explicit.'
  printf '%s\n' '- [ ] Native visual gallery surfaces match the latest current handoff.'
  printf '%s\n\n' '- [ ] No permission popup is required for scripted preflight or record generation.'
  printf '## Result\n\n'
  printf '%s\n' "- Status: \`$STATUS\`"
  printf '%s\n' "- Blockers: $BLOCKERS"
  if [[ -n "$NOTES" ]]; then
    printf '%s\n' "- Notes: $NOTES"
  else
    printf '%s\n' '- Notes: '
  fi
  printf '\n## Follow-Up Evidence\n\n'
  printf '%s\n' '- Add this record to `08-evidence-receipts.md` after manual review is complete.'
  printf '%s\n' '- If status is not `pass`, copy blockers into `10-objective-completion-matrix.md`.'
} > "$MARKDOWN_PATH"

{
  printf '{\n'
  printf '  "reviewId": "%s",\n' "$(json_escape "$REVIEW_ID")"
  printf '  "status": "%s",\n' "$(json_escape "$STATUS")"
  printf '  "reviewer": "%s",\n' "$(json_escape "$REVIEWER")"
  printf '  "created": "%s",\n' "$(json_escape "$TIMESTAMP")"
  printf '  "surfaces": "%s",\n' "$(json_escape "$SURFACES")"
  printf '  "permissionModel": "no open, AppleScript, browser automation, Accessibility, or screen recording required by this recorder",\n'
  printf '  "entrypoints": {\n'
  printf '    "webUrl": "%s",\n' "$(json_escape "$WEB_URL")"
  printf '    "webOfflineArtifact": "%s",\n' "$(json_escape "$OFFLINE_HTML")"
  printf '    "humanReviewGallery": "%s",\n' "$(json_escape "$HUMAN_REVIEW_GALLERY")"
  printf '    "humanReviewRoute": "%s",\n' "$(json_escape "$HUMAN_REVIEW_GALLERY_DOC")"
  printf '    "nativeAppBundle": "%s",\n' "$(json_escape "$NATIVE_APP")"
  printf '    "nativeChecklist": "%s",\n' "$(json_escape "$NATIVE_CHECKLIST")"
  printf '    "nativeVisualGallery": "%s",\n' "$(json_escape "$NATIVE_VISUAL_GALLERY")"
  printf '    "noPermissionServerHandoff": "%s",\n' "$(json_escape "$SERVER_HANDOFF_MD")"
  printf '    "noPermissionServerHandoffJSON": "%s",\n' "$(json_escape "$SERVER_HANDOFF_JSON")"
  printf '    "completionMatrix": "%s",\n' "$(json_escape "$COMPLETION_MATRIX")"
  printf '    "completionGate": "%s",\n' "$(json_escape "$COMPLETION_GATE")"
  printf '    "objectiveAuditLogs": "%s",\n' "$(json_escape "$OBJECTIVE_AUDIT_DIR")"
  printf '    "swiftTestLog": "%s",\n' "$(json_escape "$SWIFT_TEST_LOG")"
  printf '    "managerGate": "%s"\n' "$(json_escape "$MANAGER_GATE_SCRIPT")"
  printf '  },\n'
  printf '  "evidence": {\n'
  printf '    "latestReviewSessionId": "%s",\n' "$(json_escape "$LATEST_SESSION_ID")"
  printf '    "latestReviewSessionMarkdown": "%s",\n' "$(json_escape "$LATEST_SESSION_MD")"
  printf '    "latestReviewSessionJSON": "%s",\n' "$(json_escape "$LATEST_SESSION_JSON")"
  printf '    "latestWebReviewLog": "%s",\n' "$(json_escape "$LATEST_WEB_LOG")"
  printf '    "latestNativeReviewLog": "%s",\n' "$(json_escape "$LATEST_NATIVE_LOG")"
  printf '    "latestNativeReviewPacket": "%s",\n' "$(json_escape "$LATEST_NATIVE_PACKET_MD")"
  printf '    "latestNativeReviewPacketJSON": "%s",\n' "$(json_escape "$LATEST_NATIVE_PACKET_JSON")"
  printf '    "latestNoPermissionServerHandoff": "%s",\n' "$(json_escape "$SERVER_HANDOFF_MD")"
  printf '    "latestNoPermissionServerHandoffJSON": "%s",\n' "$(json_escape "$SERVER_HANDOFF_JSON")"
  printf '    "reviewReadyGateCommand": "LOOPOPS_MANAGER_GATE_MODE=review-ready scripts/manager-loopops-acceptance-gate.command",\n'
  printf '    "fullGateCommand": "scripts/manager-loopops-acceptance-gate.command",\n'
  printf '    "webReviewServer": "%s",\n' "$(json_escape "$WEB_REVIEW_SERVER")"
  printf '    "webDomSmokeSource": "%s",\n' "$(json_escape "$WEB_DOM_SMOKE_SOURCE")"
  printf '    "webDomLibraryPrimaryRowRun": "%s",\n' "$(json_escape "$WEB_DOM_LIBRARY_PRIMARY_ROW_RUN")"
  printf '    "webDomMultiRunQueue": "%s",\n' "$(json_escape "$WEB_DOM_MULTI_RUN")"
  printf '    "webDomRunChatIsolated": "%s",\n' "$(json_escape "$WEB_DOM_RUN_CHAT_ISOLATED")"
  printf '    "webDomStackDragAdd": "%s",\n' "$(json_escape "$WEB_DOM_STACK_DRAG_ADD")"
  printf '    "webDomStackDragReorder": "%s",\n' "$(json_escape "$WEB_DOM_STACK_DRAG_REORDER")"
  printf '    "webDomCreateToolFlow": "%s",\n' "$(json_escape "$WEB_DOM_CREATE_TOOL")"
  printf '    "webDomKnowledgeAttachUpdatesRun": "%s",\n' "$(json_escape "$WEB_DOM_KNOWLEDGE_ATTACH")"
  printf '    "webDomBuilderPatchReceipt": "%s",\n' "$(json_escape "$WEB_DOM_BUILDER_PATCH")"
  printf '    "manualPassRequiresReviewerNotes": "%s",\n' "$MANUAL_PASS_REQUIRES_REVIEWER_NOTES"
  printf '    "manualPassRejectsBlockers": "%s",\n' "$MANUAL_PASS_REJECTS_BLOCKERS"
  printf '    "manualNonPassRequiresConcreteBlockers": "%s",\n' "$MANUAL_NON_PASS_REQUIRES_CONCRETE_BLOCKERS"
  printf '    "manualGuardrailProbesCoveredByObjectiveAudit": "%s"\n' "$MANUAL_GUARDRAIL_PROBES_COVERED_BY_OBJECTIVE_AUDIT"
  printf '  },\n'
  printf '  "blockers": "%s",\n' "$(json_escape "$BLOCKERS")"
  printf '  "notes": "%s",\n' "$(json_escape "$NOTES")"
  printf '  "checklist": [\n'
  printf '    "Human review gallery opens and points at the current pending record",\n'
  printf '    "Web Workbench active queue and selected Run Result are visible",\n'
  printf '    "Web Loop Library can start one loop and multiple selected loops",\n'
  printf '    "Web Skill OS create-tool, tool drawer, and logs are reachable without hidden runtime/provider/gate labels",\n'
  printf '    "Web Knowledge attach flow updates scope and evidence context",\n'
  printf '    "Web Chat panel can seed prompts from command chips and review/chat scopes stay clear",\n'
  printf '    "Native Workbench Review Guide paths route to Loop Library, Skill OS, Knowledge, and Chat",\n'
  printf '    "Native Loop Library run actions and Run Result panel are visible",\n'
  printf '    "Native Studio skill execution path supports visible add/remove/order review",\n'
  printf '    "Native Review Packet keeps external action boundaries explicit",\n'
  printf '    "Native visual gallery surfaces match the latest current handoff",\n'
  printf '    "No permission popup is required for scripted preflight or record generation"\n'
  printf '  ]\n'
  printf '}\n'
} > "$JSON_PATH"

echo "loopops_manual_review_record=created"
echo "loopops_manual_review_status=$STATUS"
echo "loopops_manual_review_markdown=$MARKDOWN_PATH"
echo "loopops_manual_review_json=$JSON_PATH"
echo "This command did not open apps, browsers, or system automation surfaces."
