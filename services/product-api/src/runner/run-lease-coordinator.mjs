/**
 * Runner-owned bridge to the narrow durable run-control port. It keeps the
 * Worker claim/lease handshake independent from a repository implementation.
 */
export function createRunLeaseCoordinator({ runControl, workerId, clock, leaseDurationMs }) {
  for (const method of ["claimRunJob", "acquireLease", "releaseLease", "abandonRunJob"]) {
    if (typeof runControl?.[method] !== "function") {
      throw new TypeError(`run_lease_control_${method}_required`);
    }
  }
  if (typeof workerId !== "string" || !workerId || typeof clock !== "function") {
    throw new TypeError("run_lease_coordinator_identity_required");
  }
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) {
    throw new TypeError("run_lease_coordinator_duration_invalid");
  }
  return Object.freeze({
    async claim(runId) {
      const claimedAt = clock();
      const leaseExpiresAt = new Date(Date.parse(claimedAt) + leaseDurationMs).toISOString();
      const job = await runControl.claimRunJob(runId, { workerId, now: claimedAt, leaseExpiresAt });
      if (!job) return null;
      const lease = await runControl.acquireLease({
        runId,
        runJobId: job.runJobId ?? runId,
        workspaceId: job.workspaceId,
        workerId,
        fence: job.fence,
        status: "active",
        acquiredAt: claimedAt,
        heartbeatAt: claimedAt,
        expiresAt: leaseExpiresAt,
        releasedAt: null,
        updatedAt: claimedAt,
        leaseToken: job.leaseToken ?? null,
      });
      if (lease?.status === "active" && lease.workerId === workerId && lease.fence === job.fence) {
        return { ...job, leaseExpiresAt, leaseToken: job.leaseToken ?? lease.leaseToken ?? null };
      }
      const releasedAt = clock();
      await runControl.releaseLease(runId, { workerId, fence: job.fence, releasedAt });
      await runControl.abandonRunJob(runId, { workerId, fence: job.fence, now: releasedAt });
      return null;
    },
  });
}

export function createStoreRunControl(store) {
  if (!store) throw new TypeError("run_lease_store_control_required");
  const repositories = () => {
    if (!store.repositories?.runJobs || !store.repositories?.runLeases) {
      throw new TypeError("run_lease_store_not_ready");
    }
    return store.repositories;
  };
  return Object.freeze({
    claimRunJob: (runId, input) => repositories().runJobs.claimByRun(runId, input),
    acquireLease: (input) => repositories().runLeases.acquire(input),
    releaseLease: (runId, input) => repositories().runLeases.release(runId, input),
    abandonRunJob: (runId, input) => repositories().runJobs.abandonClaimByRun(runId, input),
    assertActiveFence: (runId, input) => repositories().runJobs.assertActiveFence(runId, input),
  });
}
