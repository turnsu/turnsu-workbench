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
  return {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId,
    attemptId: overrides.attemptId ?? `attempt-${invocationId}`,
    workspaceId: "workspace-alpha",
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
}

function broker(persistence = new InMemoryExecutionPersistence()) {
  let sequence = 0;
  return {
    persistence,
    value: new ExecutionBroker({
      persistence,
      clock: () => NOW,
      idFactory: (kind) => `${kind}-${++sequence}`,
    }),
  };
}

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
  assert.equal((await persistence.getInvocation(input.invocationId)).status, "completed");
  assert.deepEqual(
    persistence.events.get(input.invocationId).map((event) => event.type),
    ["execution.started", "execution.completed"],
  );
  assert.equal(persistence.checkpoints.get(input.invocationId).length, 1);
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
  });

  const result = await value.execute(input);
  const invocations = await persistence.listInvocations({ controllerId: "run-alpha" });
  const children = invocations.filter((invocation) => invocation.parentInvocationId === input.invocationId);

  assert.equal(result.status, "completed");
  assert.equal(children.length, 2);
  assert(children.every((invocation) => invocation.mode === "bounded_agent"));
  assert(children.every((invocation) => invocation.controller.controllerId === "run-alpha"));
  assert.equal((persistence.events.get(input.invocationId) ?? []).filter((event) => event.type === "execution.child_recorded").length, 2);
});
