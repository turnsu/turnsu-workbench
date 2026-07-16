import { ProductStoreError } from "../store/errors.mjs";

const clone = (value) => value === undefined ? undefined : structuredClone(value);

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
    label: connection.label,
    configuration,
    status: connection.status,
    validation: clone(connection.validation),
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
    if (connection.status !== "connected" || connection.validation?.status !== "valid") {
      throw new ProductStoreError(
        "connection_not_ready",
        "Validate the selected connection before continuing.",
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
      }, async (session) => {
        const now = clock();
        const connection = await repository().insert({
          schemaVersion: "workbench-v1",
          connectionId: idFactory("connection"),
          workspaceId,
          capabilityKey: data.capabilityKey,
          label: data.label,
          configuration: clone(data.configuration ?? {}),
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
      return runMutation({
        scope: `update-connection:${connectionId}`,
        key: idempotencyKey,
        request: { ifMatch, request: clone(request) },
        workspaceId,
      }, async (session) => {
        const current = await read(connectionId, workspaceId, { session });
        if (formatConnectionEtag(current) !== ifMatch) {
          throw new ProductStoreError("connection_revision_conflict", "The connection changed after it was opened.");
        }
        const data = request?.data ?? request;
        const enabled = data.enabled ?? current.status !== "disabled";
        const now = clock();
        const next = await repository().patchWithRevision(connectionId, current.revision, {
          ...(data.label ? { label: data.label } : {}),
          ...(data.configuration ? { configuration: clone(data.configuration) } : {}),
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
    async validate({ connectionId, idempotencyKey, ifMatch, request, workspaceId, actorId }) {
      return runMutation({
        scope: `validate-connection:${connectionId}`,
        key: idempotencyKey,
        request: { ifMatch, request: clone(request) },
        workspaceId,
      }, async (session) => {
        const current = await read(connectionId, workspaceId, { session });
        if (formatConnectionEtag(current) !== ifMatch) {
          throw new ProductStoreError("connection_revision_conflict", "The connection changed after it was opened.");
        }
        const configured = Boolean(
          current.configuration?.accountLabel && current.configuration?.permissionSummary,
        );
        const enabled = current.status !== "disabled";
        const valid = enabled && configured;
        const now = clock();
        const next = await repository().patchWithRevision(connectionId, current.revision, {
          status: !enabled ? "disabled" : valid ? "connected" : "needs_setup",
          validation: {
            status: valid ? "valid" : "invalid",
            checkedAt: now,
            message: !enabled
              ? "This connection is disabled."
              : valid
                ? "Connection setup is ready."
                : "Add an account label and permission summary, then validate again.",
          },
          revision: current.revision + 1,
          updatedAt: now,
        }, { workspaceId, session });
        if (!next) throw new ProductStoreError("connection_revision_conflict", "The connection changed while it was being validated.");
        await audit({ workspaceId, actorId, action: "connection.validated", entityId: connectionId, options: { session } });
        return { data: productSafeConnection(next), etag: formatConnectionEtag(next) };
      });
    },
  });
}
