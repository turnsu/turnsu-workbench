/**
 * PostgreSQL authority adapter for the Product Execution Broker.
 *
 * It owns the SQL mapping for execution_invocations/attempts/events/checkpoints
 * and capability leases. Callers only receive the existing execution
 * persistence contract; no Pool or query handle crosses this boundary.
 */
export class PostgresExecutionPersistence {
  #store;
  #sql;
  #eventWrites = new Map();

  constructor({ store } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction) {
      throw new TypeError("postgres_execution_persistence_store_required");
    }
    this.#store = store;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query(uow, text, values = []) { return execute(uow, { text, values }); },
    }));
  }

  async createExecutionAuthority({ invocation, attempt, lease } = {}, { uow } = {}) {
    validateAuthorityRecords(invocation, attempt, lease);
    return this.#store.withTransaction(async (transaction) => {
      const request = invocation.request;
      const capacity = await this.#capacityAuthority(transaction, request, invocation);
      await this.#query(transaction, "SET CONSTRAINTS ALL DEFERRED");
      await this.#query(transaction, `
        INSERT INTO public.execution_invocations (
          invocation_id, workspace_id, schema_version, attempt_id,
          parent_invocation_id, product_command_id,
          lineage_session_id, lineage_turn_id,
          controller_kind, controller_id, controller_fence,
          mode, isolation, status, event_sequence, execution_fence,
          capacity_admission_id, capacity_lease_id, capacity_fence,
          capacity_backend_key, capacity_provider_key, capability_lease_id,
          started_at, finished_at, cancel_requested_at, created_at, updated_at, payload
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6,
          $7, $8,
          $9, $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18, $19,
          $20, $21, $22,
          NULL, NULL, NULL, $23, $23, $24::jsonb
        )
      `, [
        invocation.invocationId, invocation.workspaceId, invocation.schemaVersion, invocation.attemptId,
        request.lineage?.parentInvocationId ?? null, request.lineage?.productCommandId,
        request.lineage?.sessionId ?? null, request.lineage?.turnId ?? null,
        invocation.controller?.kind, invocation.controller?.controllerId, invocation.controller?.fence,
        invocation.mode, invocation.isolation, invocation.status, invocation.eventSequence, invocation.executionFence,
        request.capacityAuthority.admissionId, request.capacityAuthority.capacityLeaseId, request.capacityAuthority.fence,
        capacity.backendKey, capacity.providerKey, lease.capabilityLeaseId,
        invocation.createdAt, JSON.stringify(invocationPayload(invocation)),
      ]);
      await this.#query(transaction, `
        INSERT INTO public.execution_attempts (
          attempt_id, invocation_id, schema_version, attempt_number, status, fence,
          checkpoint_sequence, started_at, finished_at, created_at, updated_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, $8, $9::jsonb)
      `, [
        attempt.attemptId, attempt.invocationId, attempt.schemaVersion, attempt.attemptNumber,
        attempt.status, attempt.fence, attempt.checkpointSequence, attempt.createdAt,
        JSON.stringify(attemptPayload(attempt)),
      ]);
      await this.#query(transaction, `
        INSERT INTO public.capability_leases (
          capability_lease_id, invocation_id, attempt_id, workspace_id, schema_version,
          fence, status, issued_at, expires_at, revoked_at, updated_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11::jsonb)
      `, [
        lease.capabilityLeaseId, lease.invocationId, lease.attemptId, lease.workspaceId,
        lease.schemaVersion, lease.fence, lease.status, lease.issuedAt, lease.expiresAt,
        lease.updatedAt, JSON.stringify({ capabilities: lease.capabilities }),
      ]);
      return { invocation: structuredClone(invocation), attempt: structuredClone(attempt), lease: structuredClone(lease) };
    }, uow === undefined ? {} : { uow });
  }

  async createInvocation() { throw new TypeError("postgres_execution_authority_must_be_atomic"); }
  async createAttempt() { throw new TypeError("postgres_execution_authority_must_be_atomic"); }
  async issueLease() { throw new TypeError("postgres_execution_authority_must_be_atomic"); }

  async appendEvent(invocationId, eventFactory, { uow } = {}) {
    // One fenced Worker can emit many frames in the same tick. Serialize its
    // independent commits before opening SERIALIZABLE snapshots, rather than
    // making those commits repeatedly conflict on the same sequence row.
    // Joined transactions retain their caller's ownership and atomic boundary.
    if (uow !== undefined) return this.#appendEvent(invocationId, eventFactory, { uow });
    const previous = this.#eventWrites.get(invocationId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.#appendEvent(invocationId, eventFactory));
    this.#eventWrites.set(invocationId, pending);
    try {
      return await pending;
    } finally {
      if (this.#eventWrites.get(invocationId) === pending) this.#eventWrites.delete(invocationId);
    }
  }

  async #appendEvent(invocationId, eventFactory, { uow } = {}) {
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#query(uow, `
        UPDATE public.execution_invocations
           SET event_sequence = event_sequence + 1, updated_at = GREATEST(updated_at, clock_timestamp())
         WHERE invocation_id = $1
         RETURNING event_sequence
      `, [invocationId])).rows[0];
      if (!row) throw coded("execution_invocation_not_found");
      const event = eventFactory(Number(row.event_sequence));
      await this.#query(uow, `
        INSERT INTO public.execution_events (
          event_id, invocation_id, attempt_id, schema_version, sequence,
          type, status, occurred_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `, [
        event.eventId, invocationId, event.attemptId, event.schemaVersion,
        event.sequence, event.type, event.status, event.occurredAt,
        JSON.stringify(event.payload ?? {}),
      ]);
      return structuredClone(event);
    }, uow === undefined ? {} : { uow });
  }

  async writeCheckpoint(record) {
    return this.#store.withTransaction(async (uow) => {
      const attempt = (await this.#query(uow, `
        UPDATE public.execution_attempts
           SET checkpoint_sequence = checkpoint_sequence + 1
         WHERE attempt_id = $1 AND invocation_id = $2 AND fence = $3 AND status = 'running'
         RETURNING checkpoint_sequence
      `, [record.attemptId, record.invocationId, record.fence])).rows[0];
      if (!attempt) throw coded("execution_checkpoint_fence_rejected");
      const checkpoint = { ...structuredClone(record), sequence: Number(attempt.checkpoint_sequence) };
      await this.#query(uow, `
        INSERT INTO public.execution_checkpoints (
          checkpoint_id, invocation_id, attempt_id, schema_version, sequence, fence, created_at, payload
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `, [
        checkpoint.checkpointId, checkpoint.invocationId, checkpoint.attemptId,
        checkpoint.schemaVersion, checkpoint.sequence, checkpoint.fence,
        checkpoint.createdAt, JSON.stringify(checkpoint.state ?? {}),
      ]);
      return checkpoint;
    });
  }

  async markRunning(invocationId, attemptId, startedAt, { uow } = {}) {
    return this.#store.withTransaction(async (transaction) => {
      const invocation = (await this.#query(transaction, `
        UPDATE public.execution_invocations
           SET status = 'running', started_at = $3, updated_at = $3
         WHERE invocation_id = $1 AND attempt_id = $2 AND status = 'queued'
         RETURNING invocation_id
      `, [invocationId, attemptId, startedAt])).rows[0];
      if (!invocation) throw coded("execution_attempt_not_startable");
      const attempt = (await this.#query(transaction, `
        UPDATE public.execution_attempts
           SET status = 'running', started_at = $3, updated_at = $3
         WHERE attempt_id = $1 AND invocation_id = $2 AND status = 'queued'
         RETURNING attempt_id
      `, [attemptId, invocationId, startedAt])).rows[0];
      if (!attempt) throw coded("execution_attempt_not_startable");
      return true;
    }, uow === undefined ? {} : { uow });
  }

  async completeAttempt(attemptId, fence, result, { uow } = {}) {
    return this.#store.withTransaction(async (transaction) => {
      const attempt = (await this.#query(transaction, `
        UPDATE public.execution_attempts
           SET status = $3, finished_at = $4, updated_at = $4,
               payload = payload || jsonb_build_object('result', $5::jsonb)
         WHERE attempt_id = $1 AND fence = $2 AND status = 'running'
         RETURNING invocation_id
      `, [attemptId, fence, result.status, result.finishedAt, JSON.stringify(result)])).rows[0];
      if (!attempt) return false;
      const invocation = (await this.#query(transaction, `
        UPDATE public.execution_invocations
           SET status = $3, finished_at = $4, updated_at = $4,
               payload = payload || jsonb_build_object('result', $5::jsonb)
         WHERE invocation_id = $1 AND execution_fence = $2 AND status = 'running'
         RETURNING invocation_id
      `, [attempt.invocation_id, fence, result.status, result.finishedAt, JSON.stringify(result)])).rows[0];
      if (!invocation) return false;
      await this.#revokeLeaseInTransaction(transaction, attempt.invocation_id, result.finishedAt);
      return true;
    }, uow === undefined ? {} : { uow });
  }

  async requestCancel(invocationId, cancelledAt) {
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#query(uow, `
        UPDATE public.execution_invocations
           SET status = CASE WHEN status IN ('completed', 'failed', 'cancelled', 'blocked', 'partial', 'effect_outcome_unknown', 'timeout', 'permission_denied', 'sandbox_unavailable', 'remote_backend_unavailable')
                             THEN status ELSE 'cancellation_requested' END,
               cancel_requested_at = COALESCE(cancel_requested_at, $2), updated_at = $2
         WHERE invocation_id = $1
         RETURNING invocation_id, status, attempt_id, payload
      `, [invocationId, cancelledAt])).rows[0];
      if (!row) return null;
      if (row.status === "cancellation_requested") await this.#revokeLeaseInTransaction(uow, invocationId, cancelledAt);
      return invocationView(row);
    });
  }

  async revokeLease(invocationId, revokedAt, { uow } = {}) {
    return this.#store.withTransaction(
      (transaction) => this.#revokeLeaseInTransaction(transaction, invocationId, revokedAt),
      uow === undefined ? {} : { uow },
    );
  }

  async cancelAttempt(invocationId, result) {
    return this.#store.withTransaction(async (uow) => {
      const current = (await this.#query(uow, `
        SELECT * FROM public.execution_invocations WHERE invocation_id = $1 FOR UPDATE
      `, [invocationId])).rows[0];
      if (!current || !['queued', 'running', 'cancellation_requested'].includes(current.status)) {
        return current ? invocationView(current).result : null;
      }
      // An attempt's fence is its immutable identity. Close it before its parent
      // becomes terminal; advance the invocation fence to reject late workers.
      await this.#query(uow, `
        UPDATE public.execution_attempts
           SET status = $2, finished_at = $3, updated_at = $3,
               payload = payload || jsonb_build_object('result', $4::jsonb)
         WHERE invocation_id = $1 AND status IN ('queued', 'running')
      `, [invocationId, result.status, result.finishedAt, JSON.stringify(result)]);
      await this.#query(uow, `
        UPDATE public.execution_invocations
           SET execution_fence = execution_fence + 1, status = $2, finished_at = $3, updated_at = $3,
               payload = payload || jsonb_build_object('result', $4::jsonb)
         WHERE invocation_id = $1
           AND status IN ('queued', 'running', 'cancellation_requested')
      `, [invocationId, result.status, result.finishedAt, JSON.stringify(result)]);
      await this.#revokeLeaseInTransaction(uow, invocationId, result.finishedAt);
      return structuredClone(result);
    });
  }

  async getInvocation(invocationId) {
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#query(uow, `
        SELECT invocation_id, attempt_id, workspace_id, controller_kind, controller_id, controller_fence,
               mode, isolation, status, event_sequence, execution_fence, capability_lease_id,
               started_at, finished_at, created_at, updated_at, payload
          FROM public.execution_invocations WHERE invocation_id = $1
      `, [invocationId])).rows[0];
      return row ? invocationView(row) : null;
    });
  }

  async getAttempt(attemptId) {
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#query(uow, `
        SELECT attempt_id, invocation_id, attempt_number, status, fence, checkpoint_sequence,
               started_at, finished_at, created_at, updated_at, payload
          FROM public.execution_attempts WHERE attempt_id = $1
      `, [attemptId])).rows[0];
      return row ? attemptView(row) : null;
    });
  }

  async getActiveLease(invocationId, attemptId, now) {
    return this.#store.withTransaction(async (uow) => {
      const row = (await this.#query(uow, `
        SELECT capability_lease_id, invocation_id, attempt_id, workspace_id, schema_version,
               fence, status, issued_at, expires_at, revoked_at, updated_at, payload
          FROM public.capability_leases
         WHERE invocation_id = $1 AND attempt_id = $2 AND status = 'active' AND expires_at > $3
      `, [invocationId, attemptId, now])).rows[0];
      return row ? leaseView(row) : null;
    });
  }

  async listInvocations({ workspaceId, controllerId, limit = 100 } = {}) {
    return this.#store.withTransaction(async (uow) => {
      const rows = (await this.#query(uow, `
        SELECT invocation_id, attempt_id, workspace_id, controller_kind, controller_id, controller_fence,
               mode, isolation, status, event_sequence, execution_fence, capability_lease_id,
               started_at, finished_at, created_at, updated_at, payload
          FROM public.execution_invocations
         WHERE ($1::text IS NULL OR workspace_id = $1)
           AND ($2::text IS NULL OR controller_id = $2)
         ORDER BY created_at DESC, invocation_id DESC LIMIT $3
      `, [workspaceId ?? null, controllerId ?? null, Math.min(Math.max(limit, 1), 500)])).rows;
      return rows.map(invocationView);
    });
  }

  async listEvents(invocationIds, after = 0, limit = 500) {
    if (invocationIds.length === 0) return [];
    return this.#store.withTransaction(async (uow) => {
      const rows = (await this.#query(uow, `
        SELECT event_id, invocation_id, attempt_id, schema_version, sequence,
               type, status, occurred_at, payload
          FROM public.execution_events
         WHERE invocation_id = ANY($1::text[]) AND sequence > $2
         ORDER BY occurred_at, invocation_id, sequence
         LIMIT $3
      `, [invocationIds, after, boundedLimit(limit)])).rows;
      return rows.map((row) => ({
        schemaVersion: row.schema_version,
        eventId: row.event_id,
        invocationId: row.invocation_id,
        attemptId: row.attempt_id,
        sequence: Number(row.sequence),
        type: row.type,
        status: row.status,
        occurredAt: iso(row.occurred_at),
        payload: structuredClone(row.payload ?? {}),
      }));
    });
  }

  async listRecoverableRealtimeInvocations({ limit = 500 } = {}) {
    return this.#store.withTransaction(async (uow) => {
      const rows = (await this.#query(uow, `
        SELECT invocation_id, attempt_id, workspace_id, controller_kind, controller_id, controller_fence,
               mode, isolation, status, event_sequence, execution_fence, capability_lease_id,
               started_at, finished_at, created_at, updated_at, payload
          FROM public.execution_invocations
         WHERE mode = 'realtime_audio'
           AND status IN ('queued', 'running', 'cancellation_requested')
         ORDER BY created_at ASC, invocation_id ASC
         LIMIT $1
      `, [boundedLimit(limit)])).rows;
      return rows.map(invocationView);
    });
  }

  async listRecoverableMemberAgentInvocations({limit=500}={}) {
    return this.#store.withTransaction(async uow => (await this.#query(uow,`SELECT * FROM public.execution_invocations WHERE controller_kind='member_agent_request' AND status IN ('queued','running','cancellation_requested') ORDER BY created_at,invocation_id LIMIT $1`,[boundedLimit(limit)])).rows.map(invocationView));
  }
  failRecoveredMemberAgentAttempt(input) { return this.#failRecoveredAttempt({...input,memberAgent:true}); }
  failRecoveredRealtimeAttempt(input) { return this.#failRecoveredAttempt({...input,memberAgent:false}); }
  async #failRecoveredAttempt({ invocationId, attemptId, fence, result, memberAgent } = {}) {
    if (!invocationId || !attemptId || !Number.isInteger(fence) || !result?.status || !result?.finishedAt) {
      throw new TypeError("postgres_realtime_recovery_input_invalid");
    }
    return this.#store.withTransaction(async (uow) => {
      const invocation = (await this.#query(uow, `
        SELECT invocation_id, attempt_id, mode, controller_kind, status, execution_fence
          FROM public.execution_invocations
         WHERE invocation_id = $1
         FOR UPDATE
      `, [invocationId])).rows[0];
      if (!invocation
        || (memberAgent ? invocation.controller_kind !== "member_agent_request" : invocation.mode !== "realtime_audio")
        || invocation.attempt_id !== attemptId
        || Number(invocation.execution_fence) !== fence
        || !["queued", "running", "cancellation_requested"].includes(invocation.status)) return false;

      const attempt = (await this.#query(uow, `
        SELECT attempt_id, fence, status
          FROM public.execution_attempts
         WHERE invocation_id = $1 AND attempt_id = $2
         FOR UPDATE
      `, [invocationId, attemptId])).rows[0];
      if (!attempt
        || Number(attempt.fence) !== fence
        || !["queued", "running"].includes(attempt.status)) return false;

      await this.#query(uow, `
        UPDATE public.execution_attempts
           SET status = $4,
               finished_at = $5::timestamptz, updated_at = $5::timestamptz,
               payload = payload || jsonb_build_object(
                 'result', $6::jsonb,
                 'recoveredAfterRestart', true
               )
         WHERE invocation_id = $1 AND attempt_id = $2 AND fence = $3
      `, [invocationId, attemptId, fence, result.status, result.finishedAt, JSON.stringify(result)]);

      const settled = (await this.#query(uow, `
        UPDATE public.execution_invocations
           SET execution_fence = execution_fence + 1, status = $4,
               finished_at = $5::timestamptz, updated_at = $5::timestamptz,
               payload = payload || jsonb_build_object(
                 'result', $6::jsonb,
                 'recoveredAfterRestart', true
               )
         WHERE invocation_id = $1 AND attempt_id = $2 AND execution_fence = $3
           AND (($7::boolean AND controller_kind='member_agent_request') OR (NOT $7::boolean AND mode='realtime_audio'))
           AND status IN ('queued', 'running', 'cancellation_requested')
         RETURNING invocation_id
      `, [invocationId, attemptId, fence, result.status, result.finishedAt, JSON.stringify(result),memberAgent])).rows[0];
      if (!settled) throw coded("postgres_realtime_recovery_atomicity_failed");

      await this.#query(uow, `
        UPDATE public.capability_leases
           SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2::timestamptz),
               updated_at = $2::timestamptz,
               payload = payload || jsonb_build_object('recoveredAfterRestart', true)
         WHERE invocation_id = $1 AND status = 'active'
      `, [invocationId, result.finishedAt]);
      return true;
    });
  }

  async #capacityAuthority(uow, request, invocation) {
    const authority = request?.capacityAuthority;
    if (!authority?.admissionId || !authority?.capacityLeaseId || !Number.isInteger(authority.fence)) {
      throw coded("postgres_execution_capacity_authority_required");
    }
    const row = (await this.#query(uow, `
      SELECT capacity.backend_key, capacity.provider_key
        FROM public.capacity_leases capacity
        JOIN public.admission_waiting admission ON admission.admission_id = capacity.admission_id
       WHERE capacity.capacity_lease_id = $1 AND capacity.admission_id = $2
         AND capacity.workspace_id = $3 AND capacity.fence = $4
         AND capacity.status = 'active' AND admission.command_id = $5
    `, [authority.capacityLeaseId, authority.admissionId, invocation.workspaceId, authority.fence,
      request.lineage?.productCommandId])).rows[0];
    if (!row) throw coded("postgres_execution_capacity_authority_invalid");
    if (row.backend_key !== `${invocation.mode}:${invocation.isolation}`) {
      throw coded("postgres_execution_capacity_backend_mismatch");
    }
    return { backendKey: row.backend_key, providerKey: row.provider_key };
  }

  async #revokeLeaseInTransaction(uow, invocationId, revokedAt) {
    const result = await this.#query(uow, `
      UPDATE public.capability_leases
         SET status = 'revoked', revoked_at = COALESCE(revoked_at, $2), updated_at = $2
       WHERE invocation_id = $1 AND status = 'active'
    `, [invocationId, revokedAt]);
    return result.rowCount;
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function validateAuthorityRecords(invocation, attempt, lease) {
  if (!invocation || !attempt || !lease
    || invocation.invocationId !== attempt.invocationId
    || invocation.invocationId !== lease.invocationId
    || invocation.attemptId !== attempt.attemptId
    || invocation.attemptId !== lease.attemptId
    || invocation.workspaceId !== lease.workspaceId) {
    throw new TypeError("postgres_execution_authority_records_invalid");
  }
}

function invocationPayload(record) {
  return {
    request: record.request,
    result: record.result ?? null,
  };
}

function attemptPayload(record) { return { result: record.result ?? null }; }

function invocationView(row) {
  return {
    invocationId: row.invocation_id,
    attemptId: row.attempt_id,
    workspaceId: row.workspace_id,
    controller: { kind: row.controller_kind, controllerId: row.controller_id, fence: Number(row.controller_fence) },
    mode: row.mode,
    isolation: row.isolation,
    status: row.status,
    eventSequence: Number(row.event_sequence),
    executionFence: Number(row.execution_fence),
    capabilityLeaseId: row.capability_lease_id,
    request: row.payload?.request ?? null,
    result: row.payload?.result ?? null,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function attemptView(row) {
  return {
    attemptId: row.attempt_id,
    invocationId: row.invocation_id,
    attemptNumber: Number(row.attempt_number),
    status: row.status,
    fence: Number(row.fence),
    checkpointSequence: Number(row.checkpoint_sequence),
    result: row.payload?.result ?? null,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function leaseView(row) {
  return {
    capabilityLeaseId: row.capability_lease_id,
    invocationId: row.invocation_id,
    attemptId: row.attempt_id,
    workspaceId: row.workspace_id,
    schemaVersion: row.schema_version,
    fence: Number(row.fence),
    status: row.status,
    capabilities: row.payload?.capabilities ?? {},
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    updatedAt: iso(row.updated_at),
  };
}

function iso(value) { return value == null ? null : new Date(value).toISOString(); }

function boundedLimit(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 500) : 500;
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
