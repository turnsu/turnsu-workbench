export function subagentContractSummary({ runID, status = "read_only_dry_run", reason = "namespaced_execution_not_enabled" } = {}) {
  return {
    schemaVersion: "core-subagent-contract-summary-v1",
    runID,
    owner: "Agent Runtime Core",
    status,
    reason,
    namespaceRequired: true,
    killStrategyRequired: true,
    userTmuxSessionsTouched: false,
    realExecutionEnabled: false,
  };
}
