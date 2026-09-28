import {
  Check,
  Errors,
  ErrorEnvelopeSchema,
  PUBLIC_ENDPOINTS,
  RunEventSchema,
  SessionDomainEnvelopeSchema,
} from "@turnsu/workbench-contracts";

import { createWorkbenchHostValidator } from "../security/workbench-host-validator.mjs";
import {
  WorkbenchSessionStore,
  clearSessionCookie,
  parseCookies,
  sessionCookie,
} from "../security/workbench-session-store.mjs";

const JSON_LIMIT = 24_000_000;
const EMPTY = Object.freeze({});
const EMPTY_PAGE = Object.freeze({ nextCursor: null, hasMore: false });
const NATIVE_DESKTOP_DEVICE_MUTATIONS = new Set([
  "acceptMemberAgentRequest", "checkMemberAgentExecution", "deliverMemberAgentOutput",
  "registerDevice",
  "heartbeatDevice",
]);

class WorkbenchHttpError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "WorkbenchHttpError";
    this.code = code;
    this.details = details;
  }
}

const errorStatus = {
  member_agent_registration_interrupted:409,
  member_agent_request_invalid:400,member_agent_cursor_invalid:400,member_agent_unavailable:503,member_agent_request_not_found:404,
  member_agent_provider_required:403,member_agent_device_forbidden:403,member_agent_method_unavailable:404,
  member_agent_method_unsupported:409,member_agent_method_changed:409,member_agent_limits_invalid:400,
  member_agent_request_decided:409,member_agent_request_expired:410,member_agent_request_changed:409,
  member_agent_request_revoked:403,member_agent_execution_unavailable:409,member_agent_execution_mismatch:409,
  member_agent_execution_finished:409,member_agent_output_changed:409,member_agent_output_invalid:400,

  session_required: 401,
  auth_unavailable: 503,
  bootstrap_admin_unavailable: 503,
  bootstrap_admin_required: 403,
  bootstrap_admin_already_claimed: 409,
  registration_closed: 403,
  username_unavailable: 409,
  invalid_credentials: 401,
  account_disabled: 403,
  member_admin_required: 403,
  member_not_found: 404,
  member_update_required: 400,
  last_admin_required: 409,
  auth_role_invalid: 400,
  password_registration_disabled: 403,
  invitation_email_invalid: 400,
  invitation_expiry_invalid: 400,
  invitation_token_hash_invalid: 400,
  invitation_already_pending: 409,
  invitation_not_found: 404,
  invitation_not_revocable: 409,
  invitation_not_resendable: 409,
  invitation_invalid: 404,
  invitation_revoked: 410,
  invitation_expired: 410,
  invitation_already_accepted: 409,
  invitation_email_mismatch: 403,
  invitation_delivery_unavailable: 503,
  identity_signing_unavailable: 503,
  smtp_delivery_receipt_invalid: 502,
  oauth_provider_invalid: 400,
  oauth_provider_unavailable: 503,
  oauth_provider_rejected: 502,
  oauth_provider_response_invalid: 502,
  oauth_provider_denied: 403,
  oauth_identity_token_invalid: 401,
  oauth_email_unverified: 403,
  oauth_state_invalid: 400,
  oauth_state_expired: 410,
  oauth_state_hash_invalid: 400,
  oauth_authorization_code_required: 400,
  oauth_identity_binding_required: 409,
  oauth_explicit_binding_required: 409,
  oauth_binding_session_required: 401,
  oauth_provider_already_bound: 409,
  oauth_new_username_invalid: 500,
  oauth_new_username_unavailable: 409,
  bearer_not_accepted: 401,
  native_client_auth_unavailable: 503,
  native_client_kind_invalid: 400,
  native_authorization_id_required: 400,
  native_authorization_invalid: 400,
  native_authorization_code_invalid: 400,
  native_authorization_unavailable: 404,
  native_authorization_expired: 410,
  native_pkce_verification_failed: 401,
  native_redirect_uri_invalid: 400,
  native_device_key_invalid: 400,
  native_device_key_mismatch: 403,
  native_token_invalid: 401,
  native_access_token_invalid: 401,
  native_refresh_token_replayed: 401,
  native_cookie_forbidden: 403,
  workspace_access_forbidden: 403,
  workspace_role_forbidden: 403,
  workspace_role_invalid: 400,
  workspace_member_role_invalid: 400,
  workspace_membership_exists: 409,
  membership_management_unavailable: 503,
  invalid_host: 403,
  origin_forbidden: 403,
  fetch_site_forbidden: 403,
  csrf_invalid: 403,
  request_invalid: 400,
  precondition_required: 428,
  workflow_revision_conflict: 412,
  local_loop_trial_invalid: 400,
  local_loop_trial_exists: 409,
  local_loop_trial_private_required: 409,
  local_loop_trial_unavailable: 503,
  native_loop_publish_invalid: 400,
  native_loop_private_required: 409,
  native_loop_trial_required: 409,
  native_loop_version_exists: 409,
  native_loop_recipe_unsupported: 409,
  native_loop_skill_unavailable: 409,
  native_loop_package_substituted: 409,
  native_loop_managed_execution_unavailable: 409,
  native_loop_unavailable: 503,
  idempotency_key_reused: 409,
  idempotency_in_progress: 409,
  idempotency_claim_lost: 409,
  idempotency_record_incomplete: 409,
  template_read_only: 409,
  skill_not_found: 404,
  template_not_found: 404,
  workflow_not_found: 404,
  workflow_revision_not_found: 404,
  run_not_found: 404,
  route_not_found: 404,
  runner_unavailable: 503,
  native_skill_package_unavailable: 503,
  native_skill_dependencies_unavailable: 409,
  native_skill_package_unsupported: 409,
  automation_lifecycle_unavailable: 503,
  device_lifecycle_unavailable: 503,
  device_not_found: 404,
  device_native_session_required: 403,
  device_revoke_forbidden: 403,
  device_revoked: 409,
  device_request_invalid: 400,
  device_context_invalid: 403,
  agent_command_authority_unavailable: 403,
  agent_command_explicit_approval_required: 403,
  agent_tool_approval_unavailable: 503,
  agent_tool_approval_resume_unavailable: 503,
  agent_tool_approval_decision_invalid: 400,
  postgres_agent_tool_approval_decision_invalid: 400,
  agent_tool_approval_not_found: 404,
  agent_tool_approval_not_pending: 409,
  agent_tool_approval_expired: 410,
  agent_tool_approval_source_turn_not_found: 404,
  agent_tool_approval_source_turn_not_blocked: 409,
  agent_tool_approval_resume_incomplete: 503,
  automation_not_found: 404,
  automation_archived: 409,
  automation_conflict: 412,
  automation_etag_required: 428,
  automation_etag_invalid: 500,
  automation_state_invalid: 400,
  automation_request_invalid: 400,
  automation_scope_required: 400,
  automation_scope_immutable: 400,
  automation_owner_scope_forbidden: 403,
  automation_scope_policy_unattended_required: 409,
  automation_display_name_invalid: 400,
  automation_loop_version_required: 400,
  automation_loop_not_available: 409,
  automation_trigger_invalid: 400,
  automation_schedule_invalid: 400,
  automation_input_bindings_invalid: 400,
  automation_connection_bindings_invalid: 400,
  automation_resource_pin_mismatch: 409,
  automation_connection_pin_mismatch: 409,
  automation_connection_not_consumable: 409,
  automation_model_policy_unavailable: 409,
  automation_grant_expiry_invalid: 400,
  automation_grant_review_invalid: 400,
  automation_grant_not_found: 409,
  automation_revision_not_found: 409,
  automation_projection_incomplete: 503,
  inbox_automation_route_unresolved: 503,
  scope_not_found: 404,
  scope_policy_request_invalid: 400,
  scope_permission_invalid: 400,
  scope_policy_etag_required: 428,
  scope_policy_conflict: 412,
  scope_policy_no_change: 409,
  review_not_waiting: 409,
  review_stale: 409,
  review_changes_required: 400,
  review_feedback_target_missing: 409,
  review_feedback_target_invalid: 409,
  workflow_run_review_not_waiting: 409,
  workflow_run_cancellation_unavailable: 503,
  workflow_run_cancellation_authorization_required: 403,
  workflow_run_authority_unavailable: 503,
  workflow_run_retry_authority_unavailable: 503,
  workflow_run_retry_source_not_found: 404,
  workflow_run_retry_source_invalid: 409,
  agent_handoff_authorization_required: 403,
  agent_proposal_authorization_required: 403,
  session_domain_events_unavailable: 503,
  session_domain_scope_unavailable: 403,
  session_domain_cursor_invalid: 400,
  session_domain_limit_invalid: 400,
  workflow_run_cancellation_scope_mismatch: 403,
  workflow_run_cancellation_terminal: 409,
  workflow_run_cancellation_in_progress: 409,
  workflow_run_cancellation_state_invalid: 409,
  workflow_run_cancellation_queue_state_invalid: 409,
  workflow_run_cancellation_lease_state_invalid: 409,
  workflow_run_review_decision_required: 409,
  run_retry_not_allowed: 409,
  run_execution_snapshot_unavailable: 409,
  run_comparison_workflow_mismatch: 409,
  run_workspace_missing: 409,
  product_trace_not_found: 404,
  product_trace_too_large: 409,
  product_trace_storage_unavailable: 503,
  workflow_execution_snapshot_incomplete: 409,
  agent_runtime_unavailable: 503,
  admission_unavailable: 503,
  skill_creation_unavailable: 503,
  admission_queue_full: 409,
  provider_rate_limited: 429,
  provider_timeout: 504,
  provider_request_failed: 502,
  provider_response_invalid: 502,
  credential_unavailable: 503,
  attachment_service_unavailable: 503,
  attachment_format_unsupported: 415,
  attachment_ocr_required: 422,
  attachment_too_large: 413,
  attachment_limit_exceeded: 422,
  attachment_integrity_failed: 409,
  attachment_mime_mismatch: 415,
  attachment_macro_forbidden: 422,
  attachment_path_traversal: 422,
  attachment_malicious_package: 422,
  attachment_processing_unavailable: 503,
  attachment_processing_failed: 422,
  attachment_expired: 410,
  attachment_deleted: 410,
  attachment_forbidden: 404,
  skill_material_media_type_mismatch: 415,
  skill_draft_unavailable: 503,
  skill_draft_not_found: 404,
  skill_upload_not_ready: 409,
  skill_package_object_missing: 409,
  skill_activation_mismatch: 409,
  skill_activation_unavailable: 503,
  skill_publish_unavailable: 503,
  skill_activation_required: 409,
  skill_validation_failed: 409,
  skill_validation_unavailable: 503,
  skill_validation_not_found: 404,
  skill_test_run_not_found: 404,
  skill_draft_stale: 409,
  skill_package_unavailable: 409,
  skill_package_not_promoted: 409,
  skill_package_substituted: 409,
  skill_package_hash_mismatch: 409,
  skill_permission_acknowledgement_required: 400,
  skill_test_cases_invalid: 400,
  skill_test_case_invalid: 400,
  skill_test_run_ids_invalid: 400,
  skill_test_run_ids_duplicate: 400,
  skill_test_run_replayed: 409,
  skill_test_cancel_conflict: 409,
  skill_validation_replayed: 409,
  skill_validation_already_passed: 409,
  skill_validation_reference_invalid: 400,
  skill_validation_hash_invalid: 400,
  skill_validation_id_invalid: 400,
  skill_draft_revision_invalid: 400,
  skill_draft_conflict: 412,
  skill_draft_not_editable: 409,
  skill_draft_update_required: 400,
  skill_owner_required: 403,
  skill_name_unavailable: 409,
  skill_version_not_found: 404,
  skill_version_history_unavailable: 503,
  skill_usage_unavailable: 503,
  skill_deprecation_unavailable: 503,
  skill_deprecation_reason_required: 400,
  skill_not_available_for_new_workflow: 409,
  skill_package_not_publishable: 409,
  skill_version_exists: 409,
  loop_creation_unavailable: 503,
  loop_duplicate_unavailable: 503,
  upload_service_unavailable: 503,
  resource_service_unavailable: 503,
  resource_not_found: 404,
  resource_not_ready: 409,
  workflow_skill_version_conflict: 409,
  workflow_revision_edit_requires_private: 409,
  workflow_resource_reference_conflict: 409,
  resource_integrity_failed: 409,
  resource_label_required: 400,
  resource_media_type_unsupported: 400,
  resource_size_invalid: 400,
  resource_text_invalid: 400,
  resource_text_empty: 400,
  resource_attachment_invalid: 422,
  connection_not_found: 404,
  connection_revision_conflict: 412,
  connection_rebind_required: 409,
  connection_not_ready: 409,
  connection_binding_invalid: 400,
  connection_requirement_conflict: 409,
  connection_disabled: 409,
  connection_credential_binding_unavailable: 503,
  connection_credential_binding_failed: 422,
  connection_probe_unavailable: 503,
  connection_driver_unavailable: 503,
  connection_runtime_binding_unavailable: 503,
  connection_credential_unbound: 409,
  connection_credential_expired: 409,
  loop_import_not_found: 404,
  loop_import_revision_conflict: 412,
  loop_import_already_committed: 409,
  loop_import_mapping_required: 400,
  loop_import_mapping_invalid: 409,
  loop_import_material_unavailable: 503,
  loop_upload_not_ready: 409,
  loop_package_invalid: 400,
  loop_package_not_canonical: 400,
  loop_package_too_large: 413,
  loop_package_integrity_failed: 409,
  loop_import_unavailable: 503,
  loop_export_forbidden: 403,
  upload_not_found: 404,
  object_not_found: 404,
  upload_size_invalid: 400,
  upload_ingest_method_invalid: 400,
  upload_chunk_invalid: 400,
  upload_chunk_size_invalid: 400,
  upload_chunk_conflict: 409,
  upload_incomplete: 409,
  upload_package_invalid: 400,
  skill_import_admin_required: 403,
  skill_import_root_forbidden: 403,
  skill_import_root_unavailable: 409,
  skill_import_root_invalid: 409,
  skill_import_path_forbidden: 400,
  skill_import_selection_invalid: 400,
  skill_import_package_invalid: 400,
  skill_import_review_required: 409,
  upload_state_invalid: 409,
  upload_promotion_blocked: 409,
  upload_review_acknowledgement_required: 409,
  repository_url_invalid: 400,
  repository_ref_invalid: 400,
  repository_directory_invalid: 400,
  repository_skill_not_found: 404,
  repository_private_or_forbidden: 403,
  repository_rate_limited: 429,
  repository_redirect_forbidden: 422,
  repository_import_cancelled: 409,
  repository_file_size_invalid: 400,
  repository_response_invalid: 502,
  repository_runtime_manifest_invalid: 422,
  repository_runtime_pair_incomplete: 422,
  repository_import_unavailable: 503,
  loop_publish_unavailable: 503,
  loop_compile_required: 409,
  loop_test_run_required: 409,
  loop_definition_required: 409,
  loop_dependency_not_shared: 409,
  loop_dependency_unavailable: 409,
  loop_connection_publication_unavailable: 409,
  loop_skill_version_unavailable: 409,
  loop_skill_update_unavailable: 503,
  loop_skill_update_unchanged: 409,
  loop_skill_update_not_found: 409,
  loop_skill_update_ambiguous: 409,
  loop_owner_required: 403,
  skill_draft_scaffold_invalid: 400,
  skill_runtime_not_found: 404,
  skill_runtime_unavailable: 503,
  skill_runtime_limits_invalid: 400,
  builder_proposal_unavailable: 503,
  builder_proposal_invalid: 422,
  builder_proposal_not_found: 404,
  builder_proposal_state_invalid: 409,
  builder_proposal_expired: 410,
  agent_definition_not_found: 404,
  agent_session_not_found: 404,
  agent_turn_not_found: 404,
  agent_handoff_not_found: 404,
  agent_turn_runner_unavailable: 503,
  agent_task_source_unavailable: 503,
  agent_session_closed: 409,
  agent_turn_not_running: 409,
  main_agent_object_forbidden: 400,
  module_agent_object_invalid: 400,
  agent_object_not_found: 404,
  agent_proposal_not_found: 404,
  agent_proposal_state_invalid: 409,
  agent_proposal_base_unavailable: 409,
  agent_proposal_object_invalid: 422,
  agent_proposal_operation_invalid: 422,
  agent_proposal_path_forbidden: 422,
  agent_proposal_target_missing: 422,
  agent_proposal_array_index_invalid: 422,
  agent_proposal_add_target_exists: 422,
  agent_proposal_result_invalid: 422,
  agent_handoff_target_invalid: 409,
  main_agent_session_required: 409,
  work_item_promotion_unavailable: 503,
  work_item_continuation_unavailable: 503,
  work_item_thread_entry_unavailable: 503,
  work_item_decision_unavailable: 503,
  work_item_promotion_participants_unavailable: 503,
  work_item_promotion_participant_projection_invalid: 503,
  work_item_promotion_source_not_found: 404,
  work_item_promotion_source_not_promotable: 409,
  work_item_promotion_source_not_ready: 409,
  work_item_promotion_request_invalid: 400,
  work_item_already_promoted: 409,
  work_item_participant_invalid: 400,
  work_item_participant_not_found: 404,
  work_item_artifact_invalid: 400,
  work_item_artifact_unavailable: 409,
  work_item_decision_invalid: 400,
  work_item_priority_invalid: 400,
  work_item_not_found: 404,
  work_item_access_forbidden: 404,
  work_item_reference_project_mismatch: 409,
  work_item_reference_audience_forbidden: 403,
  work_item_thread_entry_not_found:404,
  work_item_result_invalid:400, work_item_result_entry_invalid:409, work_item_result_forbidden:403, work_item_result_stale:409, work_item_result_review_required:409,
  work_item_run_forbidden: 403,
  work_item_access_grant_invalid: 400,
  work_item_access_grant_not_found: 404,
  work_item_owner_access_not_revocable: 409,
  work_item_continuation_access_forbidden: 403,
  work_item_continuation_access_revoked: 403,
  work_item_continuation_identifier_invalid: 400,
  work_item_continuation_initial_turn_invalid: 400,
  work_item_continuation_initial_turn_unavailable: 503,
  work_item_continuation_agent_entry_invalid: 400,
  work_item_continuation_agent_entry_incomplete: 503,
  work_item_continuation_already_exists: 409,
  work_item_continuation_session_invalid: 503,
  work_item_continuation_projection_invalid: 503,
  work_item_promote_authorization_required: 403,
  work_item_thread_comment_invalid: 400,
  work_item_thread_write_forbidden: 403,
  work_item_thread_entry_authorizer_unavailable: 503,
  work_item_thread_entry_authorization_required: 403,
  work_item_thread_entry_replay_unavailable: 503,
  work_item_thread_sequence_invalid: 503,
  work_item_decision_write_forbidden: 403,
  work_item_decision_authorizer_unavailable: 503,
  work_item_decision_authorization_required: 403,
  work_item_decision_replay_unavailable: 503,
  work_item_projection_incomplete: 503,
  work_item_promotion_replay_unavailable: 503,
  team_work_unavailable: 503,
  team_work_context_invalid: 400,
  team_work_personal_authority_unavailable: 503,
  team_work_member_invalid: 400,
  team_work_member_not_found: 404,
  team_work_agent_entry_invalid: 400,
  team_work_agent_entry_incomplete: 503,
  project_id_required: 400,
  project_request_invalid: 400,
  project_not_found: 404,
  project_file_forbidden: 404,
  project_file_not_found: 404,
  project_file_path_invalid: 400,
  project_file_path_collision: 409,
  project_file_content_invalid: 400,
  project_file_revision_invalid: 400,
  project_file_archived: 409,
  project_files_unavailable: 503,
  project_file_integrity_failed: 500,
  project_create_forbidden: 403,
  project_access_forbidden: 404,
  project_manage_forbidden: 403,
  project_etag_required: 428,
  project_conflict: 412,
  work_item_request_invalid: 400,
  work_item_update_invalid: 400,
  work_item_id_required: 400,
  work_item_etag_required: 428,
  work_item_conflict: 412,
  work_item_update_forbidden: 403,
  work_item_manage_forbidden: 403,
  work_item_status_transition_invalid: 409,
  work_item_blocked_reason_required: 400,
  memory_service_unavailable: 503,
  memory_candidate_not_found: 404,
  memory_not_found: 404,
  memory_access_forbidden: 403,
  memory_candidate_state_invalid: 409,
  memory_candidate_invalid: 400,
  memory_query_invalid: 400,
  memory_scope_invalid: 400,
  model_profile_not_found: 404,
  model_profile_forbidden: 403,
  model_capability_mismatch: 409,
  model_revision_unavailable: 503,
  model_route_unresolved: 503,
  model_catalog_unavailable: 503,
  model_configuration_unavailable: 503,
  model_configuration_forbidden: 403,
  model_secret_unavailable: 409,
  model_secret_already_bound: 409,
  model_provider_unsupported: 400,
  model_provider_auth_failed: 409,
  model_provider_model_unavailable: 409,
  model_provider_unavailable: 503,
  artifact_not_found: 404,
  artifact_access_forbidden: 403,
  artifact_read_failed: 503,
  team_library_unavailable: 503,
  release_not_available: 404,
  release_not_found: 404,
  installation_not_found: 404,
  installation_update_draft_not_found: 404,
  installation_update_draft_required: 409,
  installation_update_draft_state_invalid: 409,
  installation_update_conflict: 409,
  test_identity_forbidden: 403,
  test_identity_invalid: 400,
  cursor_invalid: 400,
  cursor_stale: 409,
};

const routeDefinitions = PUBLIC_ENDPOINTS.map((endpoint) => ({
  endpoint,
  pattern: new RegExp(`^${endpoint.path.replace(/\{(\w+)\}/g, "(?<$1>[^/]+)")}$`),
}));

const errors = (schema, value) => [...Errors(schema, value)].map(({ instancePath, message }) => ({ instancePath, message }));

function parseQuery(url) {
  const value = {};
  for (const [key, raw] of url.searchParams) {
    if (Object.hasOwn(value, key)) return { duplicate: key };
    value[key] = raw;
  }
  for (const key of ["limit", "after"]) {
    if (key in value) {
      if (!/^\d+$/.test(value[key])) return { invalid: key };
      value[key] = Number(value[key]);
    }
  }
  if ("archived" in value) {
    if (value.archived !== "true" && value.archived !== "false") return { invalid: "archived" };
    value.archived = value.archived === "true";
  }
  return { value };
}

function contractHeaders(req, endpoint) {
  const requested = {};
  for (const name of [...endpoint.requiredRequestHeaders, ...endpoint.optionalRequestHeaders]) {
    const value = req.headers[name.toLowerCase()];
    if (value !== undefined) requested[name] = Array.isArray(value) ? value[0] : value;
  }
  return requested;
}

async function readJson(req) {
  let size = 0;
  let source = "";
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT) throw new WorkbenchHttpError("request_invalid", "Request body is too large.");
    source += chunk;
  }
  if (!source) throw new WorkbenchHttpError("request_invalid", "JSON request body is required.");
  try { return JSON.parse(source); } catch { throw new WorkbenchHttpError("request_invalid", "Request body must be valid JSON."); }
}

function writeJson(res, status, value, headers = EMPTY, mediaType = "application/json") {
  res.writeHead(status, { "content-type": `${mediaType}; charset=utf-8`, ...headers });
  res.end(JSON.stringify(value));
}

function externalOrigin(req, configuredOrigin) {
  if (configuredOrigin) return configuredOrigin;
  return `http://${req.headers.host}`;
}

function productError(error, requestId) {
  const requestedCode = typeof error?.code === "string" ? error.code : null;
  // Database drivers expose SQLSTATE strings in `error.code`. Only Product
  // error codes deliberately assigned an HTTP status are safe to return to a
  // browser; everything else is an internal failure.
  const code = requestedCode && Object.hasOwn(errorStatus, requestedCode)
    ? requestedCode
    : "internal_error";
  const status = errorStatus[code] ?? 500;
  const body = {
    code,
    message: status === 500 ? "The Workbench request could not be completed." : (error?.message ?? code),
    details: publicDetails(error?.details),
    retryable: error?.retryable === true
      || code === "runner_unavailable"
      || code === "agent_runtime_unavailable"
      || code === "agent_task_source_unavailable"
      || code === "skill_runtime_unavailable"
      || code === "idempotency_in_progress"
      || code === "idempotency_claim_lost",
    requestId,
  };
  return { status, body };
}

function publicDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return sanitizeDetails(value);
}

function sanitizeDetails(value) {
  const forbidden = new Set([
    "tool", "toolid", "toolname", "provider", "providerid", "providerpayload",
    "artifact", "artifactpath", "secret", "token", "tokenhash", "bearertoken",
    "csrftoken", "schemapath", "filesystempath", "runtimepath",
    "workspaceid", "requestedby", "objectid", "packageobjectid", "packagehash",
    "contenthash", "manifest", "executionref", "publishedby", "updatedby", "authoredby",
    "requestid", "upstreamrequestid",
  ]);
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !forbidden.has(key.toLowerCase()))
    .map(([key, item]) => [key, sanitizeDetails(item)]));
}

async function requireBrowserSession(req, sessionStore) {
  const session = await sessionStore.get(parseCookies(req.headers.cookie).workbench_session);
  if (!session) throw new WorkbenchHttpError("session_required", "A Workbench session is required.");
  return session;
}

async function ensureBrowserMutationSecurity({ req, sessionStore, configuredOrigin }) {
  const session = await requireBrowserSession(req, sessionStore);
  if (req.headers.origin !== externalOrigin(req, configuredOrigin)) {
    throw new WorkbenchHttpError("origin_forbidden", "Request Origin does not match this Workbench.");
  }
  if (req.headers["sec-fetch-site"] !== "same-origin") {
    throw new WorkbenchHttpError("fetch_site_forbidden", "Cross-site mutation requests are not accepted.");
  }
  if (req.headers["x-workbench-csrf"] !== session.csrfToken) {
    throw new WorkbenchHttpError("csrf_invalid", "The Workbench CSRF token is invalid.");
  }
  return session;
}

function ensurePublicMutationSecurity({ req, configuredOrigin }) {
  if (req.headers.authorization) throw new WorkbenchHttpError("bearer_not_accepted", "Bearer authentication is not accepted.");
  if (req.headers.origin !== externalOrigin(req, configuredOrigin)) {
    throw new WorkbenchHttpError("origin_forbidden", "Request Origin does not match this Workbench.");
  }
  if (req.headers["sec-fetch-site"] !== "same-origin") {
    throw new WorkbenchHttpError("fetch_site_forbidden", "Cross-site mutation requests are not accepted.");
  }
}

// Native authorization exchanges never consume browser cookies. Their one-time
// authorization code / rotating refresh token is the CSRF-resistant secret, so
// a desktop or mobile client may call from a system-browser-less origin.  A
// browser-originated request still has to be same-origin to avoid turning the
// endpoint into a cross-site cookie side effect.
function ensureNativeCredentialExchangeSecurity({ req, configuredOrigin }) {
  if (req.headers.authorization) {
    throw new WorkbenchHttpError("bearer_not_accepted", "Bearer authentication is not accepted.");
  }
  if (parseCookies(req.headers.cookie).workbench_session) {
    throw new WorkbenchHttpError("native_cookie_forbidden", "Native credential exchanges do not accept browser sessions.");
  }
  if (req.headers.origin && req.headers.origin !== externalOrigin(req, configuredOrigin)) {
    throw new WorkbenchHttpError("origin_forbidden", "Request Origin does not match this Workbench.");
  }
}

async function resolveAuthentication({ req, sessionStore, authService }) {
  const authorization = req.headers.authorization;
  if (authorization === undefined) return requireBrowserSession(req, sessionStore);
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new WorkbenchHttpError("bearer_not_accepted", "Bearer authentication is not accepted.");
  }
  if (!authService?.authenticateNativeAccessToken) {
    throw new WorkbenchHttpError("bearer_not_accepted", "Bearer authentication is not accepted.");
  }
  const session = await authService.authenticateNativeAccessToken({ accessToken: authorization.slice("Bearer ".length) });
  if (!session) throw new WorkbenchHttpError("native_access_token_invalid", "The native access token is invalid.");
  return session;
}

function validate(schema, value, label) {
  if (!Check(schema, value)) {
    throw new WorkbenchHttpError("request_invalid", `${label} does not match the Workbench contract.`, { errors: errors(schema, value) });
  }
}

function responseData(value) {
  return value?.data === undefined ? value : value.data;
}

function responseEnvelope(endpoint, value, requestId) {
  const data = responseData(value);
  const body = Object.hasOwn(endpoint.responseBodySchema.properties ?? {}, "page")
    ? { schemaVersion: "workbench-api-v1", data: data.data ?? data, page: value?.page ?? data?.page ?? EMPTY_PAGE, requestId }
    : { schemaVersion: "workbench-api-v1", data, requestId };
  if (!Check(endpoint.responseBodySchema, body)) {
    throw new WorkbenchHttpError("internal_response_invalid", "Product response failed its contract check.", { errors: errors(endpoint.responseBodySchema, body) });
  }
  return body;
}

function contractResponse(endpoint, value, requestId) {
  if (endpoint.responseMediaType && endpoint.responseMediaType !== "application/json") {
    if (Buffer.isBuffer(value?.rawBody)) {
      return { body: undefined, rawBody: value.rawBody, mediaType: endpoint.responseMediaType };
    }
    const body = responseData(value);
    if (!Check(endpoint.responseBodySchema, body)) {
      throw new WorkbenchHttpError("internal_response_invalid", "Product response failed its contract check.", {
        errors: errors(endpoint.responseBodySchema, body),
      });
    }
    return { body, rawBody: value?.rawBody, mediaType: endpoint.responseMediaType };
  }
  return { body: responseEnvelope(endpoint, value, requestId), mediaType: "application/json" };
}

function writeSse(res, event, schema = RunEventSchema, eventName = null) {
  if (!Check(schema, event)) throw new WorkbenchHttpError("internal_response_invalid", "Stream event failed its contract check.");
  const sequence = Number.isInteger(event.sequence) ? event.sequence : event.seq;
  const name = eventName ?? event.type ?? "message";
  if (!Number.isSafeInteger(sequence) || sequence < 1 || typeof name !== "string" || !name) {
    throw new WorkbenchHttpError("internal_response_invalid", "Stream event has no valid SSE identity.");
  }
  res.write(`id: ${sequence}\nevent: ${name}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createWorkbenchHttpHandler({
  application,
  sessionStore,
  authService = null,
  origin,
  requestIdFactory = () => `request-${crypto.randomUUID()}`,
  sessionTokenFactory,
  csrfTokenFactory,
  clock,
  allowedHosts,
  testIdentityResolver = null,
  allowTestSessionBootstrap = false,
  internalErrorReporter = null,
  requestObserver = null,
} = {}) {
  if (!application) throw new TypeError("workbench_application_required");
  if (internalErrorReporter !== null && typeof internalErrorReporter !== "function") {
    throw new TypeError("workbench_internal_error_reporter_invalid");
  }
  if (requestObserver !== null && typeof requestObserver !== "function") {
    throw new TypeError("workbench_request_observer_invalid");
  }
  const validateHost = createWorkbenchHostValidator({ allowedHosts, origin });
  if (!sessionStore) {
    sessionStore = new WorkbenchSessionStore({ tokenFactory: sessionTokenFactory, csrfTokenFactory, clock });
  }
  return async (req, res) => {
    const requestId = requestIdFactory();
    const startedAt = Date.now();
    let operation = "unmatched";
    if (requestObserver && typeof res.once === "function") {
      res.once("finish", () => {
        try {
          requestObserver({
            requestId,
            traceId: traceIdFrom(req.headers.traceparent),
            method: req.method,
            operation,
            statusCode: res.statusCode ?? res.status ?? 500,
            durationMs: Math.max(0, Date.now() - startedAt),
          });
        } catch {}
      });
    }
    try {
      const requestHost = validateHost(req.headers.host);
      const url = new URL(req.url, `http://${requestHost}`);
      const route = routeDefinitions.find(({ endpoint, pattern }) => endpoint.method === req.method && pattern.test(url.pathname));
      if (!route) throw new WorkbenchHttpError("route_not_found", "Workbench route not found.");
      operation = route.endpoint.operationId;
      const match = route.pattern.exec(url.pathname);
      const path = Object.fromEntries(Object.entries(match?.groups ?? {}).map(([key, value]) => [key, decodeURIComponent(value)]));
      validate(route.endpoint.pathParamsSchema, path, "Path parameters");
      const parsedQuery = parseQuery(url);
      if (parsedQuery.duplicate || parsedQuery.invalid) throw new WorkbenchHttpError("request_invalid", "Query parameters are invalid.");
      const query = parsedQuery.value;
      validate(route.endpoint.querySchema, query, "Query parameters");

      const rawSessionToken = parseCookies(req.headers.cookie).workbench_session;
      const secureCookie = externalOrigin(req, origin).startsWith("https://");

      if (route.endpoint.operationId === "authStatus") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        if (req.headers.authorization) throw new WorkbenchHttpError("bearer_not_accepted", "Bearer authentication is not accepted.");
        const session = await sessionStore.get(rawSessionToken);
        const value = await authService.status({ session });
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(
          res,
          200,
          responseEnvelope(route.endpoint, value, requestId),
          responseHeaders,
        );
      }

      if (route.endpoint.operationId === "register" || route.endpoint.operationId === "login") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        ensurePublicMutationSecurity({ req, configuredOrigin: origin });
        const headers = contractHeaders(req, route.endpoint);
        validate(route.endpoint.requestHeadersSchema, headers, "Request headers");
        const body = await readJson(req);
        validate(route.endpoint.requestBodySchema, body, "Request body");
        const value = route.endpoint.operationId === "register"
          ? await authService.register({ ...body.data, idempotencyKey: headers["Idempotency-Key"] })
          : await authService.login(body.data);
        const issued = await sessionStore.issue({
          userId: value.user.userId,
          activeWorkspaceId: value.workspaceId,
        });
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(
          res,
          route.endpoint.successStatus,
          responseEnvelope(route.endpoint, value, requestId),
          {
            ...responseHeaders,
            "set-cookie": sessionCookie(issued.token, 7 * 24 * 60 * 60, { secure: secureCookie }),
          },
        );
      }

      if (route.endpoint.operationId === "startNativeAuthorization" || route.endpoint.operationId === "refreshNativeToken") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        ensureNativeCredentialExchangeSecurity({ req, configuredOrigin: origin });
        const headers = contractHeaders(req, route.endpoint);
        validate(route.endpoint.requestHeadersSchema, headers, "Request headers");
        const body = await readJson(req);
        validate(route.endpoint.requestBodySchema, body, "Request body");
        const value = route.endpoint.operationId === "startNativeAuthorization"
          ? await authService.startNativeAuthorization(body.data)
          : await authService.refreshNativeToken(body.data);
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(res, route.endpoint.successStatus, responseEnvelope(route.endpoint, value, requestId), responseHeaders);
      }

      if (route.endpoint.operationId === "completeNativeAuthorization") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        ensureNativeCredentialExchangeSecurity({ req, configuredOrigin: origin });
        const headers = contractHeaders(req, route.endpoint);
        validate(route.endpoint.requestHeadersSchema, headers, "Request headers");
        const body = await readJson(req);
        validate(route.endpoint.requestBodySchema, body, "Request body");
        const value = await authService.completeNativeAuthorization(body.data);
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(res, route.endpoint.successStatus, responseEnvelope(route.endpoint, value, requestId), responseHeaders);
      }

      if (route.endpoint.operationId === "approveNativeAuthorization") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        if (req.headers.authorization) throw new WorkbenchHttpError("bearer_not_accepted", "Bearer authentication is not accepted.");
        const session = await ensureBrowserMutationSecurity({ req, sessionStore, configuredOrigin: origin });
        const headers = contractHeaders(req, route.endpoint);
        validate(route.endpoint.requestHeadersSchema, headers, "Request headers");
        const body = await readJson(req);
        validate(route.endpoint.requestBodySchema, body, "Request body");
        const value = await authService.approveNativeAuthorization({
          authorizationId: body.data.authorizationId,
          auth: session,
        });
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(res, route.endpoint.successStatus, responseEnvelope(route.endpoint, value, requestId), responseHeaders);
      }

      if (route.endpoint.operationId === "inspectInvitation" || route.endpoint.operationId === "startOAuth") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        ensurePublicMutationSecurity({ req, configuredOrigin: origin });
        const headers = contractHeaders(req, route.endpoint);
        validate(route.endpoint.requestHeadersSchema, headers, "Request headers");
        const body = await readJson(req);
        validate(route.endpoint.requestBodySchema, body, "Request body");
        const existing = await sessionStore.get(rawSessionToken);
        const value = route.endpoint.operationId === "inspectInvitation"
          ? await authService.inspectInvitation(body.data)
          : await authService.startOAuth({
              provider: path.provider,
              ...body.data,
              auth: existing,
            });
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(
          res,
          route.endpoint.successStatus,
          responseEnvelope(route.endpoint, value, requestId),
          responseHeaders,
        );
      }

      if (route.endpoint.operationId === "completeOAuth") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        if (query.error) {
          throw new WorkbenchHttpError("oauth_provider_denied", "The identity provider did not complete sign-in.");
        }
        if (!query.state || !query.code) {
          throw new WorkbenchHttpError("request_invalid", "OAuth callback parameters are invalid.");
        }
        const existing = await sessionStore.get(rawSessionToken);
        const value = await authService.completeOAuth({
          provider: path.provider,
          state: query.state,
          code: query.code,
          auth: existing,
        });
        const issued = await sessionStore.issue({
          userId: value.user.userId,
          activeWorkspaceId: value.workspaceId,
        });
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        // OAuth providers navigate a browser to this callback. Keep the
        // contract JSON response for API clients, while a normal document
        // navigation receives only a same-origin completion route and never
        // puts invitation/OAuth values into that follow-up URL.
        if (String(req.headers.accept ?? "").includes("text/html")) {
          res.writeHead(303, {
            ...responseHeaders,
            Location: "/invite/complete",
            "set-cookie": sessionCookie(issued.token, 7 * 24 * 60 * 60, { secure: secureCookie }),
          });
          res.end();
          return;
        }
        return writeJson(
          res,
          route.endpoint.successStatus,
          responseEnvelope(route.endpoint, value, requestId),
          {
            ...responseHeaders,
            "set-cookie": sessionCookie(issued.token, 7 * 24 * 60 * 60, { secure: secureCookie }),
          },
        );
      }

      if (route.endpoint.operationId === "logout") {
        if (req.headers.authorization) throw new WorkbenchHttpError("bearer_not_accepted", "Bearer authentication is not accepted.");
        const session = await ensureBrowserMutationSecurity({ req, sessionStore, configuredOrigin: origin });
        const body = await readJson(req);
        validate(route.endpoint.requestBodySchema, body, "Request body");
        validate(route.endpoint.requestHeadersSchema, contractHeaders(req, route.endpoint), "Request headers");
        const result = await sessionStore.revoke(rawSessionToken);
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(
          res,
          200,
          responseEnvelope(route.endpoint, { revoked: result.revoked === true }, requestId),
          {
            ...responseHeaders,
            "set-cookie": clearSessionCookie({ secure: secureCookie }),
          },
        );
      }

      if (["listOwnNativeClientSessions", "revokeOwnNativeClientSession"].includes(route.endpoint.operationId)) {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        if (req.headers.authorization) throw new WorkbenchHttpError("bearer_not_accepted", "Use your browser session to manage connections.");
        const mutation = route.endpoint.operationId === "revokeOwnNativeClientSession";
        const session = mutation
          ? await ensureBrowserMutationSecurity({ req, sessionStore, configuredOrigin: origin })
          : await requireBrowserSession(req, sessionStore);
        validate(route.endpoint.requestHeadersSchema, contractHeaders(req, route.endpoint), "Request headers");
        if (mutation) validate(route.endpoint.requestBodySchema, await readJson(req), "Request body");
        const value = mutation
          ? await authService.revokeOwnNativeClientSession({ clientSessionId: path.clientSessionId, auth: session })
          : await authService.listOwnNativeClientSessions({ auth: session });
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(res, route.endpoint.successStatus, responseEnvelope(route.endpoint, value, requestId), responseHeaders);
      }

      if (route.endpoint.operationId === "revokeNativeClientSession") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        const session = await resolveAuthentication({ req, sessionStore, authService });
        if (!session.clientSessionId) throw new WorkbenchHttpError("native_access_token_invalid", "The native access token is invalid.");
        const headers = contractHeaders(req, route.endpoint);
        validate(route.endpoint.requestHeadersSchema, headers, "Request headers");
        const body = await readJson(req);
        validate(route.endpoint.requestBodySchema, body, "Request body");
        const value = await authService.revokeNativeClientSession({ auth: session });
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(res, route.endpoint.successStatus, responseEnvelope(route.endpoint, value, requestId), responseHeaders);
      }

      if (route.endpoint.operationId === "workspace") {
        if (req.headers.authorization) {
          const session = await resolveAuthentication({ req, sessionStore, authService });
          if (!session.clientSessionId) throw new WorkbenchHttpError("native_access_token_invalid", "The native access token is invalid.");
          const data = await application.workspace({ requestId, auth: session });
          data.session = {
            csrfToken: "",
            expiresAt: session.expiresAt,
            userId: session.userId,
            workspaceId: session.activeWorkspaceId,
          };
          const body = responseEnvelope(route.endpoint, data, requestId);
          const responseHeaders = { "Cache-Control": "no-store" };
          validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
          return writeJson(res, 200, body, responseHeaders);
        }
        const existing = await sessionStore.get(rawSessionToken);
        const hasTestIdentityHeader = Boolean(
          req.headers["x-workbench-test-user"] || req.headers["x-workbench-test-workspace"],
        );
        if (hasTestIdentityHeader && typeof testIdentityResolver !== "function") {
          throw new WorkbenchHttpError("test_identity_forbidden", "Test identity headers are not accepted.");
        }
        const testIdentity = hasTestIdentityHeader ? testIdentityResolver(req) : null;
        if (!existing && !allowTestSessionBootstrap && !testIdentity) {
          throw new WorkbenchHttpError("session_required", "A Workbench session is required.");
        }
        const bootstrap = existing
          ? null
          : (typeof application.bootstrapSession === "function"
              ? await application.bootstrapSession({ requestId, testIdentity })
              : { userId: "user-local", workspaceId: "workspace-local" });
        const issued = existing
          ? null
          : await sessionStore.issue({
            userId: bootstrap.userId,
            activeWorkspaceId: bootstrap.activeWorkspaceId ?? bootstrap.workspaceId,
          });
        const session = existing ?? issued;
        const data = await application.workspace({ requestId, auth: session });
        data.session = {
          csrfToken: session.csrfToken,
          expiresAt: session.expiresAt,
          userId: session.userId,
          workspaceId: session.activeWorkspaceId,
        };
        const body = responseEnvelope(route.endpoint, data, requestId);
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(
          res,
          200,
          body,
          {
            ...responseHeaders,
            ...(issued
              ? { "set-cookie": sessionCookie(issued.token, 7 * 24 * 60 * 60, { secure: secureCookie }) }
              : EMPTY),
          },
        );
      }

      const session = await resolveAuthentication({ req, sessionStore, authService });

      // A browser session may read Device inventory and an Owner/Admin may
      // revoke a Device, but registration and liveness are proof-of-possession
      // operations. Do not let a cookie-authenticated browser manufacture a
      // Desktop identity; only the PKCE-bound native bearer session may do so.
      if (NATIVE_DESKTOP_DEVICE_MUTATIONS.has(route.endpoint.operationId)
        && (session.clientKind !== "desktop"
          || typeof session.clientSessionId !== "string"
          || !session.clientSessionId
          || typeof session.devicePublicKey !== "string"
          || !session.devicePublicKey)) {
        throw new WorkbenchHttpError(
          "device_native_session_required",
          "A Desktop native session is required for this device operation.",
        );
      }

      if (route.endpoint.operationId === "getRunEvents") {
        validate(route.endpoint.requestHeadersSchema, contractHeaders(req, route.endpoint), "Request headers");
        const after = query.after ?? Number(req.headers["last-event-id"] ?? 0);
        let unsubscribe = () => {};
        let closed = false;
        let buffering = true;
        let lastSequence = after;
        const buffered = [];
        const close = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
        };
        const deliver = (event) => {
          if (closed || event.sequence <= after || event.sequence <= lastSequence) return;
          writeSse(res, event);
          lastSequence = event.sequence;
        };
        const receive = (event) => {
          if (closed) return;
          if (buffering) buffered.push(event);
          else deliver(event);
        };
        try {
          unsubscribe = await application.subscribe(path.runId, receive, session);
          req.once("close", close);
          res.once("close", close);
          const events = await application.listEvents({ runId: path.runId, after, auth: session });
          if (closed) return;
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const replay = [...events, ...buffered].sort((left, right) => left.sequence - right.sequence);
          for (const event of replay) deliver(event);
          buffered.length = 0;
          buffering = false;
          return;
        } catch (error) {
          close();
          req.off("close", close);
          res.off("close", close);
          throw error;
        }
      }

      if (route.endpoint.operationId === "getSessionDomainEvents") {
        validate(route.endpoint.requestHeadersSchema, contractHeaders(req, route.endpoint), "Request headers");
        const after = Number.isInteger(query.after)
          ? query.after
          : Number(req.headers["last-event-id"] ?? 0);
        const replay = await application.replaySessionDomainEvents({
          query: { after, ...(Number.isInteger(query.limit) ? { limit: query.limit } : {}) },
          auth: session,
        });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const event of replay.events) writeSse(res, event, SessionDomainEnvelopeSchema, "session");
        res.end();
        return;
      }

      let body;
      const headers = contractHeaders(req, route.endpoint);
      if (route.endpoint.mutation) {
        if (session.clientSessionId) {
          if (req.headers.origin && req.headers.origin !== externalOrigin(req, origin)) {
            throw new WorkbenchHttpError("origin_forbidden", "Request Origin does not match this Workbench.");
          }
        } else {
          await ensureBrowserMutationSecurity({ req, sessionStore, configuredOrigin: origin });
        }
        if (route.endpoint.requiredRequestHeaders.includes("If-Match") && !headers["If-Match"]) {
          throw new WorkbenchHttpError("precondition_required", "If-Match is required before this change can be saved.");
        }
        body = await readJson(req);
        validate(route.endpoint.requestBodySchema, body, "Request body");
      }
      validate(route.endpoint.requestHeadersSchema, headers, "Request headers");
      if (route.endpoint.operationId === "listMembers") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        const members = await authService.listMembers({ auth: session });
        const value = { data: members, page: EMPTY_PAGE };
        return writeJson(res, 200, responseEnvelope(route.endpoint, value, requestId));
      }
      if (route.endpoint.operationId === "updateMember") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        const value = await authService.updateMember({
          auth: session,
          userId: path.userId,
          ...body.data,
          idempotencyKey: headers["Idempotency-Key"],
        });
        return writeJson(res, 200, responseEnvelope(route.endpoint, value, requestId));
      }
      if (route.endpoint.operationId === "listInvitations") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        const invitations = await authService.listInvitations({ auth: session });
        const value = { data: invitations, page: EMPTY_PAGE };
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(res, 200, responseEnvelope(route.endpoint, value, requestId), responseHeaders);
      }
      if (route.endpoint.operationId === "createInvitation"
        || route.endpoint.operationId === "revokeInvitation"
        || route.endpoint.operationId === "resendInvitation") {
        if (!authService) throw new WorkbenchHttpError("auth_unavailable", "Authentication is unavailable.");
        const action = route.endpoint.operationId === "createInvitation"
          ? authService.createInvitation.bind(authService)
          : route.endpoint.operationId === "revokeInvitation"
            ? authService.revokeInvitation.bind(authService)
            : authService.resendInvitation.bind(authService);
        const value = await action({
          auth: session,
          invitationId: path.invitationId,
          ...body.data,
          idempotencyKey: headers["Idempotency-Key"],
        });
        const responseHeaders = { "Cache-Control": "no-store" };
        validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
        return writeJson(
          res,
          route.endpoint.successStatus,
          responseEnvelope(route.endpoint, value, requestId),
          responseHeaders,
        );
      }
      const action = application[route.endpoint.operationId];
      if (typeof action !== "function") throw new TypeError(`workbench_application_method_missing:${route.endpoint.operationId}`);
      const value = await action({
        ...path,
        query,
        request: body,
        idempotencyKey: headers["Idempotency-Key"],
        ifMatch: headers["If-Match"],
        ifNoneMatch: headers["If-None-Match"],
        requestId: path.requestId ?? requestId,
        auth: session,
      });
      const responseHeaders = {
        ...(value?.responseHeaders ?? EMPTY),
        ...(value?.etag ? { ETag: value.etag } : EMPTY),
      };
      validate(route.endpoint.responseHeadersSchema, responseHeaders, "Response headers");
      if (value?.notModified === true) {
        res.writeHead(304, responseHeaders);
        res.end();
        return;
      }
      const response = contractResponse(route.endpoint, value, requestId);
      if (Buffer.isBuffer(response.rawBody)) {
        res.writeHead(route.endpoint.successStatus, {
          ...responseHeaders,
        });
        res.end(response.rawBody);
        return;
      }
      writeJson(res, route.endpoint.successStatus, response.body, responseHeaders, response.mediaType);
    } catch (error) {
      const { status, body } = productError(error, requestId);
      if (status === 500 && internalErrorReporter) {
        try { internalErrorReporter(projectInternalError(error, requestId)); } catch {}
      }
      // A failed stream must terminate its existing response. Sending JSON
      // headers after SSE has begun throws and can bring down the HTTP server.
      if (res.headersSent) { res.end(); return; }
      if (!Check(ErrorEnvelopeSchema, body)) throw error;
      writeJson(res, status, body);
    }
  };
}

function traceIdFrom(traceparent) {
  if (typeof traceparent !== "string") return undefined;
  const match = /^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/.exec(traceparent);
  return match?.[1];
}

function projectInternalError(error, requestId) {
  const safeToken = (value, fallback = undefined) => (
    typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : fallback
  );
  const stackFrames = typeof error?.stack === "string"
    ? error.stack.split("\n").slice(1).map((line) => line.trim())
      .filter((line) => line.startsWith("at ")).slice(0, 6).map((line) => line.slice(0, 500))
    : [];
  return {
    requestId,
    name: safeToken(error?.name, "Error"),
    ...(typeof error?.code === "string" && safeToken(error.code) ? { code: safeToken(error.code) } : {}),
    ...(Number.isInteger(error?.code) ? { numericCode: error.code } : {}),
    ...(error?.code === "internal_response_invalid" && Array.isArray(error?.details?.errors) ? {
      contractPaths: error.details.errors.slice(0, 20).map((item) => String(item.instancePath ?? "").slice(0, 200)),
    } : {}),
    stackFrames,
  };
}
