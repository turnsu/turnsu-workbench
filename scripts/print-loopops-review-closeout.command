#!/usr/bin/env bash
# Print exact LoopOps manual-review closeout commands without opening apps or browsers.
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
HUMAN_REVIEW_DOC="$RESEARCH_DIR/16-human-review-gallery.md"
HUMAN_REVIEW_GALLERY="$RESEARCH_DIR/human-review-gallery.html"
MANAGER_GATE_SCRIPT="$ROOT_DIR/scripts/manager-loopops-acceptance-gate.command"
RECORDER_SCRIPT="$ROOT_DIR/scripts/record-loopops-review.command"

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
  if [[ -s "$path" ]]; then
    sed -nE "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\\1/p" "$path" | head -n 1
  fi
}

relpath() {
  local path="$1"
  if [[ "$path" == "$ROOT_DIR/"* ]]; then
    printf '%s' "${path#$ROOT_DIR/}"
  else
    printf '%s' "$path"
  fi
}

native_visual_gallery() {
  local rel
  rel="$(sed -nE 's/^Native visual gallery:[[:space:]]*(.*)$/\1/p' "$HUMAN_REVIEW_DOC" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$rel" ]]; then
    if [[ "$rel" == /* ]]; then
      printf '%s' "$rel"
    else
      printf '%s/%s' "$RESEARCH_DIR" "$rel"
    fi
    return
  fi
  local dir
  dir="$(find "$RESEARCH_DIR/native-visual-audit" -maxdepth 1 -type d -name 'loopops-native-visual-*' 2>/dev/null | sort | tail -n 1 || true)"
  if [[ -n "$dir" ]]; then
    printf '%s/README.md' "$dir"
  fi
}

LATEST_RECORD_JSON="$(latest_file "$RECORD_DIR" "loopops-review-*.json")"
LATEST_RECORD_MD=""
LATEST_STATUS=""
LATEST_BLOCKERS=""
LATEST_NOTES=""
WEB_URL="${LOOPOPS_WEB_URL:-http://127.0.0.1:5188/}"

if [[ -n "$LATEST_RECORD_JSON" ]]; then
  LATEST_RECORD_ID="$(basename "$LATEST_RECORD_JSON" .json)"
  LATEST_RECORD_MD="$RECORD_DIR/$LATEST_RECORD_ID.md"
  LATEST_STATUS="$(json_string_value "status" "$LATEST_RECORD_JSON")"
  LATEST_BLOCKERS="$(json_string_value "blockers" "$LATEST_RECORD_JSON")"
  LATEST_NOTES="$(json_string_value "notes" "$LATEST_RECORD_JSON")"
  RECORD_WEB_URL="$(json_string_value "webUrl" "$LATEST_RECORD_JSON")"
  if [[ -n "$RECORD_WEB_URL" ]]; then
    WEB_URL="$RECORD_WEB_URL"
  fi
fi

LATEST_PENDING_JSON=""
if [[ -d "$RECORD_DIR" ]]; then
  while IFS= read -r candidate; do
    candidate_status="$(json_string_value "status" "$candidate")"
    case "$candidate_status" in
      pending|pending-manual-review|*pending*)
        LATEST_PENDING_JSON="$candidate"
        ;;
    esac
  done < <(find "$RECORD_DIR" -maxdepth 1 -type f -name 'loopops-review-*.json' | sort)
fi

LATEST_PENDING_MD=""
if [[ -n "$LATEST_PENDING_JSON" ]]; then
  LATEST_PENDING_MD="$RECORD_DIR/$(basename "$LATEST_PENDING_JSON" .json).md"
fi

NATIVE_VISUAL_GALLERY="$(native_visual_gallery)"

printf 'loopops_review_closeout=ready\n'
printf 'permission_model=no open, AppleScript, browser automation, Accessibility, or screen recording\n'
printf 'web_review_url=%s\n' "$WEB_URL"
printf 'human_review_gallery=%s\n' "$(relpath "$HUMAN_REVIEW_GALLERY")"
printf 'human_review_doc=%s\n' "$(relpath "$HUMAN_REVIEW_DOC")"
if [[ -n "$NATIVE_VISUAL_GALLERY" ]]; then
  printf 'native_visual_gallery=%s\n' "$(relpath "$NATIVE_VISUAL_GALLERY")"
fi
if [[ -n "$LATEST_RECORD_JSON" ]]; then
  printf 'latest_review_record_json=%s\n' "$(relpath "$LATEST_RECORD_JSON")"
  printf 'latest_review_record_markdown=%s\n' "$(relpath "$LATEST_RECORD_MD")"
  printf 'latest_review_status=%s\n' "$LATEST_STATUS"
  printf 'latest_review_blockers=%s\n' "$LATEST_BLOCKERS"
  printf 'latest_review_notes=%s\n' "$LATEST_NOTES"
else
  printf 'latest_review_record_json=missing\n'
fi
if [[ -n "$LATEST_PENDING_JSON" ]]; then
  printf 'latest_pending_record_json=%s\n' "$(relpath "$LATEST_PENDING_JSON")"
  printf 'latest_pending_record_markdown=%s\n' "$(relpath "$LATEST_PENDING_MD")"
fi
printf '\n'

printf '== Record a pass after manual review ==\n'
printf 'LOOPOPS_WEB_URL="%s" \\\n' "$WEB_URL"
printf 'LOOPOPS_REVIEW_STATUS=pass \\\n'
printf 'LOOPOPS_REVIEW_BLOCKERS="" \\\n'
printf 'LOOPOPS_REVIEW_NOTES="Reviewed Workbench, Loop Library, Skill OS, Studio, Knowledge, Tool Logs, Run Result, Run Chat, Review Chat and native visual gallery; no blockers." \\\n'
printf '%s\n' "$(relpath "$RECORDER_SCRIPT")"
printf '\n'

printf '== Record needs-work with concrete blockers ==\n'
printf 'LOOPOPS_WEB_URL="%s" \\\n' "$WEB_URL"
printf 'LOOPOPS_REVIEW_STATUS=needs-work \\\n'
printf 'LOOPOPS_REVIEW_BLOCKERS="<specific blocker observed during manual review>" \\\n'
printf 'LOOPOPS_REVIEW_NOTES="<review path, affected surface, and expected correction>" \\\n'
printf '%s\n' "$(relpath "$RECORDER_SCRIPT")"
printf '\n'

printf '== Validate after recording ==\n'
printf 'LOOPOPS_MANAGER_GATE_MODE=review-ready %s\n' "$(relpath "$MANAGER_GATE_SCRIPT")"
printf '%s\n' "$(relpath "$MANAGER_GATE_SCRIPT")"
printf '\n'
printf 'Full gate should pass only after a pass record with explicit notes and no blockers. If the latest record is needs-work, full gate should fail and surface the blocker.\n'
