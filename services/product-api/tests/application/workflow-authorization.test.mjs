import assert from "node:assert/strict";
import test from "node:test";
import { Check, ExecutionEventSchema, ExecutionInvocationSummarySchema, RunCommandResponseSchema } from "@turnsu/workbench-contracts";

import { createWorkbenchApplication } from "../../src/application/workbench-application.mjs";

const NOW = "2026-08-04T10:00:00.000Z";

test("Run execution history authorizes the Run and exposes lifecycle metadata only", async () => {
  const calls = [];
  const { application } = fixture({ executionBroker: {
    async listInvocations(query) { calls.push(query); return [{ invocationId: "invocation-private" }]; },
    async listEvents(ids) {
      assert.deepEqual(ids, ["invocation-private"]);
      return [{ schemaVersion: "workbench-execution-fabric-v1", eventId: "event-private",
        invocationId: "invocation-private", attemptId: "attempt-private", sequence: 1,
        type: "execution.completed", status: "completed", occurredAt: NOW,
        payload: { toolArguments: { path: "/private/worker" }, providerToken: "not-public" },
        internalMetadata: "not-public" }];
    },
  } });
  const response = await application.listRunExecutionEvents({ runId: "run-alice-private", auth: auth("alice") });
  assert.equal(Check(ExecutionEventSchema, response.data[0]), true);
  assert.deepEqual(response.data[0].payload, {});
  assert.equal(JSON.stringify(response).includes("not-public"), false);
  assert.deepEqual(calls, [{ workspaceId: "workspace-a", controllerId: "run-alice-private", limit: 500 }]);
  await assert.rejects(application.listRunExecutionEvents({ runId: "run-alice-private", auth: auth("bob") }),
    (error) => error.code === "workflow_not_found");
  assert.equal(calls.length, 1);
});

function workflow({ workflowId, ownerId, visibility }) {
  return {
    schemaVersion: "workbench-v1",
    workflowId,
    workspaceId: "workspace-a",
    ownerId,
    visibility,
    name: workflowId,
    description: "",
    status: "draft",
    archived: false,
    lifecycle: "draft",
    currentRevisionId: `revision-${workflowId}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixture({ grants = [], workflowCommandAuthorizer = null, postgres = false, executionBroker = null } = {}) {
  const records = new Map([
    ["workflow-alice-private", workflow({
      workflowId: "workflow-alice-private",
      ownerId: "alice",
      visibility: "private",
    })],
    ["workflow-alice-shared", workflow({
      workflowId: "workflow-alice-shared",
      ownerId: "alice",
      visibility: "workspace",
    })],
    ["workflow-bob-private", workflow({
      workflowId: "workflow-bob-private",
      ownerId: "bob",
      visibility: "private",
    })],
  ]);
  const effects = [];
  const read = (workflowId) => {
    const value = records.get(workflowId);
    if (!value) {
      const error = new Error("Workflow not found.");
      error.code = "workflow_not_found";
      throw error;
    }
    return structuredClone(value);
  };
  const store = {
    ...(postgres ? { persistenceDriver: "postgres" } : {}),
    async connect() {},
    async authorizeWorkspace({ workspaceId }) {
      if (workspaceId !== "workspace-a") {
        const error = new Error("Workspace not found.");
        error.code = "workspace_not_found";
        throw error;
      }
      return { role: "member" };
    },
    async getWorkflow(workflowId, { workspaceId } = {}) {
      const value = read(workflowId);
      if (workspaceId !== value.workspaceId) {
        const error = new Error("Workflow not found.");
        error.code = "workflow_not_found";
        throw error;
      }
      return { workflow: value, etag: `"${value.currentRevisionId}"` };
    },
    async listActiveObjectAccessGrants({ workspaceId, objectKind, objectId, principalId }) {
      return grants.filter((grant) => (
        grant.workspaceId === workspaceId
        && grant.objectKind === objectKind
        && grant.objectId === objectId
        && grant.principalId === principalId
        && grant.revokedAt === null
      )).map((grant) => structuredClone(grant));
    },
    async saveWorkflowRevision({ workflowId, authoredBy }) {
      effects.push(["save", workflowId, authoredBy]);
      const value = read(workflowId);
      return {
        workflow: value,
        revision: { revisionId: value.currentRevisionId, workflowId },
        etag: `"${value.currentRevisionId}"`,
      };
    },
    async publishLoop({ workflowId, releasedBy }) {
      effects.push(["publish", workflowId, releasedBy]);
      return { workflowId, status: "published" };
    },
    repositories: {
      workflows: {
        async list() {
          return [...records.values()].map((value) => structuredClone(value));
        },
      },
      workflowRevisions: {
        async get(workflowId, revisionId) {
          const value = records.get(workflowId);
          return value?.currentRevisionId === revisionId
            ? { workflowId, revisionId, graph: { nodes: [], edges: [] } }
            : null;
        },
      },
    },
  };
  const runs = new Map([
    ["run-alice-private", {
      schemaVersion: "workbench-v1",
      runId: "run-alice-private",
      workflowId: "workflow-alice-private",
      workflowRevisionId: "revision-workflow-alice-private",
      status: "completed",
    }],
  ]);
  let lastRunInput = null;
  let lastCancelInput = null;
  let lastRetryInput = null;
  const runner = {
    async startRun(input) {
      lastRunInput = structuredClone(input);
      const { workflowId, requestedBy } = input;
      effects.push(["run", workflowId, requestedBy]);
      return { runId: `run-${workflowId}`, workflowId, status: "queued" };
    },
    async getRun(runId) {
      const run = runs.get(runId);
      if (!run) {
        const error = new Error("Run not found.");
        error.code = "run_not_found";
        throw error;
      }
      return { run: structuredClone(run), artifacts: [] };
    },
    async listEvents(runId) {
      effects.push(["events", runId]);
      return [];
    },
    async submitReviewDecision({ runId, decidedBy }) {
      effects.push(["review", runId, decidedBy]);
      return { runId, status: "completed" };
    },
    async cancelRun(input) {
      lastCancelInput = structuredClone(input);
      effects.push(["cancel", input.runId, input.requestedBy]);
      return { runId: input.runId, status: "cancelled" };
    },
    async retryRun(input) {
      lastRetryInput = structuredClone(input);
      effects.push(["retry", input.runId, input.requestedBy]);
      return { runId: `retry-${input.runId}`, status: "queued" };
    },
    subscribe(runId) {
      effects.push(["subscribe", runId]);
      return () => {};
    },
  };
  return {
    effects,
    application: createWorkbenchApplication({ store, runner, workflowCommandAuthorizer, executionBroker, clock: () => NOW }),
    getLastRunInput: () => lastRunInput,
    getLastCancelInput: () => lastCancelInput,
    getLastRetryInput: () => lastRetryInput,
  };
}

const auth = (userId, workspaceId = "workspace-a") => ({ userId, activeWorkspaceId: workspaceId });

test("Run invocation summaries project broker usage to the public contract", async () => {
  const usage = { steps: 1, modelRequests: 1, inputBytes: 10, outputBytes: 20, imageCount: 0,
    costUsdMicros: 3, inputTokens: 5, outputTokens: 6, totalTokens: 11,
    audioInputTokens: 0, audioOutputTokens: 0, cachedInputTokens: 0 };
  const { application } = fixture({ executionBroker: { async listInvocations() { return [{
    invocationId: "invocation-test", attemptId: "attempt-test", mode: "model_call", isolation: "process",
    status: "completed", createdAt: NOW, startedAt: NOW, finishedAt: NOW, result: { usage },
  }]; } } });
  const response = await application.listRunInvocations({ runId: "run-alice-private", auth: auth("alice") });
  assert.equal(Check(ExecutionInvocationSummarySchema, response.data[0]), true, JSON.stringify(response));
  assert.equal(response.data[0].usage.totalTokens, 11);
  assert.equal(Object.hasOwn(response.data[0].usage, "cachedInputTokens"), false);
  await assert.rejects(application.listRunInvocations({ runId: "run-alice-private", auth: auth("bob") }), { code: "workflow_not_found" });
});

test("private Workflows are filtered from list and hidden from known-ID reads", async () => {
  const { application } = fixture();

  const bobList = await application.listWorkflows({ auth: auth("bob") });
  assert.deepEqual(
    bobList.data.map((value) => value.workflowId).sort(),
    ["workflow-alice-shared", "workflow-bob-private"],
  );
  await assert.rejects(
    application.getWorkflow({ workflowId: "workflow-alice-private", auth: auth("bob") }),
    { code: "workflow_not_found" },
  );
  assert.equal(
    (await application.getWorkflow({
      workflowId: "workflow-alice-private",
      auth: auth("alice"),
    })).data.ownerId,
    "alice",
  );
});

test("workspace visibility grants read but not edit, publish, or execute authority", async () => {
  const { application, effects } = fixture();
  const bob = auth("bob");

  assert.equal(
    (await application.getWorkflow({ workflowId: "workflow-alice-shared", auth: bob })).data.visibility,
    "workspace",
  );
  await assert.rejects(
    application.saveWorkflowRevision({
      workflowId: "workflow-alice-shared",
      idempotencyKey: "bob-save",
      ifMatch: '"revision-workflow-alice-shared"',
      request: { data: {} },
      auth: bob,
    }),
    { code: "workflow_not_found" },
  );
  await assert.rejects(
    application.publishLoop({
      workflowId: "workflow-alice-shared",
      idempotencyKey: "bob-publish",
      ifMatch: '"revision-workflow-alice-shared"',
      request: { data: {} },
      auth: bob,
    }),
    { code: "workflow_not_found" },
  );
  await assert.rejects(
    application.startRun({
      workflowId: "workflow-alice-shared",
      idempotencyKey: "bob-run",
      requestId: "request-bob-run",
      request: { data: { workflowRevisionId: "revision-workflow-alice-shared" } },
      auth: bob,
    }),
    { code: "workflow_not_found" },
  );
  assert.deepEqual(effects, []);
});

test("PostgreSQL Workflow Run authority is minted from the exact Runner request and passed to intake", async () => {
  const calls = [];
  const { application, getLastRunInput } = fixture({
    workflowCommandAuthorizer: {
      async authorizeWorkflowRun(input) {
        calls.push(structuredClone(input));
        return { authorizationDecisionId: "decision-workflow-run" };
      },
    },
  });
  await application.startRun({
    workflowId: "workflow-alice-private",
    idempotencyKey: "authorized-run",
    requestId: "request-authorized-run",
    request: { data: {
      workflowRevisionId: "revision-workflow-alice-private",
      inputs: { topic: "authority" }, resourceRefs: [], materialBindings: [],
    } },
    auth: auth("alice"),
  });
  assert.deepEqual(calls, [{
    workspaceId: "workspace-a", userId: "alice", workflowId: "workflow-alice-private",
    workflowRevisionId: "revision-workflow-alice-private", inputs: { topic: "authority" },
    resourceRefs: [], materialBindings: [],
  }]);
  assert.equal(getLastRunInput().authorizationDecisionId, "decision-workflow-run");
});

test("PostgreSQL Loop Agent Task mints the exact companion-bound Run authority", async () => {
  const calls = [];
  let loopTaskInput = null;
  const { application } = fixture({
    postgres: true,
    workflowCommandAuthorizer: {
      async authorizeWorkflowRun(input) {
        calls.push(structuredClone(input));
        return { authorizationDecisionId: "decision-loop-agent-task" };
      },
    },
  });
  const runner = {
    async startRunWithCompanion(input, companion) {
      loopTaskInput = structuredClone(input);
      const run = { runId: "loop-run-authorized", workflowRevisionId: input.workflowRevisionId };
      const session = await companion.persist({ run, transactionSession: { kind: "unit" } });
      return { run, companion: session };
    },
  };
  const agentTurnRunner = {
    async createSession(input) {
      return {
        schemaVersion: "workbench-v1",
        sessionId: "loop-agent-session-authorized",
        definitionId: input.definitionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        scope: { kind: "main" },
        title: input.title,
        source: input.source,
        taskStatus: "queued",
        archived: false,
        status: "active",
        lastUsedModelProfileId: null,
        modelPreferenceState: "preference_only",
        activeTurnId: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
    },
  };
  const loopApplication = createWorkbenchApplication({
    store: {
      persistenceDriver: "postgres",
      async connect() {},
      async authorizeWorkspace() { return { role: "member" }; },
      async getWorkflow(workflowId, { workspaceId } = {}) {
        return { workflow: workflow({ workflowId, ownerId: "alice", visibility: "private" }), etag: '"loop-agent-task"' };
      },
      repositories: {
        workflowRevisions: {
          async get(workflowId, revisionId) {
            return { workflowId, revisionId, graph: { nodes: [], edges: [] } };
          },
        },
      },
    },
    runner,
    agentTurnRunner,
    workflowCommandAuthorizer: {
      async authorizeWorkflowRun(input) {
        calls.push(structuredClone(input));
        return { authorizationDecisionId: "decision-loop-agent-task" };
      },
    },
    clock: () => NOW,
  });
  const result = await loopApplication.startLoopAgentTask({
    workflowId: "workflow-alice-private",
    idempotencyKey: "loop-agent-task-authorized",
    requestId: "request-loop-agent-task-authorized",
    request: { data: {
      workflowRevisionId: "revision-workflow-alice-private",
      inputs: { topic: "companion authority" },
      resourceRefs: [],
      materialBindings: [],
    } },
    auth: auth("alice"),
  });
  assert.equal(result.run.runId, "loop-run-authorized");
  assert.deepEqual(calls, [{
    workspaceId: "workspace-a",
    userId: "alice",
    workflowId: "workflow-alice-private",
    workflowRevisionId: "revision-workflow-alice-private",
    inputs: { topic: "companion authority" },
    resourceRefs: [],
    materialBindings: [],
    companionKind: "agent-session",
  }]);
  assert.equal(loopTaskInput.authorizationDecisionId, "decision-loop-agent-task");
});

test("PostgreSQL review rejection mints a cancellation authority instead of reusing write-local review authority", async () => {
  const calls = [];
  const { application, effects } = fixture({
    workflowCommandAuthorizer: {
      async authorizeWorkflowRunReview(input) {
        calls.push(["review", structuredClone(input)]);
        return { authorizationDecisionId: "decision-review" };
      },
      async authorizeWorkflowRunCancellation(input) {
        calls.push(["cancel", structuredClone(input)]);
        return { authorizationDecisionId: "decision-cancel" };
      },
    },
  });
  await application.submitReviewDecision({
    runId: "run-alice-private",
    idempotencyKey: "reject-review",
    request: { data: { nodeId: "node-review", decision: "reject", requestedChanges: [] } },
    auth: auth("alice"),
  });
  assert.deepEqual(calls, [["cancel", {
    workspaceId: "workspace-a", userId: "alice", runId: "run-alice-private",
    nodeId: "node-review", decision: "reject", comment: undefined, requestedChanges: [],
  }]]);
  assert.deepEqual(effects, [["review", "run-alice-private", "alice"]]);
});

test("PostgreSQL public Run cancellation mints the exact execute authority before entering the Runner", async () => {
  const calls = [];
  const { application, getLastCancelInput, effects } = fixture({
    postgres: true,
    workflowCommandAuthorizer: {
      async authorizeWorkflowRunCancellationRequest(input) {
        calls.push(structuredClone(input));
        return {
          authorizationDecisionId: "decision-run-cancel",
          scopeId: "scope-alice-personal",
        };
      },
    },
  });
  const result = await application.cancelRun({
    runId: "run-alice-private",
    idempotencyKey: "cancel-private-run",
    request: { data: { reason: "Stop safely." } },
    auth: auth("alice"),
  });
  assert.deepEqual(result, { runId: "run-alice-private" });
  assert.equal(Check(RunCommandResponseSchema, { schemaVersion: "workbench-api-v1", data: result, requestId: "request-cancel" }), true);
  assert.deepEqual(calls, [{
    workspaceId: "workspace-a", userId: "alice", runId: "run-alice-private", reason: "Stop safely.",
  }]);
  assert.deepEqual(getLastCancelInput(), {
    runId: "run-alice-private",
    idempotencyKey: "cancel-private-run",
    requestedBy: "alice",
    reason: "Stop safely.",
    authorizationDecisionId: "decision-run-cancel",
    authorizationScopeId: "scope-alice-personal",
    authorizationAction: "workflow_run_cancel",
  });
  assert.deepEqual(effects, [["cancel", "run-alice-private", "alice"]]);
});

test("PostgreSQL Run retry mints a new exact workflow-run authority before the immutable replay", async () => {
  const calls = [];
  const { application, getLastRetryInput, effects } = fixture({
    postgres: true,
    workflowCommandAuthorizer: {
      async authorizeWorkflowRunRetry(input) {
        calls.push(structuredClone(input));
        return { authorizationDecisionId: "decision-run-retry" };
      },
    },
  });
  const result = await application.retryRun({
    runId: "run-alice-private",
    idempotencyKey: "retry-private-run",
    request: { data: { reason: "Retry after the dependency is restored." } },
    auth: auth("alice"),
  });
  assert.deepEqual(result, { runId: "retry-run-alice-private" });
  assert.equal(Check(RunCommandResponseSchema, { schemaVersion: "workbench-api-v1", data: result, requestId: "request-retry" }), true);
  assert.deepEqual(calls, [{
    workspaceId: "workspace-a",
    userId: "alice",
    runId: "run-alice-private",
    reason: "Retry after the dependency is restored.",
  }]);
  assert.deepEqual(getLastRetryInput(), {
    runId: "run-alice-private",
    idempotencyKey: "retry-private-run",
    requestedBy: "alice",
    reason: "Retry after the dependency is restored.",
    authorizationDecisionId: "decision-run-retry",
  });
  assert.deepEqual(effects, [["retry", "run-alice-private", "alice"]]);
});

test("PostgreSQL Run retry fails closed when its authorization owner is unavailable", async () => {
  const { application } = fixture({ postgres: true });
  await assert.rejects(
    application.retryRun({
      runId: "run-alice-private",
      idempotencyKey: "retry-without-authority",
      request: { data: {} },
      auth: auth("alice"),
    }),
    { code: "workflow_run_retry_authority_unavailable" },
  );
});

test("private Run details and event streams inherit Workflow read authority", async () => {
  const { application, effects } = fixture();

  await assert.rejects(
    application.getRun({ runId: "run-alice-private", auth: auth("bob") }),
    { code: "workflow_not_found" },
  );
  await assert.rejects(
    application.listEvents({ runId: "run-alice-private", after: 0, auth: auth("bob") }),
    { code: "workflow_not_found" },
  );
  await assert.rejects(
    application.subscribe("run-alice-private", () => {}, auth("bob")),
    { code: "workflow_not_found" },
  );
  assert.deepEqual(effects, []);

  assert.deepEqual(
    await application.listEvents({ runId: "run-alice-private", after: 0, auth: auth("alice") }),
    [],
  );
  const unsubscribe = await application.subscribe(
    "run-alice-private",
    () => {},
    auth("alice"),
  );
  unsubscribe();
  assert.deepEqual(effects, [
    ["events", "run-alice-private"],
    ["subscribe", "run-alice-private"],
  ]);
});

test("explicit object grants enable only their role operations and capabilities", async () => {
  const grant = (role, capabilities = []) => ({
    grantId: `grant-${role}`,
    workspaceId: "workspace-a",
    objectKind: "workflow",
    objectId: "workflow-alice-private",
    principalId: "bob",
    role,
    capabilities,
    grantedBy: "alice",
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const editor = fixture({ grants: [grant("editor")] });
  await editor.application.saveWorkflowRevision({
    workflowId: "workflow-alice-private",
    idempotencyKey: "editor-save",
    ifMatch: '"revision-workflow-alice-private"',
    request: { data: {} },
    auth: auth("bob"),
  });
  await assert.rejects(
    editor.application.submitReviewDecision({
      runId: "run-alice-private",
      idempotencyKey: "editor-review",
      request: { data: { decision: "approve" } },
      auth: auth("bob"),
    }),
    { code: "workflow_not_found" },
  );
  assert.deepEqual(editor.effects, [["save", "workflow-alice-private", "bob"]]);

  const reviewer = fixture({ grants: [grant("reviewer")] });
  await reviewer.application.submitReviewDecision({
    runId: "run-alice-private",
    idempotencyKey: "reviewer-review",
    request: { data: { decision: "approve" } },
    auth: auth("bob"),
  });
  assert.deepEqual(reviewer.effects, [["review", "run-alice-private", "bob"]]);

  const executor = fixture({ grants: [grant("editor", ["object.execute"])] });
  await executor.application.startRun({
    workflowId: "workflow-alice-private",
    idempotencyKey: "executor-run",
    requestId: "request-executor-run",
    request: { data: { workflowRevisionId: "revision-workflow-alice-private" } },
    auth: auth("bob"),
  });
  assert.deepEqual(executor.effects, [["run", "workflow-alice-private", "bob"]]);

  const publisher = fixture({ grants: [grant("maintainer", ["object.publish"])] });
  await publisher.application.publishLoop({
    workflowId: "workflow-alice-private",
    idempotencyKey: "publisher-publish",
    ifMatch: '"revision-workflow-alice-private"',
    request: { data: {} },
    auth: auth("bob"),
  });
  assert.deepEqual(publisher.effects, [["publish", "workflow-alice-private", "bob"]]);
});
