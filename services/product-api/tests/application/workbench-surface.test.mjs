import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const NOW = "2026-07-25T00:00:00.000Z";

function createSurfaceStore() {
  const skill = {
    schemaVersion: "workbench-v1",
    skillId: "skill-surface",
    version: "1.0.0",
    name: "Surface Skill",
    description: "A Skill used to verify the workspace surface.",
    category: "testing",
    display: { defaultLocale: "en", localized: { en: { name: "Surface Skill", description: "A Skill used to verify the workspace surface." } } },
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    risk: { level: "low", externalAction: false, summary: "No external actions." },
    dependencies: [],
    setupChecks: [],
    executionRef: { capabilityId: "surface", taskIntent: "test", adapterVersion: "1.0.0", executionMode: "deterministic" },
    usageCount: 0,
    readiness: { status: "ready", diagnostics: [] },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    async connect() {},
    async authorizeWorkspace() { return { role: "owner" }; },
    repositories: {
      workspaces: { async get() { return { name: "Surface workspace" }; } },
      skills: { async list() { return [skill]; } },
    },
  };
}

test("workspace bootstrap and Skill catalog expose their contract-safe capabilities", async () => {
  const application = createWorkbenchApplication({
    store: createSurfaceStore(),
    agentProposalService: {},
    clock: () => NOW,
  });
  const auth = { userId: "user-surface", activeWorkspaceId: "workspace-surface" };

  const workspace = await application.workspace({ auth });
  const skills = await application.listSkills({ auth });

  assert.equal(workspace.workspace.capabilities.builderProposal, true);
  assert.equal(skills.data[0].execution.executionMode, "deterministic");
  assert.equal("executionRef" in skills.data[0], false);
  assert.equal("status" in skills.data[0], false);
  assert.equal(skills.data[0].readiness.status, "ready");
});

test("model catalog operations fail closed instead of falling back to an execution service", async () => {
  const application = createWorkbenchApplication({
    store: createSurfaceStore(),
    modelService: {
      async listModels() {
        return [{ profileId: "legacy-model-that-must-not-leak" }];
      },
    },
    agentTurnRunner: {
      async selectModel() {
        throw new Error("selection_must_not_reach_runner");
      },
    },
    clock: () => NOW,
  });
  const auth = { userId: "user-surface", activeWorkspaceId: "workspace-surface" };

  await assert.rejects(
    application.listModelProfiles({ auth }),
    (error) => error.code === "model_catalog_unavailable",
  );
  await assert.rejects(
    application.selectAgentSessionModel({
      sessionId: "agent-session-surface",
      idempotencyKey: "select-model-surface",
      request: {
        schemaVersion: "workbench-api-v1",
        data: { modelProfileId: "model-profile-chat" },
      },
      auth,
    }),
    (error) => error.code === "model_catalog_unavailable",
  );
});

test("model catalog pagination uses a stable display-name and profile-id cursor", async () => {
  const profiles = [
    { profileId: "model-a", displayName: "Alpha", readiness: "ready", selectable: true, currentRevisionId: "revision-a" },
    { profileId: "model-b", displayName: "Beta", readiness: "ready", selectable: true, currentRevisionId: "revision-b" },
    { profileId: "model-c", displayName: "Beta", readiness: "ready", selectable: true, currentRevisionId: "revision-c" },
  ];
  const application = createWorkbenchApplication({
    store: createSurfaceStore(),
    modelCatalog: {
      async listProfiles() { return structuredClone(profiles); },
    },
    clock: () => NOW,
  });
  const auth = { userId: "user-surface", activeWorkspaceId: "workspace-surface" };

  const first = await application.listModelProfiles({ query: { limit: 2 }, auth });
  const second = await application.listModelProfiles({
    query: { limit: 2, cursor: first.page.nextCursor },
    auth,
  });

  assert.deepEqual(first.data.map((profile) => profile.profileId), ["model-a", "model-b"]);
  assert.equal(first.page.hasMore, true);
  assert.deepEqual(second.data.map((profile) => profile.profileId), ["model-c"]);
  assert.equal(second.page.hasMore, false);
  const exact = await application.listModelProfiles({
    query: { profileId: "model-c" },
    auth,
  });
  assert.deepEqual(exact.data.map((profile) => profile.profileId), ["model-c"]);
  await assert.rejects(
    application.listModelProfiles({ query: { cursor: "not-a-model-cursor" }, auth }),
    (error) => error.code === "cursor_invalid",
  );
});

test("an exact authorized model lookup filters before the 100-profile page limit", async () => {
  const profiles = Array.from({ length: 101 }, (_, index) => ({
    profileId: `model-${String(index + 1).padStart(3, "0")}`,
    displayName: `Model ${String(index + 1).padStart(3, "0")}`,
    readiness: "unavailable",
    selectable: false,
    currentRevisionId: `revision-${index + 1}`,
  }));
  const application = createWorkbenchApplication({
    store: createSurfaceStore(),
    modelCatalog: {
      async listProfiles() { return structuredClone(profiles); },
    },
    clock: () => NOW,
  });

  const result = await application.listModelProfiles({
    query: { profileId: "model-101" },
    auth: { userId: "user-surface", activeWorkspaceId: "workspace-surface" },
  });

  assert.deepEqual(result.data.map((profile) => profile.profileId), ["model-101"]);
  assert.equal(result.page.hasMore, false);
});

test("creation readiness is operation-specific and separates private Draft from execution setup", async () => {
  const store = {
    ...createSurfaceStore(),
    async createLoop() {},
    async getAuthAccount() {
      return { role: "admin", disabled: false };
    },
  };
  const application = createWorkbenchApplication({
    store,
    clock: () => NOW,
    skillRuntimeCatalog: [{
      runtimeId: "python3.12",
      availability: "unavailable",
    }],
    registeredToolCatalog: [{
      toolPackageId: "registered:lark-task",
      registrationStatus: "registered",
      actions: [{ actionId: "lark.task.create" }],
    }],
    skillUploadService: {
      async createUpload() {},
      async inspectUpload() {},
      async promoteUpload() {},
      async importRepository() {},
    },
    serverSkillImportService: {
      async scan() {},
      async import() {},
    },
    textResourceService: {
      async create() {},
      capabilities() { return { mediaTypes: ["text/plain"] }; },
    },
    inputAttachmentService: {
      async create() {},
      capabilities() {
        return { readyMediaTypes: ["text/plain"], unavailableMediaTypes: ["application/msword"] };
      },
    },
    connectionDriverRegistry: {
      async describe() {
        return {
          registered: true,
          backend: "production",
          bindingAvailable: false,
          probeAvailable: true,
        };
      },
    },
    executionBroker: {
      hasBackend({ mode, isolation }) {
        return mode === "bounded_agent" && isolation === "process";
      },
    },
    skillValidationService: { prepareTestIntake() {} },
    modelCatalog: {
      async listProfiles() { return []; },
    },
  });

  const result = await application.getWorkspaceFeatureReadiness({
    auth: { userId: "user-surface", activeWorkspaceId: "workspace-surface" },
  });

  assert.equal(result.data.actions.promptSkill.draftable.status, "ready");
  assert.equal(result.data.actions.promptSkill.testable.reasonCode, "model_route_unresolved");
  assert.equal(result.data.actions.scriptSkill.draftable.status, "ready");
  assert.equal(result.data.actions.scriptSkill.testable.reasonCode, "skill_runtime_unavailable");
  assert.equal(result.data.actions.stagedLoopProposal.draftable.reasonCode, "agent_container_backend_unavailable");
  assert.equal(result.data.actions.connectionSetup.runnable.reasonCode, "connection_credential_binding_unavailable");
  assert.equal(result.data.actions.serverSkillImport.importable.status, "ready");
  assert.deepEqual(result.data.support.readyRuntimeIds, []);
  assert.equal(result.responseHeaders["Cache-Control"], "private, no-store");
});

test("PostgreSQL creation readiness uses injected lifecycle and Connection owners instead of legacy repository shape", async () => {
  const connections = [];
  const application = createWorkbenchApplication({
    store: createSurfaceStore(),
    clock: () => NOW,
    skillDraftLifecycle: { async createSkill() {} },
    loopDraftLifecycle: { async createLoop() {} },
    connectionService: {
      async list({ workspaceId, query }) {
        assert.equal(workspaceId, "workspace-surface");
        assert.equal(query.includeDisabled, true);
        return connections;
      },
    },
    registeredToolCatalog: [{
      toolPackageId: "registered:lark-task",
      registrationStatus: "registered",
      actions: [{ actionId: "lark.task.create" }],
    }],
    connectionDriverRegistry: {
      async describe() {
        return { registered: true, backend: "production", bindingAvailable: true, probeAvailable: true };
      },
    },
  });
  const auth = { userId: "user-surface", activeWorkspaceId: "workspace-surface" };
  const before = await application.getWorkspaceFeatureReadiness({ auth });
  assert.equal(before.data.actions.promptSkill.draftable.status, "ready");
  assert.equal(before.data.actions.blankLoop.draftable.status, "ready");
  assert.equal(before.data.actions.registeredToolSkill.runnable.reasonCode, "connection_instance_required");

  connections.push({
    workspaceId: "workspace-surface", connectionId: "connection-ready", capabilityKey: "lark.task.create",
    driverBackend: "production", credentialState: "bound", status: "connected",
    validation: { status: "valid", expiresAt: "2026-07-25T01:00:00.000Z" },
  });
  const after = await application.getWorkspaceFeatureReadiness({ auth });
  assert.equal(after.data.actions.registeredToolSkill.runnable.status, "ready");
});

test("Tool Skill readiness requires a real valid production Connection instance, not only a driver", async () => {
  const connections = [];
  const store = {
    ...createSurfaceStore(),
    repositories: {
      ...createSurfaceStore().repositories,
      connections: {
        async listAllForReadModel({ workspaceId }) {
          return connections.filter((connection) => connection.workspaceId === workspaceId);
        },
      },
    },
  };
  const application = createWorkbenchApplication({
    store,
    clock: () => NOW,
    registeredToolCatalog: [{
      toolPackageId: "registered:lark-task",
      registrationStatus: "registered",
      actions: [{ actionId: "lark.task.create" }],
    }],
    connectionDriverRegistry: {
      async describe() {
        return {
          registered: true,
          backend: "production",
          bindingAvailable: true,
          probeAvailable: true,
        };
      },
    },
  });
  const auth = { userId: "user-surface", activeWorkspaceId: "workspace-surface" };

  const before = await application.getWorkspaceFeatureReadiness({ auth });
  assert.equal(before.data.actions.connectionSetup.runnable.status, "ready");
  assert.equal(before.data.actions.registeredToolSkill.testable.status, "needs_setup");
  assert.equal(
    before.data.actions.registeredToolSkill.testable.reasonCode,
    "connection_instance_required",
  );

  connections.push({
    workspaceId: "workspace-surface",
    connectionId: "connection-ready",
    capabilityKey: "lark.task.create",
    driverBackend: "production",
    credentialState: "bound",
    status: "connected",
    validation: {
      status: "valid",
      expiresAt: "2026-07-25T01:00:00.000Z",
    },
  });
  const after = await application.getWorkspaceFeatureReadiness({ auth });
  assert.equal(after.data.actions.registeredToolSkill.testable.status, "ready");
  assert.equal(after.data.actions.registeredToolSkill.runnable.status, "ready");
});

test("proposal readiness probes the registered sandbox instead of treating registration as runtime availability", async () => {
  const store = { ...createSurfaceStore(), async createLoop() {} };
  const modelCatalog = {
    async listProfiles() {
      return [{ selectable: true, capabilities: ["chat", "tool_calling", "structured_output"] }];
    },
  };
  for (const [probe, expectedStatus, expectedReason] of [
    [{ available: false, verified: true }, "unavailable", "agent_container_backend_unavailable"],
    [{ available: true, verified: false }, "checking", "agent_container_backend_checking"],
    [{ available: true, verified: true }, "ready", "ready"],
  ]) {
    const application = createWorkbenchApplication({
      store,
      clock: () => NOW,
      executionBroker: {
        hasBackend({ mode, isolation }) {
          return mode === "bounded_agent" && isolation === "container";
        },
        async probeBackend() { return probe; },
      },
      modelCatalog,
    });
    const result = await application.getWorkspaceFeatureReadiness({
      auth: { userId: "user-surface", activeWorkspaceId: "workspace-surface" },
    });
    assert.equal(result.data.actions.stagedLoopProposal.draftable.status, expectedStatus);
    assert.equal(result.data.actions.stagedLoopProposal.draftable.reasonCode, expectedReason);
  }
});

test("M5 runtime catalog and Loop task handoff stay product-owned and product-safe", async () => {
  const calls = [];
  const run = {
    schemaVersion: "workbench-v1",
    runId: "run-surface",
    workflowId: "workflow-surface",
    workflowRevisionId: "revision-surface",
    status: "queued",
  };
  const session = {
    schemaVersion: "workbench-v1",
    sessionId: "agent-session-surface",
    definitionId: "main",
    userId: "user-surface",
    workspaceId: "workspace-surface",
    scope: { kind: "main" },
    title: "Surface Loop",
    source: {
      kind: "loop_run",
      workflowId: run.workflowId,
      workflowRevisionId: run.workflowRevisionId,
      runId: run.runId,
    },
    taskStatus: "queued",
    status: "active",
    lastUsedModelProfileId: null,
    modelPreferenceState: "preference_only",
    activeTurnId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const store = {
    async connect() {},
    async authorizeWorkspace() { return { role: "member" }; },
    async getWorkflow() { throw new Error("legacy_store_workflow_owner_must_not_be_used"); },
    repositories: {
      workflows: {
        async list() {
          return [{
            schemaVersion: "workbench-v1",
            workflowId: run.workflowId,
            workspaceId: "workspace-surface",
            ownerId: "user-surface",
            visibility: "private",
            name: "Surface Loop",
            description: "",
            status: "ready",
            archived: false,
            currentRevisionId: run.workflowRevisionId,
            createdAt: NOW,
            updatedAt: NOW,
          }];
        },
      },
      workflowRevisions: {
        async get(workflowId, revisionId) {
          return workflowId === run.workflowId && revisionId === run.workflowRevisionId
            ? { workflowId, revisionId, graph: { nodes: [], edges: [] } }
            : null;
        },
      },
    },
  };
  const transactionSession = { id: "loop-agent-task-transaction" };
  const runner = {
    async startRunWithCompanion(request, companion) {
      calls.push(["run", request]);
      const persisted = await companion.persist({ run, transactionSession });
      return { run, companion: persisted };
    },
    async getRun() { return { run }; },
    async listRuns() { return [run]; },
  };
  const agentTurnRunner = {
    async createSession(request) {
      calls.push(["session", request]);
      return session;
    },
  };
  const workflow = {
    schemaVersion: "workbench-v1",
    workflowId: run.workflowId,
    workspaceId: "workspace-surface",
    ownerId: "user-surface",
    visibility: "private",
    name: "Surface Loop",
    description: "",
    status: "ready",
    archived: false,
    currentRevisionId: run.workflowRevisionId,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const workflowReadModel = {
    async getWorkflow({ workflowId }) {
      assert.equal(workflowId, run.workflowId);
      return { workflow, etag: '"workflow-surface:1"' };
    },
    async listWorkflows() { return [workflow]; },
    async getWorkflowRevision({ workflowId, revisionId }) {
      return workflowId === run.workflowId && revisionId === run.workflowRevisionId
        ? { workflowId, revisionId, graph: { nodes: [], edges: [] } }
        : null;
    },
  };
  const application = createWorkbenchApplication({
    store,
    runner,
    agentTurnRunner,
    workflowReadModel,
    skillRuntimeCatalog: [{
      runtimeId: "nodejs20-typescript",
      label: "Node.js · TypeScript",
      language: "typescript",
      versionLabel: "Node.js 20 · TypeScript",
      entrypoint: "scripts/main.ts",
      availability: "ready",
      availabilityReason: null,
      isolation: "container",
      network: false,
      filesystem: "scratch-only",
      timeoutSeconds: { minimum: 1, maximum: 120, step: 1, default: 30 },
      memoryMiB: { minimum: 64, maximum: 512, step: 64, default: 128 },
    }],
    registeredToolCatalog: [{
      toolPackageId: "registered:lark-task",
      skillName: "lark-task",
      label: "Lark Tasks",
      description: "Read and create governed tasks.",
      registrationStatus: "registered",
      actions: [{
        actionId: "lark.task.create",
        effect: "write",
        confirmationRequired: true,
      }],
    }],
    clock: () => NOW,
  });
  const auth = { userId: "user-surface", activeWorkspaceId: "workspace-surface" };

  const catalog = await application.listSkillRuntimes({ auth });
  const toolCatalog = await application.listRegisteredToolPackages({ auth });
  const workflows = await application.listWorkflows({ auth });
  const result = await application.startLoopAgentTask({
    workflowId: run.workflowId,
    idempotencyKey: "loop-task-surface",
    requestId: "request-surface",
    request: {
      data: {
        workflowRevisionId: run.workflowRevisionId,
        inputs: {},
        resourceRefs: [],
      },
    },
    auth,
  });

  assert.equal(catalog.data[0].runtimeId, "nodejs20-typescript");
  assert.equal("image" in catalog.data[0], false);
  assert.equal("command" in catalog.data[0], false);
  assert.equal(toolCatalog.data[0].actions[0].actionId, "lark.task.create");
  assert.equal("command" in toolCatalog.data[0], false);
  assert.equal("connection" in toolCatalog.data[0], false);
  assert.equal(workflows.data[0].latestRun.runId, run.runId);
  assert.equal(result.session.source.runId, run.runId);
  assert.equal(result.run.runId, run.runId);
  assert.equal(calls[0][0], "run");
  assert.equal(calls[1][0], "session");
  assert.equal(calls[1][1].source.workflowRevisionId, run.workflowRevisionId);
  assert.equal(calls[1][1].transactionSession, transactionSession);
});

test("Agent session creation shares the Product idempotency transaction with Agent persistence", async () => {
  const transactionSession = { id: "test-transaction-session" };
  let createInput;
  const session = {
    schemaVersion: "workbench-v1",
    sessionId: "agent-session-atomic",
    definitionId: "main",
    userId: "user-surface",
    workspaceId: "workspace-surface",
    scope: { kind: "main" },
    title: "Atomic task",
    source: { kind: "manual" },
    taskStatus: "idle",
    status: "active",
    lastUsedModelProfileId: null,
    modelPreferenceState: "preference_only",
    activeTurnId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const store = {
    async connect() {},
    async authorizeWorkspace() { return { role: "member" }; },
    async runIdempotentMutation(_options, mutation) {
      return mutation(transactionSession);
    },
  };
  const application = createWorkbenchApplication({
    store,
    agentTurnRunner: {
      async createSession(input) {
        createInput = input;
        return session;
      },
    },
    clock: () => NOW,
  });

  const created = await application.createAgentSession({
    idempotencyKey: "create-agent-session-atomic",
    request: {
      schemaVersion: "workbench-api-v1",
      data: { definitionId: "main", title: "Atomic task" },
    },
    auth: { userId: "user-surface", activeWorkspaceId: "workspace-surface" },
  });

  assert.equal(created.sessionId, session.sessionId);
  assert.equal(createInput.transactionSession, transactionSession);
});

test("Agent session creation consumes the injected PostgreSQL idempotency port without a legacy Store fallback", async () => {
  const transactionSession = { kind: "postgres_unit_of_work" };
  const calls = [];
  const session = {
    schemaVersion: "workbench-v1",
    sessionId: "agent-session-postgres-atomic",
    definitionId: "main",
    userId: "user-surface",
    workspaceId: "workspace-surface",
    scope: { kind: "main" },
    title: "PostgreSQL task",
    source: { kind: "manual" },
    taskStatus: "idle",
    status: "active",
    lastUsedModelProfileId: null,
    modelPreferenceState: "preference_only",
    activeTurnId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const store = {
    persistenceDriver: "postgres",
    async connect() {},
    async authorizeWorkspace() { return { role: "member" }; },
  };
  const application = createWorkbenchApplication({
    store,
    idempotentMutationPort: {
      async run(options, mutation) {
        calls.push(structuredClone(options));
        return mutation(transactionSession);
      },
    },
    agentTurnRunner: {
      async createSession(input) {
        assert.equal(input.transactionSession, transactionSession);
        return session;
      },
    },
    clock: () => NOW,
  });

  const created = await application.createAgentSession({
    idempotencyKey: "create-agent-session-postgres-atomic",
    request: {
      schemaVersion: "workbench-api-v1",
      data: { definitionId: "main", title: "PostgreSQL task" },
    },
    auth: { userId: "user-surface", activeWorkspaceId: "workspace-surface" },
  });

  assert.equal(created.sessionId, session.sessionId);
  assert.deepEqual(calls, [{
    scope: "create-agent-session:user-surface",
    key: "create-agent-session-postgres-atomic",
    request: {
      schemaVersion: "workbench-api-v1",
      data: { definitionId: "main", title: "PostgreSQL task" },
    },
    workspaceId: "workspace-surface",
    effectivePrincipalId: "user-surface",
  }]);
  assert.equal("runIdempotentMutation" in store, false);
});

test("Agent Turn intake commits through Product idempotency before scheduling background execution", async () => {
  const transactionSession = { id: "turn-intake-transaction" };
  const order = [];
  let enqueueInput;
  const store = {
    async connect() {},
    async authorizeWorkspace() { return { role: "member" }; },
    async runIdempotentMutation(_options, mutation) {
      order.push("transaction-started");
      const value = await mutation(transactionSession);
      order.push("transaction-committed");
      return value;
    },
  };
  const turn = {
    schemaVersion: "workbench-v1",
    turnId: "agent-turn-durable",
    sessionId: "agent-session-durable",
    productCommandId: "product-command-durable",
    sessionEpoch: 1,
    turnFence: 1,
    sequence: 1,
    kind: "agent_message",
    status: "queued",
    modelRoutingState: "pinned",
    requestedModelRevisionId: "model-revision-chat-1",
    actualModelRevisionId: null,
    artifactRefs: [],
    input: { message: "hello" },
    result: null,
    queuedAt: NOW,
    startedAt: null,
    finishedAt: null,
    updatedAt: NOW,
  };
  const agentTurnRunner = {
    async enqueueTurn(input) {
      enqueueInput = input;
      order.push("turn-persisted");
      return turn;
    },
    schedule(sessionId) {
      assert.equal(sessionId, turn.sessionId);
      order.push("scheduled");
    },
  };
  const application = createWorkbenchApplication({ store, agentTurnRunner, clock: () => NOW });

  const accepted = await application.createAgentTurn({
    sessionId: turn.sessionId,
    idempotencyKey: "durable-turn-intake",
    request: {
      schemaVersion: "workbench-api-v1",
      data: {
        kind: "agent_message",
        modelProfileId: "profile-chat",
        input: { message: "hello" },
      },
    },
    auth: { userId: "user-surface", activeWorkspaceId: "workspace-surface" },
  });

  assert.equal(accepted.productCommandId, turn.productCommandId);
  assert.equal(enqueueInput.transactionSession, transactionSession);
  assert.deepEqual(order, [
    "transaction-started",
    "turn-persisted",
    "transaction-committed",
    "scheduled",
  ]);
});

test("Agent Turn cancellation persists inside Product idempotency before dispatching cancellation", async () => {
  const transactionSession = { id: "turn-cancel-transaction" };
  const order = [];
  let cancelInput;
  const turn = {
    schemaVersion: "workbench-v1",
    turnId: "agent-turn-cancel",
    sessionId: "agent-session-cancel",
    productCommandId: "product-command-cancel-target",
    cancellationCommandId: "product-command-cancel",
    sessionEpoch: 1,
    turnFence: 2,
    sequence: 1,
    kind: "agent_message",
    status: "running",
    modelRoutingState: "pinned",
    requestedModelRevisionId: "model-revision-chat-1",
    actualModelRevisionId: null,
    artifactRefs: [],
    input: { message: "hello" },
    result: null,
    queuedAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    updatedAt: NOW,
  };
  const store = {
    async connect() {},
    async authorizeWorkspace() { return { role: "member" }; },
    async runIdempotentMutation(_options, mutation) {
      order.push("transaction-started");
      const value = await mutation(transactionSession);
      order.push("transaction-committed");
      return value;
    },
  };
  const agentTurnRunner = {
    async cancelTurn(input) {
      cancelInput = input;
      order.push("cancellation-persisted");
      return turn;
    },
    async afterCancellationCommitted(input) {
      assert.equal(input.turn, turn);
      order.push("cancellation-dispatched");
    },
  };
  const application = createWorkbenchApplication({ store, agentTurnRunner, clock: () => NOW });

  const cancelled = await application.cancelAgentTurn({
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    idempotencyKey: "durable-turn-cancel",
    request: {
      schemaVersion: "workbench-api-v1",
      data: { reason: "user_requested" },
    },
    auth: { userId: "user-surface", activeWorkspaceId: "workspace-surface" },
  });

  assert.equal(cancelled.cancellationCommandId, turn.cancellationCommandId);
  assert.equal(cancelInput.transactionSession, transactionSession);
  assert.deepEqual(order, [
    "transaction-started",
    "cancellation-persisted",
    "transaction-committed",
    "cancellation-dispatched",
  ]);
});

test("Inbox uses stable cursors and routes each item to a Product-owned action surface", async () => {
  const filters = new Map();
  const listWhere = (name, values) => ({
    async listWhere(query) {
      filters.set(name, structuredClone(query));
      return structuredClone(values);
    },
    async listAllForReadModel(query) {
      filters.set(name, structuredClone(query));
      return structuredClone(values);
    },
  });
  const store = {
    async connect() {},
    async authorizeWorkspace() { return { role: "admin" }; },
    async getWorkflow(workflowId) {
      return {
        workflow: {
          workflowId,
          workspaceId: "workspace-surface",
          ownerId: "user-surface",
          visibility: "private",
        },
      };
    },
    repositories: {
      agentObjectProposals: listWhere("agentObjectProposals", [
        {
          proposalId: "proposal-workflow",
          sessionId: "module-session-workflow",
          userId: "user-surface",
          objectKind: "workflow",
          objectId: "workflow-surface",
          status: "conflicting",
          createdAt: "2026-07-25T08:00:00.000Z",
        },
        {
          proposalId: "proposal-skill",
          sessionId: "module-session-skill",
          userId: "user-surface",
          objectKind: "skill_draft",
          objectId: "skill-draft-surface",
          status: "proposed",
          createdAt: "2026-07-25T07:00:00.000Z",
        },
      ]),
      mergeConflicts: listWhere("mergeConflicts", [{
        mergeConflictId: "merge-conflict-1",
        proposalId: "proposal-workflow",
        status: "open",
        createdAt: "2026-07-25T08:30:00.000Z",
      }]),
      builderProposals: listWhere("builderProposals", [{
        proposalId: "proposal-staged-loop",
        createdBy: "user-surface",
        kind: "staged_loop_draft",
        status: "proposed",
        createdAt: "2026-07-25T06:30:00.000Z",
      }]),
      installationUpdateDrafts: listWhere("installationUpdateDrafts", [{
        updateDraftId: "update-draft-1",
        createdBy: "user-surface",
        status: "pending_review",
        createdAt: "2026-07-25T06:00:00.000Z",
      }]),
      connections: listWhere("connections", [{
        connectionId: "connection-1",
        capabilityKey: "lark.base.records.read",
        status: "needs_setup",
        credentialState: "unbound",
        validation: { status: "never_checked" },
        createdAt: "2026-07-25T05:00:00.000Z",
      }]),
      runs: {
        async listByWorkspace() {
          return [{
            runId: "run-failed-1",
            workflowId: "workflow-surface",
            status: "failed",
            createdAt: "2026-07-25T04:00:00.000Z",
          }];
        },
        async listAllByWorkspaceForReadModel() {
          return [{
            runId: "run-failed-1",
            workflowId: "workflow-surface",
            status: "failed",
            createdAt: "2026-07-25T04:00:00.000Z",
          }];
        },
      },
    },
  };
  const application = createWorkbenchApplication({
    store,
    agentProposalService: {},
    skillRuntimeCatalog: [{
      runtimeId: "python3.12",
      label: "Python",
      availability: "unavailable",
    }],
    modelCatalog: {
      async listProfiles() {
        return [{
          profileId: "model-profile-unavailable",
          displayName: "M".repeat(200),
          enabled: true,
          selectable: false,
          readiness: "unavailable",
          readinessReason: "Provider credential is unavailable.",
        }];
      },
    },
    clock: () => NOW,
  });
  const auth = { userId: "user-surface", activeWorkspaceId: "workspace-surface" };

  const allItems = [];
  let page = await application.getInbox({ query: { limit: 2 }, auth });
  const count = page.data.count;
  while (true) {
    allItems.push(...page.data.items);
    if (!page.data.page.hasMore) break;
    page = await application.getInbox({
      query: { limit: 2, cursor: page.data.page.nextCursor },
      auth,
    });
    assert.equal(page.data.count, count);
  }

  assert.equal(page.responseHeaders["Cache-Control"], "private, no-store");

  assert.equal(count, 9);
  assert.equal(allItems.length, count);
  assert.equal(new Set(allItems.map((item) => item.itemId)).size, count);
  assert.ok(allItems.every((item) => (
    item.itemId.length <= 128
    && item.actionRoute.startsWith("/")
    && !item.actionRoute.startsWith("//")
  )));
  const workflowProposal = allItems
    .find((item) => item.objectId === "proposal-workflow");
  assert.equal(
    workflowProposal.actionRoute,
    "/?session=module-session-workflow&proposal=proposal-workflow",
  );
  assert.equal(
    allItems.find((item) => item.objectId === "proposal-staged-loop").actionRoute,
    "/loops/new?proposal=proposal-staged-loop",
  );
  assert.equal(
    allItems.find((item) => item.objectId === "update-draft-1").actionRoute,
    "/library?updateDraftId=update-draft-1",
  );
  assert.equal(
    allItems.find((item) => item.objectId === "connection-1").actionRoute,
    "/library?connectionId=connection-1&requirementId=lark.base.records.read",
  );
  assert.equal(
    allItems.find((item) => item.objectId === "run-failed-1").actionRoute,
    "/loops/workflow-surface/runs/run-failed-1",
  );
  const unavailableModel = allItems.find((item) => item.objectId === "model-profile-unavailable");
  assert.equal(
    unavailableModel.itemId,
    `inbox-${createHash("sha256")
      .update("workspace-surface:model:model-profile-unavailable")
      .digest("hex")
      .slice(0, 48)}`,
  );
  assert.equal(unavailableModel.title.length <= 200, true);
  assert.equal(
    unavailableModel.actionRoute,
    "/library?setup=models&profileId=model-profile-unavailable",
  );
  assert.equal(filters.get("agentObjectProposals").userId, auth.userId);
  assert.equal(filters.get("builderProposals").createdBy, auth.userId);
  assert.equal(filters.get("installationUpdateDrafts").createdBy, auth.userId);

  await assert.rejects(
    application.getInbox({ query: { cursor: "not-a-cursor" }, auth }),
    (error) => error.code === "cursor_invalid",
  );
});

test("Loop task projection reports source-read failure instead of fabricating blocked business state", async () => {
  const loopSession = {
    schemaVersion: "workbench-v1",
    sessionId: "agent-session-source-error",
    definitionId: "main",
    userId: "user-surface",
    workspaceId: "workspace-surface",
    scope: { kind: "main" },
    title: "Loop task",
    source: {
      kind: "loop_run",
      workflowId: "workflow-surface",
      workflowRevisionId: "revision-surface",
      runId: "run-source-error",
    },
    taskStatus: "queued",
    status: "active",
    lastUsedModelProfileId: null,
    modelPreferenceState: "preference_only",
    activeTurnId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const application = createWorkbenchApplication({
    store: {
      async connect() {},
      async authorizeWorkspace() { return { role: "member" }; },
    },
    agentTurnRunner: {
      async getSession() { return loopSession; },
    },
    runner: {
      async getRun() {
        const error = new Error("temporary runner read failure");
        error.code = "runner_read_failed";
        throw error;
      },
    },
    clock: () => NOW,
  });

  await assert.rejects(
    () => application.getAgentSession({
      sessionId: loopSession.sessionId,
      auth: { userId: "user-surface", activeWorkspaceId: "workspace-surface" },
    }),
    (error) => error?.code === "agent_task_source_unavailable"
      && error?.details?.runId === loopSession.source.runId,
  );
});

test("private Skill drafts, packages, tests, and validations remain owner-only between collaborators", async () => {
  const privateSkill = {
    schemaVersion: "workbench-v1",
    skillId: "skill-private",
    workspaceId: "workspace-surface",
    ownerId: "alice",
    visibility: "private",
    lifecycle: "draft",
    currentDraftId: "draft-private",
    latestPublishedVersionId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const privateDraft = {
    schemaVersion: "workbench-v1",
    skillDraftId: "draft-private",
    skillId: privateSkill.skillId,
    workspaceId: privateSkill.workspaceId,
    baseVersionId: null,
    revision: 1,
    name: "Private draft",
    description: "Only Alice can access this draft.",
    category: "testing",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    risk: { level: "low", externalAction: false, summary: "No external actions." },
    dependencies: [],
    connectionRequirements: [],
    files: [],
    updatedBy: "alice",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const forbiddenCalls = [];
  const store = {
    async connect() {},
    async authorizeWorkspace({ userId }) { return { role: userId === "alice" ? "owner" : "member" }; },
    async getSkillDraft({ skillId, draftId, workspaceId }) {
      assert.equal(skillId, privateSkill.skillId);
      assert.equal(draftId, privateDraft.skillDraftId);
      assert.equal(workspaceId, privateSkill.workspaceId);
      return { skill: structuredClone(privateSkill), draft: structuredClone(privateDraft) };
    },
    async resolveSkillValidationContext() {
      forbiddenCalls.push("validation-context");
      throw new Error("must_not_reach_validation_context");
    },
    async runIdempotentExternalMutation() {
      forbiddenCalls.push("external-mutation");
      throw new Error("must_not_start_external_mutation");
    },
    repositories: {
      skillAssets: {
        async list() { return [structuredClone(privateSkill)]; },
      },
      skillDrafts: {
        async list() { return [structuredClone(privateDraft)]; },
      },
      skillVersions: {
        async list() { return []; },
      },
    },
  };
  const application = createWorkbenchApplication({
    store,
    skillUploadService: {
      async getDraftPackage() {
        forbiddenCalls.push("package");
        throw new Error("must_not_read_package");
      },
    },
    skillValidationService: {
      async runTests() {
        forbiddenCalls.push("tests");
        throw new Error("must_not_run_tests");
      },
      async createValidation() {
        forbiddenCalls.push("validation");
        throw new Error("must_not_validate");
      },
    },
    clock: () => NOW,
  });
  const alice = { userId: "alice", activeWorkspaceId: "workspace-surface" };
  const bob = { userId: "bob", activeWorkspaceId: "workspace-surface" };

  const ownerAssets = await application.listSkillAssets({ auth: alice });
  const collaboratorAssets = await application.listSkillAssets({ auth: bob });
  assert.equal(ownerAssets.data.length, 1);
  assert.equal(ownerAssets.data[0].draft.skillDraftId, privateDraft.skillDraftId);
  assert.deepEqual(collaboratorAssets.data, []);

  for (const operation of [
    () => application.getSkillDraft({ skillId: privateSkill.skillId, draftId: privateDraft.skillDraftId, auth: bob }),
    () => application.getSkillDraftPackage({ skillId: privateSkill.skillId, draftId: privateDraft.skillDraftId, auth: bob }),
    () => application.createSkillTest({
      skillId: privateSkill.skillId,
      draftId: privateDraft.skillDraftId,
      idempotencyKey: "bob-test-private",
      ifMatch: '"skd1:draft-private:1"',
      request: { data: { testCase: { input: {}, expected: {} } } },
      auth: bob,
    }),
    () => application.createSkillValidation({
      skillId: privateSkill.skillId,
      draftId: privateDraft.skillDraftId,
      idempotencyKey: "bob-validate-private",
      ifMatch: '"skd1:draft-private:1"',
      request: { data: { permissionAcknowledged: true, testRunIds: ["test-run-private"] } },
      auth: bob,
    }),
  ]) {
    await assert.rejects(operation, { code: "skill_not_found" });
  }
  assert.deepEqual(forbiddenCalls, []);
});
