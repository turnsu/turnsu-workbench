#!/usr/bin/env bash
# Verify LoopOps module traceability from research artifacts to implementation evidence.
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
TRACE_DOC="$RESEARCH_DIR/14-agent-team-traceability-matrix.md"

failures=0
module_count=8

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

echo "LoopOps traceability verification"
echo "This command only reads local files. It does not call open, AppleScript, Accessibility, screen recording, or browser automation."

require_file "$TRACE_DOC"

trace_ids=(
  "trace.marketplace_loop_library"
  "trace.knowledge_toast"
  "trace.tool_skill_os_logs"
  "trace.triple_chat_quick_gui"
  "trace.workbench_run_result"
  "trace.studio_builder_skill_path"
  "trace.no_permission_review"
  "trace.agent_team_process"
)
for trace_id in "${trace_ids[@]}"; do
  require_contains "$TRACE_DOC" "$trace_id"
done

research_docs=(
  "00-research-index.md"
  "01-marketplace-template-library.md"
  "02-knowledge-toast-system.md"
  "03-tool-creation-logs.md"
  "04-triple-chat-quick-gui.md"
  "05-implementation-acceptance-spec.md"
  "07-agent-team-final-audit.md"
  "08-evidence-receipts.md"
  "09-no-permission-review-runbook.md"
  "10-objective-completion-matrix.md"
  "11-browser-clickthrough-review.md"
  "12-remaining-decision-contract.md"
  "13-native-manual-review-checklist.md"
  "15-goal-completion-gate.md"
  "16-human-review-gallery.md"
)
for doc in "${research_docs[@]}"; do
  require_file "$RESEARCH_DIR/$doc"
done

for index in 01 02 03 04 05 06 07 08 09 10; do
  if compgen -G "$RESEARCH_DIR/screenshots/${index}-*.png" >/dev/null; then
    pass "screenshot exists: screenshots/${index}-*.png"
  else
    fail "missing screenshot: screenshots/${index}-*.png"
  fi
done

web_app="$WEB_DIR/src/App.jsx"
web_model="$WEB_DIR/src/loopopsModel.js"
web_smoke="$WEB_DIR/scripts/smoke.mjs"
swift_contracts="$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Models/LoopOpsInteractionContracts.swift"
swift_acceptance="$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsAcceptanceHarness.swift"
swift_activation="$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Services/LoopOpsNativeActivationHarness.swift"
swift_views="$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/LoopOpsViews.swift"
swift_workbench="$ROOT_DIR/domains/frontend/app/code/WeChatIntelligenceRadarApp/Views/BlocksWorkbenchView.swift"
receipts="$RESEARCH_DIR/08-evidence-receipts.md"
checklist="$RESEARCH_DIR/13-native-manual-review-checklist.md"

for file in "$web_app" "$web_model" "$web_smoke" "$swift_contracts" "$swift_acceptance" "$swift_activation" "$swift_views" "$swift_workbench" "$receipts" "$checklist"; do
  require_file "$file"
done
require_file "$RESEARCH_DIR/human-review-gallery.html"

require_contains "$web_app" "loopops.review-guide.path.marketplace"
require_contains "$web_app" "loopops.review-guide.traceability"
require_contains "$web_app" "loopops.review-guide.decision"
require_contains "$web_app" "loopops.review-guide.record-preview"
require_contains "$web_app" "loopops.review-guide.persistence"
require_contains "$web_app" "reviewGuideStorageKey"
require_contains "$web_app" "agent-team-process"
require_contains "$web_app" "loopops.knowledge.new-menu"
require_contains "$web_app" "loopops.skill-os.create-tool"
require_contains "$web_app" "loopops.chat.quick-controls"
require_contains "$web_app" "loopops.workbench.active-queue"
require_contains "$web_app" "loopops.workbench.run-result"
require_contains "$web_app" "loopops.studio.execution-path"
require_contains "$web_model" "makeToolDraft"
require_contains "$web_model" "filterKnowledgeItems"
require_contains "$web_smoke" "loopops.review-guide.record-handoff"
require_contains "$web_smoke" "loopops.review-guide.record-preview"
require_contains "$web_smoke" "loopops.review-guide.persistence"
require_contains "$web_smoke" "loopops.review-guide.traceability"
require_contains "$web_smoke" "agent-team-process"

require_contains "$swift_contracts" "loopLibraryTemplateMarketplace"
require_contains "$swift_contracts" "workbenchReviewGuideEvidenceMap"
require_contains "$swift_contracts" "workbenchReviewGuideDecision"
require_contains "$swift_contracts" "workbenchReviewGuideRecordPreview"
require_contains "$swift_contracts" "workbenchReviewGuidePersistence"
require_contains "$swift_contracts" "workbenchReviewGuideTraceability"
require_contains "$swift_contracts" "agent-team-process"
require_contains "$swift_contracts" "knowledgeNewMenu"
require_contains "$swift_contracts" "skillOSCreateTool"
require_contains "$swift_contracts" "scopedChatQuickControls"
require_contains "$swift_contracts" "workbenchActiveQueue"
require_contains "$swift_contracts" "workbenchRunResult"
require_contains "$swift_contracts" "studioExecutionPath"
require_contains "$swift_acceptance" "library_marketplace_install_to_studio=true"
require_contains "$swift_acceptance" "knowledge_attach_to_run=true"
require_contains "$swift_acceptance" "tool_log_source_tag=true"
require_contains "$swift_acceptance" "skill_stack_drop_reorder=true"
require_contains "$swift_acceptance" "workbench_evidence_map_sources=4"
require_contains "$swift_acceptance" "workbench_review_decision_board=true"
require_contains "$swift_acceptance" "workbench_review_record_preview=true"
require_contains "$swift_acceptance" "workbench_review_state_persistence=true"
require_contains "$swift_acceptance" "workbench_traceability_modules=8"
require_contains "$swift_activation" "native_appkit_clicks_verified=false"
require_contains "$swift_activation" "workbench_evidence_map_sources=4"
require_contains "$swift_activation" "workbench_review_decision_board=true"
require_contains "$swift_activation" "workbench_review_record_preview=true"
require_contains "$swift_activation" "workbench_review_state_persistence=true"
require_contains "$swift_activation" "workbench_traceability_modules=8"

require_contains "$receipts" "web_action_marketplace_install_to_studio=true"
require_contains "$receipts" "web_dom_knowledge_attach_updates_run=true"
require_contains "$receipts" "web_dom_create_tool_flow=true"
require_contains "$receipts" "web_dom_chat_send=true"
require_contains "$receipts" "web_dom_multi_run_queue=true"
require_contains "$receipts" "web_dom_review_record_preview=true"
require_contains "$receipts" "web_dom_review_state_persistence=true"
require_contains "$receipts" "loopops_action_skill_stack_drop_reorder=true"
require_contains "$receipts" "workbench_evidence_map_sources=4"
require_contains "$receipts" "workbench_review_decision_board=true"
require_contains "$receipts" "workbench_review_record_preview=true"
require_contains "$receipts" "workbench_review_state_persistence=true"
require_contains "$receipts" "workbench_traceability_modules=8"
require_contains "$receipts" "loopops_objective_audit=pass"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "status=pending-manual-review"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "loopops_objective_audit=pass"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "web_dom_review_state_persistence=true"
require_contains "$RESEARCH_DIR/15-goal-completion-gate.md" "workbench_review_state_persistence=true"
require_contains "$RESEARCH_DIR/16-human-review-gallery.md" "Human Review Gallery"
require_contains "$RESEARCH_DIR/16-human-review-gallery.md" "05a-skill-os-create-tool-import.png"
require_contains "$RESEARCH_DIR/16-human-review-gallery.md" "05b-skill-os-tool-logs-validation.png"
require_contains "$RESEARCH_DIR/human-review-gallery.html" "LoopOps Human Review Gallery"
require_contains "$RESEARCH_DIR/human-review-gallery.html" "05a-skill-os-create-tool-import.png"
require_contains "$RESEARCH_DIR/human-review-gallery.html" "05b-skill-os-tool-logs-validation.png"
require_contains "$RESEARCH_DIR/human-review-gallery.html" "06a-studio-builder-patch-receipt.png"
require_contains "$checklist" "Loop Library marketplace"
require_contains "$checklist" "Knowledge attach"
require_contains "$checklist" "Skill OS Create Tool"
require_contains "$checklist" "Studio execution path"
require_contains "$checklist" "Evidence map"
require_contains "$checklist" "Review decision"
require_contains "$checklist" "Agent team traceability"
require_contains "$checklist" "workbench_review_state_persistence=true"

require_file "$ROOT_DIR/scripts/audit-loopops-objective.command"
require_file "$ROOT_DIR/scripts/review-loopops-all.command"
require_file "$ROOT_DIR/scripts/record-loopops-review.command"

echo "loopops_traceability_modules=$module_count"
echo "loopops_traceability_no_system_permissions=true"
if (( failures > 0 )); then
  echo "loopops_traceability=fail"
  echo "loopops_traceability_failures=$failures"
  exit 1
fi

echo "loopops_traceability=pass"
echo "loopops_traceability_failures=0"
