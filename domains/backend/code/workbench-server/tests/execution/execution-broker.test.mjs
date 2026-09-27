import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilitiesAreSubset,
  createDeterministicSkillBackend,
  ExecutionBroker,
  InMemoryExecutionPersistence,
} from "../../src/execution/index.mjs";

const NOW = "2026-07-16T10:00:00.000Z";
let id = 0;

function request(overrides = {}) {
  const invocationId = overrides.invocationId ?? `invocation-${++id}`;
  const value = {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId,
    attemptId: overrides.attemptId ?? `attempt-${invocationId}`,
    workspaceId: "workspace-alpha",
    actor: { userId: "user-alpha" },
    lineage: { productCommandId: "product-command-alpha" },
    controller: { kind: "workflow_run", controllerId: "run-alpha", fence: 7 },
    mode: "deterministic_skill",
    isolation: "process",
    goal: "Execute the pinned Skill.",
    input: { text: invocationId },
    limits: {
      timeoutMs: 5000,
      maxSteps: 1,
      maxModelRequests: 0,
      maxChildren: 0,
      maxInputBytes: 10000,
      maxOutputBytes: 10000,
      maxImageCount: 0,
      maxCostUsdMicros: 1_000_000,
    },
    capabilities: {
      toolAllowlist: [],
      connectionIds: [],
      network: false,
      filesystem: "none",
      externalActions: false,
    },
    resultSchema: {
      type: "object",
      properties: { echo: { type: "string" } },
      required: ["echo"],
      additionalProperties: false,
    },
    evidenceRequirements: [{
      requirementId: "output",
      kind: "output",
      required: true,
      description: "Return the output.",
    }],
    metadata: { executionRef: { capabilityId: "echo" } },
    ...overrides,
  };
  if (value.mode === "agent_orchestrator") {
    value.metadata = {
      allowedChildren: ["research", "review", "live-research", "cancel-me", "fail-with-parent"],
      ...value.metadata,
    };
  }
  return value;
}

function broker(
  persistence = new InMemoryExecutionPersistence(),
  capacityAuthorizer = { async authorize() { return true; } },
) {
  let sequence = 0;
  return {
    persistence,
    value: new ExecutionBroker({
      persistence,
      clock: () => NOW,
      idFactory: (kind) => `${kind}-${++sequence}`,
      capacityAuthorizer,
    }),
  };
}

function childCapacityPool(count) {
  const released = [];
  return {
    released,
    leases: Array.from({ length: count }, (_, index) => ({
      admissionId: `child-admission-${index + 1}`,
      capacityLeaseId: `child-capacity-lease-${index + 1}`,
      fence: 1,
    })),
    async release(capacityLeaseId) { released.push(capacityLeaseId); },
  };
}

test("Broker rejects execution before persistence when Capacity Lease authorization fails", async () => {
  const { value, persistence } = broker(
    new InMemoryExecutionPersistence(),
    { async authorize() { return false; } },
  );
  await assert.rejects(
    value.execute(request()),
    (error) => error?.code === "execution_capacity_lease_invalid"
      && error?.status === "permission_denied",
  );
  assert.equal(persistence.invocations.size, 0);
  assert.equal(persistence.attempts.size, 0);
});

test("Broker rejects an orchestrator before persistence when no child Capacity pool was admitted", async () => {
  const { value, persistence } = broker();
  const input = request({
    mode: "agent_orchestrator",
    limits: { ...request().limits, maxChildren: 1 },
  });
  await assert.rejects(
    value.execute(input),
    { code: "execution_child_capacity_unavailable", status: "blocked" },
  );
  assert.equal(await persistence.getInvocation(input.invocationId), null);
});

test("Broker executes a previously prepared Product invocation exactly once", async () => {
  const { value, persistence } = broker();
  const input = request();
  let backendCalls = 0;
  value.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: {
      async execute({ request: executionRequest }) {
        backendCalls += 1;
        return {
          output: { echo: executionRequest.input.text },
          usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const prepared = await value.prepareExecution(input);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "queued");
  assert.equal((await value.execute(input, { preparedExecution: prepared })).status, "completed");
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "completed");
  assert.equal((await value.execute(input, { preparedExecution: prepared })).status, "completed");
  assert.equal(backendCalls, 1);
});

test("Broker defers a prepared terminal result until the caller's Product UoW settles it", async () => {
  const { value, persistence } = broker();
  const input = request();
  const callerUow = Object.freeze({ kind: "workflow-run-terminal-uow" });
  let settlementUow = null;
  const completeAttempt = persistence.completeAttempt.bind(persistence);
  persistence.completeAttempt = async (attemptId, fence, result, options) => {
    settlementUow = options?.uow ?? null;
    return completeAttempt(attemptId, fence, result, options);
  };
  value.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: {
      async execute({ request: executionRequest }) {
        return {
          output: { echo: executionRequest.input.text },
          usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });

  const prepared = await value.prepareExecution(input, { start: true });
  const deferred = await value.execute(input, { preparedExecution: prepared, deferSettlement: true });
  assert.equal(deferred.schemaVersion, "workbench-deferred-execution-settlement-v1");
  assert.equal(deferred.result.status, "completed");
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "running");

  await value.settleExecution(deferred, { uow: callerUow });
  assert.equal(settlementUow, callerUow);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "completed");
  assert.equal(value.confirmExecutionSettlement(deferred).status, "completed");
});

test("Broker keeps prepared execution authority in the caller's Product UoW", async () => {
  const persistence = new InMemoryExecutionPersistence();
  const original = persistence.createExecutionAuthority.bind(persistence);
  const callerUow = Object.freeze({ kind: "workflow-run-uow" });
  let receivedUow = null;
  persistence.createExecutionAuthority = async (records, options) => {
    receivedUow = options?.uow ?? null;
    return original(records, options);
  };
  const { value } = broker(persistence);

  await value.prepareExecution(request(), { uow: callerUow });

  assert.equal(receivedUow, callerUow);
});

test("Broker enforces orchestrator concurrency, depth, and declared child policy before persistence", async () => {
  for (const [limits, metadata, code] of [
    [{ ...request().limits, maxChildren: 5, maxSpawnedChildren: 100, maxDepth: 2 }, { allowedChildren: ["worker"], orchestrationDepth: 1 }, "execution_orchestrator_budget_invalid"],
    [{ ...request().limits, maxChildren: 1, maxSpawnedChildren: 100, maxDepth: 2 }, { allowedChildren: ["worker"], orchestrationDepth: 3 }, "execution_orchestrator_depth_exceeded"],
    [{ ...request().limits, maxChildren: 1, maxSpawnedChildren: 100, maxDepth: 2 }, { allowedChildren: [], orchestrationDepth: 1 }, "execution_allowed_children_required"],
  ]) {
    const { value, persistence } = broker();
    await assert.rejects(
      value.execute(request({ mode: "agent_orchestrator", limits, metadata }), {
        childCapacityPool: childCapacityPool(4),
      }),
      (error) => error?.code === code,
    );
    assert.equal(persistence.invocations.size, 0);
  }
});

test("Broker rejects undeclared child roles and enforces cumulative spawn separately from concurrency", async () => {
  const makeInput = (invocationId, backendChildren, overrides = {}) => {
    const { value, persistence } = broker();
    value.registerBackend({
      mode: "agent_orchestrator",
      isolation: "process",
      backend: { async execute() {
        return {
          output: { workflowStatus: "completed" },
          children: backendChildren,
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        };
      } },
    });
    const input = request({
      invocationId,
      attemptId: `attempt-${invocationId}`,
      mode: "agent_orchestrator",
      limits: {
        ...request().limits,
        maxSteps: 10,
        maxModelRequests: 10,
        maxChildren: 4,
        maxDepth: 2,
        maxSpawnedChildren: 2,
      },
      metadata: { allowedChildren: ["worker"], orchestrationDepth: 1, ...overrides.metadata },
      capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
      resultSchema: {
        type: "object",
        properties: { workflowStatus: { type: "string" } },
        required: ["workflowStatus"],
        additionalProperties: false,
      },
    });
    return { value, persistence, input };
  };
  const child = (childRef, role = "worker") => ({
    childRef,
    role,
    status: "completed",
    output: { childRef },
    usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
    capabilities: { toolAllowlist: [], connectionIds: [], network: false, filesystem: "none", externalActions: false },
  });

  const forbidden = makeInput("invocation-forbidden-child", [child("child-a", "admin")]);
  assert.equal((await forbidden.value.execute(forbidden.input, { childCapacityPool: childCapacityPool(4) })).status, "permission_denied");
  assert.equal(forbidden.persistence.invocations.size, 1);

  const overSpawn = makeInput("invocation-spawn-limit", [child("child-a"), child("child-b"), child("child-c")]);
  assert.equal((await overSpawn.value.execute(overSpawn.input, { childCapacityPool: childCapacityPool(4) })).status, "failed");
  const persistedChildren = [...overSpawn.persistence.invocations.values()]
    .filter((item) => item.parentInvocationId === overSpawn.input.invocationId);
  assert.equal(persistedChildren.length, 2);
});

test("backend probes distinguish missing, registered-unverified, ready, and unavailable runtimes", async () => {
  const { value } = broker();
  assert.deepEqual(
    await value.probeBackend({ mode: "bounded_agent", isolation: "container" }),
    { available: false, verified: true, reasonCode: "execution_backend_unavailable" },
  );
  value.registerBackend({
    mode: "bounded_agent",
    isolation: "process",
    backend: { async execute() { return {}; } },
  });
  assert.deepEqual(
    await value.probeBackend({ mode: "bounded_agent", isolation: "process" }),
    { available: true, verified: false, reasonCode: "execution_backend_probe_unavailable" },
  );
  value.registerBackend({
    mode: "bounded_agent",
    isolation: "container",
    backend: {
      async probe() { return { available: true }; },
      async execute() { return {}; },
    },
  });
  assert.deepEqual(
    await value.probeBackend({ mode: "bounded_agent", isolation: "container" }),
    { available: true, verified: true, reasonCode: "ready" },
  );
  value.registerBackend({
    mode: "agent_orchestrator",
    isolation: "container",
    backend: {
      async probe() { throw new Error("docker_down"); },
      async execute() { return {}; },
    },
  });
  assert.deepEqual(
    await value.probeBackend({ mode: "agent_orchestrator", isolation: "container" }),
    { available: false, verified: true, reasonCode: "execution_backend_unavailable" },
  );
});

test("deterministic Skill uses the direct backend with zero model requests", async () => {
  const { value, persistence } = broker();
  let calls = 0;
  value.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: createDeterministicSkillBackend({
      agentRuntime: {
        async invokeSkillNode({ input }) {
          calls += 1;
          return { echo: input.text };
        },
      },
    }),
  });

  const input = request();
  const result = await value.execute(input);
  assert.equal(calls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.usage.modelRequests, 0);
  assert.deepEqual(result.output, { echo: input.input.text });
  assert.equal((await value.getInvocation(input.invocationId)).status, "completed");
  assert.deepEqual(
    persistence.events.get(input.invocationId).map((event) => event.type),
    ["execution.started", "execution.completed"],
  );
  assert.equal(persistence.checkpoints.get(input.invocationId).length, 1);
});

test("Broker preserves schema-valid technical text while projecting undeclared adapter metadata", async () => {
  const { value, persistence } = broker();
  value.registerBackend({
    mode: "deterministic_skill",
    isolation: "container",
    backend: {
      async execute() {
        return {
          output: {
            result: "Document /proc/self/mountinfo and unix:///run/docker.sock for operators.",
            examplePath: "/Users/example/project is valid documentation text.",
          },
          hostPath: "/private/runtime/adapter-only",
          imageDigest: `sha256:${"a".repeat(64)}`,
          summary: "Read /proc/self/mountinfo for diagnostics.",
          usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const input = request({
    isolation: "container",
    resultSchema: { type: "object", additionalProperties: true },
  });

  const result = await value.execute(input);
  const invocation = await persistence.getInvocation(input.invocationId);
  const attempt = await persistence.getAttempt(input.attemptId);
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "Read /proc/self/mountinfo for diagnostics.");
  assert.deepEqual(result.output, {
    result: "Document /proc/self/mountinfo and unix:///run/docker.sock for operators.",
    examplePath: "/Users/example/project is valid documentation text.",
  });
  assert.equal(Object.hasOwn(result, "hostPath"), false);
  assert.equal(Object.hasOwn(result, "imageDigest"), false);
  assert.deepEqual(invocation.result, attempt.result);
  assert.deepEqual(
    persistence.events.get(input.invocationId).map((event) => [event.type, event.payload.summary]),
    [
      ["execution.started", undefined],
      ["execution.completed", "Read /proc/self/mountinfo for diagnostics."],
    ],
  );
});

test("ExecutionResult safety boundary preserves legitimate product image fields and API paths", async () => {
  const { value, persistence } = broker();
  value.registerBackend({
    mode: "deterministic_skill",
    isolation: "container",
    backend: {
      async execute() {
        return {
          output: {
            image: "artifact-image-1",
            path: "/api/v1/items",
            socketStatus: "not-connected",
          },
          usage: { steps: 1, modelRequests: 0, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const input = request({
    isolation: "container",
    resultSchema: {
      type: "object",
      properties: {
        image: { type: "string" },
        path: { type: "string" },
        socketStatus: { type: "string" },
      },
      required: ["image", "path", "socketStatus"],
      additionalProperties: false,
    },
  });

  const result = await value.execute(input);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.output, {
    image: "artifact-image-1",
    path: "/api/v1/items",
    socketStatus: "not-connected",
  });
  assert.deepEqual((await persistence.getAttempt(input.attemptId)).result.output, result.output);
});

test("deterministic Skill resolves governed material refs only at dispatch and never persists bytes", async () => {
  const { value, persistence } = broker();
  const contentHash = `sha256:${"a".repeat(64)}`;
  const binding = {
    materialKey: "source_file",
    source: {
      kind: "attachment",
      attachment: {
        attachmentId: "attachment-1",
        version: 1,
        contentHash,
        mediaType: "text/markdown",
      },
    },
  };
  const materialBytes = Buffer.from("# governed input");
  let resolverInput = null;
  let runtimeMaterials = null;
  value.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: createDeterministicSkillBackend({
      materialResolver: async (input) => {
        resolverInput = structuredClone({ ...input, signal: undefined });
        return [{
          materialKey: "source_file",
          mediaType: "text/markdown",
          contentHash,
          bytes: materialBytes,
          contextText: "# governed input",
        }];
      },
      agentRuntime: {
        async invokeSkillNode({ input, materials }) {
          runtimeMaterials = materials;
          return { echo: input.text };
        },
      },
    }),
  });

  const input = request({
    metadata: {
      executionRef: { capabilityId: "echo" },
      requestedBy: "user-1",
      materialBindings: [binding],
    },
  });
  const result = await value.execute(input);
  const persisted = await persistence.getInvocation(input.invocationId);

  assert.equal(result.status, "completed");
  assert.equal(resolverInput.requestedBy, "user-1");
  assert.deepEqual(resolverInput.bindings, [binding]);
  assert.equal(runtimeMaterials[0].bytes.toString("utf8"), "# governed input");
  assert.equal(result.usage.inputBytes, Buffer.byteLength(JSON.stringify(input.input)) + materialBytes.byteLength);
  const persistedJson = JSON.stringify(persisted.request);
  assert.match(persistedJson, /attachment-1/);
  assert.doesNotMatch(persistedJson, /governed input/);
  assert.doesNotMatch(persistedJson, /\/Users\//);
});

test("deterministic Skill rejects resolved materials that exceed the execution input budget", async () => {
  const { value } = broker();
  let invoked = false;
  value.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: createDeterministicSkillBackend({
      materialResolver: async () => [{
        materialKey: "source_file",
        mediaType: "text/plain",
        contentHash: `sha256:${"a".repeat(64)}`,
        bytes: Buffer.alloc(512, 1),
      }],
      agentRuntime: {
        async invokeSkillNode() {
          invoked = true;
          return {};
        },
      },
    }),
  });
  const input = request({
    limits: {
      ...request().limits,
      maxInputBytes: 128,
    },
    metadata: {
      executionRef: { capabilityId: "echo" },
      requestedBy: "user-1",
      materialBindings: [{
        materialKey: "source_file",
        source: {
          kind: "attachment",
          attachment: {
            attachmentId: "attachment-1",
            version: 1,
            contentHash: `sha256:${"a".repeat(64)}`,
            mediaType: "text/plain",
          },
        },
      }],
    },
  });
  const result = await value.execute(input);
  assert.equal(result.status, "blocked");
  assert.equal(result.summary, "Execution is blocked.");
  assert.equal(invoked, false);
});

test("bounded workers execute concurrently with isolated request contexts", async () => {
  const { value } = broker();
  const entered = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  value.registerBackend({
    mode: "bounded_agent",
    isolation: "process",
    backend: {
      async execute({ request: workerRequest }) {
        entered.push(workerRequest.input.text);
        if (entered.length === 2) release();
        await gate;
        workerRequest.input.text = "mutated-locally";
        return {
          output: { echo: entered.find((item) => item !== "mutated-locally") ?? "done" },
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const limits = { ...request().limits, maxSteps: 4, maxModelRequests: 2 };
  const first = request({ mode: "bounded_agent", limits, input: { text: "one" } });
  const second = request({ mode: "bounded_agent", limits, input: { text: "two" } });
  const [left, right] = await Promise.all([value.execute(first), value.execute(second)]);
  assert.deepEqual(entered.sort(), ["one", "two"]);
  assert.equal(left.status, "completed");
  assert.equal(right.status, "completed");
  assert.equal(first.input.text, "one");
  assert.equal(second.input.text, "two");
});

test("cancel revokes the lease, cascades abort, and fences a late result", async () => {
  const { value, persistence } = broker();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  value.registerBackend({
    mode: "bounded_agent",
    isolation: "process",
    backend: {
      async execute({ signal }) {
        entered();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        await Promise.resolve();
        return {
          output: { echo: "late" },
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const input = request({
    mode: "bounded_agent",
    limits: { ...request().limits, maxSteps: 4, maxModelRequests: 2 },
  });
  const running = value.execute(input);
  await started;
  const cancelled = await value.cancel(input.invocationId);
  const result = await running;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(result.status, "cancelled");
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "cancelled");
  assert.equal((await persistence.getAttempt(input.attemptId)).fence, 2);
  assert.equal([...persistence.leases.values()][0].status, "revoked");
});

test("cancel does not claim an in-flight external effect was undone without backend settlement", async () => {
  const { value, persistence } = broker();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  value.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: {
      async execute({ signal }) {
        entered();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { output: { echo: "late-external-result" } };
      },
    },
  });
  const input = request({
    capabilities: {
      toolAllowlist: ["lark.task.create"],
      connectionIds: ["connection-lark"],
      network: false,
      filesystem: "none",
      externalActions: true,
    },
  });
  const running = value.execute(input);
  await started;
  const cancellation = await value.cancel(input.invocationId);
  const result = await running;

  assert.equal(cancellation.status, "effect_outcome_unknown");
  assert.equal(result.status, "effect_outcome_unknown");
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "effect_outcome_unknown");
  assert.equal((await persistence.getAttempt(input.attemptId)).status, "effect_outcome_unknown");
});

test("external backend can explicitly settle cooperative cancellation as partial", async () => {
  const { value } = broker();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  value.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: {
      async execute({ signal }) {
        entered();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return { output: { echo: "late" } };
      },
      async cancel() { return { status: "partial" }; },
    },
  });
  const input = request({
    capabilities: {
      toolAllowlist: ["lark.task.create"],
      connectionIds: ["connection-lark"],
      network: false,
      filesystem: "none",
      externalActions: true,
    },
  });
  const running = value.execute(input);
  await started;
  assert.equal((await value.cancel(input.invocationId)).status, "partial");
  assert.equal((await running).status, "partial");
});

test("a pre-aborted request is cancelled before a backend can start", async () => {
  const { value, persistence } = broker();
  let backendCalls = 0;
  value.registerBackend({
    mode: "bounded_agent",
    isolation: "process",
    backend: { async execute() { backendCalls += 1; return { output: { echo: "wrong" } }; } },
  });
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  const input = request({
    mode: "bounded_agent",
    limits: { ...request().limits, maxSteps: 4, maxModelRequests: 2 },
  });
  const result = await value.execute(input, { signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(backendCalls, 0);
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "cancelled");
  assert.equal((await persistence.getAttempt(input.attemptId)).status, "cancelled");
});

test("cancel racing terminal settlement leaves attempt and invocation on one authoritative outcome", async () => {
  let enterSettlement;
  let releaseSettlement;
  const settlementEntered = new Promise((resolve) => { enterSettlement = resolve; });
  const settlementGate = new Promise((resolve) => { releaseSettlement = resolve; });
  class BarrierPersistence extends InMemoryExecutionPersistence {
    async completeAttempt(...args) {
      enterSettlement();
      await settlementGate;
      return super.completeAttempt(...args);
    }
  }
  const persistence = new BarrierPersistence();
  const { value } = broker(persistence);
  value.registerBackend({
    mode: "bounded_agent",
    isolation: "process",
    backend: {
      async execute() {
        return {
          output: { echo: "late-success" },
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const input = request({
    mode: "bounded_agent",
    limits: { ...request().limits, maxSteps: 4, maxModelRequests: 2 },
  });
  const executing = value.execute(input);
  await settlementEntered;
  const cancelling = value.cancel(input.invocationId, { reason: "race" });
  await new Promise((resolve) => setImmediate(resolve));
  releaseSettlement();
  const [executionResult, cancellationResult] = await Promise.all([executing, cancelling]);
  const invocation = await persistence.getInvocation(input.invocationId);
  const attempt = await persistence.getAttempt(input.attemptId);

  assert.equal(executionResult.status, "cancelled");
  assert.equal(cancellationResult.status, "cancelled");
  assert.equal(invocation.status, "cancelled");
  assert.equal(attempt.status, "cancelled");
  assert.equal(invocation.result.status, attempt.result.status);
  assert.equal(invocation.executionFence, attempt.fence);
});

test("unavailable isolation and invalid result states remain distinct", async () => {
  const missingContainer = broker().value;
  const sandbox = await missingContainer.execute(request({
    mode: "bounded_agent",
    isolation: "container",
    limits: { ...request().limits, maxSteps: 4, maxModelRequests: 2 },
  }));
  assert.equal(sandbox.status, "sandbox_unavailable");

  const missingRemote = broker().value;
  const remote = await missingRemote.execute(request({ isolation: "remote" }));
  assert.equal(remote.status, "remote_backend_unavailable");

  const invalid = broker().value;
  invalid.registerBackend({
    mode: "deterministic_skill",
    isolation: "process",
    backend: { async execute() { return { output: { wrong: true } }; } },
  });
  assert.equal((await invalid.execute(request())).status, "failed");
});

test("child capabilities must be a strict subset of the parent lease", () => {
  const parent = {
    toolAllowlist: ["read", "search"],
    connectionIds: ["connection-a"],
    network: false,
    filesystem: "scratch_write",
    externalActions: false,
  };
  assert.equal(capabilitiesAreSubset({
    toolAllowlist: ["read"],
    connectionIds: [],
    network: false,
    filesystem: "scratch_readonly",
    externalActions: false,
  }, parent), true);
  assert.equal(capabilitiesAreSubset({
    toolAllowlist: ["bash"],
    connectionIds: [],
    network: false,
    filesystem: "none",
    externalActions: false,
  }, parent), false);
});

test("orchestrator children become independent product invocations without changing the outer controller", async () => {
  const { value, persistence } = broker();
  value.registerBackend({
    mode: "agent_orchestrator",
    isolation: "process",
    backend: {
      async execute() {
        return {
          output: { workflowStatus: "completed" },
          usage: { steps: 2, modelRequests: 2, inputBytes: 10, outputBytes: 10 },
          children: ["research", "review"].map((childRef) => ({
            childRef,
            goal: `${childRef} bounded task`,
            status: "completed",
            output: { childRef },
            summary: `${childRef} complete`,
            usage: { steps: 1, modelRequests: 1, inputBytes: 5, outputBytes: 5 },
            capabilities: {
              toolAllowlist: ["read"], connectionIds: [], network: false,
              filesystem: "none", externalActions: false,
            },
          })),
        };
      },
    },
  });
  const input = request({
    mode: "agent_orchestrator",
    limits: { ...request().limits, maxSteps: 4, maxModelRequests: 4, maxChildren: 2 },
    capabilities: {
      toolAllowlist: ["read"], connectionIds: [], network: false,
      filesystem: "scratch_readonly", externalActions: false,
    },
    resultSchema: {
      type: "object",
      properties: { workflowStatus: { type: "string" } },
      required: ["workflowStatus"],
      additionalProperties: false,
    },
    metadata: {
      allowedChildren: ["research", "review"],
      modelProfileRevisionId: "model-revision-orchestrator-1",
      modelCapability: "structured_output",
      fallbackModelProfileRevisionIds: [],
    },
  });

  const capacityPool = childCapacityPool(2);
  const result = await value.execute(input, { childCapacityPool: capacityPool });
  const invocations = await persistence.listInvocations({ controllerId: "run-alpha" });
  const children = invocations.filter((invocation) => invocation.parentInvocationId === input.invocationId);

  assert.equal(result.status, "completed");
  assert.equal(children.length, 2);
  assert(children.every((invocation) => invocation.mode === "bounded_agent"));
  assert(children.every((invocation) => invocation.controller.controllerId === "run-alpha"));
  assert.equal(new Set(children.map(
    (invocation) => invocation.request.capacityAuthority.capacityLeaseId,
  )).size, 2);
  assert(children.every((invocation) => (
    invocation.request.actor.userId === "user-alpha"
    && invocation.request.lineage.productCommandId === "product-command-alpha"
    && invocation.request.lineage.parentInvocationId === input.invocationId
  )));
  assert(children.every((invocation) => (
    invocation.request.metadata.modelProfileRevisionId === "model-revision-orchestrator-1"
    && invocation.request.metadata.modelCapability === "structured_output"
    && invocation.request.metadata.capability === undefined
  )));
  assert.equal((persistence.events.get(input.invocationId) ?? []).filter((event) => event.type === "execution.child_recorded").length, 2);
  assert.deepEqual(new Set(capacityPool.released), new Set([
    "child-capacity-lease-1",
    "child-capacity-lease-2",
  ]));
});

test("orchestrator children are durable while the parent is still running", async () => {
  const { value, persistence } = broker();
  let continueParent;
  const gate = new Promise((resolve) => { continueParent = resolve; });
  let childStarted;
  const started = new Promise((resolve) => { childStarted = resolve; });
  value.registerBackend({
    mode: "agent_orchestrator",
    isolation: "process",
    backend: {
      async execute({ reportChild }) {
        await reportChild({
          childRef: "live-research",
          goal: "Research while the parent remains active.",
          status: "running",
          checkpoint: { cursor: 1 },
          capabilities: {
            toolAllowlist: ["read"], connectionIds: [], network: false,
            filesystem: "none", externalActions: false,
          },
        });
        childStarted();
        await gate;
        await reportChild({
          childRef: "live-research",
          status: "completed",
          output: { answer: "ready" },
          summary: "Research completed.",
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        });
        return {
          output: { workflowStatus: "completed" },
          usage: { steps: 1, modelRequests: 1, inputBytes: 1, outputBytes: 1 },
        };
      },
    },
  });
  const input = request({
    mode: "agent_orchestrator",
    limits: { ...request().limits, maxSteps: 2, maxModelRequests: 2, maxChildren: 1 },
    capabilities: {
      toolAllowlist: ["read"], connectionIds: [], network: false,
      filesystem: "scratch_readonly", externalActions: false,
    },
    resultSchema: {
      type: "object",
      properties: { workflowStatus: { type: "string" } },
      required: ["workflowStatus"],
      additionalProperties: false,
    },
  });

  const running = value.execute(input, { childCapacityPool: childCapacityPool(1) });
  await started;
  const liveChildren = (await persistence.listInvocations({ controllerId: "run-alpha" }))
    .filter((invocation) => invocation.parentInvocationId === input.invocationId);
  assert.equal(liveChildren.length, 1);
  assert.equal(liveChildren[0].status, "running");
  assert.equal((persistence.checkpoints.get(liveChildren[0].invocationId) ?? []).length, 1);
  continueParent();
  assert.equal((await running).status, "completed");
  assert.equal((await persistence.getInvocation(liveChildren[0].invocationId)).status, "completed");
});

test("parent cancellation revokes and terminally cancels live orchestrator children", async () => {
  const { value, persistence } = broker();
  let childStarted;
  const started = new Promise((resolve) => { childStarted = resolve; });
  value.registerBackend({
    mode: "agent_orchestrator",
    isolation: "process",
    backend: {
      async execute({ reportChild, signal }) {
        await reportChild({ childRef: "cancel-me", status: "running" });
        childStarted();
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    },
  });
  const input = request({
    mode: "agent_orchestrator",
    limits: { ...request().limits, maxSteps: 2, maxModelRequests: 2, maxChildren: 1 },
  });
  const running = value.execute(input, { childCapacityPool: childCapacityPool(1) });
  await started;
  const child = (await persistence.listInvocations({ controllerId: "run-alpha" }))
    .find((invocation) => invocation.parentInvocationId === input.invocationId);
  await value.cancel(input.invocationId, { reason: "user_cancelled" });
  assert.equal((await running).status, "cancelled");
  assert.equal((await persistence.getInvocation(child.invocationId)).status, "cancelled");
  assert.equal(await persistence.getActiveLease(child.invocationId, child.attemptId, "2026-07-16T10:00:00.000Z"), null);
});

test("orchestrator failure terminally cancels live children and revokes their leases", async () => {
  const { value, persistence } = broker();
  value.registerBackend({
    mode: "agent_orchestrator",
    isolation: "process",
    backend: {
      async execute({ reportChild }) {
        await reportChild({ childRef: "fail-with-parent", status: "running" });
        throw new Error("orchestrator crashed");
      },
    },
  });
  const input = request({
    mode: "agent_orchestrator",
    limits: { ...request().limits, maxSteps: 2, maxModelRequests: 2, maxChildren: 1 },
  });

  assert.equal((await value.execute(input, { childCapacityPool: childCapacityPool(1) })).status, "failed");
  const child = (await persistence.listInvocations({ controllerId: "run-alpha" }))
    .find((invocation) => invocation.parentInvocationId === input.invocationId);
  assert.equal(child.status, "cancelled");
  assert.equal(await persistence.getActiveLease(child.invocationId, child.attemptId, NOW), null);
});


test("execution failures persist only recognized public codes, never backend exception details", async () => {
  for (const code of ["provider_request_invalid", "provider_payment_required", "private_token_do_not_publish"]) {
    const { value, persistence } = broker();
    value.registerBackend({ mode: "deterministic_skill", isolation: "process", backend: {
      async execute() { throw Object.assign(new Error("secret provider response"), { code }); },
    } });
    const input = request();
    const result = await value.execute(input);
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, code.startsWith("provider_") ? code : undefined);
    assert.equal(JSON.stringify(result).includes("secret provider response"), false);
    assert.equal(JSON.stringify(result).includes("private_token"), false);
    assert.deepEqual((await value.getInvocation(input.invocationId)).result, result);
  }
});
