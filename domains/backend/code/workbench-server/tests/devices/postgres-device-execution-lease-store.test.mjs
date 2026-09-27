import assert from "node:assert/strict";
import test from "node:test";

import { PostgresDeviceExecutionLeaseStore } from "../../src/devices/postgres-device-execution-lease-store.mjs";

const now = "2026-08-13T12:00:00.000Z";

function binding(overrides = {}) {
  return {
    deviceId: "device-alice",
    workspaceId: "workspace-alpha",
    ownerUserId: "alice",
    clientSessionId: "native-session-alice",
    capabilityInventory: ["local_deterministic_skill"],
    workerProtocolVersion: "workbench-device-worker-v1",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: "workbench-execution-fabric-v1",
    invocationId: "invocation-alpha",
    attemptId: "attempt-alpha",
    workspaceId: "workspace-alpha",
    actor: { userId: "alice" },
    capacityAuthority: { capacityLeaseId: "capacity-lease-alpha" },
    mode: "deterministic_skill",
    isolation: "remote",
    limits: { maxModelRequests: 0, maxChildren: 0 },
    capabilities: { network: false, externalActions: false, filesystem: "none", connectionIds: [] },
    metadata: { executionRef: { capabilityId: "local_deterministic_skill" } },
    ...overrides,
  };
}

function lease(overrides = {}) {
  return {
    capabilityLeaseId: "capability-lease-alpha",
    invocationId: "invocation-alpha",
    attemptId: "attempt-alpha",
    workspaceId: "workspace-alpha",
    fence: 1,
    status: "active",
    expiresAt: "2026-08-13T12:05:00.000Z",
    ...overrides,
  };
}

function store() {
  const queries = [];
  const inserted = {
    device_execution_lease_id: "device-execution-lease-test",
    workspace_id: "workspace-alpha",
    device_id: "device-alice",
    native_client_session_id: "native-session-alice",
    invocation_id: "invocation-alpha",
    attempt_id: "attempt-alpha",
    capability_lease_id: "capability-lease-alpha",
    capacity_lease_id: "capacity-lease-alpha",
    fence: 1,
    connection_id: "device-connection-alpha",
    connection_fence: 1,
    status: "active",
    issued_at: now,
    expires_at: "2026-08-13T12:05:00.000Z",
    revoked_at: null,
    updated_at: now,
  };
  return {
    queries,
    store: {
      bindAdapter(factory) {
        return factory({
          async execute(_uow, { text, values }) {
            queries.push({ text, values });
            if (/SELECT \* FROM public\.device_execution_leases/.test(text)) return { rows: [] };
            if (/INSERT INTO public\.device_execution_leases/.test(text)) return { rows: [inserted] };
            if (/SELECT lease\.\*/.test(text)) return { rows: [inserted] };
            if (/UPDATE public\.device_execution_leases/.test(text)) return { rowCount: 1, rows: [] };
            return { rows: [] };
          },
        });
      },
      async withTransaction(work, options = {}) {
        assert.deepEqual(options, {});
        return work(Object.freeze({ kind: "uow" }));
      },
    },
  };
}

test("Device execution lease issues only for the fixed local deterministic capability and binds all existing lease IDs", async () => {
  const fixture = store();
  const leases = new PostgresDeviceExecutionLeaseStore({
    store: fixture.store,
    clock: () => now,
    idFactory: () => "device-execution-lease-test",
  });
  const result = await leases.issue({
    binding: binding(), request: request(), lease: lease(), connectionId: "device-connection-alpha",
    dispatchContext: { workspaceId: "workspace-alpha", ownerUserId: "alice", capacityLeaseId: "capacity-lease-alpha", capacityFence: 1 },
  });
  assert.equal(result.deviceExecutionLeaseId, "device-execution-lease-test");
  assert.equal(result.connectionFence, 1);
  const insert = fixture.queries.find(({ text }) => /INSERT INTO public\.device_execution_leases/.test(text));
  assert.ok(insert);
  assert.ok(insert.values.includes("capacity-lease-alpha"));
  assert.ok(insert.values.includes("capability-lease-alpha"));
  assert.ok(insert.values.includes("native-session-alice"));
});

test("Device execution lease refuses arbitrary capabilities, cloud connections, and a principal who does not own the Device", async () => {
  const fixture = store();
  const leases = new PostgresDeviceExecutionLeaseStore({ store: fixture.store, clock: () => now });
  await assert.rejects(
    leases.issue({
      binding: binding(), request: request({ metadata: { executionRef: { capabilityId: "uploaded-anything" } } }),
      lease: lease(), connectionId: "device-connection-alpha",
      dispatchContext: { workspaceId: "workspace-alpha", ownerUserId: "alice", capacityLeaseId: "capacity-lease-alpha", capacityFence: 1 },
    }),
    (error) => error?.code === "device_execution_request_not_eligible",
  );
  await assert.rejects(
    leases.issue({
      binding: binding(), request: request({ capabilities: { network: false, externalActions: false, filesystem: "none", connectionIds: ["connection-cloud"] } }),
      lease: lease(), connectionId: "device-connection-alpha",
      dispatchContext: { workspaceId: "workspace-alpha", ownerUserId: "alice", capacityLeaseId: "capacity-lease-alpha", capacityFence: 1 },
    }),
    (error) => error?.code === "device_execution_request_not_eligible",
  );
  await assert.rejects(
    leases.issue({
      binding: binding(), request: request({ actor: { userId: "bob" } }),
      lease: lease(), connectionId: "device-connection-alpha",
      dispatchContext: { workspaceId: "workspace-alpha", ownerUserId: "alice", capacityLeaseId: "capacity-lease-alpha", capacityFence: 1 },
    }),
    (error) => error?.code === "device_execution_lease_input_invalid",
  );
  assert.equal(fixture.queries.length, 0);
});

test("Device result intake rechecks durable Device, native-session, membership, execution, capability, and capacity authority", async () => {
  const fixture = store();
  const leases = new PostgresDeviceExecutionLeaseStore({ store: fixture.store, clock: () => now });
  const result = await leases.assertActive({
    deviceExecutionLeaseId: "device-execution-lease-test",
    binding: binding(), request: request(), lease: lease(), connectionId: "device-connection-alpha",
    dispatchContext: { workspaceId: "workspace-alpha", ownerUserId: "alice", capacityLeaseId: "capacity-lease-alpha", capacityFence: 1 },
  });
  assert.equal(result.status, "active");
  const check = fixture.queries.find(({ text }) => /SELECT lease\.\*/.test(text));
  assert.ok(check);
  for (const fragment of [
    "device.registration_status = 'active'",
    "session.status = 'active'",
    "membership.status = 'active'",
    "invocation.status = 'running'",
    "attempt.status = 'running'",
    "capability.status = 'active'",
    "capacity.status = 'active'",
  ]) assert.match(check.text, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
