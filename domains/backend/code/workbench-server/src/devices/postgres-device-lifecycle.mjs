import { createHash, randomUUID } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKSPACE_MANAGERS = new Set(["owner", "admin"]);
const PLATFORM = new Set(["macos", "windows"]);
const ARCHITECTURE = new Set(["arm64", "x64"]);
const CAPABILITIES = new Set([
  "file_read",
  "file_write",
  "notification",
  "voice_input",
  "sandbox_oci",
  "local_deterministic_skill",
]);

// This is the first published Device protocol. A future compatibility catalog
// may admit an explicit range, but an unknown protocol is never dispatchable.
export const DEVICE_WORKER_PROTOCOL_VERSION = "workbench-device-worker-v1";
const DEVICE_OFFLINE_AFTER_MS = 5 * 60_000;

/**
 * PostgreSQL owner for a registered native Product Device.
 *
 * A Device is deliberately not a generic Worker registration API. It binds a
 * desktop native client session that has already completed browser-approved
 * PKCE. The raw native public key never leaves the native session store; this
 * owner persists and exposes only a fingerprint. Live outbound connections
 * are ephemeral and may be notified by the Product application after its
 * enclosing idempotent transaction commits; they do not become a second
 * Device or command authority.
 */
export class PostgresDeviceLifecycle {
  #store;
  #sql;
  #commandAuthorizer;
  #clock;
  #idFactory;
  #onDeviceRevoked;

  constructor({
    store,
    commandAuthorizer,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
    onDeviceRevoked = null,
  } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || !store?.connect) {
      throw new TypeError("postgres_device_lifecycle_store_required");
    }
    if (!commandAuthorizer
      || typeof commandAuthorizer.authorizeDeviceRegistration !== "function"
      || typeof commandAuthorizer.authorizeDeviceRevocation !== "function") {
      throw new TypeError("postgres_device_lifecycle_command_authorizer_required");
    }
    if (typeof clock !== "function" || typeof idFactory !== "function"
      || (onDeviceRevoked !== null && typeof onDeviceRevoked !== "function")) {
      throw new TypeError("postgres_device_lifecycle_dependencies_invalid");
    }
    this.#store = store;
    this.#commandAuthorizer = commandAuthorizer;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#onDeviceRevoked = onDeviceRevoked;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async listDevices({ context } = {}) {
    assertContext(context);
    return this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const rows = (await query(`
        SELECT device.*, session.status AS native_session_status,
               session.expires_at AS native_session_expires_at,
               membership.status AS membership_status
          FROM public.devices device
          JOIN public.native_client_sessions session
            ON session.client_session_id = device.native_client_session_id
          JOIN public.workspace_memberships membership
            ON membership.workspace_id = device.workspace_id
           AND membership.user_id = device.owner_user_id
         WHERE device.workspace_id = $1
           AND ($2::boolean OR device.owner_user_id = $3)
         ORDER BY device.updated_at DESC, device.device_id DESC
      `, [context.workspaceId, WORKSPACE_MANAGERS.has(context.role), context.userId])).rows;
      return rows.map((row) => publicDevice(row, now));
    });
  }

  async getDevice({ deviceId, context } = {}) {
    assertContext(context);
    assertId(deviceId, "device_id_required");
    return this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const row = await this.#loadVisibleDevice(query, { deviceId, context, lock: false });
      if (!row) throw coded("device_not_found");
      return { data: publicDevice(row, now) };
    });
  }

  async registerDevice({ request, context, transactionSession = null } = {}) {
    assertDesktopContext(context);
    const input = normalizeRegistration(request);
    return this.#transaction(async (query, uow) => {
      let now = await this.#databaseNow(query);
      // One native session may create at most one Device. An update lock turns
      // concurrent registrations with different idempotency keys into a read
      // of the first committed Device instead of a raw unique-violation.
      const nativeSession = await this.#loadActiveDesktopSession(query, { context, now, lock: "update" });
      const existing = (await query(`
        SELECT device.*, session.status AS native_session_status,
               session.expires_at AS native_session_expires_at,
               membership.status AS membership_status
          FROM public.devices device
          JOIN public.native_client_sessions session
            ON session.client_session_id = device.native_client_session_id
          JOIN public.workspace_memberships membership
            ON membership.workspace_id = device.workspace_id
           AND membership.user_id = device.owner_user_id
         WHERE device.workspace_id = $1 AND device.native_client_session_id = $2
         FOR UPDATE OF device
      `, [context.workspaceId, nativeSession.client_session_id])).rows[0];
      if (existing) return { data: publicDevice(existing, now) };

      const deviceId = newId(this.#idFactory, "device");
      const publicIdentity = deviceFingerprint(nativeSession.device_public_key);
      const authority = await this.#commandAuthorizer.authorizeDeviceRegistration({
        workspaceId: context.workspaceId,
        userId: context.userId,
        deviceId,
        clientSessionId: nativeSession.client_session_id,
        publicIdentity,
        ...input,
        uow,
      });
      // A command cannot predate the authority decision that permits it.
      now = await this.#databaseNow(query);
      const commandId = newId(this.#idFactory, "product-command");
      const eventId = newId(this.#idFactory, "device-event");
      const health = input.workerProtocolVersion === DEVICE_WORKER_PROTOCOL_VERSION
        ? "ready"
        : "incompatible";

      await query("SET CONSTRAINTS ALL DEFERRED");
      await this.#insertCompletedCommand(query, {
        commandId,
        authority,
        userId: context.userId,
        actionId: "device_register",
        targetKind: "device",
        targetId: deviceId,
        targetRevision: 1,
        now,
      });
      const row = (await query(`
        INSERT INTO public.devices (
          device_id, workspace_id, owner_user_id, native_client_session_id,
          public_identity_fingerprint, display_name, platform, architecture,
          app_version, worker_protocol_version, capability_inventory,
          registration_status, health, last_seen_at, update_required, revision,
          registration_command_id, created_at, updated_at, revoked_at, payload
        ) VALUES ($1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, $11::jsonb,
          'active', $12, $13::timestamptz, $14, 1,
          $15, $13::timestamptz, $13::timestamptz, NULL, '{}'::jsonb)
        RETURNING *
      `, [
        deviceId,
        context.workspaceId,
        context.userId,
        nativeSession.client_session_id,
        publicIdentity,
        input.displayName,
        input.platform,
        input.architecture,
        input.appVersion,
        input.workerProtocolVersion,
        JSON.stringify(input.capabilityInventory),
        health,
        now,
        health === "incompatible",
        commandId,
      ])).rows[0];
      await this.#insertLifecycleEvent(query, {
        workspaceId: context.workspaceId,
        eventId,
        commandId,
        deviceId,
        kind: "device_register",
        targetRevision: 1,
        statusAfter: "active",
        actorUserId: context.userId,
        now,
      });
      return {
        data: publicDevice({
          ...row,
          native_session_status: nativeSession.status,
          native_session_expires_at: nativeSession.expires_at,
          membership_status: "active",
        }, now),
      };
    }, transactionSession);
  }

  async heartbeatDevice({ deviceId, request, context, transactionSession = null } = {}) {
    assertDesktopContext(context);
    assertId(deviceId, "device_id_required");
    const input = normalizeHeartbeat(request);
    return this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const row = await this.#loadOwnedDeviceForHeartbeat(query, { deviceId, context, now });
      if (!row) throw coded("device_not_found");
      if (row.registration_status !== "active") throw coded("device_revoked");
      const health = input.workerProtocolVersion === DEVICE_WORKER_PROTOCOL_VERSION
        ? "ready"
        : "incompatible";
      const updated = (await query(`
        UPDATE public.devices
           SET app_version = $3,
               worker_protocol_version = $4,
               capability_inventory = $5::jsonb,
               health = $6,
               last_seen_at = $7::timestamptz,
               update_required = $8,
               revision = revision + 1,
               updated_at = $7::timestamptz
         WHERE workspace_id = $1 AND device_id = $2 AND registration_status = 'active'
        RETURNING *
      `, [
        context.workspaceId,
        deviceId,
        input.appVersion,
        input.workerProtocolVersion,
        JSON.stringify(input.capabilityInventory),
        health,
        now,
        health === "incompatible",
      ])).rows[0];
      if (!updated) throw coded("device_revoked");
      // Heartbeats are bounded operational liveness signals. They are durable
      // on the Device root but intentionally do not create a human Product
      // Command or a second command ledger for every reconnect.
      return {
        data: publicDevice({
          ...updated,
          native_session_status: row.native_session_status,
          native_session_expires_at: row.native_session_expires_at,
          membership_status: row.membership_status,
        }, now),
      };
    }, transactionSession);
  }

  /**
   * Server-internal proof that an outbound socket belongs to the same active
   * PKCE native session that registered this Device. It deliberately returns
   * no raw public key or token material and creates no Product Command.
   */
  async authenticateWorkerConnection({ deviceId, context } = {}) {
    assertDesktopContext(context);
    assertId(deviceId, "device_id_required");
    return this.#transaction(async (query) => {
      const now = await this.#databaseNow(query);
      const row = await this.#loadOwnedDeviceForHeartbeat(query, { deviceId, context, now });
      if (!row) throw coded("device_not_found");
      if (row.registration_status !== "active") throw coded("device_revoked");
      if (row.worker_protocol_version !== DEVICE_WORKER_PROTOCOL_VERSION) {
        throw coded("device_protocol_incompatible");
      }
      if (!Array.isArray(row.capability_inventory)
        || !row.capability_inventory.includes("local_deterministic_skill")) {
        throw coded("device_worker_capability_unavailable");
      }
      return Object.freeze({
        deviceId: row.device_id,
        workspaceId: row.workspace_id,
        ownerUserId: row.owner_user_id,
        clientSessionId: row.native_client_session_id,
        capabilityInventory: [...row.capability_inventory].sort(),
        workerProtocolVersion: row.worker_protocol_version,
      });
    });
  }

  async revokeDevice({ deviceId, request, context, transactionSession = null } = {}) {
    assertContext(context);
    assertId(deviceId, "device_id_required");
    if (!WORKSPACE_MANAGERS.has(context.role)) throw coded("device_revoke_forbidden");
    const { reason } = normalizeRevocation(request);
    const result = await this.#transaction(async (query, uow) => {
      const root = (await query(`
        SELECT device.*, session.status AS native_session_status,
               session.expires_at AS native_session_expires_at,
               membership.status AS membership_status
          FROM public.devices device
          JOIN public.native_client_sessions session
            ON session.client_session_id = device.native_client_session_id
          JOIN public.workspace_memberships membership
            ON membership.workspace_id = device.workspace_id
           AND membership.user_id = device.owner_user_id
         WHERE device.workspace_id = $1 AND device.device_id = $2
         FOR UPDATE OF device, session
      `, [context.workspaceId, deviceId])).rows[0];
      if (!root) throw coded("device_not_found");
      if (root.registration_status !== "active") throw coded("device_revoked");
      const targetRevision = Number(root.revision) + 1;
      const authority = await this.#commandAuthorizer.authorizeDeviceRevocation({
        workspaceId: context.workspaceId,
        userId: context.userId,
        deviceId,
        reason,
        uow,
      });
      const now = await this.#databaseNow(query);
      const commandId = newId(this.#idFactory, "product-command");
      const eventId = newId(this.#idFactory, "device-event");

      await query("SET CONSTRAINTS ALL DEFERRED");
      await this.#insertCompletedCommand(query, {
        commandId,
        authority,
        userId: context.userId,
        actionId: "device_revoke",
        targetKind: "device",
        targetId: deviceId,
        targetRevision,
        now,
      });
      const updated = (await query(`
        UPDATE public.devices
           SET registration_status = 'revoked', health = 'revoked',
               update_required = false, revision = revision + 1,
               updated_at = $3::timestamptz,
               revoked_at = $3::timestamptz
         WHERE workspace_id = $1 AND device_id = $2 AND registration_status = 'active'
        RETURNING *
      `, [context.workspaceId, deviceId, now])).rows[0];
      if (!updated) throw coded("device_revoked");
      await this.#revokeNativeSession(query, { clientSessionId: root.native_client_session_id, now });
      await this.#insertLifecycleEvent(query, {
        workspaceId: context.workspaceId,
        eventId,
        commandId,
        deviceId,
        kind: "device_revoke",
        targetRevision,
        statusAfter: "revoked",
        actorUserId: context.userId,
        now,
        reasonProvided: reason !== null,
      });
      return {
        data: publicDevice({
          ...updated,
          native_session_status: "revoked",
          native_session_expires_at: root.native_session_expires_at,
          membership_status: root.membership_status,
        }, now),
      };
    }, transactionSession);
    return result;
  }

  // The Application calls this only after its idempotency receipt transaction
  // has resolved. Keep the side effect outside the aggregate transaction so a
  // failed/deadlocked write can never close a still-authoritative Device.
  async notifyCommittedDeviceRevocation({ deviceId, workspaceId, ownerUserId } = {}) {
    assertId(deviceId, "device_id_required");
    assertId(workspaceId, "device_context_invalid");
    assertId(ownerUserId, "device_context_invalid");
    if (!this.#onDeviceRevoked) return false;
    try {
      await this.#onDeviceRevoked({ deviceId, workspaceId, ownerUserId });
      return true;
    } catch {
      return false;
    }
  }

  async #loadVisibleDevice(query, { deviceId, context, lock }) {
    return (await query(`
      SELECT device.*, session.status AS native_session_status,
             session.expires_at AS native_session_expires_at,
             membership.status AS membership_status
        FROM public.devices device
        JOIN public.native_client_sessions session
          ON session.client_session_id = device.native_client_session_id
        JOIN public.workspace_memberships membership
          ON membership.workspace_id = device.workspace_id
         AND membership.user_id = device.owner_user_id
       WHERE device.workspace_id = $1 AND device.device_id = $2
         AND ($3::boolean OR device.owner_user_id = $4)
       ${lock ? "FOR SHARE OF device, session" : ""}
    `, [
      context.workspaceId,
      deviceId,
      WORKSPACE_MANAGERS.has(context.role),
      context.userId,
    ])).rows[0] ?? null;
  }

  async #loadActiveDesktopSession(query, { context, now, lock }) {
    const session = (await query(`
      SELECT session.client_session_id, session.user_id, session.workspace_id,
             session.client_kind, session.device_public_key,
             session.status, session.expires_at
        FROM public.native_client_sessions session
        JOIN public.workspace_memberships membership
          ON membership.workspace_id = session.workspace_id
         AND membership.user_id = session.user_id
       WHERE session.client_session_id = $1 AND session.user_id = $2 AND session.workspace_id = $3
         AND session.client_kind = 'desktop' AND session.status = 'active'
         AND membership.status = 'active'
         AND session.expires_at > $4::timestamptz
       ${lock === "update" ? "FOR UPDATE OF session" : "FOR SHARE OF session"}
    `, [context.clientSessionId, context.userId, context.workspaceId, now])).rows[0];
    if (!session || !context.devicePublicKey
      || context.devicePublicKey !== session.device_public_key) {
      throw coded("device_native_session_required");
    }
    return session;
  }

  async #loadOwnedDeviceForHeartbeat(query, { deviceId, context, now }) {
    const row = (await query(`
      SELECT device.*, session.status AS native_session_status,
             session.expires_at AS native_session_expires_at,
             session.client_kind AS native_client_kind,
             session.device_public_key AS native_device_public_key,
             membership.status AS membership_status
        FROM public.devices device
        JOIN public.native_client_sessions session
          ON session.client_session_id = device.native_client_session_id
        JOIN public.workspace_memberships membership
          ON membership.workspace_id = device.workspace_id
         AND membership.user_id = device.owner_user_id
       WHERE device.workspace_id = $1 AND device.device_id = $2
         AND device.owner_user_id = $3
         AND device.native_client_session_id = $4
       FOR UPDATE OF device, session
    `, [context.workspaceId, deviceId, context.userId, context.clientSessionId])).rows[0];
    if (!row) return null;
    if (row.native_client_kind !== "desktop"
      || row.native_session_status !== "active"
      || row.membership_status !== "active"
      || new Date(row.native_session_expires_at).getTime() <= Date.parse(now)
      || !context.devicePublicKey
      || context.devicePublicKey !== row.native_device_public_key) {
      throw coded("device_native_session_required");
    }
    return row;
  }

  async #insertCompletedCommand(query, {
    commandId,
    authority,
    userId,
    actionId,
    targetKind,
    targetId,
    targetRevision,
    now,
  }) {
    await query(`
      INSERT INTO public.product_commands (
        command_id, workspace_id, scope_id,
        actor_principal_id, actor_principal_kind,
        effective_principal_id, effective_principal_kind,
        authorization_decision_id, policy_revision_id,
        effect_class, argument_digest, target_contract, quota_user_id,
        schema_version, kind, target_kind, target_id, target_revision,
        status, created_at, updated_at, finished_at, payload
      ) VALUES ($1, $2, $3,
        $4, 'user', $4, 'user',
        $5, $6,
        'administrative', $7, NULL, $4,
        'workbench-v1', $8, $9, $10, $11,
        'completed', $12::timestamptz, $12::timestamptz, $12::timestamptz, '{}'::jsonb)
    `, [
      commandId,
      authority.workspaceId,
      authority.scopeId,
      userId,
      authority.authorizationDecisionId,
      authority.policyRevisionId,
      authority.argumentDigest,
      actionId,
      targetKind,
      targetId,
      targetRevision,
      now,
    ]);
  }

  async #insertLifecycleEvent(query, {
    workspaceId,
    eventId,
    commandId,
    deviceId,
    kind,
    targetRevision,
    statusAfter,
    actorUserId,
    now,
    reasonProvided = false,
  }) {
    await query(`
      INSERT INTO public.device_lifecycle_events (
        workspace_id, event_id, product_command_id, device_id,
        kind, target_revision, status_after, actor_user_id,
        created_at, payload
      ) VALUES ($1, $2, $3, $4,
        $5, $6, $7, $8,
        $9::timestamptz, $10::jsonb)
    `, [
      workspaceId,
      eventId,
      commandId,
      deviceId,
      kind,
      targetRevision,
      statusAfter,
      actorUserId,
      now,
      JSON.stringify(reasonProvided ? { reasonProvided: true } : {}),
    ]);
  }

  async #revokeNativeSession(query, { clientSessionId, now }) {
    await query(`
      UPDATE public.native_client_sessions
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2::timestamptz)
       WHERE client_session_id = $1 AND status = 'active'
    `, [clientSessionId, now]);
    await query(`
      UPDATE public.native_refresh_tokens
         SET revoked_at = COALESCE(revoked_at, $2::timestamptz)
       WHERE client_session_id = $1 AND revoked_at IS NULL
    `, [clientSessionId, now]);
    await query(`
      UPDATE public.native_access_tokens
         SET revoked_at = COALESCE(revoked_at, $2::timestamptz)
       WHERE client_session_id = $1 AND revoked_at IS NULL
    `, [clientSessionId, now]);
  }

  async #databaseNow(query) {
    const row = (await query("SELECT clock_timestamp() AS now")).rows[0];
    return timestamp(row?.now ?? this.#clock());
  }

  #transaction(work, uow = null) {
    return this.#store.withTransaction(
      (unit) => work((text, values = []) => this.#query(unit, text, values), unit),
      uow ? { uow } : {},
    );
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function publicDevice(row, now) {
  const lastSeenAt = timestamp(row.last_seen_at);
  const registrationStatus = row.registration_status;
  const protocolCompatible = row.worker_protocol_version === DEVICE_WORKER_PROTOCOL_VERSION;
  const sessionActive = row.native_session_status === "active"
    && row.membership_status === "active"
    && Date.parse(row.native_session_expires_at) > Date.parse(now);
  const recentlySeen = Date.parse(now) - Date.parse(lastSeenAt) <= DEVICE_OFFLINE_AFTER_MS;
  const health = registrationStatus === "revoked"
    ? "revoked"
    : !protocolCompatible
      ? "incompatible"
      : !sessionActive || !recentlySeen
        ? "offline"
        : "ready";
  return {
    schemaVersion: "workbench-v1",
    deviceId: row.device_id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    displayName: row.display_name,
    platform: row.platform,
    architecture: row.architecture,
    appVersion: row.app_version,
    workerProtocolVersion: row.worker_protocol_version,
    publicIdentity: row.public_identity_fingerprint,
    capabilityInventory: [...(Array.isArray(row.capability_inventory) ? row.capability_inventory : [])].sort(),
    registrationStatus,
    health,
    lastSeenAt,
    updateRequired: registrationStatus !== "revoked" && !protocolCompatible,
    revision: Number(row.revision),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    revokedAt: row.revoked_at == null ? null : timestamp(row.revoked_at),
  };
}

function normalizeRegistration(request) {
  const data = request?.data;
  if (!plainObject(data) || Object.keys(data).some((key) => ![
    "displayName", "platform", "architecture", "appVersion", "workerProtocolVersion", "capabilityInventory",
  ].includes(key))) {
    throw coded("device_request_invalid");
  }
  return {
    displayName: text(data.displayName, 100, "device_request_invalid"),
    platform: enumValue(data.platform, PLATFORM, "device_request_invalid"),
    architecture: enumValue(data.architecture, ARCHITECTURE, "device_request_invalid"),
    appVersion: text(data.appVersion, 128, "device_request_invalid"),
    workerProtocolVersion: text(data.workerProtocolVersion, 128, "device_request_invalid"),
    capabilityInventory: capabilities(data.capabilityInventory),
  };
}

function normalizeHeartbeat(request) {
  const data = request?.data;
  if (!plainObject(data) || Object.keys(data).some((key) => ![
    "appVersion", "workerProtocolVersion", "capabilityInventory",
  ].includes(key))) {
    throw coded("device_request_invalid");
  }
  return {
    appVersion: text(data.appVersion, 128, "device_request_invalid"),
    workerProtocolVersion: text(data.workerProtocolVersion, 128, "device_request_invalid"),
    capabilityInventory: capabilities(data.capabilityInventory),
  };
}

function normalizeRevocation(request) {
  const data = request?.data;
  if (!plainObject(data) || Object.keys(data).some((key) => key !== "reason")) {
    throw coded("device_request_invalid");
  }
  return {
    reason: data.reason === undefined ? null : text(data.reason, 1000, "device_request_invalid"),
  };
}

function capabilities(value) {
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length
    || value.some((item) => !CAPABILITIES.has(item))) {
    throw coded("device_request_invalid");
  }
  return [...value].sort();
}

function text(value, maximum, code) {
  if (typeof value !== "string") throw coded(code);
  const result = value.trim();
  if (!result || result.length > maximum) throw coded(code);
  return result;
}

function enumValue(value, values, code) {
  if (typeof value !== "string" || !values.has(value)) throw coded(code);
  return value;
}

function assertContext(context) {
  assertId(context?.workspaceId, "device_context_invalid");
  assertId(context?.userId, "device_context_invalid");
}

function assertDesktopContext(context) {
  assertContext(context);
  if (context.clientKind !== "desktop") throw coded("device_native_session_required");
  assertId(context.clientSessionId, "device_native_session_required");
}

function assertId(value, code) {
  if (typeof value !== "string" || !ID.test(value)) throw coded(code);
  return value;
}

function newId(factory, kind) { return assertId(factory(kind), "device_identifier_factory_invalid"); }

function deviceFingerprint(publicKey) {
  if (typeof publicKey !== "string" || !publicKey) throw coded("device_native_session_required");
  return `sha256:${createHash("sha256").update(publicKey).digest("hex")}`;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("postgres_device_lifecycle_clock_invalid");
  return date.toISOString();
}

function plainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function coded(code) {
  const error = new Error(code);
  error.name = "PostgresDeviceLifecycleError";
  error.code = code;
  return error;
}
