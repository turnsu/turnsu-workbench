import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const BINDING_REF = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const SECRET_BINDING_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

export class CloudSecretStoreError extends Error {
  constructor(code, message = code, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "CloudSecretStoreError";
    this.code = code;
  }
}

/**
 * Reference adapter for local/self-hosted deployments. Product records keep
 * only `<binding-ref>:<revision>`; the secret value lives in a 0600 mounted
 * file named `<binding-ref>.v<revision>.secret` below the configured root.
 */
export class MountedCloudSecretStore {
  #rootDirectory;

  constructor({ rootDirectory } = {}) {
    if (typeof rootDirectory !== "string" || !isAbsolute(rootDirectory)) {
      throw new CloudSecretStoreError("cloud_secret_store_root_invalid");
    }
    this.#rootDirectory = rootDirectory;
  }

  async bind(reference) {
    const binding = parseVersionedReference(reference);
    const resolved = await this.#read(binding);
    return Object.freeze({
      secretSource: "cloud_secret_store",
      storeBindingRef: binding.storeBindingRef,
      storeBindingRevision: binding.storeBindingRevision,
      credentialBindingFingerprint: resolved.credentialBindingFingerprint,
    });
  }

  forWorkspace(workspaceId) {
    if (!SECRET_BINDING_ID.test(workspaceId ?? "")) {
      throw new CloudSecretStoreError("cloud_secret_store_workspace_invalid");
    }
    return new MountedCloudSecretStore({ rootDirectory: join(this.#rootDirectory, workspaceId) });
  }

  async resolve({
    storeBindingRef,
    storeBindingRevision,
    expectedCredentialBindingFingerprint = null,
  } = {}) {
    const binding = normalizeBinding({ storeBindingRef, storeBindingRevision });
    const resolved = await this.#read(binding);
    if (expectedCredentialBindingFingerprint !== null
      && resolved.credentialBindingFingerprint !== expectedCredentialBindingFingerprint) {
      throw new CloudSecretStoreError("cloud_secret_store_fingerprint_mismatch");
    }
    return resolved.secret;
  }

  async #read(binding) {
    const path = join(
      this.#rootDirectory,
      `${binding.storeBindingRef}.v${binding.storeBindingRevision}.secret`,
    );
    let info;
    let bytes;
    try {
      info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new CloudSecretStoreError("cloud_secret_store_file_invalid");
      }
      if ((info.mode & 0o077) !== 0) {
        throw new CloudSecretStoreError("cloud_secret_store_file_permissions_invalid");
      }
      bytes = await readFile(path);
    } catch (error) {
      if (error instanceof CloudSecretStoreError) throw error;
      throw new CloudSecretStoreError("cloud_secret_store_secret_unavailable", undefined, { cause: error });
    }
    const secret = bytes.toString("utf8").trim();
    bytes.fill(0);
    if (!secret || secret.length > 16_384) {
      throw new CloudSecretStoreError("cloud_secret_store_secret_invalid");
    }
    return Object.freeze({
      secret,
      credentialBindingFingerprint: `sha256:${createHash("sha256").update(secret).digest("hex")}`,
    });
  }
}

/** PostgreSQL authority resolver shared by Model and Connection gateways. */
export class PostgresSecretBindingGateway {
  #persistence;
  #secretStore;
  #clock;

  constructor({ persistence, secretStore, clock = () => new Date().toISOString() } = {}) {
    if (typeof persistence?.getSecretBinding !== "function") {
      throw new TypeError("secret_binding_persistence_required");
    }
    if (!(secretStore instanceof MountedCloudSecretStore) || typeof clock !== "function") {
      throw new TypeError("cloud_secret_store_required");
    }
    this.#persistence = persistence;
    this.#secretStore = secretStore;
    this.#clock = clock;
  }

  async resolve(secretBindingId, { workspaceId, revision } = {}) {
    const binding = await this.#binding({
      workspaceId,
      secretBindingId,
      ownerKind: "model_profile_revision",
      ownerId: revision?.revisionId,
    });
    if (!binding || binding.status !== "active" || expired(binding, this.#clock())) {
      throw new CloudSecretStoreError("model_secret_binding_unavailable");
    }
    return this.#resolveBinding(binding);
  }

  async bindConnection({ secretRef } = {}) {
    try {
      const binding = await this.#secretStore.bind(secretRef);
      return Object.freeze({
        ok: true,
        credentialState: "bound",
        credentialBindingFingerprint: binding.credentialBindingFingerprint,
        secretBinding: binding,
      });
    } catch (error) {
      return Object.freeze({
        ok: false,
        code: error?.code ?? "connection_credential_binding_failed",
        message: "The mounted Secret Store reference could not be bound.",
      });
    }
  }

  async resolveConnectionBinding({ workspaceId, connectionId, secretBindingId } = {}) {
    const binding = await this.#binding({
      workspaceId,
      secretBindingId,
      ownerKind: "connection",
      ownerId: connectionId,
    });
    if (!binding || ["revoked", "invalid"].includes(binding.status)) return Object.freeze({ state: "unbound" });
    if (binding.status === "expired" || expired(binding, this.#clock())) return Object.freeze({ state: "expired" });
    try {
      const profile = await this.#resolveBinding(binding);
      if (!BINDING_REF.test(profile)) {
        return Object.freeze({ state: "unbound", code: "connection_profile_secret_invalid" });
      }
      return Object.freeze({
        state: "bound",
        profile,
        credentialBindingFingerprint: binding.credential_fingerprint,
      });
    } catch (error) {
      return Object.freeze({ state: "unbound", code: error?.code ?? "connection_credential_unavailable" });
    }
  }

  async revokeConnectionBinding(context = {}) {
    const binding = await this.#binding({
      workspaceId: context.workspaceId,
      secretBindingId: context.secretBindingId,
      ownerKind: "connection",
      ownerId: context.connectionId,
    });
    return Object.freeze({
      revoked: Boolean(binding && binding.credential_fingerprint === context.expectedCredentialBindingFingerprint),
    });
  }

  async #binding({ workspaceId, secretBindingId, ownerKind, ownerId }) {
    if (!SECRET_BINDING_ID.test(workspaceId ?? "")
      || !SECRET_BINDING_ID.test(secretBindingId ?? "")
      || !SECRET_BINDING_ID.test(ownerId ?? "")) {
      return null;
    }
    return this.#persistence.getSecretBinding({
      workspaceId,
      secretBindingId,
      ownerKind,
      ownerId,
    });
  }

  #resolveBinding(binding) {
    if (binding.secret_source !== "cloud_secret_store"
      || !BINDING_REF.test(binding.store_binding_ref ?? "")
      || !Number.isInteger(Number(binding.store_binding_revision))
      || Number(binding.store_binding_revision) < 1
      || !FINGERPRINT.test(binding.credential_fingerprint ?? "")) {
      throw new CloudSecretStoreError("cloud_secret_binding_invalid");
    }
    const secretStore = binding.owner_kind === "model_profile_revision" && binding.payload?.namespace === "workspace"
      ? this.#secretStore.forWorkspace(binding.workspace_id) : this.#secretStore;
    return secretStore.resolve({
      storeBindingRef: binding.store_binding_ref,
      storeBindingRevision: Number(binding.store_binding_revision),
      expectedCredentialBindingFingerprint: binding.credential_fingerprint,
    });
  }
}

export function createMountedSecretBindingComposition({ env = process.env, store } = {}) {
  const rootDirectory = String(env.WORKBENCH_CLOUD_SECRET_STORE_DIR ?? "").trim();
  if (!rootDirectory) return Object.freeze({ credentialResolver: null, connectionSecretBindingGateway: null, modelSecretStore: null });
  if (typeof store?.createSecretBindingPersistence !== "function") {
    throw new TypeError("secret_binding_persistence_factory_required");
  }
  const secretStore = new MountedCloudSecretStore({ rootDirectory });
  const gateway = new PostgresSecretBindingGateway({
    persistence: store.createSecretBindingPersistence(),
    secretStore,
  });
  return Object.freeze({ credentialResolver: gateway, connectionSecretBindingGateway: gateway, modelSecretStore: secretStore });
}

function parseVersionedReference(value) {
  if (typeof value !== "string") throw new CloudSecretStoreError("cloud_secret_store_reference_invalid");
  const separator = value.lastIndexOf(":");
  const storeBindingRef = value.slice(0, separator);
  const storeBindingRevision = Number(value.slice(separator + 1));
  return normalizeBinding({ storeBindingRef, storeBindingRevision });
}

function normalizeBinding({ storeBindingRef, storeBindingRevision } = {}) {
  if (!BINDING_REF.test(storeBindingRef ?? "")
    || !Number.isSafeInteger(storeBindingRevision) || storeBindingRevision < 1) {
    throw new CloudSecretStoreError("cloud_secret_store_reference_invalid");
  }
  return Object.freeze({ storeBindingRef, storeBindingRevision });
}

function expired(binding, now) {
  return binding.expires_at != null
    && new Date(binding.expires_at).getTime() <= new Date(now).getTime();
}
