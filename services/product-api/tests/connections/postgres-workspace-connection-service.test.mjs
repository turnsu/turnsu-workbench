import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionDriverRegistry } from "../../src/connections/connection-driver.mjs";
import { PostgresWorkspaceConnectionService } from "../../src/connections/postgres-workspace-connection-service.mjs";

const NOW = "2026-08-11T00:00:00.000Z";
const FINGERPRINT = `sha256:${"a".repeat(64)}`;

test("PostgreSQL Connection mutations use immutable revisions and only persist governed opaque binding identity", async () => {
  const fixture = createFixture();
  const service = createService(fixture);

  const created = await service.create({
    idempotencyKey: "connection-create-1",
    workspaceId: fixture.workspaceId,
    actorId: fixture.actorId,
    request: { data: {
      capabilityKey: "lark.docs.read", label: "Team docs",
      configuration: { accountLabel: "Operations", permissionSummary: "Read team docs." },
    } },
  });
  assert.equal(created.data.status, "needs_setup");
  assert.equal(created.data.credentialState, "unbound");
  assert.equal(created.data.createdAt, NOW);
  assert.match(created.etag, /^"cnv1:connection-/);

  const updated = await service.update({
    connectionId: created.data.connectionId, idempotencyKey: "connection-update-1",
    ifMatch: created.etag, workspaceId: fixture.workspaceId, actorId: fixture.actorId,
    request: { data: { label: "Operations documents" } },
  });
  assert.equal(updated.data.label, "Operations documents");
  assert.equal(updated.data.revision, 2);
  assert.equal(updated.data.createdAt, NOW);

  const bound = await service.bindCredential({
    connectionId: created.data.connectionId, idempotencyKey: "connection-bind-1",
    ifMatch: updated.etag, workspaceId: fixture.workspaceId, actorId: fixture.actorId,
    request: { data: { secretRef: "opaque-secret-ref/never-persisted" } },
  });
  assert.equal(bound.data.credentialState, "bound");
  assert.equal(bound.data.status, "needs_setup");
  assert.equal(JSON.stringify(fixture.state).includes("opaque-secret-ref/never-persisted"), false);
  assert.equal(fixture.state.bindings.size, 1);
  const binding = [...fixture.state.bindings.values()][0];
  assert.equal(binding.secret_source, "cloud_secret_store");
  assert.equal(binding.store_binding_ref, "gateway-binding-lark-1");
  assert.equal(binding.status, "pending");

  const valid = await service.validate({
    connectionId: created.data.connectionId, idempotencyKey: "connection-validate-1",
    ifMatch: bound.etag, workspaceId: fixture.workspaceId, actorId: fixture.actorId,
    request: { data: {} },
  });
  assert.equal(valid.data.status, "connected");
  assert.equal(valid.data.validation.status, "valid");
  assert.deepEqual(valid.data.validation.effects, ["read"]);
  assert.equal(binding.status, "active");
  assert.equal(valid.data.credentialBindingFingerprint, undefined);
  assert.equal(JSON.stringify(valid).includes("gateway-binding-lark-1"), false);
  const disabled = await service.update({
    connectionId: created.data.connectionId, idempotencyKey: "connection-disable-1",
    ifMatch: valid.etag, workspaceId: fixture.workspaceId, actorId: fixture.actorId,
    request: { data: { enabled: false } },
  });
  assert.equal(disabled.data.status, "disabled");
  assert.equal(disabled.data.credentialState, "unbound");
  assert.equal(binding.status, "revoked");
  assert.equal(fixture.state.root.current_revision_number, 5);
  assert.equal(fixture.state.root.write_version, 5);
  assert.equal(fixture.idempotency.length, 2);
  assert.equal(fixture.external.length, 3);
});

test("PostgreSQL Connection mutations fail closed without a Product mutation or governed binding gateway", async () => {
  const fixture = createFixture();
  const noMutation = new PostgresWorkspaceConnectionService({
    store: fixture.store, driverRegistry: fixture.registry, clock: () => NOW, idFactory: fixture.idFactory,
  });
  await assert.rejects(
    noMutation.create({
      idempotencyKey: "create", workspaceId: fixture.workspaceId, actorId: fixture.actorId,
      request: { data: { capabilityKey: "lark.docs.read", label: "Docs", configuration: {} } },
    }),
    { code: "connection_mutation_command_required" },
  );

  const service = createService(fixture, { external: null });
  const created = await service.create({
    idempotencyKey: "create", workspaceId: fixture.workspaceId, actorId: fixture.actorId,
    request: { data: { capabilityKey: "lark.docs.read", label: "Docs", configuration: {} } },
  });
  await assert.rejects(
    service.bindCredential({
      connectionId: created.data.connectionId, idempotencyKey: "bind", ifMatch: created.etag,
      workspaceId: fixture.workspaceId, actorId: fixture.actorId,
      request: { data: { secretRef: "opaque-ref" } },
    }),
    { code: "connection_credential_binding_unavailable" },
  );
});

function createService(fixture, { external = fixture.externalPort } = {}) {
  return new PostgresWorkspaceConnectionService({
    store: fixture.store, driverRegistry: fixture.registry,
    idempotentMutationPort: fixture.idempotentPort, externalMutationPort: external,
    clock: () => NOW, idFactory: fixture.idFactory,
  });
}

function createFixture() {
  const workspaceId = "workspace-connection-test";
  const actorId = "user-connection-test";
  const state = { root: null, revisions: new Map(), bindings: new Map() };
  const idempotency = [];
  const external = [];
  let nextId = 0;
  const idFactory = (kind) => `${kind}-${++nextId}`;
  const execute = async (_uow, { text, values }) => {
    const sql = text.replaceAll(/\s+/g, " ").trim();
    if (sql === "SET CONSTRAINTS ALL DEFERRED") return { rows: [], rowCount: 0 };
    if (sql.includes("FROM public.product_scopes")) return { rows: [{ scope_id: "scope-personal-test" }], rowCount: 1 };
    if (sql.startsWith("SELECT connection.*, revision.*")) {
      const row = currentRow(state, values?.[0], values?.[1]);
      if (sql.includes("revision.payload ->> $3")) {
        const field = values[2];
        const operationId = values[3];
        return { rows: row?.payload?.[field] === operationId ? [row] : [], rowCount: row?.payload?.[field] === operationId ? 1 : 0 };
      }
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith("INSERT INTO public.workspace_connections")) {
      const [workspace, connectionId, scopeId, createdBy, label, revisionId, now] = values;
      state.root = {
        workspace_id: workspace, connection_id: connectionId, scope_id: scopeId, created_by: createdBy,
        label, enabled: true, current_revision_id: revisionId, current_revision_number: 1,
        write_version: 1, created_at: now, updated_at: now, payload: {},
      };
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO public.workspace_connection_revisions")) {
      const row = revisionRow(values);
      state.revisions.set(row.connection_revision_id, row);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE public.workspace_connections")) {
      const [workspace, connectionId, label, enabled, revisionId, revisionNumber, now, writeVersion] = values;
      if (!state.root || state.root.workspace_id !== workspace || state.root.connection_id !== connectionId || state.root.write_version !== writeVersion) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(state.root, {
        label, enabled, current_revision_id: revisionId, current_revision_number: revisionNumber,
        updated_at: now, write_version: state.root.write_version + 1,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO public.secret_bindings")) {
      const [workspace, id, scopeId, ownerId, source, storeRef, storeRevision, fingerprint, createdBy, expiresAt, now, payload] = values;
      state.bindings.set(id, {
        workspace_id: workspace, secret_binding_id: id, scope_id: scopeId, owner_id: ownerId,
        secret_source: source, store_binding_ref: storeRef, store_binding_revision: storeRevision,
        credential_fingerprint: fingerprint, status: "pending", status_revision: 1,
        created_by: createdBy, expires_at: expiresAt, created_at: now, updated_at: now, payload: JSON.parse(payload),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE public.secret_bindings") && sql.includes("status = $3")) {
      const [workspace, id, status, now] = values;
      const binding = state.bindings.get(id);
      if (!binding || binding.workspace_id !== workspace || binding.status === "revoked") return { rows: [], rowCount: 0 };
      binding.status = status;
      binding.status_revision += 1;
      binding.updated_at = now;
      if (status === "active") binding.probed_at = now;
      return { rows: [{ secret_binding_id: id }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE public.secret_bindings") && sql.includes("status = 'revoked'")) {
      const [workspace, id, now] = values;
      const binding = state.bindings.get(id);
      if (binding && binding.workspace_id === workspace && binding.status !== "revoked") {
        binding.status = "revoked"; binding.status_revision += 1; binding.revoked_at = now; binding.updated_at = now;
      }
      return { rows: [], rowCount: binding ? 1 : 0 };
    }
    throw new Error(`Unexpected query: ${sql.slice(0, 120)}`);
  };
  const store = {
    async connect() {},
    async withTransaction(work) { return work({}); },
    bindAdapter(factory) { return factory({ execute }); },
  };
  const driver = {
    async bindSecretRef() {
      return {
        ok: true, credentialState: "bound", credentialBindingFingerprint: FINGERPRINT,
        secretBinding: {
          secretSource: "cloud_secret_store", storeBindingRef: "gateway-binding-lark-1",
          storeBindingRevision: 1, credentialBindingFingerprint: FINGERPRINT,
        },
      };
    },
    async credentialState() { return "bound"; },
    async probe() { return { ok: true, principal: "lark-account-1", scopes: ["docs:read"], effects: ["read"] }; },
    async validate({ probe }) { return probe; },
    async revoke() { return { revoked: true }; },
  };
  const registry = new ConnectionDriverRegistry().register({
    driverKey: "lark", backend: "production", matches: (value) => value === "lark.docs.read", driver,
  });
  return {
    workspaceId, actorId, state, store, registry, idFactory, idempotency, external,
    idempotentPort: { async run(options, mutation) { idempotency.push(options); return mutation({}); } },
    externalPort: {
      async run(options, mutation) {
        external.push(options);
        const operationId = `operation-${external.length}`;
        const recovered = await options.recover(operationId);
        return recovered ?? mutation(operationId);
      },
    },
  };
}

function currentRow(state, workspaceId, connectionId) {
  if (!state.root || state.root.workspace_id !== workspaceId || state.root.connection_id !== connectionId) return null;
  const revision = state.revisions.get(state.root.current_revision_id);
  return revision ? { ...state.root, ...revision } : null;
}

function revisionRow(values) {
  const [
    workspaceId, connectionRevisionId, connectionId, scopeId, revisionNumber,
    baseRevisionId, baseRevisionNumber, capabilityKey, driverKey, driverBackend,
    configuration, credentialState, secretBindingId, credentialBindingFingerprint,
    readinessStatus, validationStatus, validationMessage, validationPrincipal,
    validationScopes, validationEffects, validationCheckedAt, validationExpiresAt,
    contentHash, createdBy, createdAt, payload,
  ] = values;
  return {
    workspace_id: workspaceId, connection_revision_id: connectionRevisionId, connection_id: connectionId,
    scope_id: scopeId, revision_number: revisionNumber, base_revision_id: baseRevisionId,
    base_revision_number: baseRevisionNumber, capability_key: capabilityKey, driver_key: driverKey,
    driver_backend: driverBackend, safe_configuration: JSON.parse(configuration), credential_state: credentialState,
    secret_binding_id: secretBindingId, credential_binding_fingerprint: credentialBindingFingerprint,
    readiness_status: readinessStatus, validation_status: validationStatus, validation_message: validationMessage,
    validation_principal: validationPrincipal, validation_scopes: JSON.parse(validationScopes),
    validation_effects: JSON.parse(validationEffects), validation_checked_at: validationCheckedAt,
    validation_expires_at: validationExpiresAt, content_hash: contentHash, created_by: createdBy,
    created_at: createdAt, payload: JSON.parse(payload),
  };
}
