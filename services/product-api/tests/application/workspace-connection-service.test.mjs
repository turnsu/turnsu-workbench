import assert from "node:assert/strict";
import test from "node:test";

import {
  connectionApprovalSnapshot,
  connectionApprovalSnapshotsMatch,
  createWorkspaceConnectionService,
  formatConnectionEtag,
  isCompleteConnectionApprovalSnapshot,
  productSafeConnection,
  validateRequiredConnectionBindings,
} from "../../src/connections/workspace-connection-service.mjs";
import {
  ConnectionDriverRegistry,
  LarkConnectionDriver,
  createFakeConnectionDriver,
} from "../../src/connections/connection-driver.mjs";

const now = "2026-07-14T00:00:00.000Z";
const connection = {
  schemaVersion: "workbench-v1",
  connectionId: "connection-calendar",
  workspaceId: "workspace-consumer",
  capabilityKey: "calendar-read",
  driverKey: "calendar",
  driverBackend: "production",
  credentialState: "bound",
  label: "Team calendar",
  configuration: {
    accountLabel: "Operations calendar",
    permissionSummary: "Read selected calendars.",
    credentialHandle: "must-not-leak-from-configuration",
  },
  status: "connected",
  validation: {
    status: "valid",
    checkedAt: now,
    message: "Connection setup is ready.",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  revision: 3,
  internalSecretHandle: "must-not-leak",
  createdAt: now,
  updatedAt: now,
};

test("Connection read model and ETag never expose internal credential handles", () => {
  const value = productSafeConnection({
    ...connection,
    credentialBindingFingerprint: `sha256:${"a".repeat(64)}`,
  });
  assert.equal(value.internalSecretHandle, undefined);
  assert.equal(value.credentialBindingFingerprint, undefined);
  assert.equal(JSON.stringify(value).includes("must-not-leak"), false);
  assert.deepEqual(value.configuration, {
    accountLabel: "Operations calendar",
    permissionSummary: "Read selected calendars.",
  });
  assert.equal(formatConnectionEtag(connection), '"cnv1:connection-calendar:3"');
});

test("Connection approval snapshots bind principal, permissions, and credential instance without secrets", () => {
  const governed = {
    ...connection,
    credentialBindingFingerprint: `sha256:${"a".repeat(64)}`,
    validation: {
      ...connection.validation,
      principal: "calendar-account-1",
      scopes: ["calendar:write", "calendar:read", "calendar:read"],
      effects: ["write", "read"],
    },
  };
  const first = connectionApprovalSnapshot(governed, { requirementId: "calendar-read" });
  const reordered = connectionApprovalSnapshot({
    ...governed,
    validation: {
      ...governed.validation,
      scopes: ["calendar:read", "calendar:write"],
      effects: ["read", "write"],
    },
  }, { requirementId: "calendar-read" });
  const changedPrincipal = connectionApprovalSnapshot({
    ...governed,
    validation: { ...governed.validation, principal: "calendar-account-2" },
  }, { requirementId: "calendar-read" });

  assert.equal(isCompleteConnectionApprovalSnapshot(first), true);
  assert.equal(connectionApprovalSnapshotsMatch(first, reordered), true);
  assert.equal(connectionApprovalSnapshotsMatch(first, changedPrincipal), false);
  assert.notEqual(first.principalFingerprint, changedPrincipal.principalFingerprint);
  assert.notEqual(first.approvalFingerprint, changedPrincipal.approvalFingerprint);
  assert.equal(JSON.stringify(first).includes("secret"), false);
});

test("Lark runtime binding is atomically fenced by the approved credential fingerprint", async () => {
  const credentialBindingFingerprint = `sha256:${"b".repeat(64)}`;
  const driver = new LarkConnectionDriver({
    credentialBindingResolver: async () => ({
      state: "bound",
      profile: "lark-profile-a",
      credentialBindingFingerprint,
    }),
  });
  assert.deepEqual(await driver.resolveRuntimeBinding({
    expectedCredentialBindingFingerprint: credentialBindingFingerprint,
  }), {
    ok: true,
    binding: { profile: "lark-profile-a" },
    credentialBindingFingerprint,
  });
  assert.deepEqual(await driver.resolveRuntimeBinding({
    expectedCredentialBindingFingerprint: `sha256:${"c".repeat(64)}`,
  }), {
    ok: false,
    code: "connection_credential_binding_mismatch",
  });
});

test("required connection bindings are explicit, workspace-scoped, and ready", async () => {
  const repositories = {
    connections: {
      async get(connectionId, { workspaceId }) {
        if (connectionId !== connection.connectionId || workspaceId !== connection.workspaceId) return null;
        return structuredClone(connection);
      },
    },
  };
  const requirements = [{
    requirementId: "calendar-read",
    label: "Calendar access",
    required: true,
    permissionSummary: "Read selected calendars.",
  }];

  const resolved = await validateRequiredConnectionBindings({
    requirements,
    connectionBindings: [{ requirementId: "calendar-read", connectionId: connection.connectionId }],
    repositories,
    workspaceId: "workspace-consumer",
  });
  assert.deepEqual(resolved, [{ requirementId: "calendar-read", connectionId: connection.connectionId }]);

  await assert.rejects(
    validateRequiredConnectionBindings({ requirements, connectionBindings: [], repositories, workspaceId: "workspace-consumer" }),
    (error) => error.code === "connection_rebind_required",
  );
  await assert.rejects(
    validateRequiredConnectionBindings({
      requirements,
      connectionBindings: [{ requirementId: "calendar-read", connectionId: connection.connectionId }],
      repositories,
      workspaceId: "workspace-publisher",
    }),
    (error) => error.code === "connection_rebind_required",
  );
  await assert.rejects(
    validateRequiredConnectionBindings({
      requirements,
      connectionBindings: [
        { requirementId: "calendar-read", connectionId: connection.connectionId },
        { requirementId: "calendar-read", connectionId: connection.connectionId },
      ],
      repositories,
      workspaceId: "workspace-consumer",
    }),
    (error) => error.code === "connection_binding_invalid",
  );
});

test("Connection metadata cannot become valid until an opaque Secret Store reference is bound and probed", async () => {
  let record = null;
  const auditEvents = [];
  const idempotencyPrincipals = [];
  const store = {
    async connect() {},
    runIdempotentMutation(options, mutation) {
      idempotencyPrincipals.push(options.effectivePrincipalId);
      return mutation(null);
    },
    runIdempotentExternalMutation(options, operation) {
      idempotencyPrincipals.push(options.effectivePrincipalId);
      return operation("connection-operation-1");
    },
    repositories: {
      connections: {
        async insert(value) {
          record = structuredClone(value);
          return structuredClone(record);
        },
        async get(connectionId, { workspaceId }) {
          return record?.connectionId === connectionId && record.workspaceId === workspaceId
            ? structuredClone(record)
            : null;
        },
        async patchWithRevision(connectionId, revision, patch, { workspaceId }) {
          if (record?.connectionId !== connectionId || record.workspaceId !== workspaceId || record.revision !== revision) {
            return null;
          }
          record = { ...record, ...structuredClone(patch) };
          return structuredClone(record);
        },
        async list() {
          return record ? [structuredClone(record)] : [];
        },
      },
      auditEvents: {
        async append(value) {
          auditEvents.push(structuredClone(value));
          return value;
        },
      },
    },
  };
  const registry = new ConnectionDriverRegistry().register({
    driverKey: "lark",
    backend: "test",
    matches: (capabilityKey) => capabilityKey === "lark.docs.read",
    driver: createFakeConnectionDriver({
      credentialState: "unbound",
      probeResult: {
        ok: true,
        principal: "lark-user",
        scopes: ["docs:read"],
        effects: ["read"],
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }),
  });
  let id = 0;
  const service = createWorkspaceConnectionService({
    store,
    driverRegistry: registry,
    clock: () => now,
    idFactory: (kind) => `${kind}-${++id}`,
  });
  const created = await service.create({
    idempotencyKey: "create-1",
    request: {
      data: {
        capabilityKey: "lark.docs.read",
        label: "Docs",
        configuration: {
          accountLabel: "Team docs",
          permissionSummary: "Read documents.",
        },
      },
    },
    workspaceId: "workspace-consumer",
    actorId: "alice",
  });
  assert.equal(created.data.status, "needs_setup");
  assert.equal(created.data.credentialState, "unbound");

  const checkedBeforeBinding = await service.validate({
    connectionId: created.data.connectionId,
    idempotencyKey: "validate-1",
    ifMatch: created.etag,
    request: { data: {} },
    workspaceId: "workspace-consumer",
    actorId: "alice",
  });
  assert.equal(checkedBeforeBinding.data.status, "needs_setup");
  assert.equal(checkedBeforeBinding.data.validation.status, "invalid");

  const bound = await service.bindCredential({
    connectionId: created.data.connectionId,
    idempotencyKey: "bind-1",
    ifMatch: checkedBeforeBinding.etag,
    request: { data: { secretRef: "secret-store/lark/team-docs" } },
    workspaceId: "workspace-consumer",
    actorId: "alice",
  });
  assert.equal(bound.data.credentialState, "bound");
  const firstBindingFingerprint = record.credentialBindingFingerprint;
  assert.match(firstBindingFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(bound.data.credentialBindingFingerprint, undefined);
  assert.equal(JSON.stringify(record).includes("secret-store/lark/team-docs"), false);

  const validated = await service.validate({
    connectionId: created.data.connectionId,
    idempotencyKey: "validate-2",
    ifMatch: bound.etag,
    request: { data: {} },
    workspaceId: "workspace-consumer",
    actorId: "alice",
  });
  assert.equal(validated.data.status, "connected");
  assert.equal(validated.data.validation.status, "valid");
  assert.equal(validated.data.validation.principal, "lark-user");
  assert.equal(validated.data.driverBackend, "test");

  const rebound = await service.bindCredential({
    connectionId: created.data.connectionId,
    idempotencyKey: "bind-2",
    ifMatch: validated.etag,
    request: { data: { secretRef: "secret-store/lark/replacement-account" } },
    workspaceId: "workspace-consumer",
    actorId: "alice",
  });
  assert.notEqual(record.credentialBindingFingerprint, firstBindingFingerprint);
  assert.equal(rebound.data.credentialBindingFingerprint, undefined);
  assert.equal(JSON.stringify(record).includes("replacement-account"), false);

  const revalidated = await service.validate({
    connectionId: created.data.connectionId,
    idempotencyKey: "validate-3",
    ifMatch: rebound.etag,
    request: { data: {} },
    workspaceId: "workspace-consumer",
    actorId: "alice",
  });
  await assert.rejects(
    validateRequiredConnectionBindings({
      requirements: [{ requirementId: "lark.docs.read", required: true }],
      connectionBindings: [{
        requirementId: "lark.docs.read",
        connectionId: created.data.connectionId,
      }],
      repositories: store.repositories,
      workspaceId: "workspace-consumer",
    }),
    { code: "connection_not_ready" },
  );

  const disabled = await service.update({
    connectionId: created.data.connectionId,
    idempotencyKey: "disable-1",
    ifMatch: revalidated.etag,
    request: { data: { enabled: false } },
    workspaceId: "workspace-consumer",
    actorId: "alice",
  });
  assert.equal(disabled.data.status, "disabled");
  assert.equal(disabled.data.credentialState, "unbound");
  assert.equal(auditEvents.at(-1).action, "connection.updated");
  assert.ok(idempotencyPrincipals.length > 0);
  assert.ok(idempotencyPrincipals.every((principalId) => principalId === "alice"));
});
