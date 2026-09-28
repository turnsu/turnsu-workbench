import { connectionApprovalSnapshot } from "../connections/workspace-connection-service.mjs";
import { readPinnedSkillVersion } from "../skills/postgres-published-skill-reader.mjs";

/**
 * PostgreSQL read-side resolver for the immutable Workflow execution input.
 * It is deliberately a narrow Product port: no repository facade and no raw
 * database capability leave this module.
 */
export function createPostgresWorkflowExecutionResolver({ store } = {}) {
  if (!store?.bindAdapter || !store?.withTransaction) {
    throw new TypeError("postgres_workflow_execution_resolver_store_required");
  }
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query(uow, text, values = []) { return execute(uow, { text, values }); },
  }));
  return async ({ workflowId, revisionId, automationRevisionId = null } = {}) => store.withTransaction(async (uow) => {
    required(workflowId); required(revisionId);
    const query = (text, values) => sql.query(uow, text, values);
    const source = (await query(`
      SELECT workflow.workspace_id, workflow.scope_id, revision.*
        FROM public.workflows workflow
        JOIN public.workflow_revisions revision
          ON revision.workspace_id = workflow.workspace_id
         AND revision.workflow_id = workflow.workflow_id
       WHERE workflow.workflow_id = $1 AND revision.revision_id = $2
       LIMIT 1
    `, [workflowId, revisionId])).rows[0];
    if (!source) throw unavailable();
    const compile = (await query(`
      SELECT result.*, plan.plan_id, plan.plan_document, plan.content_hash AS plan_content_hash
        FROM public.compile_results result
        JOIN public.execution_plans plan
          ON plan.workspace_id = result.workspace_id
         AND plan.compile_result_id = result.compile_result_id
       WHERE result.workspace_id = $1 AND result.workflow_id = $2
         AND result.workflow_revision_id = $3 AND result.status = 'ready'
       ORDER BY result.compiled_at DESC, result.compile_result_id DESC
       LIMIT 1
    `, [source.workspace_id, workflowId, revisionId])).rows[0];
    if (!compile || !compile.plan_document) throw unavailable();
    const plan = structuredClone(compile.plan_document);
    if (plan.workflowId !== workflowId || plan.workflowRevisionId !== revisionId) throw unavailable();
    const skills = new Map();
    const skillVersions = [];
    for (const ref of plan.pinnedSkills ?? []) {
      const skill = await readPinnedSkillVersion({ query, workspaceId: source.workspace_id, ref });
      if (!skill?.definition) throw unavailable("pinned_skill_contract_missing");
      skills.set(`${ref.skillId}:${ref.version}`, { definition: skill.definition, executionRef: skill.version.executionRef });
      skillVersions.push(skill.version);
    }
    const requiredResources = automationRevisionId === null
      ? structuredClone(source.resource_refs ?? [])
      : await automationResourceRefs({
          query,
          workspaceId: source.workspace_id,
          workflowId,
          automationRevisionId,
        });
    const resources = new Map();
    for (const ref of requiredResources) {
      const row = (await query(`
        SELECT resource_id, resource_version, object_id, content_hash, label, media_type,
               readiness_status, payload
          FROM public.workspace_resources
         WHERE workspace_id = $1 AND resource_id = $2 AND resource_version = $3
         LIMIT 1
      `, [source.workspace_id, ref.resourceId, ref.version])).rows[0];
      if (!row || row.readiness_status !== 'ready') throw unavailable();
      resources.set(`${row.resource_id}:${row.resource_version}`, resourceView(row));
    }
    const connectionBindings = [];
    for (const requirementId of connectionRequirements(plan)) {
      const row = automationRevisionId === null
        ? (await query(`
        SELECT binding.requirement_id, connection.connection_id, connection.enabled,
               connection.current_revision_number,
               revision.capability_key, revision.driver_key, revision.driver_backend,
               revision.credential_state, revision.credential_binding_fingerprint,
               revision.readiness_status, revision.validation_status,
               revision.validation_principal, revision.validation_scopes, revision.validation_effects,
               revision.validation_expires_at
          FROM public.workspace_connection_bindings binding
          JOIN public.workspace_connections connection
            ON connection.workspace_id = binding.workspace_id
           AND connection.connection_id = binding.connection_id
          JOIN public.workspace_connection_revisions revision
            ON revision.workspace_id = connection.workspace_id
           AND revision.connection_revision_id = connection.current_revision_id
         WHERE binding.workspace_id = $1 AND binding.workflow_id = $2
           AND binding.workflow_revision_id = $3 AND binding.requirement_id = $4
           AND binding.status = 'active' AND connection.enabled = true
         LIMIT 1
      `, [source.workspace_id, workflowId, revisionId, requirementId])).rows[0]
        : (await query(`
        SELECT pin.requirement_id, pin.capability_key AS required_capability_key,
               connection.connection_id, connection.enabled,
               pin.connection_revision_number AS current_revision_number,
               revision.capability_key, revision.driver_key, revision.driver_backend,
               revision.credential_state, revision.credential_binding_fingerprint,
               revision.readiness_status, revision.validation_status,
               revision.validation_principal, revision.validation_scopes,
               revision.validation_effects, revision.validation_expires_at
          FROM public.automation_connection_pins pin
          JOIN public.workspace_connections connection
            ON connection.workspace_id = pin.workspace_id
           AND connection.connection_id = pin.connection_id
          JOIN public.workspace_connection_revisions revision
            ON revision.workspace_id = pin.workspace_id
           AND revision.connection_id = pin.connection_id
           AND revision.connection_revision_id = pin.connection_revision_id
           AND revision.revision_number = pin.connection_revision_number
         WHERE pin.workspace_id = $1
           AND pin.automation_revision_id = $2
           AND pin.workflow_id = $3
           AND pin.requirement_id = $4
         FOR SHARE OF pin, connection, revision
      `, [source.workspace_id, automationRevisionId, workflowId, requirementId])).rows[0];
      if (!row || (automationRevisionId !== null
        && row.required_capability_key !== row.capability_key)) {
        throw unavailable("connection_rebind_required");
      }
      connectionBindings.push(connectionApprovalSnapshot(connectionView(row), { requirementId }));
    }
    return {
      revision: revisionView(source),
      compileResult: { compileResultId: compile.compile_result_id, status: compile.status, executionPlan: plan },
      skills, skillVersions, resources,
      workspaceId: source.workspace_id, scopeId: source.scope_id,
      workflowRevisionContentHash: source.content_hash,
      compileResultId: compile.compile_result_id, executionPlanId: compile.plan_id,
      automationRevisionId,
      connectionBindings,
      connectionIds: [...new Set(connectionBindings.map((item) => item.connectionId))].sort(),
    };
  });
}

/**
 * Current Connection approval reader for the PostgreSQL Workflow Runner.
 * It exposes only the public-safe approval snapshot; the runner never gains
 * a raw Pool or a generic repository fallback.
 */
export function createPostgresConnectionApprovalResolver({ store } = {}) {
  if (!store?.bindAdapter || !store?.withTransaction) {
    throw new TypeError("postgres_connection_approval_resolver_store_required");
  }
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query(uow, text, values = []) { return execute(uow, { text, values }); },
  }));
  return async ({
    workspaceId,
    connectionId,
    requirementId,
    automationRevisionId = null,
    session,
    now,
  } = {}) => {
    required(workspaceId); required(connectionId); required(requirementId);
    return store.withTransaction(async (uow) => {
      const row = automationRevisionId === null
        ? (await sql.query(uow, `
        SELECT connection.connection_id, connection.enabled,
               connection.current_revision_number,
               revision.capability_key, revision.driver_key, revision.driver_backend,
               revision.credential_state, revision.credential_binding_fingerprint,
               revision.readiness_status, revision.validation_status,
               revision.validation_principal, revision.validation_scopes,
               revision.validation_effects, revision.validation_expires_at
          FROM public.workspace_connections connection
          JOIN public.workspace_connection_revisions revision
            ON revision.workspace_id = connection.workspace_id
           AND revision.connection_revision_id = connection.current_revision_id
         WHERE connection.workspace_id = $1 AND connection.connection_id = $2
         FOR SHARE OF connection, revision
      `, [workspaceId, connectionId])).rows[0]
        : (await sql.query(uow, `
        SELECT pin.requirement_id, pin.capability_key AS required_capability_key,
               connection.connection_id, connection.enabled,
               pin.connection_revision_number AS current_revision_number,
               revision.capability_key, revision.driver_key, revision.driver_backend,
               revision.credential_state, revision.credential_binding_fingerprint,
               revision.readiness_status, revision.validation_status,
               revision.validation_principal, revision.validation_scopes,
               revision.validation_effects, revision.validation_expires_at
          FROM public.automation_connection_pins pin
          JOIN public.workspace_connections connection
            ON connection.workspace_id = pin.workspace_id
           AND connection.connection_id = pin.connection_id
          JOIN public.workspace_connection_revisions revision
            ON revision.workspace_id = pin.workspace_id
           AND revision.connection_id = pin.connection_id
           AND revision.connection_revision_id = pin.connection_revision_id
           AND revision.revision_number = pin.connection_revision_number
         WHERE pin.workspace_id = $1
           AND pin.automation_revision_id = $2
           AND pin.connection_id = $3
           AND pin.requirement_id = $4
         FOR SHARE OF pin, connection, revision
      `, [workspaceId, automationRevisionId, connectionId, requirementId])).rows[0];
      if (!row || (automationRevisionId !== null
        && row.required_capability_key !== row.capability_key)) return null;
      return connectionApprovalSnapshot(connectionView(row), {
        requirementId,
        ...(now ? { now: Date.parse(now) } : {}),
      });
    }, session === undefined ? {} : { uow: session });
  };
}

async function automationResourceRefs({
  query,
  workspaceId,
  workflowId,
  automationRevisionId,
}) {
  const rows = (await query(`
    SELECT input_pin.resource_id, input_pin.resource_version,
           input_pin.resource_content_hash, resource.label
      FROM public.automation_input_pins input_pin
      JOIN public.workspace_resources resource
        ON resource.workspace_id = input_pin.workspace_id
       AND resource.resource_id = input_pin.resource_id
       AND resource.resource_version = input_pin.resource_version
       AND resource.content_hash = input_pin.resource_content_hash
     WHERE input_pin.workspace_id = $1
       AND input_pin.automation_revision_id = $2
       AND input_pin.workflow_id = $3
     ORDER BY input_pin.input_name, input_pin.input_pin_id
     FOR SHARE OF input_pin, resource
  `, [workspaceId, automationRevisionId, workflowId])).rows;
  return rows.map((row) => ({
    resourceId: row.resource_id,
    version: row.resource_version,
    label: row.label,
    contentHash: row.resource_content_hash,
  }));
}

function revisionView(row) {
  return {
    workflowId: row.workflow_id, revisionId: row.revision_id, contentHash: row.content_hash,
    graph: structuredClone(row.graph), inputForm: structuredClone(row.input_form),
    outputDefinition: structuredClone(row.output_definition), resourceRefs: structuredClone(row.resource_refs),
    runSettings: structuredClone(row.run_settings), definition: structuredClone(row.definition),
  };
}
function resourceView(row) {
  return { resourceId: row.resource_id, version: row.resource_version, objectId: row.object_id,
    contentHash: row.content_hash, label: row.label, mediaType: row.media_type,
    readiness: { status: row.readiness_status }, ...structuredClone(row.payload ?? {}) };
}
function connectionView(row) {
  return { connectionId: row.connection_id, revision: Number(row.current_revision_number),
    capabilityKey: row.capability_key, driverKey: row.driver_key, driverBackend: row.driver_backend,
    credentialState: row.credential_state, credentialBindingFingerprint: row.credential_binding_fingerprint,
    status: row.enabled === true ? row.readiness_status : "disabled",
    readiness: { status: row.readiness_status }, validation: { status: row.validation_status,
      principal: row.validation_principal, scopes: row.validation_scopes, effects: row.validation_effects,
      expiresAt: iso(row.validation_expires_at) } };
}
function connectionRequirements(plan) {
  return [...new Set((plan.steps ?? []).flatMap((step) => step?.capabilities?.connectionIds ?? [])
    .filter((value) => typeof value === 'string' && value.length))].sort();
}
function required(value) { if (typeof value !== 'string' || !value) throw unavailable(); }
function unavailable(code = 'workflow_execution_not_ready') { const error = new Error(code); error.code = code; return error; }
function iso(value) { return value == null ? null : new Date(value).toISOString(); }
