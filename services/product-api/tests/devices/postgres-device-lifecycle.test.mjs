import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVICE_WORKER_PROTOCOL_VERSION,
  PostgresDeviceLifecycle,
} from "../../src/devices/postgres-device-lifecycle.mjs";

const nativeSession = {
  client_session_id: "native-session-alice",
  user_id: "alice",
  workspace_id: "workspace-alpha",
  client_kind: "desktop",
  device_public_key: "A".repeat(43),
  status: "active",
  expires_at: "2026-08-14T00:00:00.000Z",
};

function context(overrides = {}) {
  return {
    userId: "alice",
    workspaceId: "workspace-alpha",
    role: "member",
    clientKind: "desktop",
    clientSessionId: "native-session-alice",
    devicePublicKey: nativeSession.device_public_key,
    ...overrides,
  };
}

function registrationRequest(overrides = {}) {
  return {
    data: {
      displayName: "Alice Mac",
      platform: "macos",
      architecture: "arm64",
      appVersion: "0.3.0",
      workerProtocolVersion: DEVICE_WORKER_PROTOCOL_VERSION,
      capabilityInventory: ["file_read", "notification"],
      ...overrides,
    },
  };
}

function makeStore({ existing = null } = {}) {
  const queries = [];
  const store = {
    async connect() {},
    bindAdapter(factory) {
      return factory({
        async execute(_uow, { text, values }) {
          queries.push({ text, values });
          if (/SELECT clock_timestamp\(\) AS now/.test(text)) {
            return { rows: [{ now: "2026-08-13T01:00:00.000Z" }] };
          }
          if (/FROM public\.native_client_sessions session/.test(text)
            && /JOIN public\.workspace_memberships membership/.test(text)) {
            return { rows: [structuredClone(nativeSession)] };
          }
          if (/FROM public\.devices device[\s\S]*native_client_session_id/.test(text)) {
            return { rows: existing ? [structuredClone(existing)] : [] };
          }
          if (/INSERT INTO public\.devices/.test(text)) {
            return { rows: [{
              device_id: "device-test",
              workspace_id: "workspace-alpha",
              owner_user_id: "alice",
              native_client_session_id: "native-session-alice",
              public_identity_fingerprint: `sha256:${"b".repeat(64)}`,
              display_name: "Alice Mac",
              platform: "macos",
              architecture: "arm64",
              app_version: "0.3.0",
              worker_protocol_version: DEVICE_WORKER_PROTOCOL_VERSION,
              capability_inventory: ["file_read", "notification"],
              registration_status: "active",
              health: "ready",
              last_seen_at: "2026-08-13T01:00:00.000Z",
              update_required: false,
              revision: 1,
              created_at: "2026-08-13T01:00:00.000Z",
              updated_at: "2026-08-13T01:00:00.000Z",
              revoked_at: null,
            }] };
          }
          return { rows: [] };
        },
      });
    },
    async withTransaction(work, options = {}) {
      assert.deepEqual(options, {});
      return work(Object.freeze({ kind: "uow" }));
    },
  };
  return { store, queries };
}

test("Device registration derives a public fingerprint from the PKCE-bound native session and records a named command", async () => {
  const { store, queries } = makeStore();
  const authorizations = [];
  const lifecycle = new PostgresDeviceLifecycle({
    store,
    idFactory: (kind) => `${kind}-test`,
    commandAuthorizer: {
      async authorizeDeviceRegistration(input) {
        authorizations.push(input);
        return {
          workspaceId: "workspace-alpha",
          scopeId: "scope-alice",
          policyRevisionId: "policy-alice",
          authorizationDecisionId: "decision-register",
          argumentDigest: `sha256:${"c".repeat(64)}`,
        };
      },
      async authorizeDeviceRevocation() { throw new Error("unexpected"); },
    },
  });

  const result = await lifecycle.registerDevice({ request: registrationRequest(), context: context() });

  assert.equal(result.data.deviceId, "device-test");
  assert.equal(result.data.publicIdentity, `sha256:${"b".repeat(64)}`);
  assert.deepEqual(result.data.capabilityInventory, ["file_read", "notification"]);
  assert.equal(authorizations.length, 1);
  assert.equal(authorizations[0].clientSessionId, "native-session-alice");
  assert.equal(authorizations[0].publicIdentity.length, 71);
  assert.ok(queries.some(({ text, values }) => /INSERT INTO public\.product_commands/.test(text)
    && values.includes("device_register") && /'administrative'/.test(text)));
  assert.ok(queries.some(({ text }) => /INSERT INTO public\.device_lifecycle_events/.test(text)));
  assert.ok(queries.some(({ text }) => /SET CONSTRAINTS ALL DEFERRED/.test(text)));
});

test("Device registration rejects a browser or mismatched native session before it can create a Product command", async () => {
  const { store, queries } = makeStore();
  const lifecycle = new PostgresDeviceLifecycle({
    store,
    commandAuthorizer: {
      async authorizeDeviceRegistration() { throw new Error("unexpected"); },
      async authorizeDeviceRevocation() { throw new Error("unexpected"); },
    },
  });

  await assert.rejects(
    lifecycle.registerDevice({ request: registrationRequest(), context: context({ clientKind: null, clientSessionId: null }) }),
    (error) => error?.code === "device_native_session_required",
  );
  await assert.rejects(
    lifecycle.registerDevice({ request: registrationRequest(), context: context({ devicePublicKey: "B".repeat(43) }) }),
    (error) => error?.code === "device_native_session_required",
  );
  assert.equal(queries.some(({ text }) => /INSERT INTO public\.product_commands/.test(text)), false);
});
