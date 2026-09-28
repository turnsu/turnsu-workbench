import assert from "node:assert/strict";
import test from "node:test";

import {
  AdmissionController,
  AdmissionControllerError,
  AdmittedExecutionDispatcher,
  ExecutionBroker,
  InMemoryCapacityPersistence,
  InMemoryExecutionPersistence,
} from "../../src/execution/index.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function request({
  invocationId,
  userId,
  commandId,
  workspaceId = "workspace-a",
  sessionId = commandId,
  turnId = commandId,
  limits = null,
}) {
  return {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId,
    attemptId: `attempt-${invocationId}`,
    workspaceId,
    actor: { userId },
    lineage: { productCommandId: commandId, sessionId, turnId },
    controller: { kind: "agent_turn", controllerId: turnId, fence: 1 },
    mode: "bounded_agent",
    isolation: "process",
    goal: "bounded work",
    input: {},
    limits: limits ?? {
      timeoutMs: 1000,
      maxSteps: 1,
      maxModelRequests: 1,
      maxChildren: 0,
      maxInputBytes: 1000,
      maxOutputBytes: 1000,
      maxImageCount: 0,
      maxCostUsdMicros: 1000,
    },
    capabilities: {
      toolAllowlist: [],
      connectionIds: [],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
    resultSchema: { type: "object", additionalProperties: true },
    evidenceRequirements: [],
    metadata: {},
  };
}

function activeProductCommand(identity, executionRequest) {
  const kind = executionRequest.controller.kind === "workflow_run"
    ? "workflow_run"
    : executionRequest.controller.kind === "skill_test"
      ? "skill_test"
    : executionRequest.controller.kind === "skill_creation_turn"
      ? "skill_creation_turn"
      : "agent_turn";
  return {
    schemaVersion: "workbench-v1",
    ...identity,
    kind,
    sessionId: executionRequest.lineage.sessionId,
    turnId: executionRequest.lineage.turnId,
    status: "running",
  };
}

function fixture(limits = {}, options = {}) {
  let id = 0;
  const persistence = new InMemoryCapacityPersistence();
  const { resolveProductCommand = activeProductCommand, ...controllerOptions } = options;
  const controller = new AdmissionController({
    persistence,
    clock: () => "2026-08-01T00:00:00.000Z",
    idFactory: (kind) => `${kind}-${++id}`,
    limits,
    ...controllerOptions,
    resolveProductCommand,
  });
  return { persistence, controller };
}

test("AdmittedExecutionDispatcher rejects duck-typed Admission controllers", () => {
  assert.throws(
    () => new AdmittedExecutionDispatcher({
      admissionController: {
        async acquire() {},
        async acquireChildPool() { return []; },
        async authorize() { return true; },
        async heartbeat() {},
        async release() {},
      },
      broker: {
        async execute() {},
        async cancel() {},
      },
    }),
    /admission_controller_required/,
  );
});

test("AdmissionController enforces atomic workspace capacity and resumes the next waiter after release", async () => {
  const { controller, persistence } = fixture({ user: 1, workspace: 1, backend: 1, provider: 1 });
  const first = await controller.acquire({
    request: request({ invocationId: "invocation-a", userId: "alice", commandId: "command-a" }),
  });
  let secondResolved = false;
  const secondPromise = controller.acquire({
    request: request({ invocationId: "invocation-b", userId: "bob", commandId: "command-b" }),
  }).then((lease) => {
    secondResolved = true;
    return lease;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondResolved, false);
  assert.equal(persistence.counters.get("workspace:workspace-a"), 1);

  await controller.release(first.capacityLeaseId);
  const second = await secondPromise;
  assert.equal(second.userId, "bob");
  assert.equal(persistence.counters.get("workspace:workspace-a"), 1);
  await controller.release(second.capacityLeaseId);
  assert.equal(persistence.counters.get("workspace:workspace-a"), 0);
});

test("AdmissionController rejects wrong user, workspace, command, backend, fence, and expired leases", async () => {
  const { controller } = fixture();
  const input = request({ invocationId: "invocation-auth", userId: "alice", commandId: "command-auth" });
  const lease = await controller.acquire({ request: input });
  const admitted = {
    ...input,
    capacityAuthority: {
      admissionId: lease.admissionId,
      capacityLeaseId: lease.capacityLeaseId,
      fence: lease.fence,
    },
  };
  assert.equal(await controller.authorize(admitted), true);
  assert.equal(await controller.authorize({ ...admitted, actor: { userId: "mallory" } }), false);
  assert.equal(await controller.authorize({ ...admitted, workspaceId: "workspace-b" }), false);
  assert.equal(await controller.authorize({ ...admitted, lineage: { productCommandId: "command-other" } }), false);
  assert.equal(await controller.authorize({ ...admitted, mode: "agent_orchestrator" }), false);
  assert.equal(await controller.authorize({
    ...admitted,
    capacityAuthority: { ...admitted.capacityAuthority, fence: 2 },
  }), false);
  await controller.release(lease.capacityLeaseId);
  assert.equal(await controller.authorize(admitted), false);
});

test("AdmissionController resolves active Product Command lineage before writing admission state", async (t) => {
  const canonical = request({
    invocationId: "invocation-lineage",
    userId: "alice",
    commandId: "command-lineage",
    sessionId: "session-lineage",
    turnId: "turn-lineage",
  });
  const command = {
    schemaVersion: "workbench-v1",
    commandId: "command-lineage",
    workspaceId: "workspace-a",
    userId: "alice",
    kind: "agent_turn",
    sessionId: "session-lineage",
    turnId: "turn-lineage",
    status: "running",
  };
  const cases = [
    {
      name: "missing command",
      input: canonical,
      resolve: async () => null,
      code: "execution_product_command_not_found",
    },
    {
      name: "terminal command",
      input: canonical,
      resolve: async () => ({ ...command, status: "completed" }),
      code: "execution_product_command_not_active",
    },
    {
      name: "wrong principal",
      input: { ...canonical, actor: { userId: "mallory" } },
      resolve: async () => command,
      code: "execution_product_command_identity_mismatch",
    },
    {
      name: "wrong workspace",
      input: { ...canonical, workspaceId: "workspace-b" },
      resolve: async () => command,
      code: "execution_product_command_identity_mismatch",
    },
    {
      name: "wrong session",
      input: { ...canonical, lineage: { ...canonical.lineage, sessionId: "session-other" } },
      resolve: async () => command,
      code: "execution_product_command_lineage_mismatch",
    },
    {
      name: "wrong turn",
      input: { ...canonical, lineage: { ...canonical.lineage, turnId: "turn-other" } },
      resolve: async () => command,
      code: "execution_product_command_lineage_mismatch",
    },
    {
      name: "wrong target",
      input: { ...canonical, controller: { ...canonical.controller, controllerId: "turn-other" } },
      resolve: async () => command,
      code: "execution_product_command_target_mismatch",
    },
    {
      name: "requestedBy cannot replace actor",
      input: { ...canonical, actor: undefined, metadata: { requestedBy: "alice" } },
      resolve: async () => command,
      code: "execution_admission_identity_missing",
    },
    {
      name: "controller cannot replace Product Command lineage",
      input: { ...canonical, lineage: undefined, metadata: { productCommandId: "command-lineage" } },
      resolve: async () => command,
      code: "execution_admission_identity_missing",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const persistence = new InMemoryCapacityPersistence();
      const controller = new AdmissionController({
        persistence,
        clock: () => "2026-08-01T00:00:00.000Z",
        idFactory: (kind) => `${kind}-negative`,
        resolveProductCommand: testCase.resolve,
      });
      await assert.rejects(
        controller.acquire({ request: testCase.input }),
        (error) => error?.code === testCase.code,
      );
      assert.equal(persistence.waiting.size, 0);
      assert.equal(persistence.leases.size, 0);
      assert.equal(persistence.counters.size, 0);
    });
  }
});

test("AdmissionController admits a canonical Workflow Run command without Agent session lineage", async () => {
  const workflowRequest = {
    ...request({ invocationId: "invocation-workflow-run", userId: "alice", commandId: "command-workflow-run" }),
    lineage: { productCommandId: "command-workflow-run" },
    controller: { kind: "workflow_run", controllerId: "run-workflow-1", fence: 1 },
  };
  const { controller } = fixture({}, {
    resolveProductCommand: async () => ({
      schemaVersion: "workbench-v1",
      commandId: "command-workflow-run",
      workspaceId: "workspace-a",
      userId: "alice",
      kind: "workflow_run",
      sessionId: null,
      turnId: null,
      targetId: "run-workflow-1",
      status: "accepted",
    }),
  });

  const lease = await controller.acquire({ request: workflowRequest });
  assert.equal(lease.commandId, "command-workflow-run");
  await controller.release(lease.capacityLeaseId);
});

test("AdmissionController admits an Agent Turn whose accepted command targets its newly-created Work Item", async () => {
  const teamWorkRequest = request({
    invocationId: "invocation-team-work-entry",
    userId: "alice",
    commandId: "command-team-work-entry",
    sessionId: "session-team-work-entry",
    turnId: "turn-team-work-entry",
  });
  const { controller } = fixture({}, {
    resolveProductCommand: async () => ({
      schemaVersion: "workbench-v1",
      commandId: "command-team-work-entry",
      workspaceId: "workspace-a",
      userId: "alice",
      kind: "agent_turn",
      sessionId: "session-team-work-entry",
      turnId: "turn-team-work-entry",
      targetKind: "work_item",
      targetId: "work-item-team-work-entry",
      targetRevision: 1,
      status: "accepted",
    }),
  });

  const lease = await controller.acquire({ request: teamWorkRequest });
  assert.equal(lease.commandId, "command-team-work-entry");
});

test("AdmissionController admits an Agent Turn whose target is its Work continuation Turn", async () => {
  const continuationRequest = request({
    invocationId: "invocation-work-continuation-turn",
    userId: "alice",
    commandId: "command-work-continuation-turn",
    sessionId: "session-work-continuation-turn",
    turnId: "turn-work-continuation-turn",
  });
  const { controller } = fixture({}, {
    resolveProductCommand: async () => ({
      commandId: "command-work-continuation-turn",
      workspaceId: "workspace-a",
      userId: "alice",
      kind: "agent_turn",
      sessionId: "session-work-continuation-turn",
      turnId: "turn-work-continuation-turn",
      targetKind: "work_item_continuation_turn",
      targetId: "turn-work-continuation-turn",
      targetRevision: 1,
      status: "accepted",
    }),
  });
  const lease = await controller.acquire({ request: continuationRequest });
  assert.equal(lease.commandId, "command-work-continuation-turn");
});

test("AdmissionController admits only the exact Product Tool approval continuation", async () => {
  const approvalId = "agent-tool-approval-a";
  const continuationRequest = {
    ...request({
      invocationId: "invocation-tool-approval-continuation",
      userId: "alice",
      commandId: "command-tool-approval-continuation",
      sessionId: "session-tool-approval-continuation",
      turnId: "turn-tool-approval-continuation",
    }),
    metadata: {
      toolApprovalResume: {
        approvalId,
        toolId: "lark.task.create",
        inputDigest: `sha256:${"a".repeat(64)}`,
      },
    },
  };
  const command = {
    commandId: "command-tool-approval-continuation",
    workspaceId: "workspace-a",
    userId: "alice",
    kind: "agent_tool_approval_decide",
    sessionId: "session-tool-approval-continuation",
    turnId: "turn-tool-approval-continuation",
    targetKind: "agent_tool_approval",
    targetId: approvalId,
    targetRevision: 1,
    status: "accepted",
  };
  const { controller, persistence } = fixture({}, {
    resolveProductCommand: async () => command,
  });

  const lease = await controller.acquire({ request: continuationRequest });
  assert.equal(lease.commandId, command.commandId);
  await controller.release(lease.capacityLeaseId);

  await assert.rejects(
    controller.acquire({
      request: {
        ...continuationRequest,
        invocationId: "invocation-tool-approval-forged",
        attemptId: "attempt-invocation-tool-approval-forged",
        metadata: {
          toolApprovalResume: {
            ...continuationRequest.metadata.toolApprovalResume,
            approvalId: "agent-tool-approval-other",
          },
        },
      },
    }),
    (error) => error?.code === "execution_product_command_target_mismatch",
  );
  assert.equal([...persistence.leases.values()].some((item) => item.status === "active"), false);
});

test("AdmissionController rejects a malformed Work-target Agent command before allocating capacity", async () => {
  const teamWorkRequest = request({
    invocationId: "invocation-invalid-team-work-entry",
    userId: "alice",
    commandId: "command-invalid-team-work-entry",
  });
  const { controller, persistence } = fixture({}, {
    resolveProductCommand: async () => ({
      schemaVersion: "workbench-v1",
      commandId: "command-invalid-team-work-entry",
      workspaceId: "workspace-a",
      userId: "alice",
      kind: "agent_turn",
      sessionId: teamWorkRequest.lineage.sessionId,
      turnId: teamWorkRequest.lineage.turnId,
      targetKind: "work_item",
      targetId: "work-item-invalid-team-work-entry",
      targetRevision: 2,
      status: "accepted",
    }),
  });

  await assert.rejects(
    controller.acquire({ request: teamWorkRequest }),
    (error) => error?.code === "execution_product_command_target_mismatch",
  );
  assert.equal(persistence.leases.size, 0);
});

test("AdmissionController rechecks Product Command state before lease and invocation authorization", async () => {
  const persistence = new InMemoryCapacityPersistence();
  const statuses = new Map([
    ["command-running", "running"],
    ["command-queued", "running"],
  ]);
  let id = 0;
  const controller = new AdmissionController({
    persistence,
    clock: () => "2026-08-01T00:00:00.000Z",
    idFactory: (kind) => `${kind}-recheck-${++id}`,
    limits: { user: 2, workspace: 1, backend: 1, provider: 1 },
    resolveProductCommand: async (identity, executionRequest) => ({
      ...activeProductCommand(identity, executionRequest),
      status: statuses.get(identity.commandId),
    }),
  });
  const runningRequest = request({
    invocationId: "invocation-running-recheck",
    userId: "alice",
    commandId: "command-running",
  });
  const queuedRequest = request({
    invocationId: "invocation-queued-recheck",
    userId: "bob",
    commandId: "command-queued",
  });
  const runningLease = await controller.acquire({ request: runningRequest });
  const queuedLease = controller.acquire({ request: queuedRequest });
  await new Promise((resolve) => setImmediate(resolve));

  statuses.set("command-queued", "completed");
  await controller.release(runningLease.capacityLeaseId);
  await assert.rejects(
    queuedLease,
    (error) => error?.code === "execution_product_command_not_active",
  );
  const queuedAdmission = [...persistence.waiting.values()].find(
    (item) => item.commandId === "command-queued",
  );
  assert.equal(queuedAdmission.state, "cancelled");
  assert.equal([...persistence.leases.values()].some(
    (item) => item.commandId === "command-queued",
  ), false);

  const authorizedRequest = request({
    invocationId: "invocation-authorize-recheck",
    userId: "alice",
    commandId: "command-running",
  });
  statuses.set("command-running", "running");
  const lease = await controller.acquire({ request: authorizedRequest });
  const admitted = {
    ...authorizedRequest,
    capacityAuthority: {
      admissionId: lease.admissionId,
      capacityLeaseId: lease.capacityLeaseId,
      fence: lease.fence,
    },
  };
  statuses.set("command-running", "completed");
  assert.equal(await controller.authorize(admitted), false);
  await controller.release(lease.capacityLeaseId);
});

test("AdmissionController cannot promote an aborted waiter across asynchronous admission boundaries", async (t) => {
  await t.test("abort during Product Command recheck never attempts capacity acquisition", async () => {
    const persistence = new InMemoryCapacityPersistence();
    const recheckEntered = deferred();
    const finishRecheck = deferred();
    let commandReads = 0;
    let tryAcquireCalls = 0;
    const originalTryAcquire = persistence.tryAcquire.bind(persistence);
    persistence.tryAcquire = async (lease) => {
      tryAcquireCalls += 1;
      return originalTryAcquire(lease);
    };
    const controller = new AdmissionController({
      persistence,
      clock: () => "2026-08-01T00:00:00.000Z",
      idFactory: (kind) => `${kind}-abort-recheck`,
      resolveProductCommand: async (identity, executionRequest) => {
        commandReads += 1;
        if (commandReads === 2) {
          recheckEntered.resolve();
          await finishRecheck.promise;
        }
        return activeProductCommand(identity, executionRequest);
      },
    });
    const abort = new AbortController();
    const acquiring = controller.acquire({
      request: request({
        invocationId: "invocation-abort-recheck",
        userId: "alice",
        commandId: "command-abort-recheck",
      }),
      signal: abort.signal,
    });

    await recheckEntered.promise;
    abort.abort(new AdmissionControllerError("admission_cancelled"));
    finishRecheck.resolve();
    await assert.rejects(acquiring, { code: "admission_cancelled" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(tryAcquireCalls, 0);
    assert.equal(persistence.leases.size, 0);
    assert.equal([...persistence.counters.values()].some((value) => value !== 0), false);
    assert.equal([...persistence.waiting.values()][0].state, "cancelled");
  });

  await t.test("abort after atomic acquisition releases the lease before pump completion", async () => {
    const persistence = new InMemoryCapacityPersistence();
    const leaseCreated = deferred();
    const returnLease = deferred();
    const originalTryAcquire = persistence.tryAcquire.bind(persistence);
    const originalRelease = persistence.release.bind(persistence);
    let releaseCalls = 0;
    persistence.tryAcquire = async (lease) => {
      const acquired = await originalTryAcquire(lease);
      leaseCreated.resolve(acquired);
      await returnLease.promise;
      return acquired;
    };
    persistence.release = async (...input) => {
      releaseCalls += 1;
      return originalRelease(...input);
    };
    const controller = new AdmissionController({
      persistence,
      clock: () => "2026-08-01T00:00:00.000Z",
      idFactory: (kind) => `${kind}-abort-acquire`,
      resolveProductCommand: activeProductCommand,
    });
    const abort = new AbortController();
    const acquiring = controller.acquire({
      request: request({
        invocationId: "invocation-abort-acquire",
        userId: "alice",
        commandId: "command-abort-acquire",
      }),
      signal: abort.signal,
    });

    const lease = await leaseCreated.promise;
    assert.equal(persistence.leases.get(lease.capacityLeaseId).status, "active");
    abort.abort(new AdmissionControllerError("admission_cancelled"));
    returnLease.resolve();
    await assert.rejects(acquiring, { code: "admission_cancelled" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(persistence.leases.get(lease.capacityLeaseId).status, "released");
    assert.equal(releaseCalls, 1);
    assert.equal([...persistence.counters.values()].some((value) => value !== 0), false);
    assert.notEqual([...persistence.waiting.values()][0].state, "running");
  });
});

test("AdmissionController admits a Skill Test only through its matching skill_test Product Command", async () => {
  const persistence = new InMemoryCapacityPersistence();
  const controller = new AdmissionController({
    persistence,
    clock: () => "2026-08-01T00:00:00.000Z",
    idFactory: (kind) => `${kind}-skill-test`,
    resolveProductCommand: async (identity) => ({
      ...identity,
      schemaVersion: "workbench-v1",
      kind: "skill_test",
      sessionId: "skill-draft-1",
      turnId: "skill-test-run-1",
      status: "accepted",
    }),
  });
  const input = {
    ...request({
      invocationId: "skill-test-invocation-1",
      userId: "alice",
      commandId: "skill-test-run-1",
      sessionId: "skill-draft-1",
      turnId: "skill-test-run-1",
    }),
    controller: { kind: "skill_test", controllerId: "skill-test-run-1", fence: 1 },
  };
  const lease = await controller.acquire({ request: input });
  assert.equal(await controller.authorize({
    ...input,
    capacityAuthority: {
      admissionId: lease.admissionId,
      capacityLeaseId: lease.capacityLeaseId,
      fence: lease.fence,
    },
  }), true);
  await controller.release(lease.capacityLeaseId);
});

test("AdmittedExecutionDispatcher injects a validated lease and always releases it", async () => {
  const { controller, persistence } = fixture();
  let observed;
  const dispatcher = new AdmittedExecutionDispatcher({
    admissionController: controller,
    broker: {
      async execute(input) {
        observed = input;
        assert.equal(await controller.authorize(input), true);
        return { status: "completed" };
      },
      async cancel() { return { status: "cancelled" }; },
      registerBackend() {},
      hasBackend() { return true; },
      probeBackend() { return { available: true }; },
      listInvocations() { return []; },
      getInvocation() { return null; },
      listEvents() { return []; },
    },
  });
  const result = await dispatcher.execute(request({
    invocationId: "invocation-dispatch",
    userId: "alice",
    commandId: "command-dispatch",
  }));
  assert.equal(result.status, "completed");
  assert.ok(observed.capacityAuthority.capacityLeaseId);
  assert.equal(persistence.leases.get(observed.capacityAuthority.capacityLeaseId).status, "released");
});

test("AdmittedExecutionDispatcher retains Capacity authority from preparation through execution", async () => {
  const { controller, persistence: capacityPersistence } = fixture({ user: 1, workspace: 1, backend: 1, provider: 1 });
  const executionPersistence = new InMemoryExecutionPersistence();
  let id = 0;
  const broker = new ExecutionBroker({
    persistence: executionPersistence,
    clock: () => "2026-08-01T00:00:00.000Z",
    idFactory: (kind) => `${kind}-prepared-${++id}`,
    capacityAuthorizer: controller,
  });
  broker.registerBackend({
    mode: "bounded_agent",
    isolation: "process",
    backend: {
      async execute() {
        return {
          output: {},
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const dispatcher = new AdmittedExecutionDispatcher({ admissionController: controller, broker });
  const input = request({
    invocationId: "invocation-prepared-dispatch",
    userId: "alice",
    commandId: "command-prepared-dispatch",
  });
  const reservation = await dispatcher.reserveExecution(input);
  assert.equal(await executionPersistence.getInvocation(input.invocationId), null);
  assert.equal(capacityPersistence.counters.get("user:alice"), 1);
  const prepared = await dispatcher.prepareExecution(input, {
    reservation,
    uow: Object.freeze({ kind: "workflow-run-uow" }),
  });

  assert.equal((await executionPersistence.getInvocation(input.invocationId)).status, "queued");
  assert.equal(capacityPersistence.counters.get("user:alice"), 1);
  assert.equal((await dispatcher.execute(input, { preparedExecution: prepared })).status, "completed");
  assert.equal((await executionPersistence.getInvocation(input.invocationId)).status, "completed");
  assert.equal(capacityPersistence.counters.get("user:alice"), 0);
});

test("AdmittedExecutionDispatcher settles Execution and Capacity authority in the caller's UoW", async () => {
  const { controller, persistence: capacityPersistence } = fixture({ user: 1, workspace: 1, backend: 1, provider: 1 });
  const executionPersistence = new InMemoryExecutionPersistence();
  let id = 0;
  const broker = new ExecutionBroker({
    persistence: executionPersistence,
    clock: () => "2026-08-01T00:00:00.000Z",
    idFactory: (kind) => `${kind}-deferred-${++id}`,
    capacityAuthorizer: controller,
  });
  broker.registerBackend({
    mode: "bounded_agent",
    isolation: "process",
    backend: {
      async execute() {
        return {
          output: {},
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const dispatcher = new AdmittedExecutionDispatcher({ admissionController: controller, broker });
  const input = request({
    invocationId: "invocation-deferred-dispatch",
    userId: "alice",
    commandId: "command-deferred-dispatch",
  });
  const reservation = await dispatcher.reserveExecution(input);
  const prepared = await dispatcher.prepareExecution(input, { reservation, start: true });
  const deferred = await dispatcher.execute(input, {
    preparedExecution: prepared,
    deferSettlement: true,
  });
  assert.equal(deferred.result.status, "completed");
  assert.equal((await executionPersistence.getInvocation(input.invocationId)).status, "running");
  assert.equal(capacityPersistence.counters.get("user:alice"), 1);

  await dispatcher.settleExecution(deferred, { uow: Object.freeze({ kind: "workflow-run-terminal-uow" }) });
  assert.equal((await executionPersistence.getInvocation(input.invocationId)).status, "completed");
  assert.equal(capacityPersistence.counters.get("user:alice"), 0);
  assert.equal(dispatcher.confirmExecutionSettlement(deferred).status, "completed");
});

test("AdmittedExecutionDispatcher rejects missing, expired, and wrong-scope leases before backend dispatch", async (t) => {
  const cases = [
    {
      name: "missing lease identity",
      setup() {
        const persistence = new InMemoryCapacityPersistence();
        persistence.tryAcquire = async (lease) => ({ ...lease, capacityLeaseId: undefined });
        return {
          controller: new AdmissionController({
            persistence,
            clock: () => "2026-08-01T00:00:00.000Z",
            idFactory: (kind) => `${kind}-missing`,
            resolveProductCommand: activeProductCommand,
          }),
        };
      },
    },
    {
      name: "expired lease",
      setup() {
        const persistence = new InMemoryCapacityPersistence();
        let clockReads = 0;
        return {
          controller: new AdmissionController({
            persistence,
            clock: () => (++clockReads < 3
              ? "2026-08-01T00:00:00.000Z"
              : "2026-08-01T00:10:00.000Z"),
            idFactory: (kind) => `${kind}-expired`,
            leaseDurationMs: 1_000,
            resolveProductCommand: activeProductCommand,
          }),
        };
      },
    },
    {
      name: "wrong workspace scope",
      setup() {
        const persistence = new InMemoryCapacityPersistence();
        const tryAcquire = persistence.tryAcquire.bind(persistence);
        persistence.tryAcquire = (lease) => tryAcquire({ ...lease, workspaceId: "workspace-other" });
        return {
          controller: new AdmissionController({
            persistence,
            clock: () => "2026-08-01T00:00:00.000Z",
            idFactory: (kind) => `${kind}-wrong-scope`,
            resolveProductCommand: activeProductCommand,
          }),
        };
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { controller } = testCase.setup();
      let backendCalls = 0;
      const dispatcher = new AdmittedExecutionDispatcher({
        admissionController: controller,
        broker: {
          async execute() { backendCalls += 1; return { status: "completed" }; },
          async cancel() { return { status: "cancelled" }; },
        },
      });
      await assert.rejects(
        dispatcher.execute(request({
          invocationId: `invocation-${testCase.name.replaceAll(" ", "-")}`,
          userId: "alice",
          commandId: "command-lease-negative",
        })),
        (error) => error?.code === "execution_capacity_lease_invalid",
      );
      assert.equal(backendCalls, 0);
    });
  }
});

test("Capacity Lease remains valid for the full execution deadline plus settlement grace", async () => {
  const persistence = new InMemoryCapacityPersistence();
  let id = 0;
  const controller = new AdmissionController({
    persistence,
    clock: () => "2026-08-01T00:00:00.000Z",
    idFactory: (kind) => `${kind}-long-${++id}`,
    leaseDurationMs: 1_000,
    resolveProductCommand: activeProductCommand,
  });
  const base = request({
    invocationId: "invocation-long",
    userId: "alice",
    commandId: "command-long",
  });
  const lease = await controller.acquire({
    request: request({
      invocationId: "invocation-long",
      userId: "alice",
      commandId: "command-long",
      limits: { ...base.limits, timeoutMs: 60_000 },
    }),
  });

  assert.equal(
    Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt),
    65_000,
  );
  await controller.release(lease.capacityLeaseId);
});

test("Capacity Lease heartbeat extends only the matching live fence", async () => {
  const persistence = new InMemoryCapacityPersistence();
  let now = "2026-08-01T00:00:00.000Z";
  let id = 0;
  const controller = new AdmissionController({
    persistence,
    clock: () => now,
    idFactory: (kind) => `${kind}-heartbeat-${++id}`,
    leaseDurationMs: 30_000,
    resolveProductCommand: activeProductCommand,
  });
  const lease = await controller.acquire({
    request: request({
      invocationId: "invocation-heartbeat",
      userId: "alice",
      commandId: "command-heartbeat",
    }),
  });
  now = "2026-08-01T00:00:10.000Z";
  const renewed = await controller.heartbeat(lease);
  assert.equal(renewed.expiresAt, "2026-08-01T00:00:40.000Z");
  assert.equal(await controller.heartbeat({ ...lease, fence: lease.fence + 1 }), null);
  await controller.release(lease.capacityLeaseId);
});

test("Session queue read model is tenant-scoped, fair, cancellable, and cursor-stable", async () => {
  const persistence = new InMemoryCapacityPersistence();
  let id = 0;
  const controller = new AdmissionController({
    persistence,
    clock: () => `2026-08-01T00:00:0${id}.000Z`,
    idFactory: (kind) => `${kind}-queue-${++id}`,
    limits: { user: 1, workspace: 1, backend: 1, provider: 1 },
    resolveProductCommand: activeProductCommand,
  });
  const first = await controller.acquire({
    request: request({ invocationId: "invocation-running", userId: "alice", commandId: "command-running" }),
  });
  const aborts = [new AbortController(), new AbortController(), new AbortController()];
  const waiting = [
    controller.acquire({
      request: request({ invocationId: "invocation-a2", userId: "alice", commandId: "command-a2", sessionId: "session-a", turnId: "turn-a2" }),
      signal: aborts[0].signal,
    }),
    controller.acquire({
      request: request({ invocationId: "invocation-b1", userId: "bob", commandId: "command-b1", sessionId: "session-b", turnId: "turn-b1" }),
      signal: aborts[1].signal,
    }),
    controller.acquire({
      request: request({ invocationId: "invocation-a3", userId: "alice", commandId: "command-a3", sessionId: "session-a", turnId: "turn-a3" }),
      signal: aborts[2].signal,
    }),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  const firstPage = await controller.readSessionQueue({
    userId: "alice",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    limit: 1,
  });
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].position, 1);
  assert.equal(firstPage.items[0].reasonCode, "waiting_capacity");
  assert.equal(firstPage.items[0].cancelAction.method, "POST");
  assert.equal(firstPage.page.hasMore, true);
  const secondPage = await controller.readSessionQueue({
    userId: "alice",
    workspaceId: "workspace-a",
    sessionId: "session-a",
    cursor: firstPage.page.nextCursor,
    limit: 1,
  });
  assert.equal(secondPage.items[0].turnId, "turn-a3");
  assert.equal(secondPage.items[0].position, 3);
  const forbidden = await controller.readSessionQueue({
    userId: "mallory",
    workspaceId: "workspace-a",
    sessionId: "session-a",
  });
  assert.deepEqual(forbidden.items, []);

  aborts.forEach((controllerAbort) => controllerAbort.abort());
  await Promise.allSettled(waiting);
  await controller.release(first.capacityLeaseId);
});

test("orchestrator dispatch reserves four Product-owned child slots before backend launch", async () => {
  const { controller, persistence } = fixture({ user: 5, workspace: 5, backend: 4, provider: 5 });
  let observed = null;
  const dispatcher = new AdmittedExecutionDispatcher({
    admissionController: controller,
    broker: {
      async execute(input, options) {
        observed = { input, options };
        assert.equal(input.metadata.admittedChildConcurrency, 4);
        assert.equal(options.childCapacityPool.leases.length, 4);
        assert.equal(persistence.counters.get("user:alice"), 5);
        return { status: "completed" };
      },
      async cancel() { return { status: "cancelled" }; },
      registerBackend() {},
      hasBackend() { return true; },
      probeBackend() { return { available: true }; },
      listInvocations() { return []; },
      getInvocation() { return null; },
      listEvents() { return []; },
    },
  });
  const base = request({
    invocationId: "invocation-orchestrator",
    userId: "alice",
    commandId: "command-orchestrator",
  });
  await dispatcher.execute({
    ...base,
    mode: "agent_orchestrator",
    limits: { ...base.limits, maxChildren: 8 },
  });

  assert.equal(observed.options.childCapacityPool.leases.length, 4);
  assert.equal(persistence.counters.get("user:alice"), 0);
  assert.equal(persistence.waiting.size, 5);
  assert([...persistence.waiting.values()].every(
    (item) => item.kind === "execution_invocation" && item.commandId === "command-orchestrator",
  ));
});

test("AdmittedExecutionDispatcher keeps Realtime capacity until terminal settlement", async () => {
  const { controller, persistence } = fixture({ user: 1, workspace: 1, backend: 1, provider: 1 });
  let admittedRequest = null;
  let streamOptions = null;
  const authority = {
    attemptId: "attempt-invocation-realtime-dispatch",
    capabilityLeaseId: "capability-realtime-dispatch",
    fence: 1,
  };
  const dispatcher = new AdmittedExecutionDispatcher({
    admissionController: controller,
    broker: {
      async execute() { throw new Error("not_used"); },
      async openStream(input, options) {
        admittedRequest = input;
        streamOptions = options;
        assert.equal(await controller.authorize(input), true);
        return {
          ready: {
            invocationId: input.invocationId,
            attemptId: input.attemptId,
          },
          authority,
          completion: new Promise(() => {}),
        };
      },
      async updateStream(invocationId, update, options) {
        assert.equal(invocationId, admittedRequest.invocationId);
        assert.equal(update.kind, "session_instructions");
        assert.deepEqual(options.authority, authority);
        return { status: "running" };
      },
      async finishStream(invocationId, options) {
        assert.equal(invocationId, admittedRequest.invocationId);
        assert.deepEqual(options.authority, authority);
        const result = { status: "completed" };
        await streamOptions.onTerminal(result);
        return result;
      },
      async cancel() { return { status: "cancelled" }; },
    },
  });
  const base = request({
    invocationId: "invocation-realtime-dispatch",
    userId: "alice",
    commandId: "command-realtime-dispatch",
  });
  const input = {
    ...base,
    controller: {
      kind: "skill_creation_turn",
      controllerId: base.lineage.turnId,
      fence: 1,
    },
    mode: "realtime_audio",
    isolation: "process",
    modelProfileRevisionId: "model-revision-realtime-dispatch",
  };

  await dispatcher.openStream(input, { offer: { sdpOffer: "v=0\r\nm=audio 9 RTP/AVP 0\r\n" } });
  assert.ok(admittedRequest.capacityAuthority.capacityLeaseId);
  assert.equal(persistence.counters.get("user:alice"), 1);
  await assert.rejects(
    dispatcher.openStream(input, { offer: { sdpOffer: "v=0\r\nm=audio 9 RTP/AVP 0\r\n" } }),
    { code: "execution_stream_already_admitted" },
  );
  assert.equal(persistence.counters.get("user:alice"), 1);
  await dispatcher.updateStream(input.invocationId, {
    kind: "session_instructions",
    instructions: "Ask the next question.",
  });
  assert.equal((await dispatcher.finishStream(input.invocationId)).status, "completed");
  assert.equal(persistence.counters.get("user:alice"), 0);
});

test("AdmittedExecutionDispatcher retries a failed Realtime capacity release", async () => {
  const { controller, persistence } = fixture({ user: 1, workspace: 1, backend: 1, provider: 1 });
  const originalRelease = persistence.release.bind(persistence);
  let releaseAttempts = 0;
  persistence.release = async (...args) => {
    releaseAttempts += 1;
    if (releaseAttempts === 1) throw Object.assign(new Error("release failed"), { code: "capacity_release_failed" });
    return originalRelease(...args);
  };
  let streamOptions = null;
  const authority = {
    attemptId: "attempt-invocation-realtime-release-retry",
    capabilityLeaseId: "capability-realtime-release-retry",
    fence: 1,
  };
  const dispatcher = new AdmittedExecutionDispatcher({
    admissionController: controller,
    broker: {
      async execute() { throw new Error("not_used"); },
      async openStream(input, options) {
        streamOptions = options;
        return {
          ready: { invocationId: input.invocationId, attemptId: input.attemptId },
          authority,
          completion: new Promise(() => {}),
        };
      },
      async finishStream() {
        const result = { status: "completed" };
        await streamOptions.onTerminal(result).catch(() => {});
        return result;
      },
      async cancel() { return { status: "cancelled" }; },
    },
  });
  const base = request({
    invocationId: "invocation-realtime-release-retry",
    userId: "alice",
    commandId: "command-realtime-release-retry",
  });
  const input = {
    ...base,
    controller: { kind: "skill_creation_turn", controllerId: base.lineage.turnId, fence: 1 },
    mode: "realtime_audio",
    isolation: "process",
    modelProfileRevisionId: "model-revision-realtime-release-retry",
  };

  const opened = await dispatcher.openStream(input, { offer: { sdpOffer: "v=0\r\nm=audio 9 RTP/AVP 0\r\n" } });
  assert.equal(Object.hasOwn(opened.ready, "authority"), false);
  assert.equal(Object.hasOwn(opened, "authority"), false);
  assert.equal((await dispatcher.finishStream(input.invocationId)).status, "completed");
  assert.equal(releaseAttempts, 2);
  assert.equal(persistence.counters.get("user:alice"), 0);
});

test("post-open Realtime heartbeat loss fails explicitly and fences Provider events", async () => {
  const { controller, persistence: capacityPersistence } = fixture(
    { user: 1, workspace: 1, backend: 1, provider: 1 },
    { heartbeatIntervalMs: 1_000, leaseDurationMs: 3_000 },
  );
  const executionPersistence = new InMemoryExecutionPersistence();
  let executionId = 0;
  const broker = new ExecutionBroker({
    persistence: executionPersistence,
    clock: () => "2026-08-01T00:00:00.000Z",
    idFactory: (kind) => `${kind}-heartbeat-loss-${++executionId}`,
    capacityAuthorizer: controller,
    streamBackendSettlementTimeoutMs: 20,
  });
  let providerSignal = null;
  let providerEmit = null;
  broker.registerBackend({
    mode: "realtime_audio",
    isolation: "process",
    backend: {
      async open({ signal, emit }) {
        providerSignal = signal;
        providerEmit = emit;
        return {
          sdpAnswer: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n",
          handle: { callId: "call-heartbeat-loss" },
        };
      },
      async update() { return {}; },
      async finish() { return {}; },
      async cancel() { return { status: "cancelled" }; },
    },
  });
  const dispatcher = new AdmittedExecutionDispatcher({ admissionController: controller, broker });
  const original = request({
    invocationId: "invocation-realtime-heartbeat-loss",
    userId: "alice",
    commandId: "command-realtime-heartbeat-loss",
  });
  const { input: _unusedInput, ...base } = original;
  const realtimeInput = {
    ...base,
    controller: { kind: "skill_creation_turn", controllerId: base.lineage.turnId, fence: 1 },
    mode: "realtime_audio",
    isolation: "process",
    modelProfileRevisionId: "model-revision-realtime-heartbeat-loss",
    modelCapability: "realtime_audio",
    fallbackModelProfileRevisionIds: [],
    limits: {
      ...base.limits,
      timeoutMs: 5_000,
      maxChildren: 0,
      maxDepth: 0,
      maxSpawnedChildren: 0,
    },
  };
  const opened = await dispatcher.openStream(realtimeInput, {
    offer: { sdpOffer: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" },
  });
  capacityPersistence.heartbeat = async () => null;

  const result = await Promise.race([
    opened.completion,
    new Promise((_, reject) => setTimeout(() => reject(new Error("heartbeat_loss_not_observed")), 2_500)),
  ]);
  assert.equal(result.status, "failed");
  assert.equal(result.summary, "Execution capacity lease was lost.");
  assert.equal(providerSignal.aborted, true);
  assert.equal((await executionPersistence.getInvocation(realtimeInput.invocationId)).status, "failed");
  assert.equal(capacityPersistence.counters.get("user:alice"), 0);
  await assert.rejects(
    providerEmit("realtime.state", { state: "listening" }),
    { code: "execution_result_rejected_by_fence" },
  );
});

test("AdmittedExecutionDispatcher recovery releases persisted Realtime capacity", async () => {
  const { controller, persistence } = fixture({ user: 1, workspace: 1, backend: 1, provider: 1 });
  const input = request({
    invocationId: "invocation-realtime-startup-recovery",
    userId: "alice",
    commandId: "command-realtime-startup-recovery",
  });
  const lease = await controller.acquire({ request: input });
  assert.equal(persistence.counters.get("user:alice"), 1);
  const dispatcher = new AdmittedExecutionDispatcher({
    admissionController: controller,
    broker: {
      async execute() { throw new Error("not_used"); },
      async cancel() { return { status: "cancelled" }; },
      async recoverStreams() {
        return [{
          invocationId: input.invocationId,
          capacityLeaseId: lease.capacityLeaseId,
          result: { status: "failed" },
        }];
      },
    },
  });

  assert.deepEqual(await dispatcher.recoverStreams(), [{
    invocationId: input.invocationId,
    status: "failed",
  }]);
  assert.equal(persistence.counters.get("user:alice"), 0);
});
