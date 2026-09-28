const clone = (value) => value == null ? value : structuredClone(value);

export class InMemoryCapacityPersistence {
  constructor() {
    this.waiting = new Map();
    this.leases = new Map();
    this.counters = new Map();
  }

  async markWaiting(record) {
    const existing = this.waiting.get(record.admissionId);
    if (existing) {
      existing.state = "waiting_capacity";
      existing.updatedAt = record.updatedAt;
      return clone(existing);
    }
    this.waiting.set(record.admissionId, clone(record));
    return clone(record);
  }

  async tryAcquire(lease) {
    if (lease.dimensions.some((dimension) => (this.counters.get(dimension.counterId) ?? 0) >= dimension.limit)) {
      return null;
    }
    for (const dimension of lease.dimensions) {
      this.counters.set(dimension.counterId, (this.counters.get(dimension.counterId) ?? 0) + 1);
    }
    this.leases.set(lease.capacityLeaseId, clone(lease));
    const waiting = this.waiting.get(lease.admissionId)
      ?? null;
    if (waiting) {
      waiting.state = "running";
      waiting.updatedAt = lease.issuedAt;
    }
    return clone(lease);
  }

  async authorize({ request, now }) {
    const authority = request.capacityAuthority;
    const lease = this.leases.get(authority?.capacityLeaseId);
    if (!lease
      || lease.status !== "active"
      || lease.admissionId !== authority.admissionId
      || lease.fence !== authority.fence
      || lease.userId !== request.actor?.userId
      || lease.workspaceId !== request.workspaceId
      || lease.commandId !== request.lineage?.productCommandId
      || lease.backendKey !== `${request.mode}:${request.isolation}`
      || lease.providerKey !== providerKey(request)
      || Date.parse(lease.expiresAt) <= Date.parse(now)) return false;
    return true;
  }

  async heartbeat(capacityLeaseId, { fence, now, expiresAt }) {
    const lease = this.leases.get(capacityLeaseId);
    if (!lease
      || lease.status !== "active"
      || lease.fence !== fence
      || Date.parse(lease.expiresAt) <= Date.parse(now)) return null;
    lease.expiresAt = expiresAt;
    lease.updatedAt = now;
    return clone(lease);
  }

  async listWaiting(query = {}) {
    return pageWaitingRecords([...this.waiting.values()], query);
  }

  async release(capacityLeaseId, releasedAt) {
    const lease = this.leases.get(capacityLeaseId);
    if (!lease || lease.status !== "active") return clone(lease ?? null);
    lease.status = "released";
    lease.releasedAt = releasedAt;
    lease.updatedAt = releasedAt;
    for (const dimension of lease.dimensions) {
      this.counters.set(dimension.counterId, Math.max(0, (this.counters.get(dimension.counterId) ?? 0) - 1));
    }
    const waiting = this.waiting.get(lease.admissionId);
    if (waiting) {
      waiting.state = "released";
      waiting.updatedAt = releasedAt;
      waiting.releasedAt = releasedAt;
    }
    return clone(lease);
  }

  async cancelWaiting(admissionId, cancelledAt) {
    const waiting = this.waiting.get(admissionId);
    if (!waiting || waiting.state === "released") return clone(waiting ?? null);
    waiting.state = "cancelled";
    waiting.updatedAt = cancelledAt;
    waiting.releasedAt = cancelledAt;
    return clone(waiting);
  }

  async recoverExpired(now) {
    const expired = [...this.leases.values()].filter((lease) => (
      lease.status === "active" && Date.parse(lease.expiresAt) <= Date.parse(now)
    ));
    for (const lease of expired) await this.release(lease.capacityLeaseId, now);
    return expired.map((lease) => lease.capacityLeaseId);
  }
}

/** PostgreSQL mapping for the Product-owned AdmissionController port. */
export class PostgresCapacityPersistence {
  #store;
  #sql;

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_capacity_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query(uow, text, values = []) { return execute(uow, { text, values }); },
    }));
  }

  async markWaiting(record) {
    return this.#store.withTransaction(async (uow) => {
      const existing = (await this.#query(uow, `
        SELECT admission_id, command_id, workspace_id, kind, invocation_id, session_id, turn_id,
               state, queue_slot_held, created_at, updated_at, released_at, payload
          FROM public.admission_waiting WHERE admission_id = $1 FOR UPDATE
      `, [record.admissionId])).rows[0];
      if (existing) {
        if (existing.command_id !== record.commandId || existing.workspace_id !== record.workspaceId) {
          throw coded("admission_identity_conflict");
        }
        if (["released", "cancelled"].includes(existing.state)) return waitingView(existing);
        const updated = (await this.#query(uow, `
          UPDATE public.admission_waiting
             SET state = 'waiting_capacity', updated_at = $2
           WHERE admission_id = $1
           RETURNING admission_id, command_id, workspace_id, kind, invocation_id, session_id, turn_id,
                     state, queue_slot_held, created_at, updated_at, released_at, payload
        `, [record.admissionId, record.updatedAt])).rows[0];
        return waitingView(updated);
      }
      const inserted = (await this.#query(uow, `
        INSERT INTO public.admission_waiting (
          admission_id, command_id, workspace_id, schema_version, kind, invocation_id,
          session_id, turn_id, state, queue_slot_held, created_at, updated_at, released_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'waiting_capacity', $9, $10, $11, NULL, $12::jsonb)
        RETURNING admission_id, command_id, workspace_id, kind, invocation_id, session_id, turn_id,
                  state, queue_slot_held, created_at, updated_at, released_at, payload
      `, [
        record.admissionId, record.commandId, record.workspaceId, record.schemaVersion,
        record.kind, record.invocationId ?? null, record.sessionId ?? null, record.turnId ?? null,
        record.queueSlotHeld === true, record.createdAt, record.updatedAt,
        JSON.stringify({ userId: record.userId }),
      ])).rows[0];
      return waitingView(inserted);
    });
  }

  async tryAcquire(lease) {
    try {
      return await this.#store.withTransaction(async (uow) => {
        for (const dimension of lease.dimensions) {
          await this.#query(uow, `
            INSERT INTO public.capacity_counters (
              counter_id, schema_version, kind, used, updated_at, payload
            ) VALUES ($1, 'workbench-v1', $2, 0, $3, '{}'::jsonb)
            ON CONFLICT (counter_id) DO NOTHING
          `, [dimension.counterId, dimension.kind, lease.issuedAt]);
        }
        for (const dimension of lease.dimensions) {
          const counter = (await this.#query(uow, `
            UPDATE public.capacity_counters
               SET used = used + 1, updated_at = $3
             WHERE counter_id = $1 AND used < $2
             RETURNING counter_id
          `, [dimension.counterId, dimension.limit, lease.issuedAt])).rows[0];
          if (!counter) throw coded("capacity_unavailable");
        }
        const inserted = (await this.#query(uow, `
          INSERT INTO public.capacity_leases (
            capacity_lease_id, admission_id, command_id, workspace_id, schema_version,
            backend_key, provider_key, fence, lease_duration_ms, status, issued_at,
            expires_at, released_at, updated_at, dimensions, payload
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11, NULL, $10, $12::jsonb, $13::jsonb)
          RETURNING capacity_lease_id, admission_id, command_id, workspace_id, backend_key, provider_key,
                    fence, lease_duration_ms, status, issued_at, expires_at, released_at, updated_at,
                    dimensions, payload
        `, [
          lease.capacityLeaseId, lease.admissionId, lease.commandId, lease.workspaceId,
          lease.schemaVersion, lease.backendKey, lease.providerKey, lease.fence, lease.leaseDurationMs,
          lease.issuedAt, lease.expiresAt, JSON.stringify(lease.dimensions),
          JSON.stringify({ userId: lease.userId }),
        ])).rows[0];
        const waiting = await this.#query(uow, `
          UPDATE public.admission_waiting
             SET state = 'running', updated_at = $2
           WHERE admission_id = $1 AND state = 'waiting_capacity'
        `, [lease.admissionId, lease.issuedAt]);
        if (waiting.rowCount !== 1) throw coded("admission_waiting_not_acquirable");
        return capacityLeaseView(inserted);
      });
    } catch (error) {
      if (error?.code === "capacity_unavailable") return null;
      throw error;
    }
  }

  async authorize({ request, now }) {
    const authority = request.capacityAuthority;
    if (!authority) return false;
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#query(uow, `
        SELECT capacity.capacity_lease_id
          FROM public.capacity_leases capacity
          JOIN public.admission_waiting admission ON admission.admission_id = capacity.admission_id
          JOIN public.product_commands command
            ON command.workspace_id = capacity.workspace_id AND command.command_id = capacity.command_id
         WHERE capacity.capacity_lease_id = $1 AND capacity.admission_id = $2
           AND capacity.fence = $3 AND capacity.status = 'active' AND capacity.expires_at > $4
           AND capacity.workspace_id = $5 AND capacity.command_id = $6
           AND capacity.backend_key = $7 AND capacity.provider_key = $8
           AND command.quota_user_id = $9 AND admission.state = 'running'
      `, [
        authority.capacityLeaseId, authority.admissionId, authority.fence, now,
        request.workspaceId, request.lineage?.productCommandId,
        `${request.mode}:${request.isolation}`, providerKey(request), request.actor?.userId,
      ])).rows[0];
      return Boolean(row);
    });
  }

  async heartbeat(capacityLeaseId, { fence, now, expiresAt }) {
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#query(uow, `
        UPDATE public.capacity_leases
           SET expires_at = $4, updated_at = $3
         WHERE capacity_lease_id = $1 AND fence = $2 AND status = 'active' AND expires_at > $3
         RETURNING capacity_lease_id, admission_id, command_id, workspace_id, backend_key, provider_key,
                   fence, lease_duration_ms, status, issued_at, expires_at, released_at, updated_at,
                   dimensions, payload
      `, [capacityLeaseId, fence, now, expiresAt])).rows[0];
      return row ? capacityLeaseView(row) : null;
    });
  }

  async listWaiting(query = {}) {
    return this.#store.withTransaction(async (uow) => {
      const rows = (await this.#query(uow, `
        SELECT admission.admission_id, admission.command_id, admission.workspace_id, admission.kind,
               admission.invocation_id, admission.session_id, admission.turn_id, admission.state,
               admission.queue_slot_held, admission.created_at, admission.updated_at, admission.released_at,
               admission.payload, command.quota_user_id
          FROM public.admission_waiting admission
          JOIN public.product_commands command
            ON command.workspace_id = admission.workspace_id AND command.command_id = admission.command_id
         WHERE admission.workspace_id = $1
           AND admission.state IN ('waiting_session_turn', 'waiting_capacity')
         ORDER BY admission.created_at ASC, admission.admission_id ASC
         LIMIT 10001
      `, [query.workspaceId])).rows;
      return pageWaitingRecords(rows.map((row) => waitingView(row)), query);
    });
  }

  async release(capacityLeaseId, releasedAt, { uow } = {}) {
    return this.#store.withTransaction(async (transaction) => {
      const row = (await this.#query(transaction, `
        SELECT capacity_lease_id, admission_id, command_id, workspace_id, backend_key, provider_key,
               fence, lease_duration_ms, status, issued_at, expires_at, released_at, updated_at,
               dimensions, payload
          FROM public.capacity_leases WHERE capacity_lease_id = $1 FOR UPDATE
      `, [capacityLeaseId])).rows[0];
      if (!row) return null;
      if (row.status === 'released') return capacityLeaseView(row);
      const dimensions = Array.isArray(row.dimensions) ? row.dimensions : [];
      for (const dimension of dimensions) {
        await this.#query(transaction, `
          UPDATE public.capacity_counters
             SET used = GREATEST(used - 1, 0), updated_at = $2
           WHERE counter_id = $1
        `, [dimension.counterId, releasedAt]);
      }
      const released = (await this.#query(transaction, `
        UPDATE public.capacity_leases
           SET status = 'released', released_at = $2, updated_at = $2
         WHERE capacity_lease_id = $1
         RETURNING capacity_lease_id, admission_id, command_id, workspace_id, backend_key, provider_key,
                   fence, lease_duration_ms, status, issued_at, expires_at, released_at, updated_at,
                   dimensions, payload
      `, [capacityLeaseId, releasedAt])).rows[0];
      await this.#query(transaction, `
        UPDATE public.admission_waiting
           SET state = 'released', released_at = $2, updated_at = $2
         WHERE admission_id = $1 AND state <> 'cancelled'
      `, [row.admission_id, releasedAt]);
      return capacityLeaseView(released);
    }, uow === undefined ? {} : { uow });
  }

  async cancelWaiting(admissionId, cancelledAt) {
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#query(uow, `
        UPDATE public.admission_waiting
           SET state = 'cancelled', released_at = $2, updated_at = $2
         WHERE admission_id = $1 AND state IN ('waiting_session_turn', 'waiting_capacity')
         RETURNING admission_id, command_id, workspace_id, kind, invocation_id, session_id, turn_id,
                   state, queue_slot_held, created_at, updated_at, released_at, payload
      `, [admissionId, cancelledAt])).rows[0];
      return row ? waitingView(row) : null;
    });
  }

  async recoverExpired(now) {
    const rows = await this.#store.withTransaction(async (uow) => (await this.#query(uow, `
      SELECT capacity_lease_id FROM public.capacity_leases
       WHERE status = 'active' AND expires_at <= $1
       ORDER BY capacity_lease_id ASC
    `, [now])).rows);
    await Promise.all(rows.map((row) => this.release(row.capacity_lease_id, now)));
    return rows.map((row) => row.capacity_lease_id);
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function providerKey(request) {
  return request.modelProfileRevisionId
    ?? request.metadata?.modelProfileRevisionId
    ?? "provider:none";
}

function waitingView(row) {
  return {
    admissionId: row.admission_id,
    commandId: row.command_id,
    workspaceId: row.workspace_id,
    userId: row.quota_user_id ?? row.payload?.userId ?? null,
    kind: row.kind,
    invocationId: row.invocation_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    state: row.state,
    queueSlotHeld: row.queue_slot_held === true,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    releasedAt: iso(row.released_at),
  };
}

function capacityLeaseView(row) {
  return {
    capacityLeaseId: row.capacity_lease_id,
    admissionId: row.admission_id,
    commandId: row.command_id,
    workspaceId: row.workspace_id,
    userId: row.payload?.userId ?? null,
    backendKey: row.backend_key,
    providerKey: row.provider_key,
    dimensions: structuredClone(row.dimensions ?? []),
    fence: Number(row.fence),
    leaseDurationMs: Number(row.lease_duration_ms),
    status: row.status,
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    releasedAt: iso(row.released_at),
    updatedAt: iso(row.updated_at),
  };
}

function iso(value) { return value == null ? null : new Date(value).toISOString(); }

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function pageWaitingRecords(records, {
  workspaceId,
  userId,
  sessionId = null,
  cursor = null,
  limit = 50,
} = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const decoded = decodeWaitingCursor(cursor);
  const active = records
    .filter((record) => record.workspaceId === workspaceId
      && ["waiting_session_turn", "waiting_capacity"].includes(record.state))
    .sort(compareWaitingRecord);
  const positions = fairPositions(active);
  const authorized = active.filter((record) => (
    record.userId === userId
    && (!sessionId || record.sessionId === sessionId)
    && (!decoded || compareWaitingRecord(record, decoded) > 0)
  ));
  const page = authorized.slice(0, boundedLimit);
  return {
    items: page.map((record) => ({ ...clone(record), position: positions.get(record.admissionId) ?? 1 })),
    queuedTurnCount: new Set(active
      .filter((record) => record.userId === userId && (!sessionId || record.sessionId === sessionId))
      .map((record) => record.turnId)
      .filter(Boolean)).size,
    page: {
      nextCursor: authorized.length > boundedLimit
        ? encodeWaitingCursor(page.at(-1))
        : null,
      hasMore: authorized.length > boundedLimit,
    },
  };
}

function fairPositions(records) {
  const queues = new Map();
  for (const record of records) {
    const queue = queues.get(record.userId) ?? [];
    queue.push(record);
    queues.set(record.userId, queue);
  }
  const users = [...queues.entries()]
    .sort((left, right) => compareWaitingRecord(left[1][0], right[1][0]))
    .map(([userId]) => userId);
  const positions = new Map();
  let position = 1;
  while (users.some((userId) => queues.get(userId).length > 0)) {
    for (const userId of users) {
      const record = queues.get(userId).shift();
      if (!record) continue;
      positions.set(record.admissionId, position);
      position += 1;
    }
  }
  return positions;
}

function compareWaitingRecord(left, right) {
  return String(left.createdAt).localeCompare(String(right.createdAt))
    || String(left.admissionId).localeCompare(String(right.admissionId));
}

function encodeWaitingCursor(record) {
  return Buffer.from(JSON.stringify({
    kind: "admission_waiting",
    createdAt: record.createdAt,
    admissionId: record.admissionId,
  }), "utf8").toString("base64url");
}

function decodeWaitingCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (decoded?.kind !== "admission_waiting"
      || typeof decoded.createdAt !== "string"
      || typeof decoded.admissionId !== "string") throw new Error();
    return decoded;
  } catch {
    const error = new Error("admission_cursor_invalid");
    error.code = "cursor_invalid";
    throw error;
  }
}
