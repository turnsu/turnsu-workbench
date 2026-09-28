/**
 * PostgreSQL B3 control for a Workflow Run worker. A B3 workflow_run_job
 * already is the fenced lease authority; this port deliberately does not
 * create a second lease projection just to resemble Mongo.
 */
export function createPostgresRunControl({ store, workspaceId, idFactory } = {}) {
  if (!store?.bindAdapter || !store?.withTransaction) {
    throw new TypeError("postgres_run_control_store_required");
  }
  if (typeof workspaceId !== "string" || !workspaceId) {
    throw new TypeError("postgres_run_control_workspace_required");
  }
  if (typeof idFactory !== "function") throw new TypeError("postgres_run_control_id_factory_required");
  const sql = store.bindAdapter(({ execute }) => Object.freeze({
    query(uow, text, values = []) { return execute(uow, { text, values }); },
  }));
  const transact = (work, { uow } = {}) => store.withTransaction(work, uow ? { uow } : {});
  const query = (uow, text, values) => sql.query(uow, text, values);

  return Object.freeze({
    async claimRunJob(runId, { workerId, leaseExpiresAt, now } = {}) {
      const leaseDurationMs = Date.parse(leaseExpiresAt) - Date.parse(now);
      if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
        throw new TypeError("postgres_run_control_lease_duration_invalid");
      }
      return transact(async (uow) => {
        const leaseToken = idFactory("run-lease-token");
        const claimEventId = idFactory("run-lease-claim-event");
        const row = (await query(uow, `
          SELECT workspace_id, run_id, state, lease_owner, lease_token, lease_expires_at, fence
            FROM public.claim_workflow_run_job_for_run(
              $1, $2, $3, $4, $5, $6::interval
            )
        `, [workspaceId, runId, workerId, leaseToken, claimEventId, `${leaseDurationMs} milliseconds`])).rows[0];
        return row ? jobView(row) : null;
      });
    },

    async acquireLease({ runId, workerId, fence, leaseToken, expiresAt } = {}) {
      const active = await this.assertActiveFence(runId, {
        workerId, fence, leaseToken, now: new Date().toISOString(),
      });
      if (!active) return null;
      return {
        status: "active", runId, workerId, fence, leaseToken,
        expiresAt: expiresAt ?? active.leaseExpiresAt,
      };
    },

    async releaseLease(runId, { workerId, fence, leaseToken, releasedAt } = {}) {
      // The immutable terminal event preserves writer/fence lineage. The Job
      // projection clears its active owner tuple, so this is an observation of
      // the durable terminal release rather than a second release mutation.
      const row = await transact(async (uow) => (await query(uow, `
        SELECT workspace_id, run_id, state, lease_owner, lease_token, lease_expires_at, fence
          FROM public.workflow_run_jobs
         WHERE workspace_id = $1 AND run_id = $2
      `, [workspaceId, runId])).rows[0]);
      if (!row || row.fence !== fence) return null;
      if (row.state === "terminal") {
        return { ...jobView(row), status: "released", releasedAt };
      }
      if (row.lease_owner !== workerId || row.lease_token !== leaseToken) return null;
      return { ...jobView(row), status: "active", releasedAt };
    },

    async abandonRunJob(runId, { workerId, fence, leaseToken } = {}) {
      // A successful claim is already durable. If the local handoff fails it
      // must be recovered by expiry/fence takeover, never silently unfenced.
      await this.assertActiveFence(runId, {
        workerId, fence, leaseToken, now: new Date().toISOString(),
      });
      return null;
    },

    async renewActiveFence(runId, {
      workerId,
      fence,
      leaseToken,
      leaseDurationMs,
      minimumRemainingMs,
    } = {}) {
      if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
        throw new TypeError("postgres_run_control_lease_duration_invalid");
      }
      if (!Number.isSafeInteger(minimumRemainingMs)
        || minimumRemainingMs < 1
        || minimumRemainingMs >= leaseDurationMs) {
        throw new TypeError("postgres_run_control_lease_headroom_invalid");
      }
      return transact(async (transaction) => {
        const current = (await query(transaction, `
          SELECT job.workspace_id, job.run_id, job.state, job.lease_owner,
                 job.lease_token, job.lease_expires_at, job.fence,
                 job.lease_expires_at > clock_timestamp() + $6::interval AS has_headroom
            FROM public.workflow_runs run
            JOIN public.workflow_run_jobs job
              ON job.workspace_id = run.workspace_id AND job.run_id = run.run_id
           WHERE job.workspace_id = $1 AND job.run_id = $2
             AND job.state = 'leased' AND job.lease_owner = $3
             AND job.lease_token = $4 AND job.fence = $5
             AND job.lease_expires_at > clock_timestamp()
             AND run.status IN ('running', 'cancellation_requested')
           FOR UPDATE OF run, job
        `, [
          workspaceId,
          runId,
          workerId,
          leaseToken,
          fence,
          `${minimumRemainingMs} milliseconds`,
        ])).rows[0];
        if (!current) return null;
        if (current.has_headroom === true) return jobView(current);
        const renewalEventId = idFactory("run-lease-renewal-event");
        const renewed = (await query(transaction, `
          SELECT workspace_id, run_id, state, lease_owner, lease_token, lease_expires_at, fence
            FROM public.renew_workflow_run_job_lease($1, $2, $3, $4, $5, $6::interval)
        `, [
          workspaceId,
          runId,
          workerId,
          leaseToken,
          renewalEventId,
          `${leaseDurationMs} milliseconds`,
        ])).rows[0];
        const renewedJob = renewed ? jobView(renewed) : null;
        return renewedJob?.fence === fence ? renewedJob : null;
      });
    },

    async assertActiveFence(runId, { workerId, fence, leaseToken, now, uow = undefined } = {}) {
      return transact(async (transaction) => {
        const row = (await query(transaction, `
          SELECT workspace_id, run_id, state, lease_owner, lease_token, lease_expires_at, fence
            FROM public.workflow_run_jobs
           WHERE workspace_id = $1 AND run_id = $2
             AND state = 'leased' AND lease_owner = $3 AND lease_token = $4
             AND fence = $5 AND lease_expires_at > $6::timestamptz
           ${uow ? "FOR UPDATE" : ""}
        `, [workspaceId, runId, workerId, leaseToken, fence, now])).rows[0];
        return row ? jobView(row) : null;
      }, { uow });
    },
  });
}

function jobView(row) {
  return {
    runId: row.run_id,
    workspaceId: row.workspace_id,
    status: row.state,
    workerId: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: iso(row.lease_expires_at),
    fence: Number(row.fence),
  };
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}
