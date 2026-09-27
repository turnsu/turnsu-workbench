import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schemaUrl = new URL(
  "../../src/store/postgres/migrations/001_pg_baseline.sql",
  import.meta.url,
);
const sql = await readFile(schemaUrl, "utf8");

const requiredTables = [
  "product_schema_migrations",
  "product_users",
  "product_workspaces",
  "workspace_memberships",
  "workspace_principals",
  "product_scopes",
  "scope_policy_revisions",
  "scope_principal_grants",
  "policy_grants",
  "authorization_decisions",
  "object_access_grants",
  "product_commands",
  "secret_bindings",
  "model_profiles",
  "model_profile_revisions",
  "workspace_model_policy_revisions",
  "admission_waiting",
  "capacity_counters",
  "agent_branches",
  "agent_sessions",
  "agent_turns",
  "agent_messages",
  "agent_context_events",
  "agent_session_events",
  "agent_handoffs",
  "agent_object_proposals",
  "execution_invocations",
  "execution_attempts",
  "execution_events",
  "execution_checkpoints",
  "capability_leases",
  "agent_child_spawn_counters",
  "agent_child_spawn_reservations",
  "capacity_leases",
  "workbench_browser_sessions",
  "memory_candidates",
  "durable_memories",
  "memory_events",
  "memory_deletion_tombstones",
  "external_effect_receipts",
  "product_objects",
  "upload_sessions",
  "input_attachments",
  "attachment_derived_representations",
  "workspace_resources",
  "skill_assets",
  "skill_system_catalog_principals",
  "skill_system_catalog_sources",
  "legacy_skill_definitions",
  "skill_drafts",
  "skill_draft_revision_snapshots",
  "skill_test_runs",
  "skill_test_evidence",
  "skill_validations",
  "skill_validation_test_runs",
  "skill_execution_bindings",
  "skill_versions",
  "templates",
  "workflows",
  "workflow_revisions",
  "workspace_connections",
  "workspace_connection_revisions",
  "compile_results",
  "execution_plans",
  "execution_plan_model_pins",
  "loop_imports",
  "builder_proposals",
  "loop_versions",
  "loop_version_skill_pins",
  "loop_version_resource_pins",
  "loop_version_connection_requirements",
  "workspace_asset_releases",
  "asset_installations",
  "installation_update_drafts",
  "installation_update_draft_connection_bindings",
  "workspace_connection_bindings",
  "workflow_runs",
  "workflow_run_events",
  "workflow_run_jobs",
  "workflow_run_node_attempts",
  "workflow_run_reviews",
  "workflow_run_final_outputs",
  "automations",
  "automation_revisions",
  "automation_input_pins",
  "automation_connection_pins",
  "automation_occurrences",
  "inbox_items",
];

const tableBlock = (table) => {
  const match = sql.match(new RegExp(
    `CREATE TABLE public\\.${table} \\(([\\s\\S]*?)\\n\\);`,
  ));
  assert.ok(match, `missing table ${table}`);
  return match[1];
};

const functionBlock = (name) => {
  const start = sql.indexOf(`CREATE FUNCTION public.${name}()`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = sql.indexOf("\n$function$;", start);
  assert.notEqual(end, -1, `unterminated function ${name}`);
  return sql.slice(start, end + "\n$function$;".length);
};

const parameterizedFunctionBlock = (name) => {
  const start = sql.indexOf(`CREATE FUNCTION public.${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = sql.indexOf("\n$function$;", start);
  assert.notEqual(end, -1, `unterminated function ${name}`);
  return sql.slice(start, end + "\n$function$;".length);
};

const triggerBlock = (name) => {
  const start = sql.indexOf(`CREATE TRIGGER ${name}`);
  assert.notEqual(start, -1, `missing trigger ${name}`);
  const end = sql.indexOf(";", start);
  assert.notEqual(end, -1, `unterminated trigger ${name}`);
  return sql.slice(start, end + 1);
};

const constraintBlock = (name) => {
  const start = sql.indexOf(`CONSTRAINT ${name}`);
  assert.notEqual(start, -1, `missing constraint ${name}`);
  const candidates = [
    sql.indexOf("\n  CONSTRAINT ", start + 1),
    sql.indexOf("\n);", start + 1),
    sql.indexOf(";", start + 1),
  ].filter((candidate) => candidate !== -1);
  assert.ok(candidates.length > 0, `unterminated constraint ${name}`);
  return sql.slice(start, Math.min(...candidates));
};

const compactSql = (value) => value.replace(/\s+/g, " ").trim();

test("baseline owns each required business family without generic entity or seed tables", () => {
  const createdTables = [...sql.matchAll(/CREATE TABLE public\.([a-z0-9_]+) \(/g)]
    .map((match) => match[1]);
  assert.deepEqual(createdTables, requiredTables);
  assert.doesNotMatch(sql, /\b(?:entities|generic_records|seed_data)\b/i);
  const ddlWithoutFunctionBodies = sql.replace(
    /CREATE FUNCTION public\.[\s\S]*?\n\$function\$;/g,
    "",
  );
  assert.doesNotMatch(ddlWithoutFunctionBodies, /\bINSERT\s+INTO\b/i);
});

test("identifier domain and tenant lineage use bytewise C collation and foreign keys", () => {
  assert.match(
    sql,
    /CREATE DOMAIN public\.product_identifier AS text COLLATE "C"[\s\S]*VALUE ~ '\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,127\}\$'/,
  );
  const identifierDeclarations = [...sql.matchAll(
    /^\s{2}([a-z][a-z0-9_]*_id)\s+([a-z][a-z0-9_.]*)/gm,
  )];
  assert.ok(identifierDeclarations.length >= 100, "expected core identifier declarations");
  for (const [, column, type] of identifierDeclarations) {
    assert.equal(type, "public.product_identifier", `${column} must use product_identifier`);
  }
  assert.match(tableBlock("workspace_memberships"), /FOREIGN KEY \(workspace_id\).*product_workspaces/s);
  assert.match(tableBlock("product_commands"), /product_commands_quota_user_fk[\s\S]*FOREIGN KEY \(workspace_id, quota_user_id\).*workspace_memberships/s);
  assert.match(tableBlock("product_commands"), /UNIQUE \(workspace_id, quota_user_id, command_id, session_id, turn_id\)/);
  assert.match(tableBlock("agent_sessions"), /FOREIGN KEY \(workspace_id, user_id\).*workspace_memberships/s);
  assert.match(tableBlock("agent_turns"), /FOREIGN KEY \(session_id, user_id, workspace_id\).*agent_sessions/s);
  assert.match(tableBlock("agent_turns"), /FOREIGN KEY \(workspace_id, user_id, product_command_id, session_id, turn_id\).*product_commands/s);
  assert.match(tableBlock("agent_turns"), /FOREIGN KEY \(workspace_id, user_id, cancellation_command_id, session_id, turn_id\).*product_commands/s);
  assert.match(tableBlock("agent_handoffs"), /FOREIGN KEY \(source_session_id, user_id, workspace_id\).*agent_sessions/s);
  assert.match(tableBlock("agent_handoffs"), /FOREIGN KEY \(target_session_id, user_id, workspace_id\).*agent_sessions/s);
  assert.match(tableBlock("agent_context_events"), /FOREIGN KEY \(product_command_id, session_id, turn_id\).*product_commands/s);
  assert.match(tableBlock("execution_attempts"), /FOREIGN KEY \(invocation_id\).*execution_invocations/s);
  assert.match(tableBlock("execution_invocations"), /product_command_id public\.product_identifier NOT NULL/);
  assert.match(tableBlock("execution_invocations"), /capacity_admission_id public\.product_identifier NOT NULL/);
  assert.match(tableBlock("execution_invocations"), /capacity_lease_id public\.product_identifier NOT NULL/);
  assert.match(tableBlock("execution_invocations"), /capacity_fence integer NOT NULL/);
  assert.match(tableBlock("execution_invocations"), /capacity_backend_key text COLLATE "C" NOT NULL/);
  assert.match(tableBlock("execution_invocations"), /capacity_provider_key text COLLATE "C" NOT NULL/);
  assert.match(tableBlock("execution_invocations"), /capability_lease_id public\.product_identifier NOT NULL/);
  assert.match(tableBlock("execution_invocations"), /capacity_backend_key = mode \|\| ':' \|\| isolation/);
  assert.match(tableBlock("execution_invocations"), /execution_invocations_command_fk[\s\S]*workspace_id, product_command_id[\s\S]*REFERENCES public\.product_commands/);
  assert.match(tableBlock("execution_invocations"), /execution_invocations_command_lineage_fk[\s\S]*session_lineage_key, turn_lineage_key/);
  assert.match(tableBlock("execution_invocations"), /execution_invocations_parent_authority_uq UNIQUE \([\s\S]*invocation_id, product_command_id,[\s\S]*lineage_session_key, lineage_turn_key, controller_kind, controller_id,[\s\S]*controller_fence/);
  assert.match(tableBlock("execution_invocations"), /execution_invocations_parent_authority_fk[\s\S]*parent_invocation_id, product_command_id,[\s\S]*REFERENCES public\.execution_invocations/);
  assert.match(tableBlock("execution_invocations"), /parent_invocation_id IS NULL OR parent_invocation_id <> invocation_id/);
  assert.match(sql, /execution_invocations_capacity_authority_fk[\s\S]*FOREIGN KEY \([\s\S]*capacity_lease_id, capacity_admission_id, product_command_id,[\s\S]*workspace_id,[\s\S]*capacity_backend_key, capacity_provider_key,[\s\S]*capacity_fence[\s\S]*REFERENCES public\.capacity_leases/);
  assert.match(tableBlock("agent_context_events"), /source_hash ~ '\^sha256:\[0-9a-f\]\{64\}\$'/);
  assert.match(tableBlock("external_effect_receipts"), /FOREIGN KEY \(workspace_id, invocation_id\).*execution_invocations/s);
});

test("queue ordering keys, CAS, fence and sequence identities are relational constraints", () => {
  const branches = tableBlock("agent_branches");
  assert.match(branches, /status IN \('active', 'conflicting', 'merged', 'rejected', 'closed'\)/);
  assert.match(sql, /agent_branches_one_active_user_object_uq[\s\S]*WHERE status = 'active'/);
  assert.match(tableBlock("product_commands"), /UNIQUE \(command_id, session_id, turn_id\)/);
  assert.match(tableBlock("admission_waiting"), /UNIQUE NULLS NOT DISTINCT \(command_id, kind, invocation_id\)/);
  assert.match(sql, /admission_waiting_workspace_fifo_idx[\s\S]*created_at, admission_id/);
  assert.match(tableBlock("agent_turns"), /UNIQUE \(session_id, sequence\)/);
  assert.match(tableBlock("agent_session_events"), /UNIQUE \(session_id, sequence\)/);
  assert.match(tableBlock("execution_invocations"), /execution_fence integer NOT NULL/);
  assert.match(sql, /execution_invocations_attempt_authority_fk[\s\S]*FOREIGN KEY \(invocation_id, attempt_id\)/);
  assert.match(sql, /execution_invocations_capability_authority_fk[\s\S]*FOREIGN KEY \(invocation_id, attempt_id, capability_lease_id\)/);
  assert.match(tableBlock("execution_attempts"), /fence integer NOT NULL/);
  assert.match(tableBlock("execution_checkpoints"), /UNIQUE \(invocation_id, attempt_id, sequence\)/);
  assert.match(tableBlock("capacity_leases"), /UNIQUE \(admission_id, fence\)/);
  assert.match(tableBlock("capacity_leases"), /capacity_leases_admission_fk[\s\S]*admission_id, workspace_id, command_id[\s\S]*admission_waiting/s);
  assert.match(tableBlock("agent_child_spawn_counters"), /FOREIGN KEY \(workspace_id, session_id\).*agent_sessions/s);
  assert.match(tableBlock("agent_child_spawn_counters"), /UNIQUE NULLS NOT DISTINCT \([\s\S]*workspace_id, counter_id, session_id, parent_scope_invocation_id[\s\S]*\)/);
  assert.match(tableBlock("agent_child_spawn_reservations"), /PRIMARY KEY \(counter_id, child_key\)/);
  assert.match(tableBlock("agent_child_spawn_reservations"), /FOREIGN KEY \(workspace_id, counter_id, session_id\).*agent_child_spawn_counters/s);
  assert.match(tableBlock("agent_child_spawn_reservations"), /FOREIGN KEY \(workspace_id, counter_id, parent_scope_invocation_id\).*agent_child_spawn_counters/s);
  assert.match(tableBlock("agent_child_spawn_reservations"), /FOREIGN KEY \(workspace_id, session_id, parent_invocation_id\).*execution_invocations/s);
  assert.match(tableBlock("agent_child_spawn_reservations"), /parent_invocation_id = parent_scope_invocation_id/);
  assert.match(tableBlock("agent_child_spawn_reservations"), /UNIQUE \(workspace_id, parent_invocation_id, child_key\)/);
});

test("B3 owns the outer Workflow Run with exact Command, pin, fence, review, and output lineage", () => {
  const commands = tableBlock("product_commands");
  assert.match(commands, /'workflow_run', 'workflow_run_cancel', 'workflow_run_review'/);
  assert.match(commands, /kind = 'workflow_run'[\s\S]*target_kind = 'workflow_run'[\s\S]*target_revision = 1/);
  assert.match(commands, /kind = 'workflow_run_review'[\s\S]*target_kind = 'workflow_run_review'/);
  assert.match(commands, /kind = 'workflow_run_cancel'[\s\S]*target_kind = 'workflow_run_cancellation'/);

  const runs = tableBlock("workflow_runs");
  assert.match(runs, /workflow_runs_command_fk[\s\S]*target_kind, target_id, target_revision/);
  assert.match(runs, /workflow_runs_revision_fk[\s\S]*workflow_revision_content_hash/);
  assert.match(runs, /workflow_runs_compile_fk[\s\S]*compile_result_id, execution_plan_id/);
  assert.match(runs, /workflow_runs_plan_fk[\s\S]*plan_pins_finalized/);
  assert.match(runs, /retry_of_run_id[\s\S]*workflow_runs_retry_fk/);
  assert.doesNotMatch(runs, /actor_principal|effective_principal|authorization_decision|policy_grant|quota_user/);

  const events = tableBlock("workflow_run_events");
  assert.match(events, /UNIQUE \(workspace_id, run_id, sequence\)/);
  assert.match(events, /run_fence integer NOT NULL/);
  assert.match(events, /review_id public\.product_identifier/);
  assert.match(events, /node_attempt_id public\.product_identifier/);
  assert.match(events, /workflow_run_events_node_attempt_shape/);
  assert.match(events, /lease_expires_at timestamptz/);
  assert.match(events, /previous_run_fence integer/);
  assert.match(events, /previous_lease_owner public\.product_identifier/);
  assert.match(events, /previous_lease_token public\.product_identifier/);
  assert.match(events, /previous_lease_expires_at timestamptz/);
  assert.match(events, /'run\.worker_recovered', 'run\.lease_renewed'/);
  assert.match(sql, /workflow_run_events_node_attempt_fk[\s\S]*run_fence, lease_owner, lease_token[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /workflow_run_events_one_terminal_uq[\s\S]*effect_outcome_unknown/);
  assert.match(sql, /workflow_run_events_cursor_idx[\s\S]*sequence, event_id/);
  assert.match(sql, /workflow_run_events_node_started_uq[\s\S]*type = 'node\.started'/);
  assert.match(sql, /workflow_run_events_node_outcome_uq[\s\S]*node\.completed', 'node\.failed'/);
  assert.match(sql, /workflow_run_events_effect_recovery_started_uq/);
  assert.match(sql, /workflow_run_events_effect_recovery_outcome_uq/);

  const jobs = tableBlock("workflow_run_jobs");
  assert.match(jobs, /state IN \('queued', 'leased', 'waiting_review', 'terminal'\)/);
  assert.match(jobs, /lease_owner public\.product_identifier/);
  assert.match(jobs, /lease_event_id public\.product_identifier/);
  assert.match(jobs, /workflow_run_jobs_lease_event_fk[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(jobs, /fence integer NOT NULL DEFAULT 0/);
  assert.match(sql, /workflow_run_jobs_fifo_idx[\s\S]*available_at, queued_at, run_id/);
  assert.match(sql, /CREATE FUNCTION public\.claim_workflow_run_job\([\s\S]*lease_duration interval[\s\S]*database_now := clock_timestamp\(\)[\s\S]*FOR UPDATE OF r SKIP LOCKED/);
  assert.doesNotMatch(sql, /CREATE FUNCTION public\.claim_workflow_run_job\([\s\S]*claim_time timestamptz/);
  const claim = parameterizedFunctionBlock("claim_workflow_run_job");
  assert.match(claim, /FOR UPDATE;[\s\S]*database_now := clock_timestamp\(\)/);
  assert.match(claim, /CASE WHEN candidate\.state = 'leased'[\s\S]*run\.worker_recovered/);
  const renew = parameterizedFunctionBlock("renew_workflow_run_job_lease");
  assert.match(renew, /FROM public\.workflow_runs run[\s\S]*FOR UPDATE;[\s\S]*FROM public\.workflow_run_jobs job[\s\S]*FOR UPDATE;/);
  assert.match(renew, /database_now := clock_timestamp\(\)/);
  assert.match(renew, /next_expiry <= job_row\.lease_expires_at[\s\S]*workflow_run_lease_expiry_not_extended/);
  assert.match(renew, /lease_duration > interval '1 hour'/);
  const recover = parameterizedFunctionBlock("close_workflow_run_recovered_execution");
  assert.match(recover, /FROM public\.workflow_runs run[\s\S]*FOR UPDATE;[\s\S]*FROM public\.workflow_run_jobs job[\s\S]*FOR UPDATE;/);
  assert.match(recover, /recovery\.type = 'run\.worker_recovered'/);
  assert.match(recover, /recovery\.run_fence = job_row\.fence/);
  assert.match(recover, /recovery\.lease_owner = job_row\.lease_owner/);
  assert.match(recover, /recovery\.lease_token = job_row\.lease_token/);
  assert.doesNotMatch(recover, /recovery\.event_id = job_row\.lease_event_id/);
  assert.match(recover, /SET status = 'cancelled'/);
  assert.match(recover, /capability\.status <> 'revoked'/);
  assert.match(recover, /capacity\.status <> 'released'/);
  const decideReview = parameterizedFunctionBlock("decide_workflow_run_review");
  assert.match(decideReview, /FROM public\.workflow_runs run[\s\S]*FOR UPDATE;[\s\S]*FROM public\.workflow_run_jobs job[\s\S]*FOR UPDATE;[\s\S]*FROM public\.workflow_run_reviews review[\s\S]*FOR UPDATE;/);
  assert.match(decideReview, /FROM public\.workflow_run_reviews review[\s\S]*FOR UPDATE;[\s\S]*FROM public\.execution_invocations invocation[\s\S]*FOR UPDATE;/);
  assert.match(decideReview, /WHEN 'approve' THEN 'completed' ELSE 'cancelled'/);
  assert.match(decideReview, /review_event_id := md5\(/);
  assert.match(decideReview, /attempt_id <> node_attempt_row\.execution_attempt_id[\s\S]*status IN \('queued', 'running'\)/);
  assert.match(decideReview, /workflow_run_review_execution_attempt_terminal/);
  assert.match(decideReview, /PERFORM execution_attempt\.attempt_id[\s\S]*FOR UPDATE;/);
  assert.equal(
    decideReview.match(/PERFORM execution_attempt\.attempt_id/g)?.length,
    2,
    "Review must lock and then rescan the Invocation attempt set",
  );
  assert.match(decideReview, /workflow_run_review_effect_outcome_unresolved/);
  assert.match(decideReview, /workflow_run_review_replay_inconsistent/);
  assert.doesNotMatch(decideReview, /review_decision_command_id \|\| ':event'/);
  const attemptSerialization = functionBlock(
    "enforce_execution_attempt_parent_serialization",
  );
  assert.match(attemptSerialization, /FROM public\.execution_invocations invocation[\s\S]*FOR UPDATE;/);
  assert.match(attemptSerialization, /execution_attempt_parent_invocation_terminal/);
  assert.match(attemptSerialization, /invocation_row\.status = 'effect_outcome_unknown'/);
  assert.match(attemptSerialization, /FROM public\.external_effect_receipts receipt/);
  assert.match(attemptSerialization, /count\(\*\) > 0[\s\S]*CASE NEW\.status/);
  assert.match(attemptSerialization, /WHEN 'completed' THEN bool_and\(receipt\.status = 'succeeded'\)/);
  assert.match(attemptSerialization, /ELSE bool_and\(receipt\.status IN \('succeeded', 'cancelled'\)\)/);
  assert.match(sql, /CREATE TRIGGER execution_attempts_parent_serialization_guard[\s\S]*BEFORE INSERT OR UPDATE OR DELETE ON public\.execution_attempts/);
  assert.match(attemptSerialization, /execution_attempt_delete_forbidden/);
  const effectReceiptAuthority = functionBlock(
    "enforce_external_effect_receipt_authority",
  );
  assert.match(effectReceiptAuthority, /external_effect_receipt_delete_forbidden/);
  assert.match(effectReceiptAuthority, /NEW\.status <> 'intent_recorded'/);
  assert.match(effectReceiptAuthority, /external_effect_receipt_initial_status_invalid/);
  assert.match(effectReceiptAuthority, /FROM public\.execution_attempts execution_attempt[\s\S]*FOR UPDATE;[\s\S]*FROM public\.execution_invocations invocation[\s\S]*FOR UPDATE;/);
  assert.match(effectReceiptAuthority, /invocation_row\.workspace_id <> NEW\.workspace_id[\s\S]*invocation_row\.controller_id IS DISTINCT FROM NEW\.controller_id/);
  assert.match(effectReceiptAuthority, /invocation_row\.status <> 'running'[\s\S]*attempt_row\.status <> 'running'/);
  assert.match(effectReceiptAuthority, /external_effect_receipt_lineage_invalid/);
  assert.match(effectReceiptAuthority, /external_effect_receipt_identity_immutable/);
  assert.match(effectReceiptAuthority, /external_effect_receipt_terminal/);
  assert.match(effectReceiptAuthority, /external_effect_receipt_transition_invalid/);
  assert.match(effectReceiptAuthority, /external_effect_receipt_reconciliation_authority_invalid/);
  assert.match(effectReceiptAuthority, /external_effect_receipt_parent_terminal/);
  assert.match(effectReceiptAuthority, /OLD\.status = 'intent_recorded' AND NEW\.status = 'dispatching'[\s\S]*external_effect_receipt_dispatch_after_cancellation/);
  assert.match(sql, /CREATE TRIGGER external_effect_receipts_authority_guard[\s\S]*BEFORE INSERT OR UPDATE OR DELETE ON public\.external_effect_receipts/);
  const effectReceiptAggregate = functionBlock(
    "validate_execution_effect_receipt_parent_aggregate",
  );
  assert.match(effectReceiptAggregate, /execution_effect_receipt_parent_inconsistent/);
  assert.match(effectReceiptAggregate, /attempt\.status = 'completed'[\s\S]*receipt\.status <> 'succeeded'/);
  assert.match(effectReceiptAggregate, /attempt\.status = 'effect_outcome_unknown'[\s\S]*receipt\.status = 'outcome_unknown'/);
  assert.match(effectReceiptAggregate, /receipt\.status IN \('pending', 'intent_recorded', 'dispatching'\)/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER execution_attempts_effect_receipt_parent_guard/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER execution_invocations_effect_receipt_parent_guard/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER external_effect_receipts_parent_guard/);

  const attempts = tableBlock("workflow_run_node_attempts");
  assert.match(attempts, /workflow_run_node_attempts_invocation_fk[\s\S]*controller_kind, controller_id, controller_fence/);
  assert.match(attempts, /workflow_run_node_attempts_execution_attempt_fk/);
  assert.match(attempts, /workflow_run_node_attempts_checkpoint_fk/);
  assert.match(attempts, /workflow_run_node_attempts_worker_lineage_uq UNIQUE \([\s\S]*run_fence, lease_owner, lease_token/);
  assert.match(functionBlock("enforce_workflow_run_node_attempt"), /workflow_run_recovery_lineage_not_closed/);
  const nodeEventOrder = functionBlock("validate_workflow_run_node_event_order");
  assert.match(nodeEventOrder, /'node\.progress', 'node\.completed', 'node\.failed'/);
  assert.match(nodeEventOrder, /started\.type = 'node\.started'/);
  assert.match(nodeEventOrder, /workflow_run_node_started_predecessor_missing/);

  const reviews = tableBlock("workflow_run_reviews");
  assert.match(reviews, /workflow_run_reviews_decision_command_fk[\s\S]*target_kind, target_id, target_revision/);
  assert.match(sql, /workflow_run_events_review_fk[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(reviews, /decision IN \('approve', 'reject', 'revise'\)/);
  assert.match(reviews, /status IN \('pending', 'decided', 'cancelled'\)/);
  assert.match(reviews, /cancellation_target_kind[\s\S]*workflow_run_cancellation/);
  assert.match(reviews, /workflow_run_reviews_cancellation_command_fk[\s\S]*target_kind, target_id, target_revision/);

  const outputs = tableBlock("workflow_run_final_outputs");
  assert.match(outputs, /outcome IN \('completed', 'partial'\)/);
  assert.match(outputs, /workflow_run_final_outputs_node_attempt_fk[\s\S]*run_fence, lease_owner, lease_token/);
  assert.match(functionBlock("validate_workflow_run_terminal_aggregate"), /workflow_run_final_output_forbidden_for_terminal/);
  assert.match(functionBlock("validate_workflow_run_projection_consistency"), /workflow_run_projection_inconsistent/);
  assert.match(functionBlock("validate_workflow_run_job_lease_aggregate"), /event\.type = 'run\.started'/);
  assert.match(functionBlock("validate_workflow_run_job_lease_aggregate"), /event\.type = 'run\.worker_recovered'/);
  assert.match(functionBlock("validate_workflow_run_job_lease_aggregate"), /run\.lease_renewed/);
  assert.match(functionBlock("validate_workflow_run_job_lease_aggregate"), /event\.lease_expires_at = NEW\.lease_expires_at/);
  assert.match(functionBlock("validate_workflow_run_job_lease_aggregate"), /event\.event_id = NEW\.lease_event_id/);
  assert.match(functionBlock("validate_workflow_run_job_lease_aggregate"), /event\.previous_run_fence = OLD\.fence/);
  assert.match(functionBlock("validate_workflow_run_lease_event_aggregate"), /job\.lease_event_id = NEW\.event_id/);
  assert.match(functionBlock("validate_workflow_run_lease_event_aggregate"), /workflow_run_lease_event_not_current/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /workflow_run_execution_state_inconsistent/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /'node\.started', 'node\.progress'/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /'node\.effect_recovery_started', 'node\.effect_recovery_completed'/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /WHEN 'node\.effect_recovery_unknown'[\s\S]*effect_outcome_unknown/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /capability\.status = 'revoked'/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /capacity\.status = 'released'/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /controller_kind = 'workflow_run'/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /workflow_run_cancellation_execution_not_closed/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /workflow_run_terminal_execution_not_closed/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /JOIN public\.execution_attempts execution_attempt[\s\S]*execution_attempt\.invocation_id = invocation\.invocation_id/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /WHEN 'run\.completed' THEN[\s\S]*invocation\.status IN \('completed', 'cancelled'\)/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /workflow_run_cancellation_leases_not_released/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /workflow_run_review_execution_not_closed/);
  assert.match(functionBlock("validate_workflow_run_execution_state_aggregate"), /workflow_run_final_output_attempt_not_terminal/);
  assert.match(sql, /workflow_run_jobs_projection_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /workflow_run_jobs_lease_aggregate_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /workflow_run_events_lease_event_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(functionBlock("validate_workflow_run_node_event_order"), /workflow_run_effect_recovery_predecessor_missing/);
  assert.match(sql, /workflow_run_events_node_event_order_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.doesNotMatch(sql, /CREATE TABLE public\.(?:generic_jobs|run_snapshots|run_checkpoints|run_command_ledger|run_transition_table)/);
});

test("B4A fixes authority at scope policy, decision, command, and downstream lineage", () => {
  const memberships = tableBlock("workspace_memberships");
  assert.match(memberships, /status IN \('active', 'suspended', 'removed'\)/);
  assert.match(memberships, /revision integer NOT NULL DEFAULT 1/);
  assert.match(memberships, /workspace_memberships_status_shape/);
  assert.match(triggerBlock("workspace_memberships_revoke_authority_epoch"), /AFTER UPDATE OF role, status/);
  assert.match(functionBlock("revoke_membership_authority_epoch"), /UPDATE public\.scope_principal_grants/);
  assert.match(functionBlock("revoke_membership_authority_epoch"), /UPDATE public\.object_access_grants/);

  const principals = tableBlock("workspace_principals");
  assert.match(principals, /'user', 'automation', 'connector', 'scheduler', 'system'/);
  assert.match(principals, /status IN \('active', 'revoked'\)/);
  assert.match(principals, /FOREIGN KEY \(workspace_id, user_id, membership_id\).*workspace_memberships/s);
  assert.match(principals, /principal_id = user_id/);

  const scopes = tableBlock("product_scopes");
  assert.match(scopes, /scope_kind IN \('personal', 'project'\)/);
  assert.match(scopes, /current_policy_revision_id public\.product_identifier NOT NULL/);
  assert.match(scopes, /creation_mode IN \('workspace_initial_seed', 'system_initial_seed', 'command'\)/);
  assert.match(scopes, /creation_authority_scope_id public\.product_identifier/);
  assert.match(scopes, /scope_id = 'system-catalog'/);
  assert.match(scopes, /workspace_id = 'system-catalog'/);
  assert.match(constraintBlock("product_scopes_current_policy_fk"), /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(constraintBlock("product_scopes_creation_command_fk"), /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER product_scopes_creation_aggregate_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(functionBlock("validate_product_scope_creation_aggregate"), /product_scope_initial_aggregate_incomplete/);
  assert.match(functionBlock("validate_product_scope_creation_aggregate"), /skill_system_catalog_principals/);
  assert.match(sql, /product_scopes_one_active_personal_uq[\s\S]*status = 'active'/);

  const policies = tableBlock("scope_policy_revisions");
  assert.match(policies, /permission_mode IN \('discuss', 'plan', 'interactive', 'auto', 'custom'\)/);
  assert.match(policies, /auto_approved_effect_classes <@ ARRAY\[/);
  assert.match(triggerBlock("scope_policy_revisions_immutable"), /BEFORE UPDATE OR DELETE/);
  assert.match(functionBlock("validate_scope_policy_revision_insert"), /scope_policy_arrays_not_canonical/);

  const scopeGrants = tableBlock("scope_principal_grants");
  assert.match(scopeGrants, /access_kind IN \('observation', 'operation'\)/);
  assert.match(scopeGrants, /capabilities <@ ARRAY\[/);
  assert.match(scopeGrants, /can_approve boolean NOT NULL DEFAULT false/);
  assert.match(scopeGrants, /issuance_kind text COLLATE "C" NOT NULL/);
  assert.match(scopeGrants, /issuance_authority_scope_id public\.product_identifier/);
  assert.match(scopeGrants, /membership_recovery/);
  assert.doesNotMatch(scopeGrants, /creator_bootstrap/);
  assert.match(sql, /scope_principal_grants_one_scope_creation_uq/);
  assert.match(sql, /scope_principal_grants_one_issuance_command_uq/);
  assert.match(scopeGrants, /scope_principal_grant_issue/);
  assert.match(constraintBlock("scope_principal_grants_issuance_command_fk"), /REFERENCES public\.product_commands[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /scope_principal_grants_one_active_uq[\s\S]*WHERE status = 'active'/);

  const policyGrants = tableBlock("policy_grants");
  assert.match(policyGrants, /'active', 'revoked', 'expired', 'revalidation_required'/);
  assert.match(policyGrants, /subject_principal_id, subject_principal_kind, policy_revision_id/);
  assert.doesNotMatch(policyGrants, /budget|connection|automation_id/);
  assert.match(policyGrants, /issuance_command_id public\.product_identifier NOT NULL/);
  assert.match(policyGrants, /policy_grant_issue/);
  assert.match(policyGrants, /issuance_target_kind text COLLATE "C"/);
  assert.match(constraintBlock("policy_grants_issuance_command_fk"), /REFERENCES public\.product_commands[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /policy_grants_one_issuance_command_uq/);
  assert.match(sql, /policy_grants_one_active_subject_policy_uq[\s\S]*WHERE status = 'active'/);

  const decisions = tableBlock("authorization_decisions");
  assert.match(decisions, /disposition IN \('authorized', 'approval_required', 'denied'\)/);
  assert.match(decisions, /authorizer_principal_id = effective_principal_id/);
  assert.match(decisions, /authorizer_principal_kind = effective_principal_kind/);
  assert.match(decisions, /approval_id = authorization_decision_id/);
  assert.match(decisions, /authorization_decisions_approval_reference_fk/);
  assert.match(
    constraintBlock("authorization_decisions_approval_reference_fk"),
    /target_contract_key[\s\S]*REFERENCES public\.authorization_decisions[\s\S]*target_contract_key/,
  );
  assert.match(decisions, /actor_principal_id, actor_principal_kind,[\s\S]*effective_principal_id, effective_principal_kind/);
  assert.match(decisions, /target_contract jsonb/);
  assert.match(decisions, /target_contract_key jsonb GENERATED ALWAYS AS/);
  assert.match(decisions, /coalesce\(target_contract, 'null'::jsonb\)/);
  assert.match(decisions, /action_id, effect_class, argument_digest, target_contract_key, disposition/);
  assert.match(decisions, /disposition = 'denied' AND approval_id IS NULL/);
  assert.match(triggerBlock("authorization_decisions_immutable"), /BEFORE UPDATE OR DELETE/);
  assert.match(functionBlock("validate_authorization_decision_insert"), /authorization_policy_snapshot_mismatch/);
  assert.match(functionBlock("validate_authorization_decision_insert"), /authorization_interactive_approval_required/);
  assert.match(functionBlock("validate_authorization_decision_insert"), /authorization_approver_inactive_or_forbidden/);
  assert.match(functionBlock("validate_authorization_decision_insert"), /approval_request\.actor_principal_id IS DISTINCT FROM NEW\.actor_principal_id/);
  assert.match(functionBlock("validate_authorization_decision_insert"), /approval_request\.target_contract IS DISTINCT FROM NEW\.target_contract/);
  assert.match(functionBlock("validate_authorization_decision_insert"), /clock_timestamp\(\)/);
  assert.match(sql, /authorization_decisions_one_final_per_approval_uq[\s\S]*WHERE disposition = 'authorized'/);

  const objectGrants = tableBlock("object_access_grants");
  assert.match(objectGrants, /scope_id public\.product_identifier NOT NULL/);
  assert.match(objectGrants, /principal_kind text COLLATE "C" NOT NULL/);
  assert.match(objectGrants, /capabilities <@ ARRAY\[/);
  assert.match(objectGrants, /product_command_id public\.product_identifier NOT NULL/);
  assert.match(objectGrants, /object_access_grant_issue/);
  assert.doesNotMatch(objectGrants, /authorization_decision_id|actor_principal_id|effective_principal_id|authorization_argument_digest/);
  assert.match(constraintBlock("object_access_grants_issuance_command_fk"), /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(functionBlock("validate_object_access_grant_insert"), /object_access_grant_object_scope_mismatch/);
  assert.match(functionBlock("validate_object_access_grant_insert"), /FOR SHARE/);
  assert.match(functionBlock("validate_object_access_grant_insert"), /object_access_grant_initial_status_invalid/);

  const commands = tableBlock("product_commands");
  assert.match(commands, /scope_id public\.product_identifier NOT NULL/);
  assert.match(commands, /actor_principal_id public\.product_identifier NOT NULL/);
  assert.match(commands, /effective_principal_id public\.product_identifier NOT NULL/);
  assert.match(commands, /authorization_decision_id public\.product_identifier NOT NULL/);
  assert.match(commands, /effect_class text COLLATE "C" NOT NULL/);
  assert.match(commands, /argument_digest text COLLATE "C" NOT NULL/);
  assert.match(commands, /target_contract jsonb/);
  assert.match(commands, /target_contract_key jsonb GENERATED ALWAYS AS/);
  assert.match(commands, /coalesce\(target_contract, 'null'::jsonb\)/);
  assert.match(commands, /quota_user_id public\.product_identifier NOT NULL/);
  assert.doesNotMatch(commands, /^\s*user_id public\.product_identifier NOT NULL/m);
  assert.match(commands, /workflow_run', 'workflow_run_cancel', 'workflow_run_review',[\s\S]*workflow_run_step'/);
  assert.doesNotMatch(commands, /'automation_run'/);
  assert.match(commands, /session_id IS NULL AND turn_id IS NULL/);
  assert.match(commands, /target_command_kind text COLLATE "C" GENERATED ALWAYS AS/);
  assert.match(commands, /target_kind text COLLATE "C"/);
  assert.match(commands, /'scope_create', 'scope_principal_grant_issue'/);
  assert.match(commands, /'policy_grant_issue', 'object_access_grant_issue'/);
  assert.match(commands, /product_commands_decision_consumption_uq/);
  assert.match(
    constraintBlock("product_commands_decision_fk"),
    /target_contract_key[\s\S]*REFERENCES public\.authorization_decisions[\s\S]*target_contract_key/,
  );
  assert.match(commands, /product_commands_special_target_authority_uq/);
  assert.match(commands, /target_contract_key,[\s\S]*authorization_disposition/);
  assert.match(
    constraintBlock("product_commands_special_completed"),
    /scope_create[\s\S]*scope_principal_grant_issue[\s\S]*policy_grant_issue[\s\S]*object_access_grant_issue[\s\S]*status = 'completed'/,
  );
  assert.match(commands, /workspace_id, target_command_id, scope_id, target_command_kind/);
  assert.doesNotMatch(constraintBlock("product_commands_target_fk"), /user_id|actor_principal_id/);
  assert.match(triggerBlock("product_commands_validate_authority"), /BEFORE INSERT/);
  assert.match(functionBlock("validate_product_command_authority_insert"), /d\.action_id = NEW\.kind/);
  assert.match(functionBlock("validate_product_command_authority_insert"), /d\.effect_class = NEW\.effect_class/);
  assert.match(functionBlock("validate_product_command_authority_insert"), /d\.argument_digest = NEW\.argument_digest/);
  assert.match(functionBlock("validate_product_command_authority_insert"), /clock_timestamp\(\)/);
  assert.match(triggerBlock("product_commands_mutation_guard"), /BEFORE UPDATE OR DELETE/);
  assert.match(sql, /CREATE CONSTRAINT TRIGGER product_commands_special_target_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED/);
  assert.match(functionBlock("validate_product_command_special_target"), /product_command_special_target_missing/);
  assert.match(functionBlock("validate_product_command_special_target"), /product_command_target_contract_mismatch/);
  assert.match(functionBlock("validate_product_command_special_target"), /jsonb_build_object/);
  assert.match(functionBlock("validate_product_command_special_target"), /'status', g\.status/);
  assert.match(functionBlock("validate_product_command_special_target"), /g\.status = 'active'/);
  assert.match(functionBlock("validate_scope_principal_grant_insert"), /scope_principal_grant_subject_inactive/);
  assert.match(functionBlock("validate_scope_principal_grant_insert"), /membership_recovery/);
  assert.match(functionBlock("validate_scope_principal_grant_insert"), /FOR SHARE/);
  assert.match(functionBlock("validate_scope_principal_grant_insert"), /scope_principal_grant_initial_status_invalid/);
  assert.match(functionBlock("validate_scope_principal_grant_insert"), /NEW\.capabilities = original_grant\.capabilities/);
  assert.match(functionBlock("validate_scope_principal_grant_insert"), /NEW\.can_approve = original_grant\.can_approve/);
  assert.match(functionBlock("validate_scope_principal_grant_insert"), /scope_principal_grant_recovery_rights_mismatch/);
  assert.match(functionBlock("validate_policy_grant_insert"), /policy_grant_initial_status_invalid/);

  for (const table of ["admission_waiting", "capacity_leases", "execution_invocations"]) {
    const block = tableBlock(table);
    assert.doesNotMatch(block, /quota_user_id public\.product_identifier/);
    assert.doesNotMatch(block, /scope_id public\.product_identifier/);
    assert.doesNotMatch(block, /actor_principal_id public\.product_identifier/);
    assert.doesNotMatch(block, /effective_principal_id public\.product_identifier/);
    assert.doesNotMatch(block, /authorization_decision_id public\.product_identifier/);
    assert.doesNotMatch(block, /authorization_disposition/);
  }
  assert.doesNotMatch(tableBlock("execution_invocations"), /actor_user_id/);

  const proposals = tableBlock("builder_proposals");
  assert.match(proposals, /scope_id public\.product_identifier NOT NULL/);
  assert.match(proposals, /created_by_principal_id public\.product_identifier NOT NULL/);
  assert.match(proposals, /created_by_principal_kind text COLLATE "C" NOT NULL/);
  assert.match(proposals, /effective_principal_id, effective_principal_kind, kind/);
  assert.match(proposals, /builder_proposals_workflow_scope_fk/);
  assert.doesNotMatch(proposals, /policy_revision_id public\.product_identifier|authorization_decision_id public\.product_identifier|authorization_disposition/);
});

test("Memory uses generated simple FTS and indexed application-owned TTL", () => {
  const durable = tableBlock("durable_memories");
  assert.match(durable, /search_document tsvector GENERATED ALWAYS AS/);
  assert.match(durable, /to_tsvector\('simple'::regconfig, coalesce\(statement, ''\)\)/);
  assert.match(durable, /payload ->> 'tags'/);
  assert.match(sql, /durable_memories_search_gin_idx[\s\S]*USING gin \(search_document\)/);
  for (const index of ["memory_candidates_expires_idx", "durable_memories_expires_idx"]) {
    assert.match(sql, new RegExp(`${index}[\\s\\S]*\\(expires_at\\)[\\s\\S]*WHERE expires_at IS NOT NULL`));
  }
  assert.doesNotMatch(sql, /pg_cron/i);
});

test("browser sessions and external effects retain governed expiry and terminal states", () => {
  const sessions = tableBlock("workbench_browser_sessions");
  assert.match(sessions, /token_hash text COLLATE "C" NOT NULL/);
  assert.match(sessions, /UNIQUE \(token_hash\)/);
  assert.match(sessions, /token_hash ~ '\^sha256:\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /workbench_browser_sessions_expires_idx[\s\S]*WHERE revoked_at IS NULL/);

  const effects = tableBlock("external_effect_receipts");
  assert.match(effects, /PRIMARY KEY \(workspace_id, effect_id\)/);
  assert.match(effects, /'intent_recorded', 'dispatching', 'outcome_unknown', 'succeeded', 'cancelled'/);
  assert.match(effects, /external_effect_receipts_terminal_state CHECK/);
  assert.match(effects, /argument_digest ~ '\^sha256:\[0-9a-f\]\{64\}\$'/);
  assert.match(effects, /status IN \('dispatching', 'outcome_unknown'\)[\s\S]*reconcile_after IS NOT NULL/);
});

test("B1 keeps object, material, and Skill authority relational without storing blobs or host paths", () => {
  const object = tableBlock("product_objects");
  assert.match(object, /PRIMARY KEY \(workspace_id, object_id\)/);
  assert.match(object, /UNIQUE \(workspace_id, object_id, object_kind, content_hash\)/);
  assert.match(object, /content_hash ~ '\^sha256:\[a-f0-9\]\{16,64\}\$'/);
  assert.match(object, /size_bytes BETWEEN 0 AND 1073741824/);
  assert.doesNotMatch(sql, /\bbytea\b|\bhost_path\b|\bprovider_payload\b|\bsecret_value\b/i);

  const upload = tableBlock("upload_sessions");
  assert.match(upload, /FOREIGN KEY \(workspace_id, requested_by\).*workspace_memberships/s);
  assert.match(upload, /FOREIGN KEY \(workspace_id, object_id, object_kind, object_content_hash\).*product_objects/s);
  assert.match(
    upload,
    /state IN \([\s\S]*'selecting', 'uploading', 'quarantined', 'scanning', 'parsing',[\s\S]*'needs_decision', 'ready_draft', 'failed', 'promoted'[\s\S]*\)/,
  );
  assert.doesNotMatch(upload, /'committed'/);

  const attachment = tableBlock("input_attachments");
  assert.match(attachment, /scope_kind = 'personal'/);
  assert.match(attachment, /source text COLLATE "C" NOT NULL DEFAULT 'user_upload'/);
  assert.match(attachment, /processing_status IN \('processing', 'ready', 'failed', 'blocked', 'deleted', 'expired'\)/);
  assert.match(attachment, /processing_code text COLLATE "C"/);
  assert.match(attachment, /processing_message text NOT NULL/);
  assert.match(attachment, /processing_retryable boolean NOT NULL/);
  assert.match(attachment, /processing_status IN \('deleted', 'expired'\)[\s\S]*deleted_at IS NOT NULL/);
  assert.match(attachment, /length\(file_name\) BETWEEN 1 AND 255/);
  assert.match(attachment, /size_bytes BETWEEN 1 AND 16777216/);
  assert.match(attachment, /row_revision integer NOT NULL DEFAULT 1/);
  assert.match(attachment, /FOREIGN KEY \(workspace_id, owner_user_id\).*workspace_memberships/s);
  assert.match(attachment, /FOREIGN KEY \(workspace_id, object_id, object_kind, content_hash\).*product_objects/s);
  assert.match(sql, /input_attachments_expires_idx[\s\S]*WHERE deleted_at IS NULL/);

  const representation = tableBlock("attachment_derived_representations");
  assert.match(representation, /workspace_id public\.product_identifier NOT NULL/);
  assert.doesNotMatch(representation, /UNIQUE \(workspace_id, attachment_id, attachment_version\)/);
  assert.match(representation, /FOREIGN KEY \(workspace_id, attachment_id, attachment_version, attachment_content_hash\).*input_attachments/s);
  assert.match(representation, /'binary_reference', 'utf8_text', 'document_text', 'spreadsheet_tables'/);
  assert.match(representation, /character_count BETWEEN 0 AND 2000000/);
  assert.match(representation, /jsonb_array_length\(evidence\) <= 10000/);

  const resource = tableBlock("workspace_resources");
  assert.match(resource, /FOREIGN KEY \(workspace_id, object_id, object_kind, content_hash\).*product_objects/s);
  assert.match(resource, /length\(resource_version\) BETWEEN 1 AND 64/);
  assert.doesNotMatch(resource, /resource_version ~ '\^\[0-9\]/);
  assert.doesNotMatch(resource, /ON DELETE CASCADE/i);
});

test("B1 separates legacy definitions and preserves immutable Skill history authority", () => {
  const legacy = tableBlock("legacy_skill_definitions");
  assert.match(legacy, /scope_kind = 'global' AND workspace_id IS NULL AND owner_user_id IS NULL/);
  assert.match(legacy, /scope_kind = 'workspace' AND workspace_id IS NOT NULL AND owner_user_id IS NOT NULL/);
  assert.ok(sql.includes("legacy_skill_definitions_global_identity_uq"));
  assert.ok(sql.includes("WHERE scope_kind = 'global'"));
  assert.ok(sql.includes("legacy_skill_definitions_workspace_identity_uq"));
  assert.ok(sql.includes("WHERE scope_kind = 'workspace'"));

  const assets = tableBlock("skill_assets");
  assert.match(assets, /scope_id public\.product_identifier NOT NULL/);
  assert.match(assets, /FOREIGN KEY \(workspace_id, scope_id\).*product_scopes/s);
  assert.match(assets, /UNIQUE \(workspace_id, skill_id, scope_id\)/);
  assert.match(constraintBlock("skill_assets_current_draft_fk"), /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(constraintBlock("skill_assets_latest_version_fk"), /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(assets, /UNIQUE \(workspace_id, name_normalized\)/);
  assert.match(
    assets,
    /lifecycle IN \('draft', 'validating', 'tested', 'published', 'deprecated', 'archived'\)/,
  );
  assert.doesNotMatch(assets, /'ready'|'shared'|'blocked'/);

  const drafts = tableBlock("skill_drafts");
  assert.doesNotMatch(drafts, /scope_id public\.product_identifier/);
  assert.match(drafts, /draft_revision integer NOT NULL/);
  assert.match(drafts, /UNIQUE \(workspace_id, skill_id, skill_draft_id\)/);
  assert.doesNotMatch(
    tableBlock("skill_test_evidence"),
    /FOREIGN KEY \([^)]*draft_revision[^)]*\)\s*REFERENCES public\.skill_drafts/s,
  );
  assert.doesNotMatch(
    tableBlock("skill_validations"),
    /FOREIGN KEY \([^)]*draft_revision[^)]*\)\s*REFERENCES public\.skill_drafts/s,
  );

  const snapshots = tableBlock("skill_draft_revision_snapshots");
  assert.match(snapshots, /PRIMARY KEY \(workspace_id, skill_draft_id, draft_revision\)/);
  assert.ok(compactSql(constraintBlock("skill_draft_revision_snapshots_authority_uq")).includes(
    "workspace_id, skill_id, skill_draft_id, draft_revision, package_object_id, package_object_hash, package_hash, content_hash",
  ));
  assert.doesNotMatch(snapshots, /updated_at/);
  const currentSnapshot = compactSql(constraintBlock("skill_drafts_current_snapshot_fk"));
  assert.ok(currentSnapshot.includes("draft_revision"));
  assert.ok(currentSnapshot.includes("content_hash"));
  assert.ok(currentSnapshot.includes("REFERENCES public.skill_draft_revision_snapshots"));

  const tests = tableBlock("skill_test_runs");
  assert.match(tests, /command_kind text COLLATE "C" NOT NULL DEFAULT 'skill_test'/);
  const testCommand = compactSql(constraintBlock("skill_test_runs_command_fk"));
  assert.ok(testCommand.includes("product_command_id"));
  assert.ok(testCommand.includes("command_kind"));
  assert.ok(testCommand.includes("REFERENCES public.product_commands"));
  assert.match(tests, /runner_claim_fence integer NOT NULL DEFAULT 0/);
  assert.match(tests, /row_revision integer NOT NULL DEFAULT 1/);
  const testSnapshot = compactSql(constraintBlock("skill_test_runs_snapshot_fk"));
  for (const field of ["draft_revision", "object_hash", "package_hash", "content_hash"]) {
    assert.ok(testSnapshot.includes(field));
  }
  assert.ok(testSnapshot.includes("REFERENCES public.skill_draft_revision_snapshots"));
  assert.match(triggerBlock("skill_test_runs_terminal_immutable"), /BEFORE UPDATE OR DELETE ON public\.skill_test_runs/);
  assert.match(functionBlock("reject_terminal_skill_test_run_mutation"), /OLD\.status IN \('passed', 'failed', 'blocked', 'cancelled'\)/);

  const validations = tableBlock("skill_validations");
  assert.doesNotMatch(validations, /test_run_ids jsonb/);
  const primaryTest = compactSql(constraintBlock("skill_validations_primary_test_run_fk"));
  assert.ok(primaryTest.includes("primary_test_run_id"));
  assert.ok(primaryTest.includes("primary_test_status"));
  assert.ok(primaryTest.includes("REFERENCES public.skill_test_runs"));
  const primaryEvidence = compactSql(constraintBlock("skill_validations_primary_evidence_fk"));
  for (const field of [
    "primary_test_run_id", "draft_revision", "primary_evidence_isolated",
    "primary_evidence_network_denied",
  ]) assert.ok(primaryEvidence.includes(field));
  assert.ok(primaryEvidence.includes("REFERENCES public.skill_test_evidence"));
  const passedRequirements = compactSql(constraintBlock("skill_validations_passed_requirements"));
  for (const condition of [
    "status <> 'passed'", "permission_acknowledged", "primary_test_status = 'passed'",
    "primary_evidence_isolated", "primary_evidence_network_denied",
  ]) assert.ok(passedRequirements.includes(condition));

  const validationTests = tableBlock("skill_validation_test_runs");
  const validationMembership = compactSql(
    constraintBlock("skill_validation_test_runs_validation_fk"),
  );
  assert.ok(validationMembership.includes("validation_id"));
  assert.ok(validationMembership.includes("validation_status"));
  assert.ok(validationMembership.includes("REFERENCES public.skill_validations"));
  const validationTestRun = compactSql(constraintBlock("skill_validation_test_runs_test_run_fk"));
  assert.ok(validationTestRun.includes("test_run_id"));
  assert.ok(validationTestRun.includes("test_status"));
  assert.ok(validationTestRun.includes("REFERENCES public.skill_test_runs"));
  const validationEvidence = compactSql(constraintBlock("skill_validation_test_runs_evidence_fk"));
  for (const field of [
    "test_run_id", "draft_revision", "evidence_isolated", "evidence_network_denied",
  ]) assert.ok(validationEvidence.includes(field));
  assert.ok(validationEvidence.includes("REFERENCES public.skill_test_evidence"));
  assert.match(validationTests, /skill_validation_test_runs_authority_uq UNIQUE/);
  assert.match(constraintBlock("skill_validations_primary_membership_fk"), /DEFERRABLE INITIALLY DEFERRED/);

  const binding = tableBlock("skill_execution_bindings");
  const compactBinding = compactSql(binding);
  assert.match(binding, /validation_status text COLLATE "C" NOT NULL DEFAULT 'passed'/);
  const bindingValidation = compactSql(constraintBlock("skill_execution_bindings_validation_fk"));
  assert.ok(bindingValidation.includes("validation_id"));
  assert.ok(bindingValidation.includes("validation_status"));
  assert.ok(bindingValidation.includes("REFERENCES public.skill_validations"));
  assert.match(binding, /UNIQUE \(workspace_id, validation_id\)/);
  assert.ok(!compactBinding.includes(
    "UNIQUE ( workspace_id, skill_draft_id, draft_revision, content_hash, package_hash )",
  ));
  assert.doesNotMatch(sql, /skill_execution_bindings_execution_ref_uq/);
  assert.match(binding, /image_digest ~ '\^\[A-Za-z0-9\.\/:_-\]\+@sha256:\[a-f0-9\]\{64\}\$'/);
  assert.match(binding, /published_version_content_hash text COLLATE "C" NOT NULL/);
  assert.ok(compactBinding.includes(
    "package_hash, content_hash, published_version_content_hash )",
  ));

  const versions = tableBlock("skill_versions");
  assert.doesNotMatch(versions, /scope_id public\.product_identifier/);
  const versionBinding = compactSql(constraintBlock("skill_versions_binding_fk"));
  assert.ok(versionBinding.includes("execution_binding_id"));
  assert.ok(versionBinding.includes("validated_draft_content_hash, content_hash"));
  assert.ok(versionBinding.includes("content_hash, published_version_content_hash"));
  assert.ok(versionBinding.includes("REFERENCES public.skill_execution_bindings"));
  assert.match(versions, /UNIQUE \(workspace_id, skill_id, version\)/);
  assert.match(versions, /source_kind IN \('validated_draft', 'system_catalog'\)/);
  assert.match(versions, /skill_versions_source_shape CHECK/);
  const catalogVersion = compactSql(constraintBlock("skill_versions_system_catalog_source_fk"));
  assert.ok(catalogVersion.includes("system_catalog_source_id"));
  assert.ok(catalogVersion.includes("published_by_system_principal_id"));
  assert.ok(catalogVersion.includes("content_hash"));
  assert.ok(catalogVersion.includes("published_version_content_hash"));
  assert.ok(catalogVersion.includes("REFERENCES public.skill_system_catalog_sources"));
  assert.match(versions, /published_version_content_hash/);
  assert.doesNotMatch(versions, /updated_at/);
  const versionAuthority = functionBlock("require_skill_version_authoritative_definition");
  assert.match(versionAuthority, /skill_draft_revision_snapshots/);
  assert.match(versionAuthority, /skill_system_catalog_sources/);
  assert.match(versionAuthority, /NEW\.definition IS DISTINCT FROM authoritative_definition/);
  assert.match(
    triggerBlock("skill_versions_require_authoritative_definition"),
    /BEFORE INSERT ON public\.skill_versions/,
  );

  const systemPrincipal = tableBlock("skill_system_catalog_principals");
  assert.match(systemPrincipal, /principal_id = 'system-catalog'/);
  const systemSource = tableBlock("skill_system_catalog_sources");
  assert.match(systemSource, /FOREIGN KEY \(system_principal_id\)/);
  assert.match(systemSource, /source_locator ~ '\^bundled:\/\//);
  assert.match(systemSource, /runtime_probe_status = 'ready'/);
  assert.match(systemSource, /runtime_probe_digest ~ '\^sha256:/);
  assert.match(systemSource, /execution_ref_hash ~ '\^sha256:/);
  assert.match(systemSource, /published_version_content_hash text COLLATE "C" NOT NULL/);
  assert.match(systemSource, /definition jsonb NOT NULL/);
  assert.ok(compactSql(systemSource).includes(
    "package_hash, published_version_content_hash )",
  ));
  assert.doesNotMatch(systemSource, /signature|signing_key/);
  for (const functionName of [
    "require_enabled_catalog_principal_for_source",
    "require_enabled_catalog_principal_for_version",
  ]) {
    const policy = functionBlock(functionName);
    assert.match(policy, /FOR UPDATE;/);
    assert.match(policy, /system_catalog_principal_not_enabled/);
  }
  assert.match(
    triggerBlock("skill_system_catalog_sources_require_enabled_principal"),
    /BEFORE INSERT ON public\.skill_system_catalog_sources/,
  );
  assert.match(
    triggerBlock("skill_versions_require_enabled_system_principal"),
    /WHEN \(NEW\.source_kind = 'system_catalog'\)/,
  );
  assert.doesNotMatch(versions, /system_principal_status/);

  const immutableTables = [
    "skill_test_runs",
    "skill_draft_revision_snapshots",
    "skill_validation_test_runs",
    "skill_test_evidence",
    "skill_validations",
    "skill_execution_bindings",
    "skill_system_catalog_sources",
    "skill_versions",
  ];
  assert.equal(
    [...sql.matchAll(/CREATE FUNCTION public\.reject_immutable_skill_history_mutation\(\)/g)].length,
    1,
  );
  const b1Sql = sql.slice(sql.indexOf("-- G2 B1:"), sql.indexOf("-- G2 B2:"));
  assert.deepEqual(
    [...b1Sql.matchAll(/CREATE TRIGGER ([a-z0-9_]+)_immutable\n\s+BEFORE UPDATE OR DELETE ON public\.([a-z0-9_]+)/g)]
      .map((match) => match[2])
      .filter((table) => immutableTables.includes(table)),
    immutableTables,
  );
  const lifecycleTransition = functionBlock("enforce_skill_asset_lifecycle_transition");
  assert.match(lifecycleTransition, /WHEN 'draft' THEN NEW\.lifecycle = 'validating'/);
  assert.match(lifecycleTransition, /WHEN 'deprecated' THEN NEW\.lifecycle = 'archived'/);
  assert.match(
    triggerBlock("skill_assets_enforce_lifecycle_transition"),
    /BEFORE UPDATE OF lifecycle ON public\.skill_assets/,
  );
  assert.equal([...b1Sql.matchAll(/CREATE FUNCTION public\.[a-z0-9_]+\(\)/g)].length, 7);
  assert.equal([...b1Sql.matchAll(/CREATE TRIGGER [a-z0-9_]+/g)].length, 13);
});

test("B4B Batch A pins model, secret, policy, and Connection revisions relationally", () => {
  const secrets = tableBlock("secret_bindings");
  assert.match(secrets, /owner_kind IN \('connection', 'model_profile_revision'\)/);
  assert.match(secrets, /secret_source IN \('cloud_secret_store', 'desktop_keychain'\)/);
  assert.match(secrets, /store_binding_ref public\.product_identifier NOT NULL/);
  assert.match(secrets, /store_binding_revision integer NOT NULL/);
  assert.match(secrets, /FOREIGN KEY \(workspace_id, scope_id\)[\s\S]*product_scopes/);
  assert.doesNotMatch(secrets, /secret_value|credential_json|\btoken\b|\bpassword\b/i);
  assert.match(
    functionBlock("enforce_secret_binding_lifecycle"),
    /secret_binding_active_probe_invalid[\s\S]*TG_OP = 'INSERT'[\s\S]*secret_binding_identity_immutable[\s\S]*secret_binding_lifecycle_transition_forbidden/,
  );
  assert.match(
    triggerBlock("secret_bindings_lifecycle_guard"),
    /BEFORE INSERT OR UPDATE OR DELETE/,
  );

  const profiles = tableBlock("model_profiles");
  assert.match(profiles, /profile_scope IN \('global', 'workspace'\)/);
  assert.match(profiles, /profile_scope = 'global'[\s\S]*workspace_id = 'system-catalog'/);
  assert.match(profiles, /current_revision_id public\.product_identifier NOT NULL/);
  assert.match(constraintBlock("model_profiles_current_revision_fk"), /DEFERRABLE INITIALLY DEFERRED/);

  const revisions = tableBlock("model_profile_revisions");
  assert.match(revisions, /deployment_key public\.product_identifier NOT NULL/);
  assert.match(revisions, /secret_binding_id public\.product_identifier NOT NULL/);
  assert.match(revisions, /model_profile_revisions_secret_binding_fk/);
  assert.match(revisions, /capabilities text\[\] NOT NULL/);
  assert.match(
    revisions,
    /protocol = 'openai_realtime'[\s\S]*NOT capabilities && ARRAY\['image_generation'\]/,
  );
  assert.doesNotMatch(revisions, /credential_ref|store_binding_ref|secret_value|credential_json/i);
  assert.match(
    functionBlock("validate_model_secret_binding_aggregate"),
    /owner_kind = 'model_profile_revision'[\s\S]*owner_id = revision\.revision_id[\s\S]*cloud_secret_store/,
  );

  const policy = tableBlock("workspace_model_policy_revisions");
  assert.match(policy, /scope_id public\.product_identifier NOT NULL/);
  assert.match(policy, /FOREIGN KEY \(workspace_id, scope_id\)[\s\S]*product_scopes/);
  assert.match(policy, /capability_model_revision_ids jsonb NOT NULL/);
  assert.match(policy, /UNIQUE \(workspace_id, scope_id, revision\)/);
  assert.match(
    functionBlock("validate_workspace_model_policy_revision"),
    /jsonb_each_text[\s\S]*assert_model_revision_consumable/,
  );
  assert.match(
    triggerBlock("workspace_model_policy_revisions_immutable"),
    /reject_immutable_governance_revision_mutation/,
  );

  const turns = tableBlock("agent_turns");
  assert.match(turns, /agent_turns_requested_model_revision_fk/);
  assert.match(turns, /agent_turns_actual_model_revision_fk/);
  assert.match(turns, /required_model_capability text COLLATE "C"/);
  assert.match(turns, /model_routing_state = 'pinned'[\s\S]*required_model_capability IS NOT NULL/);
  assert.match(turns, /kind = 'model_task' AND required_model_capability = 'image_generation'/);
  assert.match(turns, /model_routing_state = 'pinned'[\s\S]*requested_model_revision_id IS NOT NULL/);
  assert.match(
    turns,
    /agent_turns_completed_model_revision_shape[\s\S]*status <> 'completed'[\s\S]*actual_model_revision_id IS NOT NULL[\s\S]*actual_model_revision_id IS NOT DISTINCT FROM requested_model_revision_id/,
  );
  assert.match(tableBlock("agent_context_events"), /agent_context_events_model_revision_fk/);
  assert.match(tableBlock("execution_plan_model_pins"), /execution_plan_model_pins_model_revision_fk/);
  assert.match(
    functionBlock("validate_model_revision_consumer"),
    /agent_turn_model_pin_immutable[\s\S]*actual_model_revision_id IS NOT DISTINCT FROM OLD\.actual_model_revision_id[\s\S]*agent_context_events[\s\S]*execution_plan_model_pins/,
  );
  assert.match(
    parameterizedFunctionBlock("assert_model_revision_consumable"),
    /consumer_scope_id[\s\S]*profile\.scope_id = consumer_scope_id[\s\S]*binding\.scope_id = profile\.scope_id[\s\S]*binding\.secret_source = 'cloud_secret_store'[\s\S]*binding\.status = 'active'[\s\S]*FOR SHARE OF profile, binding/,
  );
  assert.match(
    functionBlock("validate_model_revision_consumer"),
    /agent_sessions[\s\S]*product_scopes[\s\S]*skill_drafts[\s\S]*workflows[\s\S]*agent_session_consumer_scope_missing[\s\S]*scope_principal_grants[\s\S]*access_kind = 'operation'[\s\S]*agent_session_scope_grant_missing/,
  );
  assert.match(
    parameterizedFunctionBlock("assert_model_revision_consumable"),
    /consumer_scope\.status = 'active'[\s\S]*binding\.probed_at IS NOT NULL[\s\S]*binding\.probed_at <= clock_timestamp[\s\S]*FOR SHARE OF profile, binding, consumer_scope/,
  );
  assert.match(
    parameterizedFunctionBlock("assert_execution_plan_model_pins_consumable"),
    /workflow\.scope_id[\s\S]*public\.workflows[\s\S]*pins_finalized = true[\s\S]*modelCapability[\s\S]*assert_model_revision_consumable[\s\S]*execution_plan_model_pins_missing/,
  );
  assert.match(
    functionBlock("enforce_finalizable_pin_parent"),
    /execution_plan_model_pin_projection_incomplete/,
  );
  assert.match(
    functionBlock("validate_finalized_execution_plan_model_consumption"),
    /NEW\.pins_finalized[\s\S]*assert_execution_plan_model_pins_consumable/,
  );
  assert.match(
    sql,
    /CREATE CONSTRAINT TRIGGER execution_plans_model_consumption_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED[\s\S]*validate_finalized_execution_plan_model_consumption/,
  );
  assert.match(
    sql,
    /CREATE CONSTRAINT TRIGGER compile_results_ready_model_pins_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED[\s\S]*validate_ready_compile_result_model_pins/,
  );
  assert.match(
    functionBlock("validate_workflow_run_initial_aggregate"),
    /assert_execution_plan_model_pins_consumable/,
  );
  assert.match(
    parameterizedFunctionBlock("claim_workflow_run_job"),
    /candidate_plan_id[\s\S]*assert_execution_plan_model_pins_consumable[\s\S]*UPDATE public\.workflow_run_jobs/,
  );

  const connections = tableBlock("workspace_connections");
  assert.match(connections, /scope_id public\.product_identifier NOT NULL/);
  assert.match(connections, /current_revision_id public\.product_identifier NOT NULL/);
  assert.doesNotMatch(connections, /secret_binding_id|credential_state|safe_configuration|validation_status/);
  const connectionRevisions = tableBlock("workspace_connection_revisions");
  assert.match(connectionRevisions, /connection_revision_id public\.product_identifier NOT NULL/);
  assert.match(connectionRevisions, /secret_binding_id public\.product_identifier/);
  assert.match(connectionRevisions, /workspace_connection_revisions_secret_binding_fk/);
  assert.match(constraintBlock("workspace_connections_current_revision_fk"), /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(
    functionBlock("validate_connection_secret_binding_aggregate"),
    /scope_id = binding\.scope_id[\s\S]*credential_binding_fingerprint = binding\.credential_fingerprint[\s\S]*owner_kind = 'connection'/,
  );
  assert.match(
    functionBlock("validate_workspace_connection_revision_readiness"),
    /validation_effects[\s\S]*workspace_connection_validation_effects_not_canonical[\s\S]*owner_id = NEW\.connection_id[\s\S]*NEW\.credential_binding_fingerprint = binding\.credential_fingerprint[\s\S]*cloud_secret_store[\s\S]*validation_checked_at > clock_timestamp[\s\S]*validation_expires_at[\s\S]*clock_timestamp/,
  );
  assert.match(
    parameterizedFunctionBlock("assert_workspace_connection_consumable"),
    /required_capability_key[\s\S]*required_effects[\s\S]*current_revision_id[\s\S]*consumer_scope\.status = 'active'[\s\S]*driver_backend = 'production'[\s\S]*readiness_status = 'connected'[\s\S]*revision\.capability_key = required_capability_key[\s\S]*revision\.validation_effects @> required_effects[\s\S]*validation_expires_at > clock_timestamp[\s\S]*cloud_secret_store[\s\S]*binding\.probed_at <= clock_timestamp[\s\S]*FOR SHARE OF connection, binding, consumer_scope/,
  );
  const connectionBindingGuard = functionBlock("validate_workspace_connection_binding_scope");
  assert.match(
    connectionBindingGuard,
    /required_capability_key text[\s\S]*required_effects jsonb[\s\S]*loop_versions[\s\S]*loop_version_connection_requirements[\s\S]*requirement\.requirement_id = NEW\.requirement_id/,
  );
  assert.match(
    connectionBindingGuard,
    /asset_installations[\s\S]*FOR SHARE OF installation[\s\S]*workspace_asset_releases[\s\S]*release\.release_id = locked_release_id[\s\S]*release\.loop_version_id = locked_loop_version_id[\s\S]*workspace_connection_binding_requirement_invalid[\s\S]*required_capability_key, required_effects/,
  );
  assert.match(
    triggerBlock("workspace_connection_bindings_generation_guard"),
    /validate_workspace_connection_binding_generation/,
  );
  assert.match(
    functionBlock("validate_workspace_connection_binding_generation"),
    /generation = 1[\s\S]*first_generation_exists[\s\S]*generation - 1[\s\S]*FOR SHARE OF previous[\s\S]*previous_generation_missing[\s\S]*previous_generation_active/,
  );
  assert.match(
    triggerBlock("workspace_connection_bindings_identity_immutable"),
    /enforce_workspace_connection_binding_identity_immutable/,
  );
  assert.match(
    functionBlock("enforce_workspace_connection_binding_identity_immutable"),
    /workspace_connection_binding_delete_forbidden[\s\S]*NEW\.connection_id[\s\S]*NEW\.requirement_id[\s\S]*NEW\.workflow_revision_id[\s\S]*NEW\.installation_id[\s\S]*NEW\.generation[\s\S]*workspace_connection_binding_identity_immutable[\s\S]*superseded_terminal[\s\S]*transition_forbidden[\s\S]*superseded_at_immutable[\s\S]*time_regression/,
  );
  assert.match(
    sql,
    /CREATE CONSTRAINT TRIGGER workspace_connection_bindings_active_aggregate_guard[\s\S]*DEFERRABLE INITIALLY DEFERRED[\s\S]*validate_workspace_connection_binding_active_aggregate/,
  );
  assert.match(
    functionBlock("validate_workspace_connection_binding_active_aggregate"),
    /status = 'active'[\s\S]*active_count <> 1[\s\S]*active_generation IS DISTINCT FROM latest_generation[\s\S]*active_generation_invalid/,
  );
  assert.doesNotMatch(sql, /compile_results_ready_connection_bindings_guard/);
  assert.match(
    parameterizedFunctionBlock("assert_execution_plan_connection_bindings_consumable"),
    /workflow_revision_id[\s\S]*workspace_connection_bindings[\s\S]*binding\.status = 'active'[\s\S]*FOR SHARE OF binding[\s\S]*execution_plan_connection_binding_not_in_requirement_set[\s\S]*requirement\.capability_key[\s\S]*requirement\.required_effects[\s\S]*FOR SHARE OF binding[\s\S]*asset_installations[\s\S]*FOR SHARE OF installation[\s\S]*release\.release_id = locked_release_id[\s\S]*loop_version\.execution_plan_id = selected_plan_id[\s\S]*valid_candidate_count <> 1[\s\S]*execution_plan_connection_requirement_unbound[\s\S]*assert_workspace_connection_consumable/,
  );
  assert.match(
    functionBlock("validate_workflow_run_initial_aggregate"),
    /assert_execution_plan_model_pins_consumable[\s\S]*assert_execution_plan_connection_bindings_consumable/,
  );
  assert.match(
    parameterizedFunctionBlock("claim_workflow_run_job"),
    /assert_execution_plan_model_pins_consumable[\s\S]*assert_execution_plan_connection_bindings_consumable[\s\S]*UPDATE public\.workflow_run_jobs/,
  );
  assert.match(
    triggerBlock("workspace_connection_revisions_immutable"),
    /reject_immutable_governance_revision_mutation/,
  );
});

test("B4B Batch B keeps Automation trigger generations and Inbox as bounded recipient projections", () => {
  const automation = tableBlock("automations");
  assert.match(automation, /scope_id public\.product_identifier NOT NULL/);
  assert.match(automation, /owner_user_id public\.product_identifier NOT NULL/);
  assert.match(automation, /automation_principal_id public\.product_identifier NOT NULL/);
  assert.match(automation, /status IN \('draft', 'checking', 'active', 'paused', 'blocked', 'archived'\)/);
  assert.match(automation, /current_revision_id public\.product_identifier NOT NULL/);
  assert.match(constraintBlock("automations_current_revision_fk"), /DEFERRABLE INITIALLY DEFERRED/);

  const revisions = tableBlock("automation_revisions");
  assert.match(revisions, /trigger_revision integer NOT NULL/);
  assert.match(revisions, /trigger_content_key text COLLATE "C" GENERATED ALWAYS AS/);
  assert.match(revisions, /automation_revisions_trigger_generation_uq/);
  assert.match(revisions, /trigger_kind = 'daily_cron'/);
  assert.match(revisions, /execution_location_policy = 'cloud'/);
  assert.match(
    revisions,
    /misfire_max_lateness_seconds integer NOT NULL[\s\S]*misfire_policy = 'skip'[\s\S]*misfire_max_lateness_seconds = 0[\s\S]*misfire_policy = 'run_once'[\s\S]*BETWEEN 1 AND 86400/,
  );
  assert.match(revisions, /dedupe_policy = 'local_schedule_date'/);
  assert.match(
    functionBlock("validate_automation_revision_contract"),
    /TG_OP = 'DELETE'[\s\S]*automation_revision_immutable[\s\S]*trigger_content_key[\s\S]*automation_trigger_generation_content_mismatch[\s\S]*automation_trigger_generation_not_next/,
  );

  const inputs = tableBlock("automation_input_pins");
  assert.match(inputs, /input_kind = 'resource'/);
  assert.match(inputs, /automation_input_pins_resource_fk/);
  assert.match(inputs, /automation_input_pins_resource_uq/);
  assert.match(triggerBlock("automation_input_pins_finalized_guard"), /reject_finalized_automation_pin_append/);
  assert.match(
    functionBlock("validate_automation_revision_pins"),
    /automation_resource_pin_projection_incomplete[\s\S]*automation_connection_pin_projection_incomplete/,
  );

  const connectionPins = tableBlock("automation_connection_pins");
  assert.match(connectionPins, /automation_connection_pins_requirement_fk/);
  assert.match(connectionPins, /automation_connection_pins_connection_revision_fk/);
  assert.match(connectionPins, /secret_source = 'cloud_secret_store'/);
  assert.match(functionBlock("validate_automation_connection_pin"), /driver_backend = 'production'[\s\S]*validation_effects @> NEW\.required_effects[\s\S]*binding\.status = 'active'/);

  const occurrences = tableBlock("automation_occurrences");
  assert.match(occurrences, /automation_occurrences_revision_fk[\s\S]*automation_revision_id, trigger_revision/);
  assert.match(occurrences, /UNIQUE \(\s*workspace_id, automation_id, trigger_revision, local_schedule_date\s*\)/);
  assert.doesNotMatch(occurrences, /scheduled_for >= created_at/);
  assert.match(occurrences, /accepted_at IS NULL OR accepted_at >= created_at/);
  assert.match(
    functionBlock("enforce_automation_occurrence_lifecycle"),
    /TG_OP = 'DELETE'[\s\S]*automation_occurrence_terminal[\s\S]*automation_occurrence_schedule_mismatch[\s\S]*automation_occurrence_misfire_must_skip[\s\S]*automation_occurrence_misfire_lateness_exceeded/,
  );
  assert.match(
    functionBlock("validate_automation_occurrence_accepted_aggregate"),
    /authorization_source = 'policy_grant'[\s\S]*command\.kind = 'workflow_run'[\s\S]*run\.idempotency_key = occurrence_row\.occurrence_id/,
  );
  assert.match(
    functionBlock("validate_automation_workflow_run_occurrence_aggregate"),
    /command_row\.kind <> 'workflow_run'[\s\S]*automation_workflow_run_occurrence_missing/,
  );

  const inbox = tableBlock("inbox_items");
  assert.match(inbox, /recipient_user_id public\.product_identifier NOT NULL/);
  assert.match(inbox, /source_domain text COLLATE "C" NOT NULL/);
  assert.match(inbox, /source_revision integer NOT NULL/);
  assert.match(inbox, /status IN \('unread', 'read', 'dismissed'\)/);
  assert.match(inbox, /UNIQUE \(\s*workspace_id, recipient_user_id,\s*source_domain, source_id, source_revision\s*\)/);
  assert.match(functionBlock("validate_inbox_item_source"), /inbox_recipient_inactive[\s\S]*authorization_decision[\s\S]*workflow_run[\s\S]*automation_occurrence[\s\S]*installation_update_draft/);
  assert.match(functionBlock("enforce_inbox_item_lifecycle"), /inbox_item_projection_identity_immutable[\s\S]*inbox_item_transition_invalid/);
});

test("B2 keeps Loop/Library revision, compile, release, and Connection authority relational", () => {
  const workflows = tableBlock("workflows");
  assert.match(workflows, /scope_id public\.product_identifier NOT NULL/);
  assert.match(workflows, /FOREIGN KEY \(workspace_id, scope_id\).*product_scopes/s);
  assert.match(workflows, /UNIQUE \([\s\S]*workspace_id, workflow_id, scope_id[\s\S]*\)/);
  assert.match(workflows, /FOREIGN KEY \(workspace_id, owner_user_id\).*workspace_memberships/s);
  assert.match(workflows, /current_revision_number integer NOT NULL/);
  assert.match(workflows, /write_version integer NOT NULL DEFAULT 1/);
  assert.match(workflows, /visibility = 'private' AND lifecycle IN \('draft', 'ready', 'blocked'\)/);
  assert.match(workflows, /source_release_workspace_id IS NULL OR source_release_workspace_id = workspace_id/);
  assert.match(constraintBlock("workflows_current_revision_fk"), /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(constraintBlock("workflows_source_workflow_fk"), /workflow_revisions/);
  assert.match(constraintBlock("workflows_source_release_fk"), /workspace_asset_releases/);
  assert.match(constraintBlock("workflows_latest_compile_result_fk"), /compile_results/);

  const revisions = tableBlock("workflow_revisions");
  assert.doesNotMatch(revisions, /scope_id public\.product_identifier/);
  assert.match(revisions, /UNIQUE \(workspace_id, workflow_id, revision_number\)/);
  assert.match(revisions, /base_revision_number integer/);
  assert.match(revisions, /FOREIGN KEY \([\s\S]*base_revision_id, base_revision_number[\s\S]*\).*workflow_revisions/s);
  assert.match(revisions, /base_revision_number IS NOT NULL/);
  assert.match(revisions, /base_revision_number = revision_number - 1/);
  assert.doesNotMatch(revisions, /execution_plan|compile_result/);

  const results = tableBlock("compile_results");
  const plans = tableBlock("execution_plans");
  assert.doesNotMatch(plans, /scope_id public\.product_identifier/);
  assert.match(results, /status = 'ready' AND execution_plan_id IS NOT NULL/);
  assert.match(results, /status IN \('blocked', 'invalid'\) AND execution_plan_id IS NULL/);
  assert.doesNotMatch(results, /execution_plan jsonb|plan_document/);
  assert.match(plans, /schema_version = 'workbench-execution-plan-v2'/);
  assert.match(plans, /plan_version = 2/);
  assert.match(plans, /pins_finalized boolean NOT NULL DEFAULT false/);
  assert.match(plans, /plan_document ->> 'workflowId' = workflow_id/);
  assert.match(plans, /plan_document \?& ARRAY\[/);
  assert.match(plans, /plan_document ->> 'contentHash' = content_hash/);
  assert.match(plans, /plan_document ->> 'generatedAt'\)::timestamptz = generated_at/);
  assert.match(plans, /jsonb_path_query_array\(plan_document, '\$\.steps\[\*\]\.nodeId'\)/);
  assert.match(plans, /jsonb_path_query_array\(plan_document, '\$\.reviewGates\[\*\]\.nodeId'\)/);
  assert.match(plans, /UNIQUE \(workspace_id, compile_result_id\)/);
  assert.match(constraintBlock("compile_results_execution_plan_fk"), /DEFERRABLE INITIALLY DEFERRED/);
  assert.match(constraintBlock("execution_plans_compile_result_fk"), /DEFERRABLE INITIALLY DEFERRED/);

  const loopVersions = tableBlock("loop_versions");
  assert.match(loopVersions, /workflow_revision_content_hash text COLLATE "C" NOT NULL/);
  assert.match(loopVersions, /compile_result_id public\.product_identifier NOT NULL/);
  assert.match(loopVersions, /execution_plan_id public\.product_identifier NOT NULL/);
  assert.match(loopVersions, /compile_status = 'ready'/);
  assert.match(loopVersions, /pins_finalized boolean NOT NULL DEFAULT false/);
  assert.match(loopVersions, /validation_run_id public\.product_identifier/);
  assert.match(tableBlock("loop_version_skill_pins"), /REFERENCES public\.skill_versions/s);
  assert.match(tableBlock("loop_version_resource_pins"), /REFERENCES public\.workspace_resources/s);
  assert.doesNotMatch(tableBlock("loop_version_connection_requirements"), /connection_id/);
  assert.match(
    functionBlock("validate_loop_version_connection_requirement_effects"),
    /SELECT DISTINCT effect[\s\S]*jsonb_array_elements\(NEW\.required_effects\)[\s\S]*loop_connection_required_effects_not_canonical/,
  );

  const releases = tableBlock("workspace_asset_releases");
  assert.match(releases, /asset_id public\.product_identifier GENERATED ALWAYS AS/);
  assert.match(releases, /version_id public\.product_identifier GENERATED ALWAYS AS/);
  assert.match(releases, /asset_kind = 'skill'[\s\S]*skill_id IS NOT NULL[\s\S]*loop_version_id IS NULL/);
  assert.match(releases, /asset_kind = 'loop'[\s\S]*skill_id IS NULL[\s\S]*loop_version_id IS NOT NULL/);
  assert.match(releases, /FOREIGN KEY \([\s\S]*skill_version_id[\s\S]*\).*skill_versions/s);
  assert.match(releases, /FOREIGN KEY \([\s\S]*loop_version_id[\s\S]*\).*loop_versions/s);

  const installations = tableBlock("asset_installations");
  assert.match(installations, /source_workspace_id = workspace_id/);
  assert.match(installations, /REFERENCES public\.workspace_asset_releases/s);
  assert.match(sql, /asset_installations_active_asset_uq[\s\S]*WHERE state <> 'removed'/);

  const updateDrafts = tableBlock("installation_update_drafts");
  assert.match(updateDrafts, /base_release_id public\.product_identifier NOT NULL/);
  assert.match(updateDrafts, /target_release_id public\.product_identifier NOT NULL/);
  assert.match(updateDrafts, /base_installation_write_version integer NOT NULL/);
  assert.match(updateDrafts, /FOREIGN KEY \(workspace_id, installation_id\)[\s\S]*asset_installations/);
  assert.doesNotMatch(updateDrafts, /base_(?:skill|loop)_installation_fk/);
  assert.doesNotMatch(updateDrafts, /ON UPDATE CASCADE|ON DELETE CASCADE/);

  const connections = tableBlock("workspace_connections");
  assert.match(connections, /scope_id public\.product_identifier NOT NULL/);
  assert.match(connections, /current_revision_id public\.product_identifier NOT NULL/);
  assert.match(connections, /current_revision_number integer NOT NULL/);
  assert.doesNotMatch(connections, /driver_backend|secret_binding_id|credential_state|safe_configuration|validation_status/);
  const connectionRevisions = tableBlock("workspace_connection_revisions");
  assert.match(connectionRevisions, /driver_backend IN \('production', 'test'\)/);
  assert.match(connectionRevisions, /secret_binding_id public\.product_identifier/);
  assert.match(connectionRevisions, /credential_state = 'bound'[\s\S]*validation_status = 'valid'[\s\S]*validation_checked_at IS NOT NULL/);
  assert.match(connectionRevisions, /safe_configuration - ARRAY\['accountLabel', 'permissionSummary'\]::text\[\] = '\{\}'::jsonb/);
  assert.doesNotMatch(connectionRevisions, /\btoken\b|\bpassword\b|secret_value|credential_json|host_path/i);
  const bindings = tableBlock("workspace_connection_bindings");
  assert.match(bindings, /workflow_revision_id IS NOT NULL AND installation_id IS NULL/);
  assert.match(bindings, /workflow_revision_id IS NULL AND installation_id IS NOT NULL/);
  assert.match(bindings, /generation integer NOT NULL DEFAULT 1/);
  assert.match(bindings, /status IN \('active', 'superseded'\)/);
  assert.match(bindings, /status = 'active' AND superseded_at IS NULL/);
  assert.match(bindings, /status = 'superseded' AND superseded_at IS NOT NULL/);
  assert.match(bindings, /REFERENCES public\.workspace_connections/s);
  assert.match(sql, /workspace_connection_bindings_workflow_generation_uq[\s\S]*requirement_id, generation/);
  assert.match(sql, /workspace_connection_bindings_installation_generation_uq[\s\S]*requirement_id, generation/);
  assert.match(sql, /workspace_connection_bindings_workflow_active_uq[\s\S]*status = 'active'/);
  assert.match(sql, /workspace_connection_bindings_installation_active_uq[\s\S]*status = 'active'/);

  const proposals = tableBlock("builder_proposals");
  assert.match(proposals, /created_by_principal_id public\.product_identifier NOT NULL/);
  assert.match(proposals, /created_by_principal_kind text COLLATE "C" NOT NULL/);
  assert.match(proposals, /builder_proposals_workflow_scope_fk/);
  assert.match(proposals, /product_command_id public\.product_identifier NOT NULL/);
  assert.match(proposals, /planned_invocation_id public\.product_identifier/);
  assert.match(proposals, /planned_attempt_id public\.product_identifier/);
  assert.match(proposals, /source_invocation_id public\.product_identifier/);
  assert.match(proposals, /source_attempt_id public\.product_identifier/);
  assert.match(proposals, /FOREIGN KEY \([\s\S]*source_invocation_id, source_attempt_id,[\s\S]*product_command_id[\s\S]*\).*execution_invocations/s);
  assert.match(proposals, /planned_invocation_id IS NULL AND planned_attempt_id IS NULL/);
  assert.match(proposals, /planned_invocation_id IS NOT DISTINCT FROM source_invocation_id/);
  assert.match(proposals, /planned_attempt_id IS NOT DISTINCT FROM source_attempt_id/);
  assert.match(proposals, /planned_invocation_id IS NOT NULL/);

  const immutableTables = [
    "workflow_revisions",
    "compile_results",
    "execution_plan_model_pins",
    "loop_version_skill_pins",
    "loop_version_resource_pins",
    "loop_version_connection_requirements",
    "workspace_asset_releases",
  ];
  assert.equal(
    [...sql.matchAll(/CREATE FUNCTION public\.reject_immutable_loop_library_history_mutation\(\)/g)].length,
    1,
  );
  assert.deepEqual(
    [...sql.matchAll(/CREATE TRIGGER ([a-z0-9_]+)_immutable\n\s+BEFORE UPDATE OR DELETE ON public\.([a-z0-9_]+)/g)]
      .map((match) => match[2])
      .filter((table) => immutableTables.includes(table)),
    immutableTables,
  );
  assert.match(
    triggerBlock("templates_version_content_immutable"),
    /enforce_template_version_content_immutability/,
  );
  assert.match(
    triggerBlock("execution_plans_immutable"),
    /enforce_finalizable_pin_parent/,
  );
  assert.match(
    functionBlock("enforce_finalizable_pin_parent"),
    /SELECT \* FROM expected EXCEPT SELECT \* FROM actual[\s\S]*SELECT \* FROM actual EXCEPT SELECT \* FROM expected/,
  );
  assert.match(
    functionBlock("enforce_finalizable_pin_parent"),
    /FROM public\.workflow_revisions[\s\S]*loop_version_resource_pins/,
  );
  assert.match(
    triggerBlock("loop_versions_immutable"),
    /enforce_finalizable_pin_parent/,
  );
  for (const trigger of [
    "execution_plan_model_pins_reject_finalized_append",
    "loop_version_skill_pins_reject_finalized_append",
    "loop_version_resource_pins_reject_finalized_append",
    "loop_version_connection_requirements_reject_finalized_append",
  ]) {
    assert.match(triggerBlock(trigger), /reject_finalized_pin_projection_append/);
  }
  assert.match(
    triggerBlock("installation_update_drafts_enforce_snapshot"),
    /enforce_installation_update_draft_snapshot/,
  );
  assert.match(
    functionBlock("enforce_installation_update_draft_snapshot"),
    /FROM public\.asset_installations[\s\S]*FOR UPDATE/,
  );
  for (const mutableTable of [
    "workflows",
    "loop_imports",
    "builder_proposals",
    "workspace_connections",
    "asset_installations",
    "installation_update_drafts",
    "workspace_connection_bindings",
  ]) {
    assert.doesNotMatch(sql, new RegExp(
      `CREATE TRIGGER ${mutableTable}_immutable\\b`,
    ));
  }
});
