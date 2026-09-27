import { createHash } from "node:crypto";

import { ProductStoreError } from "../store/errors.mjs";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
export const CONNECTION_APPROVAL_SCHEMA_VERSION = "connection-approval-v1";

const canonicalJson = (value) => {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
};
const fingerprint = (value) =>
  `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
const normalizedStrings = (value) => [...new Set(
  (Array.isArray(value) ? value : [])
    .filter((entry) => typeof entry === "string" && entry.length > 0),
)].sort();
const CONTENT_FINGERPRINT = /^sha256:[a-f0-9]{16,64}$/;

const requiredString = (value, code) => {
  if (typeof value !== "string" || value.length === 0) throw new ProductStoreError(code, code);
  return value;
};

const uniqueRequirements = (requirements = []) => {
  const byId = new Map();
  for (const requirement of requirements) {
    if (!requirement?.requirementId) continue;
    const existing = byId.get(requirement.requirementId);
    if (existing && existing.permissionSummary !== requirement.permissionSummary) {
      throw new ProductStoreError(
        "connection_requirement_conflict",
        "This release contains conflicting connection requirements.",
        { requirementId: requirement.requirementId },
      );
    }
    byId.set(requirement.requirementId, clone(requirement));
  }
  return [...byId.values()].sort((left, right) => left.requirementId.localeCompare(right.requirementId));
};

export function productSafeConnection(connection) {
  if (!connection) return null;
  const expired = typeof connection.validation?.expiresAt === "string"
    && Date.parse(connection.validation.expiresAt) <= Date.now();
  const configuration = {};
  if (typeof connection.configuration?.accountLabel === "string") {
    configuration.accountLabel = connection.configuration.accountLabel;
  }
  if (typeof connection.configuration?.permissionSummary === "string") {
    configuration.permissionSummary = connection.configuration.permissionSummary;
  }
  return {
    schemaVersion: connection.schemaVersion,
    connectionId: connection.connectionId,
    workspaceId: connection.workspaceId,
    capabilityKey: connection.capabilityKey,
    driverKey: connection.driverKey ?? "unconfigured",
    driverBackend: connection.driverBackend ?? "production",
    label: connection.label,
    configuration,
    credentialState: expired ? "expired" : connection.credentialState ?? "unbound",
    status: expired && connection.status === "connected" ? "needs_setup" : connection.status,
    validation: expired ? {
      ...clone(connection.validation),
      status: "invalid",
      message: "This Connection credential has expired. Rebind and validate it before use.",
    } : clone(connection.validation),
    revision: connection.revision,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export function formatConnectionEtag({ connectionId, revision } = {}) {
  if (!connectionId || !Number.isInteger(revision) || revision < 1) {
    throw new TypeError("connection_etag_requires_revision");
  }
  return `"cnv1:${connectionId}:${revision}"`;
}

export function connectionOperationalIssue(connection, { now = Date.now() } = {}) {
  if (connection?.status !== "connected" || connection?.validation?.status !== "valid") {
    return {
      code: "connection_not_ready",
      message: "Validate the selected connection before continuing.",
    };
  }
  if (
    connection.credentialState !== "bound"
    || connection.driverBackend !== "production"
    || (
      typeof connection.validation?.expiresAt === "string"
      && Date.parse(connection.validation.expiresAt) <= now
    )
  ) {
    return {
      code: "connection_not_ready",
      message: "The selected connection credential is missing, expired, or test-only.",
    };
  }
  return null;
}

export function isCompleteConnectionApprovalSnapshot(snapshot) {
  return Boolean(
    snapshot
    && snapshot.approvalSchemaVersion === CONNECTION_APPROVAL_SCHEMA_VERSION
    && typeof snapshot.requirementId === "string"
    && snapshot.requirementId.length > 0
    && typeof snapshot.connectionId === "string"
    && snapshot.connectionId.length > 0
    && Number.isSafeInteger(snapshot.connectionRevision)
    && snapshot.connectionRevision >= 1
    && typeof snapshot.capabilityKey === "string"
    && snapshot.capabilityKey.length > 0
    && typeof snapshot.driverKey === "string"
    && snapshot.driverKey.length > 0
    && snapshot.driverBackend === "production"
    && typeof snapshot.principal === "string"
    && snapshot.principal.length > 0
    && CONTENT_FINGERPRINT.test(snapshot.principalFingerprint)
    && CONTENT_FINGERPRINT.test(snapshot.permissionFingerprint)
    && CONTENT_FINGERPRINT.test(snapshot.credentialBindingFingerprint)
    && CONTENT_FINGERPRINT.test(snapshot.approvalFingerprint)
    && (snapshot.validationExpiresAt === null || typeof snapshot.validationExpiresAt === "string")
  );
}

export function connectionApprovalSnapshot(connection, { requirementId, now = Date.now() } = {}) {
  const operationalIssue = connectionOperationalIssue(connection, { now });
  if (operationalIssue) {
    throw new ProductStoreError(operationalIssue.code, operationalIssue.message, {
      connectionId: connection?.connectionId,
      requirementId,
    });
  }
  const principal = connection?.validation?.principal;
  if (
    typeof requirementId !== "string"
    || requirementId.length === 0
    || typeof connection?.connectionId !== "string"
    || !Number.isSafeInteger(connection?.revision)
    || typeof connection?.capabilityKey !== "string"
    || typeof connection?.driverKey !== "string"
    || connection?.driverBackend !== "production"
    || typeof principal !== "string"
    || principal.length === 0
    || !CONTENT_FINGERPRINT.test(connection?.credentialBindingFingerprint)
  ) {
    throw new ProductStoreError(
      "connection_rebind_required",
      "Rebind and validate this Connection before creating a Run.",
      { connectionId: connection?.connectionId, requirementId },
    );
  }
  const scopes = normalizedStrings(connection.validation?.scopes);
  const effects = normalizedStrings(connection.validation?.effects);
  const base = {
    approvalSchemaVersion: CONNECTION_APPROVAL_SCHEMA_VERSION,
    requirementId,
    connectionId: connection.connectionId,
    connectionRevision: connection.revision,
    capabilityKey: connection.capabilityKey,
    driverKey: connection.driverKey,
    driverBackend: connection.driverBackend,
    principal,
    principalFingerprint: fingerprint({ principal }),
    permissionFingerprint: fingerprint({ principal, scopes, effects }),
    credentialBindingFingerprint: connection.credentialBindingFingerprint,
    validationExpiresAt: connection.validation?.expiresAt ?? null,
  };
  return Object.freeze({
    ...base,
    approvalFingerprint: fingerprint(base),
  });
}

export function connectionApprovalSnapshotsMatch(expected, current) {
  if (!isCompleteConnectionApprovalSnapshot(expected) || !isCompleteConnectionApprovalSnapshot(current)) {
    return false;
  }
  return [
    "approvalSchemaVersion",
    "requirementId",
    "connectionId",
    "connectionRevision",
    "capabilityKey",
    "driverKey",
    "driverBackend",
    "principal",
    "principalFingerprint",
    "permissionFingerprint",
    "credentialBindingFingerprint",
    "validationExpiresAt",
    "approvalFingerprint",
  ].every((field) => expected[field] === current[field]);
}

export async function validateRequiredConnectionBindings({
  requirements = [],
  connectionBindings = [],
  repositories,
  workspaceId,
  options = {},
} = {}) {
  requiredString(workspaceId, "workspace_id_required");
  if (!repositories?.connections) throw new TypeError("connection_repository_required");
  const expected = uniqueRequirements(requirements);
  const expectedById = new Map(expected.map((requirement) => [requirement.requirementId, requirement]));
  const supplied = new Map();
  for (const binding of connectionBindings ?? []) {
    if (!binding?.requirementId || !binding?.connectionId || supplied.has(binding.requirementId)) {
      throw new ProductStoreError(
        "connection_binding_invalid",
        "Each connection requirement must be bound exactly once.",
      );
    }
    if (!expectedById.has(binding.requirementId)) {
      throw new ProductStoreError(
        "connection_binding_invalid",
        "A selected connection does not match this release.",
        { requirementId: binding.requirementId },
      );
    }
    supplied.set(binding.requirementId, binding.connectionId);
  }

  const resolved = [];
  for (const requirement of expected) {
    const connectionId = supplied.get(requirement.requirementId);
    if (!connectionId) {
      if (!requirement.required) continue;
      throw new ProductStoreError(
        "connection_rebind_required",
        "Choose a connection from this workspace before continuing.",
        { requirementId: requirement.requirementId },
      );
    }
    const connection = await repositories.connections.get(connectionId, { workspaceId, ...options });
    if (!connection) {
      throw new ProductStoreError(
        "connection_rebind_required",
        "Choose a connection from this workspace before continuing.",
        { requirementId: requirement.requirementId },
      );
    }
    if (connection.capabilityKey !== requirement.requirementId) {
      throw new ProductStoreError(
        "connection_binding_invalid",
        "The selected connection does not provide the required capability.",
        { requirementId: requirement.requirementId },
      );
    }
    const operationalIssue = connectionOperationalIssue(connection);
    if (operationalIssue) {
      throw new ProductStoreError(
        operationalIssue.code,
        operationalIssue.message,
        { requirementId: requirement.requirementId, connectionId },
      );
    }
    resolved.push({ requirementId: requirement.requirementId, connectionId });
  }
  return resolved;
}

export async function collectReleaseConnectionRequirements({ release, repositories, options = {} } = {}) {
  if (!release) throw new ProductStoreError("release_not_available", "This Team library item is not available.");
  const workspaceId = release.sourceWorkspaceId;
  if (release.assetKind === "skill") {
    const version = await repositories.skillVersions.get(release.versionId, { workspaceId, ...options });
    if (!version) throw new ProductStoreError("release_not_available", "The released Skill version is not available.");
    return uniqueRequirements(version.connectionRequirements);
  }
  if (release.assetKind === "loop") {
    const loopVersion = await repositories.loopVersions.get(release.versionId, { workspaceId, ...options });
    if (!loopVersion) throw new ProductStoreError("release_not_available", "The released Loop version is not available.");
    const requirements = [];
    for (const skillRef of loopVersion.pinnedSkills ?? []) {
      const version = await repositories.skillVersions.getBySkillRef(
        skillRef.skillId,
        skillRef.version,
        { workspaceId, ...options },
      );
      if (!version) throw new ProductStoreError("release_not_available", "A released Skill dependency is not available.");
      requirements.push(...(version.connectionRequirements ?? []));
    }
    return uniqueRequirements(requirements);
  }
  return [];
}

export async function persistConnectionBindings({
  repositories,
  workspaceId,
  targetKind,
  targetId,
  bindings,
  boundBy,
  boundAt,
  options = {},
} = {}) {
  if (!repositories?.connectionBindings?.replaceForTarget) {
    throw new TypeError("connection_binding_repository_required");
  }
  return repositories.connectionBindings.replaceForTarget({
    workspaceId,
    targetKind,
    targetId,
    bindings,
    boundBy,
    boundAt,
  }, options);
}

export function createWorkspaceConnectionService({
  store,
  driverRegistry = null,
  clock = () => new Date().toISOString(),
  idFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
} = {}) {
  if (!store?.connect) throw new TypeError("workbench_store_required");
  const runMutation = (options, mutation) => {
    if (!store.runIdempotentMutation) throw new TypeError("workbench_idempotency_store_required");
    return store.runIdempotentMutation(options, mutation);
  };
  const repository = () => {
    const value = store.repositories?.connections;
    if (!value) throw new TypeError("connection_repository_required");
    return value;
  };
  const audit = async ({ workspaceId, actorId, action, entityId, options }) => {
    await store.repositories.auditEvents.append({
      schemaVersion: "workbench-v1",
      auditEventId: idFactory("audit"),
      workspaceId,
      actorId,
      action,
      entityKind: "workspace_connection",
      entityId,
      createdAt: clock(),
    }, options);
  };
  const read = async (connectionId, workspaceId, options = {}) => {
    await store.connect();
    const value = await repository().get(connectionId, { workspaceId, ...options });
    if (!value) throw new ProductStoreError("connection_not_found", "Connection not found.", { connectionId });
    return value;
  };
  const resolveDriver = (capabilityKey) =>
    driverRegistry?.resolve?.(capabilityKey) ?? null;

  return Object.freeze({
    async list({ workspaceId, query = {} }) {
      await store.connect();
      const values = await repository().list({ workspaceId, ...query });
      return values.map(productSafeConnection);
    },
    async get({ connectionId, workspaceId }) {
      const value = await read(connectionId, workspaceId);
      return { data: productSafeConnection(value), etag: formatConnectionEtag(value) };
    },
    async create({ idempotencyKey, request, workspaceId, actorId }) {
      const data = request?.data ?? request;
      return runMutation({
        scope: "create-connection",
        key: idempotencyKey,
        request: clone(request),
        workspaceId,
        effectivePrincipalId: actorId,
      }, async (session) => {
        const now = clock();
        const registration = resolveDriver(data.capabilityKey);
        const connection = await repository().insert({
          schemaVersion: "workbench-v1",
          connectionId: idFactory("connection"),
          workspaceId,
          capabilityKey: data.capabilityKey,
          driverKey: registration?.driverKey ?? "unconfigured",
          driverBackend: registration?.backend ?? "production",
          label: data.label,
          configuration: clone(data.configuration ?? {}),
          credentialState: "unbound",
          credentialBindingFingerprint: null,
          status: "needs_setup",
          validation: {
            status: "never_checked",
            checkedAt: null,
            message: "Validate this connection before using it.",
          },
          revision: 1,
          createdAt: now,
          updatedAt: now,
        }, { session });
        await audit({ workspaceId, actorId, action: "connection.created", entityId: connection.connectionId, options: { session } });
        return { data: productSafeConnection(connection), etag: formatConnectionEtag(connection) };
      });
    },
    async update({ connectionId, idempotencyKey, ifMatch, request, workspaceId, actorId }) {
      const updateData = request?.data ?? request;
      if (updateData?.enabled === false) {
        const current = await read(connectionId, workspaceId);
        if (formatConnectionEtag(current) !== ifMatch) {
          throw new ProductStoreError("connection_revision_conflict", "The connection changed after it was opened.");
        }
        const registration = resolveDriver(current.capabilityKey);
        await registration?.driver?.revoke?.({
          workspaceId,
          actorId,
          connectionId,
          capabilityKey: current.capabilityKey,
          configuration: clone(current.configuration),
        });
      }
      return runMutation({
        scope: `update-connection:${connectionId}`,
        key: idempotencyKey,
        request: { ifMatch, request: clone(request) },
        workspaceId,
        effectivePrincipalId: actorId,
      }, async (session) => {
        const current = await read(connectionId, workspaceId, { session });
        if (formatConnectionEtag(current) !== ifMatch) {
          throw new ProductStoreError("connection_revision_conflict", "The connection changed after it was opened.");
        }
        const data = updateData;
        const enabled = data.enabled ?? current.status !== "disabled";
        const registration = resolveDriver(current.capabilityKey);
        const now = clock();
        const next = await repository().patchWithRevision(connectionId, current.revision, {
          ...(data.label ? { label: data.label } : {}),
          ...(data.configuration ? { configuration: clone(data.configuration) } : {}),
          driverKey: registration?.driverKey ?? current.driverKey ?? "unconfigured",
          driverBackend: registration?.backend ?? current.driverBackend ?? "production",
          credentialState: enabled ? current.credentialState ?? "unbound" : "unbound",
          credentialBindingFingerprint: enabled && current.credentialState === "bound"
            ? current.credentialBindingFingerprint ?? null
            : null,
          status: enabled ? "needs_setup" : "disabled",
          validation: {
            status: "never_checked",
            checkedAt: null,
            message: enabled ? "Validate this connection before using it." : "This connection is disabled.",
          },
          revision: current.revision + 1,
          updatedAt: now,
        }, { workspaceId, session });
        if (!next) throw new ProductStoreError("connection_revision_conflict", "The connection changed while it was being saved.");
        await audit({ workspaceId, actorId, action: "connection.updated", entityId: connectionId, options: { session } });
        return { data: productSafeConnection(next), etag: formatConnectionEtag(next) };
      });
    },
    async bindCredential({ connectionId, idempotencyKey, ifMatch, request, workspaceId, actorId }) {
      if (!store.runIdempotentExternalMutation) {
        throw new TypeError("workbench_external_idempotency_required");
      }
      const secretRef = requiredString(
        request?.data?.secretRef ?? request?.secretRef,
        "connection_secret_ref_required",
      );
      return store.runIdempotentExternalMutation({
        scope: `bind-connection-credential:${connectionId}`,
        key: idempotencyKey,
        request: { ifMatch, secretRef },
        workspaceId,
        effectivePrincipalId: actorId,
        operationIdKind: "connection-credential-binding",
      }, async () => {
        const current = await read(connectionId, workspaceId);
        if (formatConnectionEtag(current) !== ifMatch) {
          throw new ProductStoreError("connection_revision_conflict", "The connection changed after it was opened.");
        }
        if (current.status === "disabled") {
          throw new ProductStoreError("connection_disabled", "This connection is disabled.");
        }
        const registration = resolveDriver(current.capabilityKey);
        if (!registration?.driver?.bindSecretRef) {
          throw new ProductStoreError(
            "connection_credential_binding_unavailable",
            "No governed credential binding service is configured for this Connection.",
          );
        }
        const result = await registration.driver.bindSecretRef({
          workspaceId,
          actorId,
          connectionId,
          capabilityKey: current.capabilityKey,
          configuration: clone(current.configuration),
          secretRef,
        });
        if (
          result?.ok !== true
          || result.credentialState !== "bound"
          || !CONTENT_FINGERPRINT.test(result.credentialBindingFingerprint)
        ) {
          throw new ProductStoreError(
            result?.code ?? "connection_credential_binding_failed",
            result?.message ?? "The credential reference could not be bound.",
          );
        }
        const credentialBindingFingerprint = result.credentialBindingFingerprint;
        return runMutation({
          scope: `commit-connection-credential-binding:${connectionId}`,
          key: idempotencyKey,
          request: { ifMatch, bound: true },
          workspaceId,
          effectivePrincipalId: actorId,
        }, async (session) => {
          const latest = await read(connectionId, workspaceId, { session });
          if (formatConnectionEtag(latest) !== ifMatch) {
            throw new ProductStoreError(
              "connection_revision_conflict",
              "The Connection changed while its credential was being bound.",
            );
          }
          const now = clock();
          const next = await repository().patchWithRevision(connectionId, latest.revision, {
            driverKey: registration.driverKey,
            driverBackend: registration.backend,
            credentialState: "bound",
            credentialBindingFingerprint,
            status: "needs_setup",
            validation: {
              status: "never_checked",
              checkedAt: null,
              message: "Credential reference bound. Validate this Connection before using it.",
            },
            revision: latest.revision + 1,
            updatedAt: now,
          }, { workspaceId, session });
          if (!next) {
            throw new ProductStoreError(
              "connection_revision_conflict",
              "The Connection changed while its credential was being bound.",
            );
          }
          await audit({
            workspaceId,
            actorId,
            action: "connection.credential_bound",
            entityId: connectionId,
            options: { session },
          });
          return {
            data: productSafeConnection(next),
            etag: formatConnectionEtag(next),
          };
        });
      });
    },
    async validate({ connectionId, idempotencyKey, ifMatch, request, workspaceId, actorId }) {
      if (!store.runIdempotentExternalMutation) {
        throw new TypeError("workbench_external_idempotency_required");
      }
      return store.runIdempotentExternalMutation({
        scope: `validate-connection:${connectionId}`,
        key: idempotencyKey,
        request: { ifMatch, request: clone(request) },
        workspaceId,
        effectivePrincipalId: actorId,
        operationIdKind: "connection-validation",
      }, async () => {
        const current = await read(connectionId, workspaceId);
        if (formatConnectionEtag(current) !== ifMatch) {
          throw new ProductStoreError("connection_revision_conflict", "The connection changed after it was opened.");
        }
        if (current.status === "disabled") {
          throw new ProductStoreError("connection_disabled", "This connection is disabled.");
        }
        const registration = resolveDriver(current.capabilityKey);
        const context = {
          workspaceId,
          actorId,
          connectionId,
          capabilityKey: current.capabilityKey,
          configuration: clone(current.configuration),
        };
        const credentialState = registration?.driver?.credentialState
          ? await registration.driver.credentialState(context)
          : "unbound";
        const rawProbe = registration?.driver?.probe
          ? await registration.driver.probe(context)
          : {
              ok: false,
              code: "connection_driver_unavailable",
              message: "No Connection driver is configured for this capability.",
            };
        const probe = rawProbe?.ok === true && registration?.driver?.validate
          ? await registration.driver.validate({ ...context, probe: clone(rawProbe) })
          : rawProbe;
        return runMutation({
          scope: `commit-connection-validation:${connectionId}`,
          key: idempotencyKey,
          request: {
            ifMatch,
            probe: {
              ok: probe?.ok === true,
              code: probe?.code ?? null,
              principal: probe?.principal ?? null,
              scopes: probe?.scopes ?? [],
              effects: probe?.effects ?? [],
              expiresAt: probe?.expiresAt ?? null,
            },
          },
          workspaceId,
          effectivePrincipalId: actorId,
        }, async (session) => {
          const latest = await read(connectionId, workspaceId, { session });
          if (formatConnectionEtag(latest) !== ifMatch) {
            throw new ProductStoreError("connection_revision_conflict", "The connection changed while it was being validated.");
          }
          const valid = probe?.ok === true
            && credentialState === "bound"
            && CONTENT_FINGERPRINT.test(latest.credentialBindingFingerprint);
          const now = clock();
          const next = await repository().patchWithRevision(connectionId, latest.revision, {
            driverKey: registration?.driverKey ?? latest.driverKey ?? "unconfigured",
            driverBackend: registration?.backend ?? latest.driverBackend ?? "production",
            credentialState,
            status: valid ? "connected" : "needs_setup",
            validation: {
              status: valid ? "valid" : "invalid",
              checkedAt: now,
              message: valid
                ? "Connection probe and required scopes passed."
                : String(
                  credentialState === "bound" && !latest.credentialBindingFingerprint
                    ? "Rebind this legacy credential before validation."
                    : probe?.message ?? "Connection validation failed.",
                ).slice(0, 1000),
              ...(valid ? {
                principal: String(probe.principal ?? "").slice(0, 200),
                scopes: clone(probe.scopes ?? []),
                effects: clone(probe.effects ?? []),
                expiresAt: probe.expiresAt ?? null,
              } : {}),
            },
            revision: latest.revision + 1,
            updatedAt: now,
          }, { workspaceId, session });
          if (!next) {
            throw new ProductStoreError("connection_revision_conflict", "The connection changed while it was being validated.");
          }
          await audit({
            workspaceId,
            actorId,
            action: "connection.validated",
            entityId: connectionId,
            options: { session },
          });
          return {
            data: productSafeConnection(next),
            etag: formatConnectionEtag(next),
          };
        });
      });
    },
  });
}
