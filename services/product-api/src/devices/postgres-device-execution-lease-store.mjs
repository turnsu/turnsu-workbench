import { randomUUID } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * PostgreSQL authority adapter for the extra lease that binds a remote
 * Invocation to one live Desktop connection. It deliberately delegates the
 * actual capability/capacity authority to the existing Execution Broker.
 */
export class PostgresDeviceExecutionLeaseStore {
  #store;
  #sql;
  #clock;
  #idFactory;

  constructor({
    store,
    clock = () => new Date(),
    idFactory = (kind) => `${kind}-${randomUUID()}`,
  } = {}) {
    if (!store?.bindAdapter || !store?.withTransaction || typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("postgres_device_execution_lease_store_dependencies_invalid");
    }
    this.#store = store;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#sql = store.bindAdapter(({ execute }) => Object.freeze({
      query: (uow, text, values = []) => execute(uow, { text, values }),
    }));
  }

  async issue({ binding, request, lease, connectionId, dispatchContext } = {}) {
    const input = normalizeIssue({ binding, request, lease, connectionId, dispatchContext });
    return this.#store.withTransaction(async (uow) => {
      const now = timestamp(this.#clock());
      const existing = (await this.#query(uow, `
        SELECT * FROM public.device_execution_leases
         WHERE invocation_id = $1 AND attempt_id = $2
         FOR UPDATE
      `, [input.invocationId, input.attemptId])).rows[0];
      if (existing) {
        const view = leaseView(existing);
        if (view.status !== "active"
          || view.deviceId !== input.deviceId
          || view.nativeClientSessionId !== input.nativeClientSessionId
          || view.connectionId !== input.connectionId
          || view.fence !== input.fence
          || view.capabilityLeaseId !== input.capabilityLeaseId
          || view.capacityLeaseId !== input.capacityLeaseId) {
          throw coded("device_execution_lease_conflict");
        }
        return view;
      }
      const deviceExecutionLeaseId = stableId(this.#idFactory("device-execution-lease"), "device_execution_lease_id_invalid");
      const row = (await this.#query(uow, `
        INSERT INTO public.device_execution_leases (
          device_execution_lease_id, workspace_id, device_id, native_client_session_id,
          invocation_id, attempt_id, capability_lease_id, capacity_lease_id,
          fence, connection_id, connection_fence, status,
          issued_at, expires_at, revoked_at, updated_at, payload
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10, 1, 'active',
          $11::timestamptz, $12::timestamptz, NULL, $11::timestamptz, '{}'::jsonb
        )
        RETURNING *
      `, [
        deviceExecutionLeaseId, input.workspaceId, input.deviceId, input.nativeClientSessionId,
        input.invocationId, input.attemptId, input.capabilityLeaseId, input.capacityLeaseId,
        input.fence, input.connectionId, now, input.expiresAt,
      ])).rows[0];
      return leaseView(row);
    });
  }

  async assertActive({ deviceExecutionLeaseId, binding, request, lease, connectionId, dispatchContext } = {}) {
    const input = normalizeAssertion({
      deviceExecutionLeaseId, binding, request, lease, connectionId, dispatchContext,
    });
    return this.#store.withTransaction(async (uow) => {
      const now = timestamp(this.#clock());
      const row = (await this.#query(uow, `
        SELECT lease.*
          FROM public.device_execution_leases lease
          JOIN public.devices device
            ON device.workspace_id = lease.workspace_id AND device.device_id = lease.device_id
          JOIN public.native_client_sessions session
            ON session.client_session_id = lease.native_client_session_id
          JOIN public.workspace_memberships membership
            ON membership.workspace_id = device.workspace_id AND membership.user_id = device.owner_user_id
          JOIN public.execution_invocations invocation
            ON invocation.workspace_id = lease.workspace_id AND invocation.invocation_id = lease.invocation_id
          JOIN public.execution_attempts attempt
            ON attempt.invocation_id = lease.invocation_id AND attempt.attempt_id = lease.attempt_id
          JOIN public.capability_leases capability
            ON capability.invocation_id = lease.invocation_id
           AND capability.attempt_id = lease.attempt_id
           AND capability.capability_lease_id = lease.capability_lease_id
          JOIN public.capacity_leases capacity
            ON capacity.capacity_lease_id = lease.capacity_lease_id
         WHERE lease.device_execution_lease_id = $1
           AND lease.workspace_id = $2
           AND lease.device_id = $3
           AND lease.native_client_session_id = $4
           AND lease.invocation_id = $5
           AND lease.attempt_id = $6
           AND lease.capability_lease_id = $7
           AND lease.capacity_lease_id = $8
           AND lease.fence = $9
           AND lease.connection_id = $10
           AND lease.status = 'active' AND lease.expires_at > $11::timestamptz
           AND device.registration_status = 'active'
           AND device.worker_protocol_version = 'workbench-device-worker-v1'
           AND device.capability_inventory @> '["local_deterministic_skill"]'::jsonb
           AND session.status = 'active' AND session.client_kind = 'desktop' AND session.expires_at > $11::timestamptz
           AND membership.status = 'active'
           AND invocation.status = 'running' AND invocation.execution_fence = $9
           AND attempt.status = 'running' AND attempt.fence = $9
           AND capability.status = 'active' AND capability.fence = $9 AND capability.expires_at > $11::timestamptz
           AND capacity.status = 'active' AND capacity.expires_at > $11::timestamptz
         FOR SHARE OF lease, device, session, membership, invocation, attempt, capability, capacity
      `, [
        input.deviceExecutionLeaseId, input.workspaceId, input.deviceId, input.nativeClientSessionId,
        input.invocationId, input.attemptId, input.capabilityLeaseId, input.capacityLeaseId,
        input.fence, input.connectionId, now,
      ])).rows[0];
      if (!row) throw coded("device_execution_lease_fenced");
      return leaseView(row);
    });
  }

  async revokeForDevice({ deviceId, workspaceId, revokedAt = this.#clock() } = {}) {
    stableId(deviceId, "device_id_required");
    stableId(workspaceId, "workspace_id_required");
    const now = timestamp(revokedAt);
    return this.#store.withTransaction(async (uow) => {
      const result = await this.#query(uow, `
        UPDATE public.device_execution_leases
           SET status = 'revoked', revoked_at = COALESCE(revoked_at, $3::timestamptz),
               updated_at = $3::timestamptz
         WHERE workspace_id = $1 AND device_id = $2 AND status = 'active'
      `, [workspaceId, deviceId, now]);
      return result.rowCount;
    });
  }

  #query(uow, text, values = []) { return this.#sql.query(uow, text, values); }
}

function normalizeIssue({ binding, request, lease, connectionId, dispatchContext }) {
  const core = normalizeCore({ binding, request, lease, connectionId, dispatchContext });
  if (request.isolation !== "remote" || request.mode !== "deterministic_skill"
    || request.metadata?.executionRef?.capabilityId !== "local_deterministic_skill"
    || request.capabilities?.network !== false
    || request.capabilities?.externalActions !== false
    || request.capabilities?.filesystem !== "none"
    || !Array.isArray(request.capabilities?.connectionIds)
    || request.capabilities.connectionIds.length !== 0
    || request.limits?.maxModelRequests !== 0
    || request.limits?.maxChildren !== 0) {
    throw coded("device_execution_request_not_eligible");
  }
  return core;
}

function normalizeAssertion({ deviceExecutionLeaseId, binding, request, lease, connectionId, dispatchContext }) {
  return {
    deviceExecutionLeaseId: stableId(deviceExecutionLeaseId, "device_execution_lease_id_required"),
    ...normalizeCore({ binding, request, lease, connectionId, dispatchContext }),
  };
}

function normalizeCore({ binding, request, lease, connectionId, dispatchContext }) {
  if (!binding || !request || !lease) throw coded("device_execution_lease_input_invalid");
  const workspaceId = stableId(request.workspaceId, "workspace_id_required");
  const invocationId = stableId(request.invocationId, "invocation_id_required");
  const attemptId = stableId(request.attemptId, "attempt_id_required");
  const deviceId = stableId(binding.deviceId, "device_id_required");
  const nativeClientSessionId = stableId(binding.clientSessionId, "native_client_session_id_required");
  const normalizedConnectionId = stableId(connectionId, "device_connection_id_required");
  const capabilityLeaseId = stableId(lease.capabilityLeaseId, "capability_lease_id_required");
  const capacityLeaseId = stableId(dispatchContext?.capacityLeaseId, "capacity_lease_id_required");
  if (lease.workspaceId !== workspaceId
    || lease.invocationId !== invocationId
    || lease.attemptId !== attemptId
    || lease.status !== "active"
    || dispatchContext?.workspaceId !== workspaceId
    || dispatchContext?.ownerUserId !== binding.ownerUserId
    || request.actor?.userId !== dispatchContext.ownerUserId
    || !Number.isInteger(dispatchContext?.capacityFence)
    || dispatchContext.capacityFence < 1
    || !Number.isInteger(lease.fence)
    || lease.fence < 1) {
    throw coded("device_execution_lease_input_invalid");
  }
  return {
    workspaceId,
    invocationId,
    attemptId,
    deviceId,
    nativeClientSessionId,
    connectionId: normalizedConnectionId,
    capabilityLeaseId,
    capacityLeaseId,
    fence: lease.fence,
    expiresAt: timestamp(lease.expiresAt),
  };
}

function leaseView(row) {
  return Object.freeze({
    deviceExecutionLeaseId: row.device_execution_lease_id,
    workspaceId: row.workspace_id,
    deviceId: row.device_id,
    nativeClientSessionId: row.native_client_session_id,
    invocationId: row.invocation_id,
    attemptId: row.attempt_id,
    capabilityLeaseId: row.capability_lease_id,
    capacityLeaseId: row.capacity_lease_id,
    fence: Number(row.fence),
    connectionId: row.connection_id,
    connectionFence: Number(row.connection_fence),
    status: row.status,
    issuedAt: timestamp(row.issued_at),
    expiresAt: timestamp(row.expires_at),
    revokedAt: row.revoked_at == null ? null : timestamp(row.revoked_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function stableId(value, code) {
  if (typeof value !== "string" || !ID.test(value)) throw coded(code);
  return value;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw coded("device_execution_lease_time_invalid");
  return date.toISOString();
}

function coded(code) {
  const error = new Error(code);
  error.name = "PostgresDeviceExecutionLeaseStoreError";
  error.code = code;
  return error;
}
