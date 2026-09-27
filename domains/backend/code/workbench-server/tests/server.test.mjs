import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_WORKBENCH_PORT,
  authorizeAgentObjectForSession,
  createConnectionRuntimeResolver,
  createDefaultProductPostgresStore,
  createWorkbenchComposition,
  createWorkbenchServer,
  resolveMemoryObjectPermission,
} from "../src/server.mjs";
import { connectionApprovalSnapshot } from "../src/connections/workspace-connection-service.mjs";
import {
  AdmissionController,
  AdmittedExecutionDispatcher,
  InMemoryCapacityPersistence,
  InMemoryExecutionPersistence,
  LoopbackRemoteWorkerTransport,
} from "../src/execution/index.mjs";
import { InMemoryAgentPersistence } from "../src/agents/agent-persistence.mjs";
import { createProductArtifactMetadataRepositoryFixture } from "./artifacts/product-artifact-metadata-repository-fixture.mjs";
import { createProductWorkerTranscriptArtifactRepositoryAdapter } from "../src/artifacts/product-worker-transcript-artifact-repository-adapter.mjs";
import { InMemoryMemoryPersistence } from "../src/memory/memory-persistence.mjs";
import { CanonicalMemoryResolver } from "../src/memory/canonical-memory-resolver.mjs";
import { createRepositoryWorkflowRunPersistence } from "./runner/fixtures/repository-workflow-run-persistence.mjs";

const testCapacityPersistence = () => new InMemoryCapacityPersistence();
const compositionStore = (store) => {
  const result = {
    async withTransaction(callback) { return callback({ id: "composition-test" }); },
    ...store,
  };
  // Unit fixtures own explicit in-memory ports. Production composition never
  // discovers these methods or chooses a second database adapter.
  result.createAgentPersistence ??= ({ clock }) => new InMemoryAgentPersistence({ clock });
  result.createExecutionPersistence ??= () => new InMemoryExecutionPersistence();
  result.createCapacityPersistence ??= () => new InMemoryCapacityPersistence();
  result.createMemoryPersistence ??= () => new InMemoryMemoryPersistence();
  result.createCanonicalMemoryResolver ??= () => new CanonicalMemoryResolver({ store: result });
  result.createModelCatalog ??= () => ({
    async listProfiles() { return []; },
    async getWorkspacePolicy() { return null; },
    async resolveCurrentProfile() { throw new Error("test_model_profile_unavailable"); },
    async resolveRevision() { throw new Error("test_model_revision_unavailable"); },
  });
  result.createArtifactMetadataRepository ??= () => createProductArtifactMetadataRepositoryFixture(result);
  result.createWorkerTranscriptArtifactRepository ??= () => createProductWorkerTranscriptArtifactRepositoryAdapter(result);
  result.createWorkflowRunPersistence ??= () => createRepositoryWorkflowRunPersistence({ store: result });
  return result;
};
const serverFixtureStore = () => compositionStore({ async connect() {} });
const testSkillTestPersistence = Object.freeze({
  async getTestRun() { return null; },
  async listRecoverable() { return []; },
  async claim() { return null; },
  async renewClaim() { return null; },
  async transitionTestRun() { return null; },
  async withTransaction(work) { return work(Object.freeze({ kind: "skill-test-fixture" })); },
});
const testSessionStore = Object.freeze({
  async issue() { throw new Error("session_not_expected"); },
  async get() { return null; },
  async revoke() { return { revoked: false }; },
});

test("the Product server uses the frozen local port", () => {
  assert.equal(DEFAULT_WORKBENCH_PORT, 8798);
});

test("the Product server requires PostgreSQL when no explicit test store is injected", () => {
  assert.throws(
    () => createDefaultProductPostgresStore({ env: {} }),
    /workbench_postgres_url_required/,
  );
});

test("the Product server refuses a legacy Store outside declared test mode", () => {
  assert.throws(
    () => createWorkbenchServer({
      store: serverFixtureStore(),
      application: {},
      bootstrapCatalog: false,
      distDirectory: null,
      env: {},
    }),
    /product_postgres_store_required/,
  );
});

test("a legacy test Store must inject its Session owner explicitly", () => {
  assert.throws(
    () => createWorkbenchServer({
      store: serverFixtureStore(), application: {}, bootstrapCatalog: false, distDirectory: null,
      env: { WORKBENCH_TEST_MODE: "1" },
    }),
    /postgres_workbench_session_store_required/,
  );
});

test("generic Workbench composition requires an explicitly selected Store", () => {
  assert.throws(
    () => createWorkbenchComposition({ env: {} }),
    /workbench_store_required/,
  );
});

test("non-PostgreSQL composition is rejected outside explicit test mode", () => {
  assert.throws(
    () => createWorkbenchComposition({
      store: { persistenceDriver: "test", async connect() {} },
      env: {},
    }),
    /non_postgres_composition_requires_test_mode/,
  );
});

test("Connection runtime resolution rejects legacy snapshots and principal drift before binding a Tool account", async () => {
  let connection = {
    schemaVersion: "workbench-v1",
    connectionId: "connection-runtime-1",
    workspaceId: "workspace-runtime",
    capabilityKey: "lark.task.create",
    driverKey: "lark",
    driverBackend: "production",
    credentialState: "bound",
    secretBindingId: "secret-binding-runtime-1",
    credentialBindingFingerprint: `sha256:${"a".repeat(64)}`,
    status: "connected",
    validation: {
      status: "valid",
      principal: "lark-account-a",
      scopes: ["task:write"],
      effects: ["write"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    revision: 7,
  };
  let runtimeBindingCalls = 0;
  let runtimeFingerprint = connection.credentialBindingFingerprint;
  let runtimeBindingInput = null;
  const resolver = createConnectionRuntimeResolver({
    store: {
      async connect() {},
      repositories: {
        connections: {
          async get(connectionId, { workspaceId }) {
            return connection.connectionId === connectionId && connection.workspaceId === workspaceId
              ? structuredClone(connection)
              : null;
          },
        },
      },
    },
    driverRegistry: {
      resolve() {
        return {
          driverKey: "lark",
          backend: "production",
          driver: {
            async resolveRuntimeBinding(input) {
              runtimeBindingCalls += 1;
              runtimeBindingInput = structuredClone(input);
              return {
                ok: true,
                binding: { profile: "profile-a" },
                credentialBindingFingerprint: runtimeFingerprint,
              };
            },
          },
        };
      },
    },
    clock: () => "2026-08-01T00:00:00.000Z",
  });
  const expectedConnection = connectionApprovalSnapshot(connection, {
    requirementId: "lark.task.create",
    now: Date.parse("2026-08-01T00:00:00.000Z"),
  });
  assert.deepEqual(await resolver({
    workspaceId: connection.workspaceId,
    connectionId: connection.connectionId,
    toolId: "lark.task.create",
    requestedBy: "user-a",
    expectedConnection,
  }), { profile: "profile-a" });
  assert.equal(runtimeBindingInput.secretBindingId, "secret-binding-runtime-1");

  runtimeFingerprint = `sha256:${"b".repeat(64)}`;
  await assert.rejects(
    resolver({
      workspaceId: connection.workspaceId,
      connectionId: connection.connectionId,
      toolId: "lark.task.create",
      requestedBy: "user-a",
      expectedConnection,
    }),
    { code: "connection_runtime_binding_unavailable" },
  );
  runtimeFingerprint = connection.credentialBindingFingerprint;

  connection = {
    ...connection,
    validation: { ...connection.validation, principal: "lark-account-b" },
  };
  await assert.rejects(
    resolver({
      workspaceId: connection.workspaceId,
      connectionId: connection.connectionId,
      toolId: "lark.task.create",
      requestedBy: "user-a",
      expectedConnection,
    }),
    { code: "connection_reapproval_required" },
  );
  await assert.rejects(
    resolver({
      workspaceId: connection.workspaceId,
      connectionId: connection.connectionId,
      toolId: "lark.task.create",
      requestedBy: "user-a",
      expectedConnection: {
        connectionId: connection.connectionId,
        connectionRevision: connection.revision,
        capabilityKey: connection.capabilityKey,
        driverKey: connection.driverKey,
      },
    }),
    { code: "run_connection_snapshot_unavailable" },
  );
  assert.equal(runtimeBindingCalls, 2);
});

test("the Product server forwards the isolated uploaded-Skill execution root", async () => {
  const serverSource = await readFile(new URL("../src/server.mjs", import.meta.url), "utf8");
  assert.match(serverSource, /executionRoot:\s*env\.WORKBENCH_EXECUTION_ROOT/);
  assert.match(serverSource, /tempRoot:\s*executionRoot/);
});

test("composition injects one execution resolver into a real Runner", () => {
  const store = compositionStore({
    async connect() {},
    repositories: {
      workflowRevisions: {},
      compileResults: {},
      skills: {},
      runJobs: {
        async insert() {},
        async list() { return []; },
        async listRecoverable() { return []; },
        async claimByRun() { return null; },
        async finishByRun() { return null; },
        async requeueByRun() { return null; },
        async abandonClaimByRun() { return null; },
        async cancelByRun() { return null; },
        async heartbeatByRun() { return null; },
        async nextCheckpointSequence() { return null; },
      },
      runLeases: { async acquire() {}, async heartbeat() {}, async release() {}, async cancelByRun() {} },
      runCheckpoints: { async insert() {} },
    },
    async runIdempotentMutation() {},
    async appendRunEvent() {},
  });
  const agentRuntime = {
    async probeSkill() {},
    async invokeSkillNode() {},
    async buildAuthoritativeFinal() {},
  };
  const composed = createWorkbenchComposition({
    store,
    agentRuntime,
    capacityPersistence: testCapacityPersistence(),
    env: { WORKBENCH_TEST_MODE: "1" },
    clock: () => "2026-07-10T00:00:00.000Z",
    idFactory: (kind) => `${kind}-test`,
  });
  assert.equal(composed.store, store);
  assert.equal(composed.agentRuntime, agentRuntime);
  assert.equal(typeof composed.runner.startRun, "function");
  assert.equal(typeof composed.application.compileWorkflow, "function");
  assert.equal(typeof composed.agentExecutor.execute, "function");
  assert.equal(typeof composed.admissionController.recover, "function");
});

test("test composition can bind repository fixtures during server readiness", () => {
  const store = compositionStore({
    async connect() {},
    repositories: null,
    async runIdempotentMutation() {},
    async appendRunEvent() {},
  });
  const agentRuntime = {
    async probeSkill() {},
    async invokeSkillNode() {},
    async buildAuthoritativeFinal() {},
  };

  const composed = createWorkbenchComposition({
    store,
    agentRuntime,
    capacityPersistence: testCapacityPersistence(),
    env: { WORKBENCH_TEST_MODE: "1" },
    clock: () => "2026-07-11T00:00:00.000Z",
    idFactory: (kind) => `${kind}-lazy-store`,
  });

  assert.equal(typeof composed.runner.startRun, "function");
});

test("composition consumes an explicitly injected Agent persistence", async () => {
  const created = [];
  const agentPersistence = {
    async createSession(session) {
      created.push(structuredClone(session));
      return structuredClone(session);
    },
    async createQueuedTurn() { throw new Error("not_used_by_this_composition_proof"); },
    async settleTurn() { throw new Error("not_used_by_this_composition_proof"); },
    async requestCancelWithEvent() { throw new Error("not_used_by_this_composition_proof"); },
  };
  const store = compositionStore({
    async connect() {},
    repositories: {
      workflowRevisions: {}, compileResults: {}, skills: {},
      runJobs: { async claimByRun() { return null; }, async abandonClaimByRun() {} },
      runLeases: { async acquire() {}, async release() {} },
    },
    async runIdempotentMutation() {},
    async appendRunEvent() {},
  });
  const composed = createWorkbenchComposition({
    store,
    agentPersistence,
    agentRuntime: {
      async probeSkill() {}, async invokeSkillNode() {}, async buildAuthoritativeFinal() {},
    },
    capacityPersistence: testCapacityPersistence(),
    runner: { async startRun() { throw new Error("not_used_by_this_composition_proof"); } },
    env: { WORKBENCH_TEST_MODE: "1" },
    clock: () => "2026-08-10T00:00:00.000Z",
    idFactory: (kind) => `${kind}-postgres-composition-proof`,
  });

  await composed.agentTurnRunner.createSession({
    definitionId: "main",
    userId: "user-alpha",
    workspaceId: "workspace-alpha",
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].sessionId, "agent-session-postgres-composition-proof");
  assert.equal(created[0].scope.kind, "main");
});

test("the concrete Module Agent authorizer uses canonical Skill assets and isolates private owners", async () => {
  const calls = [];
  const store = {
    async connect() {},
    repositories: {
      skillDrafts: {
        async get(draftId, query) {
          calls.push(["draft", draftId, query]);
          return { skillDraftId: draftId, skillId: "skill-private" };
        },
      },
      skillAssets: {
        async get(skillId, query) {
          calls.push(["asset", skillId, query]);
          return { skillId, ownerId: "alice", visibility: "private" };
        },
      },
      skills: {
        async get() {
          throw new Error("legacy_skill_repository_must_not_be_used");
        },
      },
    },
  };

  await assert.doesNotReject(authorizeAgentObjectForSession({
    store,
    objectKind: "skill_draft",
    objectId: "skill-draft-private",
    userId: "alice",
    workspaceId: "workspace-alpha",
  }));
  await assert.rejects(
    authorizeAgentObjectForSession({
      store,
      objectKind: "skill_draft",
      objectId: "skill-draft-private",
      userId: "bob",
      workspaceId: "workspace-alpha",
    }),
    (error) => error?.code === "agent_object_forbidden"
      && error?.status === "permission_denied",
  );
  assert.deepEqual(calls, [
    ["draft", "skill-draft-private", { workspaceId: "workspace-alpha" }],
    ["asset", "skill-private", { workspaceId: "workspace-alpha" }],
    ["draft", "skill-draft-private", { workspaceId: "workspace-alpha" }],
    ["asset", "skill-private", { workspaceId: "workspace-alpha" }],
  ]);
});

test("the concrete Module Agent authorizer consumes active object grants and revocation", async () => {
  let active = true;
  const store = {
    async connect() {},
    async authorizeWorkspace() { return { role: "member" }; },
    async listActiveObjectAccessGrants() {
      return active
        ? [{ principalId: "bob", role: "reviewer", capabilities: [] }]
        : [];
    },
    async getWorkflow(workflowId) {
      return {
        workflow: {
          workflowId,
          workspaceId: "workspace-alpha",
          ownerId: "alice",
          visibility: "private",
        },
      };
    },
  };

  await assert.doesNotReject(authorizeAgentObjectForSession({
    store,
    objectKind: "workflow",
    objectId: "workflow-private",
    userId: "bob",
    workspaceId: "workspace-alpha",
  }));
  active = false;
  await assert.rejects(
    authorizeAgentObjectForSession({
      store,
      objectKind: "workflow",
      objectId: "workflow-private",
      userId: "bob",
      workspaceId: "workspace-alpha",
    }),
    (error) => error?.code === "agent_object_forbidden",
  );
});

test("object Memory inherits private Skill and Loop ownership", async () => {
  const store = {
    async connect() {},
    repositories: {
      skillDrafts: {
        async get(draftId) {
          return draftId === "skill-draft-private"
            ? { skillDraftId: draftId, skillId: "skill-private" }
            : null;
        },
      },
      skillAssets: {
        async get(skillId) {
          return skillId === "skill-private"
            ? { skillId, ownerId: "alice", visibility: "private" }
            : null;
        },
      },
    },
    async getWorkflow(workflowId) {
      if (workflowId === "workflow-private") {
        return { workflow: { workflowId, ownerId: "alice", visibility: "private" } };
      }
      if (workflowId === "workflow-team") {
        return { workflow: { workflowId, ownerId: "alice", visibility: "workspace" } };
      }
      return null;
    },
  };
  const permission = (objectKind, objectId, userId, action = "read", role = "member") => (
    resolveMemoryObjectPermission({
      store,
      scope: { kind: "object", objectKind, objectId },
      context: { workspaceId: "workspace-alpha", userId, role },
      action,
    })
  );

  assert.equal(await permission("skill_draft", "skill-draft-private", "alice"), true);
  assert.equal(await permission("skill_draft", "skill-draft-private", "bob"), false);
  assert.equal(await permission("workflow", "workflow-private", "alice"), true);
  assert.equal(await permission("workflow", "workflow-private", "bob"), false);
  assert.equal(await permission("workflow", "workflow-team", "bob"), true);
  assert.equal(await permission("workflow", "workflow-team", "bob", "delete", "viewer"), false);
});

test("composition registers one shared Agent sandbox for bounded and orchestrator container modes", () => {
  const registrations = [];
  const executionBroker = {
    registerBackend(registration) { registrations.push(registration); return () => {}; },
  };
  const store = compositionStore({ async connect() {} });
  const agentRuntime = { async probeSkill() {} };
  const agentSandbox = { async run() {}, async scavenge() {} };
  const composed = createWorkbenchComposition({
    store,
    agentRuntime,
    executionBroker,
    allowUnadmittedExecutionBrokerForTests: true,
    env: { WORKBENCH_TEST_MODE: "1" },
    agentSandbox,
    agentTurnRunner: {},
    memoryService: {},
    runner: {},
  });
  assert.equal(composed.agentSandbox, agentSandbox);
  assert.deepEqual(registrations.map(({ mode, isolation }) => ({ mode, isolation })), [
    { mode: "bounded_agent", isolation: "container" },
    { mode: "agent_orchestrator", isolation: "container" },
  ]);
  assert.ok(registrations.every(({ backend }) => typeof backend.execute === "function"));
});

test("composition registers an injected Remote transport internally for every compiled execution mode", () => {
  const registrations = [];
  const executionBroker = {
    registerBackend(registration) { registrations.push(registration); return () => {}; },
  };
  const remoteTransport = new LoopbackRemoteWorkerTransport();
  const composed = createWorkbenchComposition({
    store: compositionStore({ async connect() {} }),
    agentRuntime: { async probeSkill() {}, async invokeSkillNode() {} },
    capacityPersistence: testCapacityPersistence(),
    executionBroker,
    allowUnadmittedExecutionBrokerForTests: true,
    env: { WORKBENCH_TEST_MODE: "1" },
    remoteTransport,
    agentTurnRunner: {},
    memoryService: {},
    runner: {},
  });
  assert.equal(composed.remoteTransport, remoteTransport);
  assert.deepEqual(registrations.map(({ mode, isolation }) => ({ mode, isolation })), [
    { mode: "deterministic_skill", isolation: "remote" },
    { mode: "model_call", isolation: "remote" },
    { mode: "bounded_agent", isolation: "remote" },
    { mode: "agent_orchestrator", isolation: "remote" },
  ]);
  assert.equal(new Set(registrations.map(({ backend }) => backend)).size, 1);
});

test("production composition rejects unbranded execution brokers and forged brand properties", () => {
  const executionBroker = {
    admissionEnforced: true,
    __admittedExecutionDispatcher: true,
    async execute() {},
    async cancel() {},
    registerBackend() {},
  };
  assert.throws(
    () => createWorkbenchComposition({ executionBroker, env: {} }),
    /unadmitted_execution_broker_forbidden/,
  );
  const admissionController = new AdmissionController({
    persistence: testCapacityPersistence(),
    clock: () => "2026-08-01T00:00:00.000Z",
    idFactory: (kind) => `${kind}-forged-subclass`,
    resolveProductCommand: async () => null,
  });
  class TestOnlyDispatcher extends AdmittedExecutionDispatcher {
    async execute() { return { status: "completed" }; }
  }
  const testOnlyDispatcher = new TestOnlyDispatcher({
    admissionController,
    broker: {
      async execute() { return { status: "completed" }; },
      async cancel() { return { status: "cancelled" }; },
    },
  });
  assert.throws(
    () => createWorkbenchComposition({ executionBroker: testOnlyDispatcher, env: {} }),
    /unadmitted_execution_broker_forbidden/,
  );
  assert.throws(
    () => createWorkbenchComposition({
      executionBroker,
      allowUnadmittedExecutionBrokerForTests: true,
      env: {},
    }),
    /test_execution_broker_override_requires_test_mode/,
  );
  assert.throws(
    () => createWorkbenchComposition({
      executionBroker,
      env: { WORKBENCH_TEST_MODE: "1" },
    }),
    /unadmitted_execution_broker_forbidden/,
  );
});

test("explicit test mode override permits a raw test broker without branding it for production", () => {
  const executionBroker = { registerBackend() {} };
  const input = {
    store: compositionStore({ async connect() {} }),
    agentRuntime: { async probeSkill() {} },
    executionBroker,
    agentTurnRunner: {},
    memoryService: {},
    runner: {},
  };
  const composed = createWorkbenchComposition({
    ...input,
    allowUnadmittedExecutionBrokerForTests: true,
    env: { WORKBENCH_TEST_MODE: "1" },
  });
  assert.equal(composed.executionBroker, executionBroker);
  assert.throws(
    () => createWorkbenchComposition({ ...input, env: {} }),
    /unadmitted_execution_broker_forbidden/,
  );
});

test("production composition owns dispatcher construction and rejects test-created dispatchers", () => {
  const admissionController = new AdmissionController({
    persistence: testCapacityPersistence(),
    clock: () => "2026-08-01T00:00:00.000Z",
    idFactory: (kind) => `${kind}-production-brand`,
    resolveProductCommand: async () => null,
  });
  const dispatcher = new AdmittedExecutionDispatcher({
    admissionController,
    broker: {
      async execute() { return { status: "completed" }; },
      async cancel() { return { status: "cancelled" }; },
      registerBackend() {},
    },
  });
  assert.throws(
    () => { dispatcher.execute = async () => ({ status: "completed" }); },
    TypeError,
  );
  assert.throws(
    () => createWorkbenchComposition({
      store: { async connect() {} },
      agentRuntime: { async probeSkill() {} },
      executionBroker: dispatcher,
      agentTurnRunner: {},
      memoryService: {},
      runner: {},
      env: {},
    }),
    /unadmitted_execution_broker_forbidden/,
  );
});

test("composition configures Prompt Skill tests through the governed model and Tool Gateway", () => {
  let promptRuntime = null;
  const skillValidationService = {
    async loadExecutionPackage() {},
    async executeTestPackage() {},
    async executePublished() {},
    async probeExecution() {},
    acceptsExecutionRef() { return true; },
    prepareTestIntake() {},
    async startAcceptedTestRun() {},
    async prepareAcceptedTestExecution() {},
    classifyAcceptedTestOutcome() {},
    classifyPersistedAcceptedTestOutcome() {},
    async settleAcceptedTestRun() {},
    blockedAcceptedTestOutcome() {},
    cancelledAcceptedTestOutcome() {},
    async requeueAcceptedTestRun() {},
    async resolveValidationContext() { return null; },
    testExecutionIdentity() { return { invocationId: "invocation-test", attemptId: "attempt-test" }; },
    configurePromptRuntime(runtime) { promptRuntime = runtime; },
  };
  const modelExecutor = async () => ({
    requestedModelRevisionId: "model-revision-1",
    actualModelRevisionId: "model-revision-1",
    content: [{ type: "text", text: "{}" }],
    toolCalls: [],
  });
  modelExecutor.resolveTurnSelection = async () => ({
    modelProfileRevisionId: "model-revision-1",
  });
  const composed = createWorkbenchComposition({
    store: compositionStore({ async connect() {} }),
    agentRuntime: { async probeSkill() {}, async invokeSkillNode() {} },
    capacityPersistence: testCapacityPersistence(),
    agentTurnRunner: {},
    memoryService: {},
    runner: {},
    skillValidationService,
    skillValidationPersistence: testSkillTestPersistence,
    gatewayModelExecutor: modelExecutor,
    gatewayToolExecutor: async () => ({}),
    env: { WORKBENCH_TEST_MODE: "1" },
  });

  assert.equal(typeof promptRuntime?.probe, "function");
  assert.equal(typeof promptRuntime?.executeTest, "function");
  assert.equal(typeof composed.toolGateway?.handle, "function");
  assert.equal(typeof composed.skillTestRunner?.schedule, "function");
});

test("composition gives Skill tests to the durable Runner without installing a request-local execution callback", () => {
  let legacyRuntimeConfigured = false;
  const requests = [];
  const executionBroker = {
    registerBackend() {},
    async getInvocation() { return null; },
    async cancel() { return null; },
    async execute(request) {
      requests.push(structuredClone(request));
      return { status: "completed", output: { result: "ok" } };
    },
  };
  const composed = createWorkbenchComposition({
    store: compositionStore({ async connect() {} }),
    agentRuntime: { async probeSkill() {} },
    executionBroker,
    allowUnadmittedExecutionBrokerForTests: true,
    agentTurnRunner: {},
    memoryService: {},
    runner: {},
    skillValidationService: {
      prepareTestIntake() {},
      async startAcceptedTestRun() {},
      async prepareAcceptedTestExecution() {},
      classifyAcceptedTestOutcome() {},
      classifyPersistedAcceptedTestOutcome() {},
      async settleAcceptedTestRun() {},
      blockedAcceptedTestOutcome() {},
      cancelledAcceptedTestOutcome() {},
      async requeueAcceptedTestRun() {},
      async resolveValidationContext() { return null; },
      testExecutionIdentity() { return { invocationId: "invocation-test", attemptId: "attempt-test" }; },
      configureTestExecutionRuntime() { legacyRuntimeConfigured = true; },
    },
    skillValidationPersistence: testSkillTestPersistence,
    env: { WORKBENCH_TEST_MODE: "1" },
  });

  assert.equal(legacyRuntimeConfigured, false);
  assert.equal(requests.length, 0);
  assert.equal(typeof composed.skillTestRunner?.schedule, "function");
});

test("server readiness recovers durable RunJobs before serving requests", async (t) => {
  let recoverCalls = 0;
  const composed = createWorkbenchServer({
    store: serverFixtureStore(),
    testSessionStore,
    application: {},
    runner: { async recover() { recoverCalls += 1; return { recoveredRunIds: [] }; } },
    bootstrapCatalog: false,
    distDirectory: null,
    env: { WORKBENCH_TEST_MODE: "1" },
    httpHandler: async (_req, res) => { res.writeHead(204); res.end(); },
  });
  t.after(() => composed.server.close());
  await composed.ready;
  assert.equal(recoverCalls, 1);
});

test("server readiness polls due Automations only after durable Run recovery", async (t) => {
  const order = [];
  const composed = createWorkbenchServer({
    store: serverFixtureStore(),
    testSessionStore,
    application: {},
    runner: {
      async recover() {
        order.push("runner");
        return { recoveredRunIds: [] };
      },
    },
    automationScheduler: {
      async pollDue() {
        order.push("automation");
        return { inspected: 0, accepted: 0, blocked: 0, skipped: 0, misfired: 0 };
      },
    },
    bootstrapCatalog: false,
    distDirectory: null,
    env: { WORKBENCH_TEST_MODE: "1" },
    httpHandler: async (_req, res) => { res.writeHead(204); res.end(); },
  });
  t.after(() => composed.close());
  await composed.ready;
  assert.deepEqual(order, ["runner", "automation"]);
});

test("server readiness reconciles Artifacts inside the configured workspace", async (t) => {
  let reconciledWorkspaceId = null;
  const composed = createWorkbenchServer({
    store: compositionStore({ async connect() {} }),
    testSessionStore,
    executionBroker: {
      hasBackend() { return false; },
      registerBackend() {},
      async execute() { throw new Error("execution_not_expected"); },
      async cancel() { return null; },
      async getInvocation() { return null; },
      async listInvocations() { return []; },
      async listEvents() { return []; },
    },
    allowUnadmittedExecutionBrokerForTests: true,
    agentRuntime: {
      async probeSkill() {},
      async invokeSkillNode() {},
      async buildAuthoritativeFinal() {},
    },
    artifactService: {
      async reconcile({ workspaceId }) { reconciledWorkspaceId = workspaceId; },
    },
    runner: { async recover() { return { recoveredRunIds: [] }; } },
    agentTurnRunner: { async recover() { return { recoveredTurnIds: [] }; } },
    capacityPersistence: testCapacityPersistence(),
    bootstrapCatalog: false,
    objectStoreRoot: null,
    distDirectory: null,
    env: { WORKBENCH_DEFAULT_WORKSPACE_ID: "workspace-preview", WORKBENCH_TEST_MODE: "1" },
    httpHandler: async (_req, res) => { res.writeHead(204); res.end(); },
  });
  t.after(() => composed.server.close());

  await composed.ready;
  assert.equal(reconciledWorkspaceId, "workspace-preview");
});

test("server readiness scavenges owned Skill containers before recovering durable RunJobs", async (t) => {
  const order = [];
  const composed = createWorkbenchServer({
    store: serverFixtureStore(),
    testSessionStore,
    application: {},
    runner: { async recover() { order.push("runner"); return { recoveredRunIds: [] }; } },
    startupRecovery: async () => { order.push("docker"); },
    bootstrapCatalog: false,
    distDirectory: null,
    env: { WORKBENCH_TEST_MODE: "1" },
    httpHandler: async (_req, res) => { res.writeHead(204); res.end(); },
  });
  t.after(() => composed.server.close());
  await composed.ready;
  assert.deepEqual(order, ["docker", "runner"]);
});

test("server readiness scavenges the Agent sandbox before Runner recovery", async (t) => {
  const order = [];
  const composed = createWorkbenchServer({
    store: serverFixtureStore(),
    testSessionStore,
    application: {},
    agentSandbox: { async scavenge() { order.push("agent-sandbox"); } },
    runner: { async recover() { order.push("runner"); return { recoveredRunIds: [] }; } },
    bootstrapCatalog: false,
    distDirectory: null,
    env: { WORKBENCH_TEST_MODE: "1" },
    httpHandler: async (_req, res) => { res.writeHead(204); res.end(); },
  });
  t.after(() => composed.server.close());
  await composed.ready;
  assert.deepEqual(order, ["agent-sandbox", "runner"]);
});

test("server readiness reconciles orphaned Realtime streams before business Runner recovery", async (t) => {
  const order = [];
  const composed = createWorkbenchServer({
    store: serverFixtureStore(),
    testSessionStore,
    application: {},
    executionBroker: { async recoverStreams() { order.push("realtime"); } },
    runner: { async recover() { order.push("runner"); return { recoveredRunIds: [] }; } },
    bootstrapCatalog: false,
    distDirectory: null,
    env: { WORKBENCH_TEST_MODE: "1" },
    httpHandler: async (_req, res) => { res.writeHead(204); res.end(); },
  });
  t.after(() => composed.server.close());
  await composed.ready;
  assert.deepEqual(order, ["realtime", "runner"]);
});

test("an injected application can host API tests without constructing runtime dependencies", async (t) => {
  const application = {};
  const composed = createWorkbenchServer({
    store: serverFixtureStore(),
    testSessionStore,
    application,
    bootstrapCatalog: false,
    distDirectory: null,
    env: { WORKBENCH_TEST_MODE: "1" },
    httpHandler: async (_req, res) => {
      res.writeHead(204);
      res.end();
    },
  });
  t.after(() => composed.server.close());
  assert.equal(composed.application, application);
  await composed.ready;
});

test("liveness remains available during startup recovery while readiness fails closed", async (t) => {
  let releaseRecovery;
  const recovery = new Promise((resolve) => { releaseRecovery = resolve; });
  const composed = createWorkbenchServer({
    store: serverFixtureStore(),
    testSessionStore,
    application: {},
    bootstrapCatalog: false,
    distDirectory: null,
    env: { WORKBENCH_TEST_MODE: "1" },
    startupRecovery: () => recovery,
    readiness: { async check() { return { ready: false, checks: [{ name: "startup", status: "failed" }] }; } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    httpHandler: async (_req, res) => { res.writeHead(204); res.end(); },
  });
  t.after(() => composed.close());
  const invoke = (url) => new Promise((resolve) => {
    const req = new EventEmitter();
    req.url = url;
    req.method = "GET";
    req.headers = {};
    const res = new EventEmitter();
    res.statusCode = 200;
    res.body = "";
    res.writeHead = (statusCode, headers) => { res.statusCode = statusCode; res.headers = headers; };
    res.end = (value = "") => { res.body += value; res.emit("finish"); resolve(res); };
    res.destroy = () => resolve(res);
    composed.server.emit("request", req, res);
  });

  const health = await invoke("/healthz");
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { status: "alive" });
  const ready = await invoke("/readyz");
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(JSON.parse(ready.body), { status: "not_ready", checks: { startup: "failed" } });

  releaseRecovery();
  await composed.ready;
});
