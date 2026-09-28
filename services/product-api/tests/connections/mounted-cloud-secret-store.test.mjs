import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CloudSecretStoreError,
  MountedCloudSecretStore,
  PostgresSecretBindingGateway,
  createMountedSecretBindingComposition,
} from "../../src/security/mounted-cloud-secret-store.mjs";

const fingerprint = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("mounted cloud secrets bind an opaque revision and reject drift or unsafe file permissions", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "looloomi-cloud-secrets-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const path = join(rootDirectory, "model-primary.v3.secret");
  await writeFile(path, "provider-secret\n", { mode: 0o600 });
  const store = new MountedCloudSecretStore({ rootDirectory });

  const binding = await store.bind("model-primary:3");
  assert.deepEqual(binding, {
    secretSource: "cloud_secret_store",
    storeBindingRef: "model-primary",
    storeBindingRevision: 3,
    credentialBindingFingerprint: fingerprint("provider-secret"),
  });
  assert.equal(await store.resolve({
    storeBindingRef: "model-primary",
    storeBindingRevision: 3,
    expectedCredentialBindingFingerprint: binding.credentialBindingFingerprint,
  }), "provider-secret");
  await assert.rejects(
    store.resolve({
      storeBindingRef: "model-primary",
      storeBindingRevision: 3,
      expectedCredentialBindingFingerprint: `sha256:${"0".repeat(64)}`,
    }),
    code("cloud_secret_store_fingerprint_mismatch"),
  );
  await chmod(path, 0o644);
  await assert.rejects(store.bind("model-primary:3"), code("cloud_secret_store_file_permissions_invalid"));
});

test("PostgreSQL binding gateway resolves active Model bindings and gives Connections only a governed profile", async (t) => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "looloomi-binding-gateway-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  await writeFile(join(rootDirectory, "provider-main.v1.secret"), "api-key-value", { mode: 0o600 });
  await writeFile(join(rootDirectory, "lark-team.v2.secret"), "team-profile", { mode: 0o600 });
  const rows = new Map([
    ["secret-model", bindingRow({ ref: "provider-main", revision: 1, value: "api-key-value", ownerKind: "model_profile_revision", ownerId: "revision-model" })],
    ["secret-connection", bindingRow({ ref: "lark-team", revision: 2, value: "team-profile", ownerKind: "connection", ownerId: "connection-team", status: "pending" })],
  ]);
  const persistence = fakeBindingPersistence(rows);
  const secretStore = new MountedCloudSecretStore({ rootDirectory });
  const gateway = new PostgresSecretBindingGateway({ persistence, secretStore });

  assert.equal(await gateway.resolve("secret-model", {
    workspaceId: "workspace-test",
    revision: { revisionId: "revision-model" },
  }), "api-key-value");
  assert.deepEqual(await gateway.bindConnection({ secretRef: "lark-team:2" }), {
    ok: true,
    credentialState: "bound",
    credentialBindingFingerprint: fingerprint("team-profile"),
    secretBinding: {
      secretSource: "cloud_secret_store",
      storeBindingRef: "lark-team",
      storeBindingRevision: 2,
      credentialBindingFingerprint: fingerprint("team-profile"),
    },
  });
  assert.deepEqual(await gateway.resolveConnectionBinding({
    workspaceId: "workspace-test",
    connectionId: "connection-team",
    secretBindingId: "secret-connection",
  }), {
    state: "bound",
    profile: "team-profile",
    credentialBindingFingerprint: fingerprint("team-profile"),
  });
});

test("production secret composition is explicitly disabled or injects both consumers", () => {
  const store = fakePostgresStore(new Map());
  assert.deepEqual(createMountedSecretBindingComposition({ env: {}, store }), {
    credentialResolver: null,
    connectionSecretBindingGateway: null,
    modelSecretStore: null,
  });
  const enabled = createMountedSecretBindingComposition({
    env: { WORKBENCH_CLOUD_SECRET_STORE_DIR: "/run/workbench-secrets" },
    store,
  });
  assert.ok(enabled.modelSecretStore instanceof MountedCloudSecretStore);
  assert.equal(enabled.credentialResolver, enabled.connectionSecretBindingGateway);
  assert.equal(typeof enabled.credentialResolver.resolve, "function");
  assert.equal(typeof enabled.connectionSecretBindingGateway.bindConnection, "function");
});

function bindingRow({ ref, revision, value, ownerKind, ownerId, status = "active" }) {
  return {
    secret_source: "cloud_secret_store",
    store_binding_ref: ref,
    store_binding_revision: revision,
    credential_fingerprint: fingerprint(value),
    status,
    owner_kind: ownerKind,
    owner_id: ownerId,
    expires_at: null,
  };
}

function fakePostgresStore(rows) {
  return {
    createSecretBindingPersistence() {
      return fakeBindingPersistence(rows);
    },
  };
}

function fakeBindingPersistence(rows) {
  return {
    async getSecretBinding({ secretBindingId, ownerKind, ownerId }) {
      const row = rows.get(secretBindingId);
      return row && row.owner_kind === ownerKind && row.owner_id === ownerId ? row : null;
    },
  };
}

function code(expected) {
  return (error) => error instanceof CloudSecretStoreError && error.code === expected;
}
