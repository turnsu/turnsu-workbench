export function memoryContractSummary({ runID, status = "adapter_unavailable", writeStatus = "not_written", reason = "memory_adapter_not_configured" } = {}) {
  return {
    schemaVersion: "core-memory-contract-summary-v1",
    runID,
    owner: "Agent Runtime Core",
    status,
    writeStatus,
    reason,
    requiresUserReview: true,
    retentionPolicyRequired: true,
    purgeSupportedRequired: true,
  };
}
