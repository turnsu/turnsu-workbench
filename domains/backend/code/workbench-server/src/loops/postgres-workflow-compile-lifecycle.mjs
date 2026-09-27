import { compileWorkflowV1 } from "../compiler/compile-workflow-v1.mjs";
import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash } from "../store/serialization.mjs";
import { requireWorkflowReferences } from "./postgres-workflow-references.mjs";

const memberRank = Object.freeze({ viewer: 0, member: 1, admin: 2, owner: 3 });

/**
 * PostgreSQL owner for compiling a canonical Loop revision and atomically
 * fixing the exact model revisions consumed by its execution plan.
 */
export class PostgresWorkflowCompileLifecycle {
  constructor({ store, clock = () => new Date().toISOString(), idFactory, modelCatalog = null, probeSkill = null } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof idFactory !== "function") {
      throw new TypeError("postgres_workflow_compile_lifecycle_dependencies_invalid");
    }
    this.store = store; this.clock = clock; this.idFactory = idFactory;
    this.modelCatalog = modelCatalog; this.probeSkill = probeSkill;
    this.sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async compileWorkflow({ workflowId, revisionId, idempotencyKey, request, workspaceId, compiledBy } = {}) {
    for (const [value, code] of [[workflowId, "workflow_id_required"], [revisionId, "workflow_revision_id_required"], [idempotencyKey, "idempotency_key_required"], [workspaceId, "workspace_id_required"], [compiledBy, "user_id_required"]]) required(value, code);
    const requestHash = canonicalRequestHash(request);
    const operationScope = `compile-workflow:${workflowId}`;
    return this.store.withTransaction(async (uow) => {
      const query = (text, values) => this.sql.query(uow, text, values);
      const membership = (await query(`SELECT role FROM public.workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' FOR SHARE`, [workspaceId, compiledBy])).rows[0];
      if (!membership || memberRank[membership.role] < memberRank.member) throw coded("workflow_compile_forbidden");
      const existing = (await query(`SELECT request_hash, response FROM public.product_idempotency_receipts WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 FOR UPDATE`, [workspaceId, compiledBy, operationScope, idempotencyKey])).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw coded("idempotency_key_reused");
        if (!existing.response) throw coded("idempotency_record_incomplete");
        return structuredClone(existing.response);
      }
      const workflow = (await query(`SELECT * FROM public.workflows WHERE workspace_id = $1 AND workflow_id = $2 FOR UPDATE`, [workspaceId, workflowId])).rows[0];
      if (!workflow || workflow.owner_user_id !== compiledBy) throw coded("workflow_not_found");
      if (workflow.current_revision_id !== revisionId) throw coded("workflow_revision_conflict");
      const revisionRow = (await query(`SELECT * FROM public.workflow_revisions WHERE workspace_id = $1 AND workflow_id = $2 AND revision_id = $3 FOR SHARE`, [workspaceId, workflowId, revisionId])).rows[0];
      if (!revisionRow) throw coded("workflow_revision_not_found");
      const revision = revisionView(revisionRow);
      const references = await requireWorkflowReferences({ query, workspaceId, userId: compiledBy, revision });
      const options = await compilationOptions({ revision, references, workspaceId, userId: compiledBy,
        modelCatalog: this.modelCatalog, probeSkill: this.probeSkill });
      const now = iso(this.clock());
      const compileResult = compileWorkflowV1(revision, {
        compiledAt: now,
        ...options,
      });
      const compileResultId = this.idFactory("compile-result");
      const planId = compileResult.status === "ready" ? this.idFactory("plan") : null;
      await query(`INSERT INTO public.product_idempotency_receipts (workspace_id, effective_principal_id, operation_scope, idempotency_key, request_hash, response, created_at, completed_at) VALUES ($1, $2, $3, $4, $5, NULL, $6::timestamptz, NULL)`, [workspaceId, compiledBy, operationScope, idempotencyKey, requestHash, now]);
      await query("SET CONSTRAINTS ALL DEFERRED");
      await query(`INSERT INTO public.compile_results (workspace_id, compile_result_id, workflow_id, workflow_revision_id, schema_version, status, execution_plan_id, ordered_steps, required_run_inputs, missing_bindings, missing_resources, unavailable_skills, orphan_node_ids, unreachable_node_ids, invalid_cycles, port_schema_mismatches, review_gates, output_nodes, warnings, recovery_actions, compiled_at, payload) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb, $20::timestamptz, '{}'::jsonb)`, [workspaceId, compileResultId, workflowId, revisionId, compileResult.status, planId, JSON.stringify(compileResult.orderedSteps), JSON.stringify(compileResult.requiredRunInputs), JSON.stringify(compileResult.missingBindings), JSON.stringify(compileResult.missingResources), JSON.stringify(compileResult.unavailableSkills), JSON.stringify(compileResult.orphanNodeIds), JSON.stringify(compileResult.unreachableNodeIds), JSON.stringify(compileResult.invalidCycles), JSON.stringify(compileResult.portSchemaMismatches), JSON.stringify(compileResult.reviewGates), JSON.stringify(compileResult.outputNodes), JSON.stringify(compileResult.warnings), JSON.stringify(compileResult.recoveryActions), now]);
      if (planId) {
        const plan = compileResult.executionPlan;
        await query(`INSERT INTO public.execution_plans (workspace_id, plan_id, compile_result_id, workflow_id, workflow_revision_id, schema_version, plan_version, content_hash, model_routing_state, plan_document, generated_at, payload) VALUES ($1, $2, $3, $4, $5, $6, 2, $7, $8, $9::jsonb, $10::timestamptz, '{}'::jsonb)`, [workspaceId, planId, compileResultId, workflowId, revisionId, plan.schemaVersion, plan.contentHash, plan.modelRoutingState, JSON.stringify(plan), now]);
        for (const step of plan.steps) {
          if (!step.modelProfileRevisionId) continue;
          const revisions = [step.modelProfileRevisionId, ...(step.fallbackModelProfileRevisionIds ?? [])];
          for (const [ordinal, modelRevisionId] of revisions.entries()) {
            await query(`INSERT INTO public.execution_plan_model_pins
              (workspace_id, plan_id, node_id, pin_role, ordinal, model_profile_revision_id, schema_version, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, 'workbench-internal-v1', $7::timestamptz)`,
            [workspaceId, planId, step.nodeId, ordinal === 0 ? "primary" : "fallback", ordinal, modelRevisionId, now]);
          }
        }
        await query(`UPDATE public.execution_plans SET pins_finalized = true WHERE workspace_id = $1 AND plan_id = $2 AND pins_finalized = false`, [workspaceId, planId]);
      }
      const ready = compileResult.status === "ready";
      await query(`UPDATE public.workflows SET status = $3, lifecycle = $4, latest_compile_result_id = $5, updated_at = $6::timestamptz WHERE workspace_id = $1 AND workflow_id = $2 AND current_revision_id = $7`, [workspaceId, workflowId, ready ? "ready" : "blocked", ready ? "ready" : "blocked", compileResultId, now, revisionId]);
      const response = { ...compileResult, compileResultId, ...(planId ? { executionPlanId: planId } : {}) };
      await query(`UPDATE public.product_idempotency_receipts SET response = $6::jsonb, completed_at = $7::timestamptz WHERE workspace_id = $1 AND effective_principal_id = $2 AND operation_scope = $3 AND idempotency_key = $4 AND request_hash = $5`, [workspaceId, compiledBy, operationScope, idempotencyKey, requestHash, JSON.stringify(response), now]);
      return response;
    });
  }
}

function revisionView(row) {
  return {
    schemaVersion: row.schema_version, revisionId: row.revision_id, workflowId: row.workflow_id,
    revisionNumber: Number(row.revision_number), baseRevisionId: row.base_revision_id ?? null,
    graph: structuredClone(row.graph), inputForm: structuredClone(row.input_form), outputDefinition: structuredClone(row.output_definition),
    resourceRefs: structuredClone(row.resource_refs ?? []), runSettings: structuredClone(row.run_settings), definition: row.definition == null ? null : structuredClone(row.definition),
    contentHash: row.content_hash, authoredBy: row.authored_by, saveReason: row.save_reason,
    compile: { status: "blocked", diagnostics: [] },
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
async function compilationOptions({ revision, references, workspaceId, userId, modelCatalog, probeSkill }) {
  const resolvedSkills = new Map();
  for (const [key, skill] of references.skills) {
    let probe;
    try { if (skill.canExecute && skill.definition) probe = await probeSkill?.(skill.definition.executionRef, { workspaceId }); } catch {}
    const readiness = skill.canExecute && (probe?.ready === true || probe?.status === "ready")
      ? { status: "ready" } : { status: "blocked", reason: !skill.canExecute ? "You do not have permission to execute this Skill." : "The pinned Skill runtime is unavailable." };
    resolvedSkills.set(key, { definition: skill.definition, toolActions: skill.toolActions,
      adapterReadiness: readiness, piReadiness: readiness });
  }
  const policy = references.skills.size ? await modelCatalog?.getWorkspacePolicy?.(workspaceId, { userId }) : null;
  const modelSelections = {
    agentControllerModelProfileId: policy?.defaultProfileIdsByCapability?.tool_calling ?? policy?.defaultProfileIdsByCapability?.chat,
    imageGenerationModelProfileId: policy?.defaultProfileIdsByCapability?.image_generation,
    workflowFallbackAllowed: policy?.workflowFallbackAllowed === true,
  };
  const routes = new Map();
  for (const node of revision.graph.nodes) {
    if (node.kind !== "Skill") continue;
    const skill = references.skills.get(`${node.skillRef.skillId}:${node.skillRef.version}`)?.definition;
    const mode = skill?.executionRef?.executionMode;
    if (!["agent", "orchestrator", "model"].includes(mode)) continue;
    const capability = mode === "model" ? skill.executionRef.requiredModelCapability : "tool_calling";
    const setting = capability === "image_generation" ? "imageGenerationModelProfileId" : "agentControllerModelProfileId";
    const profileId = node.configuration?.modelProfileId ?? revision.runSettings?.[setting] ?? modelSelections[setting];
    if (!profileId || !modelCatalog) continue;
    try {
      const resolved = await modelCatalog.resolveCurrentProfile({ profileId, workspaceId, userId,
        capabilities: mode === "model" ? [capability] : ["chat", "tool_calling"], requireReady: true });
      routes.set(node.nodeId, { profileId, revision: resolved.revision, fallbackRevisions: [] });
    } catch (error) { routes.set(node.nodeId, { errorCode: error?.code ?? "model_route_unresolved" }); }
  }
  return {
    modelSelections,
    modelResolver({ nodeId }) {
      const route = routes.get(nodeId);
      if (route?.errorCode) throw coded(route.errorCode);
      return route ?? null;
    },
    resolver: {
      resolveSkill: (ref) => resolvedSkills.get(`${ref.skillId}:${ref.version}`) ?? null,
      resolveResource: (ref) => ({ readiness: { status: references.resources.get(ref.resourceId)?.ready ? "ready" : "blocked" } }),
    },
  };
}
function required(value, code) { if (typeof value !== "string" || !value.trim()) throw coded(code); }
function iso(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_workflow_compile_clock_invalid"); return date.toISOString(); }
function coded(code) { return new ProductStoreError(code, code); }
