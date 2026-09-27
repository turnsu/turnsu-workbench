import assert from "node:assert/strict";
import test from "node:test";

import { Check, CompileResultSchema } from "@looloomi/workbench-contracts";
import {
  createExecutionResolver,
  createWorkbenchApplication,
} from "../../src/application/workbench-application.mjs";
import { connectionApprovalSnapshot } from "../../src/connections/workspace-connection-service.mjs";
import { makeResolver, makeRevision } from "../compiler/fixtures.mjs";

function withIdempotency(store) {
  store.getWorkflow ??= async (workflowId) => ({
    workflow: {
      workflowId,
      workspaceId: "workspace-local",
      ownerId: "user-local",
      visibility: "private",
    },
    etag: `"${workflowId}"`,
  });
  const records = new Map();
  store.runIdempotentMutation = async ({ scope, key, request }, mutation) => {
    const id = scope + ":" + key;
    const requestJson = JSON.stringify(request);
    const existing = records.get(id);
    if (existing) {
      if (existing.requestJson !== requestJson) {
        const error = new Error("idempotency_key_reused");
        error.code = "idempotency_key_reused";
        throw error;
      }
      return structuredClone(existing.response);
    }
    const response = await mutation({ id: "test-session" });
    records.set(id, { requestJson, response: structuredClone(response) });
    return response;
  };
  return store;
}

const publishedVersionFromDefinition = (definition) => ({
  schemaVersion: "workbench-v1",
  skillVersionId: `skill-version-${definition.skillId}-${definition.version}`,
  skillId: definition.skillId,
  workspaceId: "workspace-local",
  version: definition.version,
  name: definition.name,
  description: definition.description,
  category: definition.category,
  inputSchema: structuredClone(definition.inputSchema),
  outputSchema: structuredClone(definition.outputSchema),
  risk: structuredClone(definition.risk),
  dependencies: structuredClone(definition.dependencies),
  validation: {
    validationId: `validation-${definition.skillId}-${definition.version}`,
    status: "passed",
    diagnostics: [],
    testedAt: definition.updatedAt,
  },
  executionRef: structuredClone(definition.executionRef),
  publishedBy: "user-local",
  publishedAt: definition.updatedAt,
});

const governedSkillRepositories = (definitionFor) => ({
  skillAssets: {
    async get(skillId) {
      const version = publishedVersionFromDefinition(definitionFor(skillId, "1.0.0"));
      return {
        skillId,
        workspaceId: "workspace-local",
        ownerId: "user-local",
        visibility: "private",
        lifecycle: "published",
        latestPublishedVersionId: version.skillVersionId,
      };
    },
  },
  skillVersions: {
    async getBySkillRef(skillId, version) {
      return publishedVersionFromDefinition(definitionFor(skillId, version));
    },
  },
  skills: { async get() { throw new Error("legacy_skill_definition_must_not_be_used"); } },
});

test("compile prefetches SkillDefinition and runtime probe, then persists only server-derived readiness", async () => {
  const revision = makeRevision();
  const resolver = makeResolver();
  const persisted = { results: [], plans: [] };
  const store = withIdempotency({
    async connect() {},
    repositories: {
      workflowRevisions: { async get() { return structuredClone(revision); } },
      ...governedSkillRepositories((skillId, version) => (
        resolver.resolveSkill({ skillId, version }).definition
      )),
      compileResults: { async insert(value) { persisted.results.push(value); return value; } },
      executionPlans: { async insert(planId, value) { persisted.plans.push({ planId, value }); return value; } },
      workflows: { async updateCompileSummary(workflowId, summary) { persisted.workflow = { workflowId, summary }; } },
    },
  });
  const runtime = {
    async probeSkill() { return { status: "ready", ready: true, code: "ready" }; },
  };
  const application = createWorkbenchApplication({
    store,
    agentRuntime: runtime,
    clock: () => "2026-07-10T10:00:00.000Z",
    idFactory: (kind) => `${kind}-test-1`,
  });

  const result = await application.compileWorkflow({
    workflowId: revision.workflowId,
    idempotencyKey: "compile-ready-1",
    request: { data: { workflowRevisionId: revision.revisionId } },
  });
  const replay = await application.compileWorkflow({
    workflowId: revision.workflowId,
    idempotencyKey: "compile-ready-1",
    request: { data: { workflowRevisionId: revision.revisionId } },
  });
  await assert.rejects(
    () => application.compileWorkflow({
      workflowId: revision.workflowId,
      idempotencyKey: "compile-ready-1",
      request: { data: { workflowRevisionId: "revision-conflict" } },
    }),
    (error) => error?.code === "idempotency_key_reused",
  );

  assert.equal(Check(CompileResultSchema, result), true);
  assert.deepEqual(replay, result);
  assert.equal(result.status, "ready");
  assert.equal(persisted.results.length, 1);
  assert.equal(persisted.plans.length, 1);
  assert.equal(persisted.plans[0].planId, "plan-test-1");
  assert.equal(persisted.workflow.summary.status, "ready");
});

test("application compile freezes the async Catalog route into the immutable plan", async () => {
  const revision = makeRevision();
  const resolver = makeResolver();
  const definitionFor = (skillId, version) => {
    const definition = structuredClone(resolver.resolveSkill({ skillId, version }).definition);
    definition.executionRef.executionMode = "agent";
    return definition;
  };
  const definition = definitionFor("skill-research-b", "1.0.0");
  const persisted = { plans: [] };
  const store = withIdempotency({
    async connect() {},
    repositories: {
      workflowRevisions: { async get() { return structuredClone(revision); } },
      ...governedSkillRepositories(definitionFor),
      compileResults: { async insert(value) { return value; } },
      executionPlans: {
        async insert(_planId, value) { persisted.plans.push(structuredClone(value)); return value; },
      },
      workflows: { async updateCompileSummary() {} },
    },
  });
  const seen = [];
  const application = createWorkbenchApplication({
    store,
    agentRuntime: { async probeSkill() { return { status: "ready", ready: true, code: "ready" }; } },
    modelCatalog: {
      async getWorkspacePolicy(workspaceId, context) {
        assert.equal(context?.userId, "user-local");
        return {
          defaultProfileIdsByCapability: { tool_calling: "model-profile-controller" },
          workflowFallbackAllowed: false,
        };
      },
      async resolveCurrentProfile(input) {
        assert.equal(input.userId, "user-local");
        seen.push(structuredClone(input));
        return {
          profile: { profileId: input.profileId },
          revision: {
            revisionId: "model-revision-controller-1",
            capabilities: ["chat", "tool_calling"],
            protocol: "openai_compatible_chat",
            limits: { kind: "chat", maxInputTokens: 128_000, maxOutputTokens: 8_192 },
          },
          readiness: { state: "ready" },
        };
      },
    },
    clock: () => "2026-07-10T10:00:00.000Z",
    idFactory: (kind) => `${kind}-model-route`,
  });
  const result = await application.compileWorkflow({
    workflowId: revision.workflowId,
    idempotencyKey: "compile-model-route-1",
    request: { data: { workflowRevisionId: revision.revisionId } },
  });

  assert.equal(result.status, "ready", JSON.stringify(result.warnings));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].capabilities, ["chat", "tool_calling"]);
  const step = result.executionPlan.steps.find((item) => item.kind === "Skill");
  assert.equal(step.executionMode, "bounded_agent");
  assert.equal(step.modelProfileRevisionId, "model-revision-controller-1");
  assert.deepEqual(step.parameterSchema, definition.inputSchema);
  assert.equal(persisted.plans[0].steps.find((item) => item.kind === "Skill").modelProfileRevisionId,
    "model-revision-controller-1");
});

test("application compile records an unavailable Catalog revision as blocked", async () => {
  const revision = makeRevision();
  const resolver = makeResolver();
  const definitionFor = (skillId, version) => {
    const definition = structuredClone(resolver.resolveSkill({ skillId, version }).definition);
    definition.executionRef.executionMode = "agent";
    return definition;
  };
  const store = withIdempotency({
    async connect() {},
    repositories: {
      workflowRevisions: { async get() { return structuredClone(revision); } },
      ...governedSkillRepositories(definitionFor),
      compileResults: { async insert(value) { return value; } },
      executionPlans: { async insert() { throw new Error("blocked_plan_must_not_persist"); } },
      workflows: { async updateCompileSummary(_workflowId, summary) { store.status = summary.status; } },
    },
  });
  const application = createWorkbenchApplication({
    store,
    agentRuntime: { async probeSkill() { return { status: "ready", ready: true, code: "ready" }; } },
    modelCatalog: {
      async getWorkspacePolicy() {
        return { defaultProfileIdsByCapability: { tool_calling: "model-profile-controller" } };
      },
      async resolveCurrentProfile() {
        const error = new Error("credential missing");
        error.code = "model_revision_unavailable";
        throw error;
      },
    },
    clock: () => "2026-07-10T10:00:00.000Z",
  });
  const result = await application.compileWorkflow({
    workflowId: revision.workflowId,
    idempotencyKey: "compile-model-route-blocked",
    request: { data: { workflowRevisionId: revision.revisionId } },
  });
  assert.equal(result.status, "blocked");
  assert.equal(store.status, "blocked");
  assert.ok(result.warnings.some((entry) => entry.code === "model_revision_unavailable"));
});

test("compile blocks a Skill when the runtime probe is unavailable even when stored readiness says ready", async () => {
  const revision = makeRevision();
  const resolver = makeResolver();
  const store = withIdempotency({
    async connect() {},
    repositories: {
      workflowRevisions: { async get() { return structuredClone(revision); } },
      ...governedSkillRepositories((skillId, version) => (
        resolver.resolveSkill({ skillId, version }).definition
      )),
      compileResults: { async insert(value) { return value; } },
      executionPlans: { async insert() { throw new Error("must not persist blocked plan"); } },
      workflows: { async updateCompileSummary(_workflowId, summary) { store.derivedStatus = summary.status; } },
    },
  });
  const application = createWorkbenchApplication({
    store,
    agentRuntime: { async probeSkill() { return { status: "blocked", ready: false, code: "offline" }; } },
    clock: () => "2026-07-10T10:00:00.000Z",
  });
  const result = await application.compileWorkflow({
    workflowId: revision.workflowId,
    idempotencyKey: "compile-blocked-1",
    request: { data: { workflowRevisionId: revision.revisionId } },
  });
  assert.equal(result.status, "blocked");
  assert.equal(store.derivedStatus, "blocked");
  assert.ok(result.unavailableSkills.some((entry) => entry.reason.includes("offline")));
});

test("compile prefers an immutable published SkillVersion over the mutable compatibility catalog", async () => {
  const revision = makeRevision();
  const resolver = makeResolver();
  const publishedVersion = (skillRef) => {
    const definition = resolver.resolveSkill(skillRef).definition;
    return {
      schemaVersion: "workbench-v1",
      skillVersionId: `skill-version-${definition.skillId}-${definition.version}`,
      skillId: definition.skillId,
      workspaceId: "workspace-local",
      version: definition.version,
      name: definition.name,
      description: definition.description,
      category: definition.category,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      risk: definition.risk,
      dependencies: definition.dependencies,
      validation: { validationId: "validation-a-1", status: "passed", diagnostics: [], testedAt: "2026-07-10T10:00:00.000Z" },
      executionRef: definition.executionRef,
      publishedAt: "2026-07-10T10:00:00.000Z",
    };
  };
  const store = withIdempotency({
    async connect() {},
    repositories: {
      workflowRevisions: { async get() { return structuredClone(revision); } },
      skillVersions: { async getBySkillRef(skillId, version) { return structuredClone(publishedVersion({ skillId, version })); } },
      skillAssets: {
        async get(skillId) {
          const version = publishedVersion({ skillId, version: "1" });
          return {
            skillId,
            workspaceId: "workspace-local",
            ownerId: "user-local",
            visibility: "private",
            lifecycle: "published",
            latestPublishedVersionId: version.skillVersionId,
          };
        },
      },
      skills: { async get() { throw new Error("mutable_catalog_must_not_be_used"); } },
      compileResults: { async insert(value) { return value; } },
      executionPlans: { async insert() { return null; } },
      workflows: { async updateCompileSummary() {} },
    },
  });
  const application = createWorkbenchApplication({
    store,
    agentRuntime: { async probeSkill() { return { status: "ready", ready: true, code: "ready" }; } },
    clock: () => "2026-07-10T10:00:00.000Z",
  });
  const result = await application.compileWorkflow({
    workflowId: revision.workflowId,
    idempotencyKey: "compile-published-skill-1",
    request: { data: { workflowRevisionId: revision.revisionId } },
  });
  assert.equal(result.status, "ready", JSON.stringify(result.unavailableSkills));
  assert.equal(result.executionPlan.pinnedSkills.length, 1);
});

test("compile never falls back to a legacy SkillDefinition without a governed asset", async () => {
  const revision = makeRevision();
  let legacyRead = false;
  const store = withIdempotency({
    async connect() {},
    repositories: {
      workflowRevisions: { async get() { return structuredClone(revision); } },
      skillAssets: { async get() { return null; } },
      skillVersions: { async getBySkillRef() { throw new Error("version_lookup_must_not_run_without_asset"); } },
      skills: { async get() { legacyRead = true; return {}; } },
      compileResults: { async insert() { throw new Error("compile_result_must_not_persist"); } },
      executionPlans: { async insert() { throw new Error("execution_plan_must_not_persist"); } },
      workflows: { async updateCompileSummary() { throw new Error("workflow_must_not_update"); } },
    },
  });
  const application = createWorkbenchApplication({
    store,
    agentRuntime: { async probeSkill() { return { status: "ready", ready: true }; } },
  });

  await assert.rejects(
    () => application.compileWorkflow({
      workflowId: revision.workflowId,
      idempotencyKey: "compile-legacy-definition-denied",
      request: { data: { workflowRevisionId: revision.revisionId } },
    }),
    (error) => error?.code === "skill_not_found",
  );
  assert.equal(legacyRead, false);
});

test("execution resolver returns only the saved revision, latest ready plan, and pinned Skill versions", async () => {
  const revision = makeRevision();
  const definition = makeResolver().resolveSkill({ skillId: "skill-a", version: "1" }).definition;
  const executionPlan = {
    workflowId: revision.workflowId,
    workflowRevisionId: revision.revisionId,
    pinnedSkills: [{ skillId: definition.skillId, version: definition.version }],
    steps: [{
      capabilities: {
        connectionIds: ["lark.calendar.read"],
      },
    }],
  };
  const currentConnection = {
    connectionId: "connection-calendar",
    workspaceId: "workspace-local",
    revision: 7,
    capabilityKey: "lark.calendar.read",
    driverKey: "lark",
    credentialState: "bound",
    credentialBindingFingerprint: `sha256:${"a".repeat(64)}`,
    driverBackend: "production",
    status: "connected",
    validation: {
      status: "valid",
      principal: "calendar-account-1",
      scopes: ["calendar:read"],
      effects: ["read"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  let connected = false;
  const store = {
    async connect() { connected = true; },
    repositories: {
      workflowRevisions: { async get() { return revision; } },
      compileResults: { async getLatest() { return { status: "ready", executionPlan }; } },
      skillVersions: {
        async getBySkillRef() { return publishedVersionFromDefinition(definition); },
      },
      skills: { async get() { throw new Error("legacy_skill_definition_must_not_be_used"); } },
      workflows: { async getInternal() { return { workspaceId: "workspace-local" }; } },
      connections: {
        async get(connectionId, { workspaceId }) {
          assert.equal(connectionId, "connection-calendar");
          assert.equal(workspaceId, "workspace-local");
          return structuredClone(currentConnection);
        },
      },
      connectionBindings: {
        async listByTarget({ workspaceId, targetKind, targetId }) {
          assert.equal(workspaceId, "workspace-local");
          assert.equal(targetKind, "workflow_revision");
          assert.equal(targetId, revision.revisionId);
          return [
            { requirementId: "lark.calendar.read", connectionId: "connection-calendar" },
          ];
        },
      },
    },
  };
  const resolveExecution = createExecutionResolver({ store });
  const resolved = await resolveExecution({
    workflowId: revision.workflowId,
    revisionId: revision.revisionId,
  });
  assert.equal(connected, true);
  assert.equal(resolved.revision.revisionId, revision.revisionId);
  assert.deepEqual(resolved.compileResult.executionPlan, executionPlan);
  const resolvedSkill = resolved.skills.get(`${definition.skillId}:${definition.version}`);
  assert.equal(resolvedSkill.definition.skillId, definition.skillId);
  assert.equal(resolvedSkill.definition.version, definition.version);
  assert.deepEqual(resolvedSkill.executionRef, definition.executionRef);
  assert.deepEqual(resolved.connectionBindings, [connectionApprovalSnapshot(currentConnection, {
    requirementId: "lark.calendar.read",
  })]);
  assert.deepEqual(resolved.connectionIds, ["connection-calendar"]);
});

test("execution resolver rejects missing or non-ready compile results", async () => {
  const revision = makeRevision();
  const store = {
    async connect() {},
    repositories: {
      workflowRevisions: { async get() { return revision; } },
      compileResults: { async getLatest() { return { status: "blocked" }; } },
      skills: { async get() { throw new Error("must not resolve skills"); } },
    },
  };
  const resolveExecution = createExecutionResolver({ store });
  await assert.rejects(
    () => resolveExecution({ workflowId: revision.workflowId, revisionId: revision.revisionId }),
    (error) => error?.code === "workflow_execution_not_ready",
  );
});
