import { ProductStoreError } from "../store/errors.mjs";
import { canonicalRequestHash } from "../store/serialization.mjs";
import { formatConnectionEtag, productSafeConnection } from "./workspace-connection-service.mjs";

const clone = (value) => value === undefined ? undefined : structuredClone(value);
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

/**
 * PostgreSQL authority for Connection revisions.
 *
 * Browser input contains only an opaque Secret Store reference. A registered
 * Connection driver owns the host gateway interaction, while this service
 * persists only that gateway's opaque binding identity/fingerprint. It never
 * receives a credential value or constructs a Provider request.
 */
export class PostgresWorkspaceConnectionService {
  #store;
  #sql;
  #driverRegistry;
  #idempotentMutationPort;
  #externalMutationPort;
  #clock;
  #idFactory;

  constructor({
    store,
    driverRegistry = null,
    idempotentMutationPort = null,
    externalMutationPort = null,
    clock = () => new Date().toISOString(),
    idFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
  } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_connection_service_store_required");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("postgres_connection_service_dependencies_invalid");
    }
    this.#store = store;
    this.#driverRegistry = driverRegistry;
    this.#idempotentMutationPort = idempotentMutationPort;
    this.#externalMutationPort = externalMutationPort;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async list({ workspaceId, query = {} } = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
    return this.#transact(async (sql) => (await sql(`
      SELECT connection.*, revision.*
        FROM public.workspace_connections connection
        JOIN public.workspace_connection_revisions revision
          ON revision.workspace_id = connection.workspace_id
         AND revision.connection_id = connection.connection_id
         AND revision.connection_revision_id = connection.current_revision_id
       WHERE connection.workspace_id = $1
         AND ($2::boolean OR connection.enabled = true)
       ORDER BY connection.updated_at DESC, connection.connection_id DESC LIMIT $3
    `, [workspaceId, query.includeDisabled === true, limit])).rows.map(connectionView).map(productSafeConnection));
  }

  async get({ connectionId, workspaceId } = {}) {
    const connection = await this.getInternal({ connectionId, workspaceId });
    if (!connection) throw notFound(connectionId);
    return { data: productSafeConnection(connection), etag: formatConnectionEtag(connection) };
  }

  async getInternal({ connectionId, workspaceId } = {}) {
    return this.#transact(async (sql) => connectionView((await sql(currentConnectionQuery(), [workspaceId, connectionId])).rows[0]));
  }

  async create({ idempotencyKey, request, workspaceId, actorId } = {}) {
    const data = requestData(request);
    requireString(workspaceId, "workspace_id_required");
    requireString(actorId, "user_id_required");
    requireString(idempotencyKey, "idempotency_key_required");
    const capabilityKey = requireString(data?.capabilityKey, "connection_capability_required", 128);
    const label = requireString(data?.label, "connection_label_required", 200);
    const configuration = safeConfiguration(data?.configuration);
    return this.#runIdempotent({
      scope: "create-connection", key: idempotencyKey, request: { data: { capabilityKey, label, configuration } },
      workspaceId, effectivePrincipalId: actorId,
    }, async (uow) => this.#write(async (sql) => {
      const scopeId = await personalScope(sql, workspaceId, actorId);
      if (!scopeId) throw new ProductStoreError("connection_scope_unavailable", "Create a personal workspace scope before configuring a Connection.");
      const registration = this.#registration(capabilityKey);
      const now = this.#now();
      const connectionId = this.#idFactory("connection");
      const revisionId = this.#idFactory("connection-revision");
      const revision = {
        connectionId, connectionRevisionId: revisionId, scopeId, revision: 1,
        capabilityKey, driverKey: registration?.driverKey ?? "unconfigured",
        driverBackend: registration?.backend ?? "production", configuration,
        credentialState: "unbound", secretBindingId: null, credentialBindingFingerprint: null,
        readinessStatus: "needs_setup", validationStatus: "never_checked",
        validationMessage: "Bind and validate this Connection before using it.",
        validationPrincipal: null, validationScopes: [], validationEffects: [],
        validationCheckedAt: null, validationExpiresAt: null, createdBy: actorId,
        createdAt: now, rootCreatedAt: now, payload: {},
      };
      await sql("SET CONSTRAINTS ALL DEFERRED");
      await sql(`INSERT INTO public.workspace_connections (
        workspace_id, connection_id, scope_id, created_by, schema_version, label, enabled,
        current_revision_id, current_revision_number, created_at, updated_at, payload
      ) VALUES ($1, $2, $3, $4, 'workbench-v1', $5, true, $6, 1, $7::timestamptz, $7::timestamptz, '{}'::jsonb)`, [
        workspaceId, connectionId, scopeId, actorId, label, revisionId, now,
      ]);
      await insertRevision(sql, workspaceId, revision);
      return response(connectionFromWrite({ workspaceId, label, enabled: true, revision }));
    }, uow));
  }

  async update({ connectionId, idempotencyKey, ifMatch, request, workspaceId, actorId } = {}) {
    const data = requestData(request);
    requireString(connectionId, "connection_id_required");
    requireString(idempotencyKey, "idempotency_key_required");
    requireString(ifMatch, "connection_etag_required");
    requireString(workspaceId, "workspace_id_required");
    requireString(actorId, "user_id_required");
    const patch = normalizedUpdate(data);
    if (patch.enabled === false) {
      return this.#disable({ connectionId, idempotencyKey, ifMatch, patch, workspaceId, actorId });
    }
    return this.#runIdempotent({
      scope: `update-connection:${connectionId}`, key: idempotencyKey,
      request: { ifMatch, data: patch }, workspaceId, effectivePrincipalId: actorId,
    }, async (uow) => this.#write(async (sql) => {
      const current = await currentForUpdate(sql, workspaceId, connectionId);
      assertEtag(current, ifMatch);
      const now = this.#now();
      const nextEnabled = patch.enabled ?? current.enabled;
      const registration = this.#registration(current.capabilityKey);
      const revision = revisionFromCurrent(current, {
        connectionRevisionId: this.#idFactory("connection-revision"),
        revision: current.revision + 1, createdBy: actorId, createdAt: now,
        driverKey: registration?.driverKey ?? current.driverKey,
        driverBackend: registration?.backend ?? current.driverBackend,
        configuration: patch.configuration ?? current.configuration,
        readinessStatus: "needs_setup", validationStatus: "never_checked",
        validationMessage: nextEnabled
          ? "Validate this Connection after changing its configuration."
          : "This connection is disabled.",
        validationPrincipal: null, validationScopes: [], validationEffects: [],
        validationCheckedAt: null, validationExpiresAt: null,
      });
      await sql("SET CONSTRAINTS ALL DEFERRED");
      await insertRevision(sql, workspaceId, revision);
      await advanceConnection(sql, {
        workspaceId, connectionId, revision, label: patch.label ?? current.label,
        enabled: nextEnabled, now, expectedWriteVersion: current.writeVersion,
      });
      return response(connectionFromWrite({ workspaceId, label: patch.label ?? current.label, enabled: nextEnabled, revision }));
    }, uow));
  }

  async #disable({ connectionId, idempotencyKey, ifMatch, patch, workspaceId, actorId }) {
    const current = await this.getInternal({ workspaceId, connectionId });
    assertEtag(current, ifMatch);
    // A Connection that never received a binding has no external authority to
    // revoke. Its local disable remains an ordinary atomic revision write.
    if (!current.secretBindingId) {
      return this.#runIdempotent({
        scope: `update-connection:${connectionId}`, key: idempotencyKey,
        request: { ifMatch, data: patch }, workspaceId, effectivePrincipalId: actorId,
      }, async (uow) => this.#write(async (sql) => this.#commitDisabled({
        sql, connectionId, ifMatch, patch, workspaceId, actorId, operationId: null,
      }), uow));
    }
    const registration = this.#registration(current.capabilityKey);
    if (typeof registration?.driver?.revoke !== "function") {
      throw new ProductStoreError("connection_credential_revoke_unavailable", "The governed credential binding cannot be revoked by this Connection driver.");
    }
    return this.#runExternal({
      scope: `disable-connection:${connectionId}`, key: idempotencyKey,
      request: { ifMatch, data: patch }, workspaceId, effectivePrincipalId: actorId,
      recover: async (operationId) => this.#recoverOperation({ workspaceId, connectionId, operationId, kind: "disable" }),
    }, async (operationId) => {
      const latest = await this.getInternal({ workspaceId, connectionId });
      assertEtag(latest, ifMatch);
      const result = await registration.driver.revoke({
        workspaceId, actorId, connectionId, scopeId: latest.scopeId,
        secretBindingId: latest.secretBindingId,
        expectedCredentialBindingFingerprint: latest.credentialBindingFingerprint,
        capabilityKey: latest.capabilityKey, operationId,
      });
      if (result?.revoked !== true) {
        throw new ProductStoreError("connection_credential_revoke_unavailable", "The governed credential binding could not be revoked.");
      }
      return this.#write(async (sql) => this.#commitDisabled({
        sql, connectionId, ifMatch, patch, workspaceId, actorId, operationId,
      }));
    });
  }

  async #commitDisabled({ sql, connectionId, ifMatch, patch, workspaceId, actorId, operationId }) {
    const current = await currentForUpdate(sql, workspaceId, connectionId);
    assertEtag(current, ifMatch);
    const now = this.#now();
    await sql("SET CONSTRAINTS ALL DEFERRED");
    if (current.secretBindingId) await revokeBinding(sql, workspaceId, current.secretBindingId, now);
    const revision = revisionFromCurrent(current, {
      connectionRevisionId: this.#idFactory("connection-revision"), revision: current.revision + 1,
      createdBy: actorId, createdAt: now, configuration: patch.configuration ?? current.configuration,
      credentialState: "unbound", secretBindingId: null, credentialBindingFingerprint: null,
      readinessStatus: "needs_setup", validationStatus: "never_checked",
      validationMessage: "This connection is disabled.", validationPrincipal: null,
      validationScopes: [], validationEffects: [], validationCheckedAt: null, validationExpiresAt: null,
      payload: operationId ? { disableOperationId: operationId } : {},
    });
    await insertRevision(sql, workspaceId, revision);
    await advanceConnection(sql, {
      workspaceId, connectionId, revision, label: patch.label ?? current.label,
      enabled: false, now, expectedWriteVersion: current.writeVersion,
    });
    return response(connectionFromWrite({ workspaceId, label: patch.label ?? current.label, enabled: false, revision }));
  }

  async bindCredential({ connectionId, idempotencyKey, ifMatch, request, workspaceId, actorId } = {}) {
    const secretRef = requireString(requestData(request)?.secretRef, "connection_secret_ref_required", 256);
    requireString(connectionId, "connection_id_required");
    requireString(idempotencyKey, "idempotency_key_required");
    requireString(ifMatch, "connection_etag_required");
    requireString(workspaceId, "workspace_id_required");
    requireString(actorId, "user_id_required");
    const registration = await this.#requireDriver(connectionId, workspaceId);
    if (typeof registration.driver?.bindSecretRef !== "function") throw bindingUnavailable();
    return this.#runExternal({
      scope: `bind-connection-credential:${connectionId}`, key: idempotencyKey,
      // The idempotency receipt contains a request hash only. Never persist the opaque ref itself.
      request: { ifMatch, secretRefHash: canonicalRequestHash(secretRef) },
      workspaceId, effectivePrincipalId: actorId,
      recover: async (operationId) => this.#recoverOperation({ workspaceId, connectionId, operationId, kind: "binding" }),
    }, async (operationId) => {
      const current = await this.getInternal({ workspaceId, connectionId });
      assertEtag(current, ifMatch);
      if (!current.enabled) throw disabled();
      const result = await registration.driver.bindSecretRef({
        workspaceId, actorId, connectionId, scopeId: current.scopeId,
        capabilityKey: current.capabilityKey, configuration: clone(current.configuration),
        secretRef, operationId,
      });
      const binding = bindingFromDriver(result);
      return this.#write(async (sql) => {
        const latest = await currentForUpdate(sql, workspaceId, connectionId);
        assertEtag(latest, ifMatch);
        if (!latest.enabled) throw disabled();
        const now = this.#now();
        await sql("SET CONSTRAINTS ALL DEFERRED");
        if (latest.secretBindingId) await revokeBinding(sql, workspaceId, latest.secretBindingId, now);
        const secretBindingId = this.#idFactory("secret-binding");
        await sql(`INSERT INTO public.secret_bindings (
          workspace_id, secret_binding_id, scope_id, schema_version, owner_kind, owner_id,
          secret_source, store_binding_ref, store_binding_revision, credential_fingerprint,
          status, status_revision, created_by_principal_id, created_by_principal_kind,
          probed_at, expires_at, revoked_at, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, 'workbench-secret-binding-v1', 'connection', $4,
          $5, $6, $7, $8, 'pending', 1, $9, 'user', NULL, $10::timestamptz, NULL,
          $11::timestamptz, $11::timestamptz, $12::jsonb)`, [
          workspaceId, secretBindingId, latest.scopeId, connectionId,
          binding.secretSource, binding.storeBindingRef, binding.storeBindingRevision,
          binding.credentialBindingFingerprint, actorId, binding.expiresAt,
          now, JSON.stringify({ bindingOperationId: operationId }),
        ]);
        const revision = revisionFromCurrent(latest, {
          connectionRevisionId: this.#idFactory("connection-revision"), revision: latest.revision + 1,
          createdBy: actorId, createdAt: now, driverKey: registration.driverKey,
          driverBackend: registration.backend, credentialState: "bound", secretBindingId,
          credentialBindingFingerprint: binding.credentialBindingFingerprint,
          readinessStatus: "needs_setup", validationStatus: "never_checked",
          validationMessage: "Credential reference bound. Validate this Connection before using it.",
          validationPrincipal: null, validationScopes: [], validationEffects: [],
          validationCheckedAt: null, validationExpiresAt: null,
          payload: { bindingOperationId: operationId },
        });
        await insertRevision(sql, workspaceId, revision);
        await advanceConnection(sql, {
          workspaceId, connectionId, revision, label: latest.label, enabled: true,
          now, expectedWriteVersion: latest.writeVersion,
        });
        return response(connectionFromWrite({ workspaceId, label: latest.label, enabled: true, revision }));
      });
    });
  }

  async validate({ connectionId, idempotencyKey, ifMatch, request, workspaceId, actorId } = {}) {
    requireString(connectionId, "connection_id_required");
    requireString(idempotencyKey, "idempotency_key_required");
    requireString(ifMatch, "connection_etag_required");
    requireString(workspaceId, "workspace_id_required");
    requireString(actorId, "user_id_required");
    const registration = await this.#requireDriver(connectionId, workspaceId);
    return this.#runExternal({
      scope: `validate-connection:${connectionId}`, key: idempotencyKey,
      request: { ifMatch, data: requestData(request) ?? {} }, workspaceId, effectivePrincipalId: actorId,
      recover: async (operationId) => this.#recoverOperation({ workspaceId, connectionId, operationId, kind: "validation" }),
    }, async (operationId) => {
      const current = await this.getInternal({ workspaceId, connectionId });
      assertEtag(current, ifMatch);
      if (!current.enabled) throw disabled();
      if (current.credentialState !== "bound" || !current.secretBindingId || !FINGERPRINT.test(current.credentialBindingFingerprint ?? "")) {
        throw new ProductStoreError("connection_credential_unbound", "Bind a governed credential before validating this Connection.");
      }
      const context = {
        workspaceId, actorId, connectionId, scopeId: current.scopeId,
        capabilityKey: current.capabilityKey, configuration: clone(current.configuration),
        secretBindingId: current.secretBindingId,
        expectedCredentialBindingFingerprint: current.credentialBindingFingerprint,
        operationId,
      };
      const credentialState = typeof registration.driver?.credentialState === "function"
        ? await registration.driver.credentialState(context)
        : "unbound";
      const rawProbe = typeof registration.driver?.probe === "function"
        ? await registration.driver.probe(context)
        : { ok: false, code: "connection_driver_unavailable", message: "No Connection driver is configured for this capability." };
      const probe = rawProbe?.ok === true && typeof registration.driver?.validate === "function"
        ? await registration.driver.validate({ ...context, probe: clone(rawProbe) })
        : rawProbe;
      return this.#write(async (sql) => {
        const latest = await currentForUpdate(sql, workspaceId, connectionId);
        assertEtag(latest, ifMatch);
        if (!latest.enabled) throw disabled();
        if (latest.secretBindingId !== current.secretBindingId || latest.credentialBindingFingerprint !== current.credentialBindingFingerprint) {
          throw conflict("The Connection changed while it was being validated.");
        }
        const now = this.#now();
        const valid = probe?.ok === true && credentialState === "bound";
        await sql("SET CONSTRAINTS ALL DEFERRED");
        await transitionBinding(sql, {
          workspaceId, secretBindingId: latest.secretBindingId,
          status: valid ? "active" : "invalid", now,
        });
        const revision = revisionFromCurrent(latest, {
          connectionRevisionId: this.#idFactory("connection-revision"), revision: latest.revision + 1,
          createdBy: actorId, createdAt: now, driverKey: registration.driverKey,
          driverBackend: registration.backend, readinessStatus: valid ? "connected" : "needs_setup",
          validationStatus: valid ? "valid" : "invalid",
          validationMessage: valid
            ? "Connection probe and required scopes passed."
            : String(probe?.message ?? "Connection validation failed.").slice(0, 1000),
          validationPrincipal: valid ? boundedString(probe?.principal, 200) : null,
          validationScopes: valid ? normalizedStrings(probe?.scopes, 200) : [],
          validationEffects: valid ? normalizedStrings(probe?.effects, 128) : [],
          validationCheckedAt: now, validationExpiresAt: valid ? optionalTimestamp(probe?.expiresAt) : null,
          payload: { validationOperationId: operationId },
        });
        await insertRevision(sql, workspaceId, revision);
        await advanceConnection(sql, {
          workspaceId, connectionId, revision, label: latest.label, enabled: true,
          now, expectedWriteVersion: latest.writeVersion,
        });
        return response(connectionFromWrite({ workspaceId, label: latest.label, enabled: true, revision }));
      });
    });
  }

  async #requireDriver(connectionId, workspaceId) {
    const connection = await this.getInternal({ connectionId, workspaceId });
    if (!connection) throw notFound(connectionId);
    const registration = this.#registration(connection.capabilityKey);
    if (!registration) {
      throw new ProductStoreError("connection_driver_unavailable", "No Connection driver is configured for this capability.");
    }
    return registration;
  }

  #registration(capabilityKey) { return this.#driverRegistry?.resolve?.(capabilityKey) ?? null; }

  #runIdempotent(options, mutation) {
    if (typeof this.#idempotentMutationPort?.run !== "function") throw mutationUnavailable();
    return this.#idempotentMutationPort.run(options, mutation);
  }

  #runExternal(options, mutation) {
    if (typeof this.#externalMutationPort?.run !== "function") throw bindingUnavailable();
    return this.#externalMutationPort.run(options, mutation);
  }

  async #recoverOperation({ workspaceId, connectionId, operationId, kind }) {
    const field = kind === "binding"
      ? "bindingOperationId"
      : kind === "disable"
        ? "disableOperationId"
        : "validationOperationId";
    return this.#transact(async (sql) => {
      const row = (await sql(`${currentConnectionQuery()} AND revision.payload ->> $3 = $4`, [workspaceId, connectionId, field, operationId])).rows[0];
      return row ? response(connectionView(row)) : null;
    });
  }

  #write(work, uow = undefined) { return this.#transact(work, uow); }
  #transact(work, uow = undefined) {
    return this.#store.withTransaction((unit) => work((text, values = []) => this.#sql.query(unit, text, values), unit), uow ? { uow } : {});
  }
  #now() { return timestamp(this.#clock()); }
}

function currentConnectionQuery({ lock = false } = {}) {
  return `SELECT connection.*, revision.*
    FROM public.workspace_connections connection
    JOIN public.workspace_connection_revisions revision
      ON revision.workspace_id = connection.workspace_id
     AND revision.connection_id = connection.connection_id
     AND revision.connection_revision_id = connection.current_revision_id
   WHERE connection.workspace_id = $1 AND connection.connection_id = $2${lock ? " FOR UPDATE OF connection" : ""}`;
}

async function currentForUpdate(sql, workspaceId, connectionId) {
  const value = connectionView((await sql(currentConnectionQuery({ lock: true }), [workspaceId, connectionId])).rows[0]);
  if (!value) throw notFound(connectionId);
  return value;
}

async function personalScope(sql, workspaceId, actorId) {
  return (await sql(`SELECT scope_id FROM public.product_scopes
    WHERE workspace_id = $1 AND scope_kind = 'personal' AND owner_user_id = $2
    ORDER BY scope_id ASC LIMIT 1 FOR SHARE`, [workspaceId, actorId])).rows[0]?.scope_id ?? null;
}

async function insertRevision(sql, workspaceId, revision) {
  await sql(`INSERT INTO public.workspace_connection_revisions (
    workspace_id, connection_revision_id, connection_id, scope_id, revision_number,
    base_revision_id, base_revision_number, schema_version, capability_key, driver_key,
    driver_backend, safe_configuration, credential_state, secret_binding_id,
    credential_binding_fingerprint, readiness_status, validation_status, validation_message,
    validation_principal, validation_scopes, validation_effects, validation_checked_at,
    validation_expires_at, content_hash, created_by, created_at, payload
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'workbench-connection-v1', $8, $9,
    $10, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb,
    $21::timestamptz, $22::timestamptz, $23, $24, $25::timestamptz, $26::jsonb)`, [
    workspaceId, revision.connectionRevisionId, revision.connectionId, revision.scopeId, revision.revision,
    revision.baseRevisionId, revision.baseRevisionNumber, revision.capabilityKey, revision.driverKey,
    revision.driverBackend, JSON.stringify(revision.configuration), revision.credentialState,
    revision.secretBindingId, revision.credentialBindingFingerprint, revision.readinessStatus,
    revision.validationStatus, revision.validationMessage, revision.validationPrincipal,
    JSON.stringify(revision.validationScopes), JSON.stringify(revision.validationEffects),
    revision.validationCheckedAt, revision.validationExpiresAt, contentHash(revision), revision.createdBy,
    revision.createdAt, JSON.stringify(revision.payload ?? {}),
  ]);
}

async function advanceConnection(sql, { workspaceId, connectionId, revision, label, enabled, now, expectedWriteVersion }) {
  const result = await sql(`UPDATE public.workspace_connections
    SET label = $3, enabled = $4, current_revision_id = $5, current_revision_number = $6,
        write_version = write_version + 1, updated_at = $7::timestamptz
    WHERE workspace_id = $1 AND connection_id = $2 AND write_version = $8`, [
    workspaceId, connectionId, label, enabled, revision.connectionRevisionId, revision.revision, now, expectedWriteVersion,
  ]);
  if (result.rowCount !== 1) throw conflict("The Connection changed while it was being saved.");
}

async function revokeBinding(sql, workspaceId, secretBindingId, now) {
  await sql(`UPDATE public.secret_bindings
    SET status = 'revoked', status_revision = status_revision + 1, revoked_at = $3::timestamptz,
        updated_at = $3::timestamptz
    WHERE workspace_id = $1 AND secret_binding_id = $2 AND status <> 'revoked'`, [workspaceId, secretBindingId, now]);
}

async function transitionBinding(sql, { workspaceId, secretBindingId, status, now }) {
  const result = await sql(`UPDATE public.secret_bindings
    SET status = $3, status_revision = status_revision + 1,
        probed_at = CASE WHEN $3 = 'active' THEN $4::timestamptz ELSE probed_at END,
        updated_at = $4::timestamptz
    WHERE workspace_id = $1 AND secret_binding_id = $2 AND status <> 'revoked'
    RETURNING secret_binding_id`, [workspaceId, secretBindingId, status, now]);
  if (result.rowCount !== 1) {
    throw new ProductStoreError("connection_credential_unbound", "The governed credential binding is no longer available.");
  }
}

function revisionFromCurrent(current, patch) {
  return {
    connectionId: current.connectionId, scopeId: current.scopeId,
    baseRevisionId: current.connectionRevisionId, baseRevisionNumber: current.revision,
    capabilityKey: current.capabilityKey, driverKey: current.driverKey, driverBackend: current.driverBackend,
    configuration: clone(current.configuration), credentialState: current.credentialState,
    secretBindingId: current.secretBindingId, credentialBindingFingerprint: current.credentialBindingFingerprint,
    readinessStatus: current.status === "connected" ? "connected" : "needs_setup",
    validationStatus: current.validation.status, validationMessage: current.validation.message,
    validationPrincipal: current.validation.principal ?? null, validationScopes: clone(current.validation.scopes ?? []),
    validationEffects: clone(current.validation.effects ?? []), validationCheckedAt: current.validation.checkedAt,
    validationExpiresAt: current.validation.expiresAt, rootCreatedAt: current.createdAt, payload: {}, ...patch,
  };
}

function connectionFromWrite({ workspaceId, label, enabled, revision }) {
  return {
    schemaVersion: "workbench-v1", workspaceId, connectionId: revision.connectionId, scopeId: revision.scopeId,
    capabilityKey: revision.capabilityKey, driverKey: revision.driverKey, driverBackend: revision.driverBackend,
    label, enabled, configuration: clone(revision.configuration), credentialState: revision.credentialState,
    secretBindingId: revision.secretBindingId, credentialBindingFingerprint: revision.credentialBindingFingerprint,
    status: enabled ? revision.readinessStatus : "disabled",
    validation: {
      status: revision.validationStatus, checkedAt: revision.validationCheckedAt,
      message: revision.validationMessage, principal: revision.validationPrincipal,
      scopes: clone(revision.validationScopes), effects: clone(revision.validationEffects),
      expiresAt: revision.validationExpiresAt,
    }, revision: revision.revision,
    createdAt: revision.rootCreatedAt ?? revision.createdAt, updatedAt: revision.createdAt,
  };
}

function connectionView(row) {
  if (!row) return null;
  const configuration = row.safe_configuration ?? {};
  return {
    ...(row.payload ?? {}), schemaVersion: "workbench-v1", connectionId: row.connection_id,
    connectionRevisionId: row.connection_revision_id, workspaceId: row.workspace_id, scopeId: row.scope_id,
    capabilityKey: row.capability_key, driverKey: row.driver_key, driverBackend: row.driver_backend,
    label: row.label, enabled: row.enabled === true, configuration: {
      ...(typeof configuration.accountLabel === "string" ? { accountLabel: configuration.accountLabel } : {}),
      ...(typeof configuration.permissionSummary === "string" ? { permissionSummary: configuration.permissionSummary } : {}),
    }, credentialState: row.credential_state, secretBindingId: row.secret_binding_id,
    credentialBindingFingerprint: row.credential_binding_fingerprint,
    status: row.enabled === true ? row.readiness_status : "disabled",
    validation: {
      status: row.validation_status, checkedAt: row.validation_checked_at ? iso(row.validation_checked_at) : null,
      message: row.validation_message, principal: row.validation_principal ?? null,
      scopes: clone(row.validation_scopes ?? []), effects: clone(row.validation_effects ?? []),
      expiresAt: row.validation_expires_at ? iso(row.validation_expires_at) : null,
    }, revision: Number(row.current_revision_number), writeVersion: Number(row.write_version),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

function response(connection) { return { data: productSafeConnection(connection), etag: formatConnectionEtag(connection) }; }
function assertEtag(current, ifMatch) { if (!current || formatConnectionEtag(current) !== ifMatch) throw conflict("The Connection changed after it was opened."); }
function notFound(connectionId) { return new ProductStoreError("connection_not_found", "Connection not found.", { connectionId }); }
function conflict(message) { return new ProductStoreError("connection_revision_conflict", message); }
function disabled() { return new ProductStoreError("connection_disabled", "This connection is disabled."); }
function mutationUnavailable() { return new ProductStoreError("connection_mutation_command_required", "Connection changes require the Product mutation command path."); }
function bindingUnavailable() { return new ProductStoreError("connection_credential_binding_unavailable", "No governed credential binding service is configured for this Connection."); }

function requestData(request) { return request?.data && typeof request.data === "object" ? request.data : request; }
function requireString(value, code, max = Infinity) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new ProductStoreError(code, code);
  return value;
}
function safeConfiguration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, max] of [["accountLabel", 200], ["permissionSummary", 1000]]) {
    if (value[key] !== undefined) out[key] = requireString(value[key], "connection_configuration_invalid", max);
  }
  return out;
}
function normalizedUpdate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductStoreError("connection_update_invalid", "A Connection update is required.");
  }
  const result = {};
  if (value.label !== undefined) result.label = requireString(value.label, "connection_label_required", 200);
  if (value.configuration !== undefined) result.configuration = safeConfiguration(value.configuration);
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") throw new ProductStoreError("connection_update_invalid", "Connection enabled must be a boolean.");
    result.enabled = value.enabled;
  }
  if (Object.keys(result).length === 0) throw new ProductStoreError("connection_update_invalid", "A Connection update is required.");
  return result;
}
function bindingFromDriver(result) {
  const binding = result?.secretBinding ?? result?.binding;
  if (
    result?.ok !== true || result?.credentialState !== "bound" || !binding
    || binding.secretSource !== "cloud_secret_store"
    || typeof binding.storeBindingRef !== "string" || binding.storeBindingRef.length === 0
    || !Number.isInteger(binding.storeBindingRevision) || binding.storeBindingRevision < 1
    || !FINGERPRINT.test(binding.credentialBindingFingerprint ?? result.credentialBindingFingerprint ?? "")
  ) {
    throw new ProductStoreError(result?.code ?? "connection_credential_binding_failed", result?.message ?? "The credential reference could not be bound.");
  }
  return {
    secretSource: binding.secretSource, storeBindingRef: binding.storeBindingRef,
    storeBindingRevision: binding.storeBindingRevision,
    credentialBindingFingerprint: binding.credentialBindingFingerprint ?? result.credentialBindingFingerprint,
    expiresAt: optionalTimestamp(binding.expiresAt),
  };
}
function normalizedStrings(value, max) {
  return [...new Set((Array.isArray(value) ? value : []).filter((entry) => typeof entry === "string" && entry.length > 0).map((entry) => entry.slice(0, max)))].sort();
}
function boundedString(value, max) { return typeof value === "string" && value.length > 0 ? value.slice(0, max) : null; }
function optionalTimestamp(value) { return value == null ? null : timestamp(value); }
function timestamp(value) { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_connection_clock_invalid"); return date.toISOString(); }
function iso(value) { return value == null ? null : timestamp(value); }
function contentHash(revision) {
  return canonicalRequestHash({
    connectionId: revision.connectionId, connectionRevisionId: revision.connectionRevisionId,
    scopeId: revision.scopeId, revision: revision.revision, baseRevisionId: revision.baseRevisionId,
    baseRevisionNumber: revision.baseRevisionNumber, capabilityKey: revision.capabilityKey,
    driverKey: revision.driverKey, driverBackend: revision.driverBackend, configuration: revision.configuration,
    credentialState: revision.credentialState, secretBindingId: revision.secretBindingId,
    credentialBindingFingerprint: revision.credentialBindingFingerprint, readinessStatus: revision.readinessStatus,
    validationStatus: revision.validationStatus, validationMessage: revision.validationMessage,
    validationPrincipal: revision.validationPrincipal, validationScopes: revision.validationScopes,
    validationEffects: revision.validationEffects, validationCheckedAt: revision.validationCheckedAt,
    validationExpiresAt: revision.validationExpiresAt,
  });
}
