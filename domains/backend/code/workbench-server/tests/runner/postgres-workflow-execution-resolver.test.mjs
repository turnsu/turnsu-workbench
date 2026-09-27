import assert from "node:assert/strict";
import test from "node:test";
import { Check, SkillVersionSchema } from "@looloomi/workbench-contracts";

import { createPostgresWorkflowExecutionResolver } from "../../src/runner/index.mjs";

const HASH = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function scriptedStore(steps) {
  const remaining = [...steps];
  const store = {
    bindAdapter(factory) {
      return factory({
        execute: async (_uow, { text, values }) => {
          const step = remaining.shift();
          assert.ok(step, `unexpected PostgreSQL query: ${text}`);
          assert.match(text, step.match);
          assert.deepEqual(values, step.values);
          return { rows: step.rows ?? [] };
        },
      });
    },
    async withTransaction(work) { return work(Object.freeze({ kind: "postgres_unit_of_work" })); },
  };
  return { store, assertDrained: () => assert.equal(remaining.length, 0, "all PostgreSQL reads must be accounted for") };
}

test("PostgreSQL Workflow execution resolver assembles only ready pinned inputs and a governed Connection approval", async () => {
  const plan = {
    workflowId: "workflow-alpha",
    workflowRevisionId: "workflow-revision-1",
    pinnedSkills: [{ skillId: "skill-alpha", version: "1.0.0" }],
    steps: [{ capabilities: { connectionIds: ["calendar-read"] } }],
  };
  const fixture = scriptedStore([
    {
      match: /FROM public\.workflows workflow[\s\S]*workflow\.workflow_id = \$1 AND revision\.revision_id = \$2/,
      values: ["workflow-alpha", "workflow-revision-1"],
      rows: [{
        workspace_id: "workspace-alpha", scope_id: "scope-alpha", workflow_id: "workflow-alpha",
        revision_id: "workflow-revision-1", content_hash: HASH, graph: {}, input_form: {},
        output_definition: {}, resource_refs: [], run_settings: {}, definition: {},
      }],
    },
    {
      match: /FROM public\.compile_results result[\s\S]*result\.workflow_revision_id = \$3/,
      values: ["workspace-alpha", "workflow-alpha", "workflow-revision-1"],
      rows: [{ compile_result_id: "compile-1", status: "ready", plan_id: "plan-1", plan_document: plan }],
    },
    {
      match: /FROM public\.skill_versions[\s\S]*version.skill_id = \$2 AND version.version = \$3/,
      values: ["workspace-alpha", "skill-alpha", "1.0.0"],
      rows: [{
        skill_version_id: "skill-version-1", skill_id: "skill-alpha", version: "1.0.0", content_hash: HASH,
        schema_version: "workbench-v1", workspace_id: "workspace-alpha", package_hash: HASH, package_object_id: "package-1",
        published_at: "2026-09-21T06:00:00.000Z", published_by_user_id: "alice",
        source_execution_ref: { capabilityId: "catalog-calendar", taskIntent: "read", adapterVersion: "1.0.0", executionMode: "deterministic" },
        definition: { name: "Calendar", description: "Read calendar", category: "data", manifest: {},
          inputSchema: { type: "object" }, outputSchema: { type: "object" },
          risk: { level: "low", externalAction: false, summary: "Read only" }, dependencies: [], connectionRequirements: [],
          validation: { validationId: "validation-1", status: "passed", diagnostics: [], testedAt: "2026-09-21T06:00:00.000Z" } },
      }],
    },
    {
      match: /FROM public\.workspace_connection_bindings binding[\s\S]*binding\.requirement_id = \$4/,
      values: ["workspace-alpha", "workflow-alpha", "workflow-revision-1", "calendar-read"],
      rows: [{
        requirement_id: "calendar-read", connection_id: "connection-calendar", enabled: true,
        current_revision_number: 3, capability_key: "calendar-read", driver_key: "lark",
        driver_backend: "production", credential_state: "bound", credential_binding_fingerprint: HASH,
        readiness_status: "connected", validation_status: "valid", validation_principal: "principal-alpha",
        validation_scopes: ["calendar:read"], validation_effects: ["read"],
        validation_expires_at: "2030-01-01T00:00:00.000Z",
      }],
    },
  ]);

  const resolveExecution = createPostgresWorkflowExecutionResolver({ store: fixture.store });
  const result = await resolveExecution({ workflowId: "workflow-alpha", revisionId: "workflow-revision-1" });

  assert.equal(result.workspaceId, "workspace-alpha");
  assert.equal(result.compileResultId, "compile-1");
  assert.equal(result.skillVersions.length, 1);
  assert.equal(result.skillVersions[0].skillVersionId, "skill-version-1");
  assert.equal(Check(SkillVersionSchema, result.skillVersions[0]), true);
  assert.deepEqual(result.connectionIds, ["connection-calendar"]);
  assert.equal(result.connectionBindings[0].connectionRevision, 3);
  assert.equal(result.connectionBindings[0].requirementId, "calendar-read");
  fixture.assertDrained();
});

test("PostgreSQL Workflow execution resolver rejects disabled or unready Connection bindings", async () => {
  const fixture = scriptedStore([
    {
      match: /FROM public\.workflows workflow/,
      values: ["workflow-alpha", "workflow-revision-1"],
      rows: [{
        workspace_id: "workspace-alpha", scope_id: "scope-alpha", workflow_id: "workflow-alpha",
        revision_id: "workflow-revision-1", content_hash: HASH, graph: {}, input_form: {},
        output_definition: {}, resource_refs: [], run_settings: {}, definition: {},
      }],
    },
    {
      match: /FROM public\.compile_results result/,
      values: ["workspace-alpha", "workflow-alpha", "workflow-revision-1"],
      rows: [{
        compile_result_id: "compile-1", status: "ready", plan_id: "plan-1",
        plan_document: {
          workflowId: "workflow-alpha", workflowRevisionId: "workflow-revision-1", pinnedSkills: [],
          steps: [{ capabilities: { connectionIds: ["calendar-read"] } }],
        },
      }],
    },
    {
      match: /FROM public\.workspace_connection_bindings binding/,
      values: ["workspace-alpha", "workflow-alpha", "workflow-revision-1", "calendar-read"],
      rows: [{
        requirement_id: "calendar-read", connection_id: "connection-calendar", enabled: false,
        current_revision_number: 3, capability_key: "calendar-read", driver_key: "lark",
        driver_backend: "production", credential_state: "bound", credential_binding_fingerprint: HASH,
        readiness_status: "connected", validation_status: "valid", validation_principal: "principal-alpha",
        validation_scopes: ["calendar:read"], validation_effects: ["read"],
        validation_expires_at: "2030-01-01T00:00:00.000Z",
      }],
    },
  ]);
  const resolveExecution = createPostgresWorkflowExecutionResolver({ store: fixture.store });
  await assert.rejects(
    resolveExecution({ workflowId: "workflow-alpha", revisionId: "workflow-revision-1" }),
    (error) => error?.code === "connection_not_ready",
  );
  fixture.assertDrained();
});
