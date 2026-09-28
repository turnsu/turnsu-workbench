/**
 * Narrow durable boundary owned by WorkflowRunner.  It intentionally models
 * product aggregates, never tables/collections or a generic repository API.
 * The first slice is the recovery-critical accepted aggregate/read surface;
 * subsequent slices add node/review/terminal/effect operations here.
 */
export function assertWorkflowRunPersistence(value) {
  for (const method of [
    "createAcceptedAggregate",
    "loadRecoverableAggregates",
    "readInternalRun",
    "readPublicRun",
    "saveExecutionSnapshot",
    "transact",
    "appendRunEvent",
    "projectReadModel",
    "transitionRunState",
    "readReadModel",
    "listRunStateEvents",
    "listRunsByWorkflow",
    "listRecentRuns",
    "listRunEvents",
    "listNodeAttempts",
    "createNodeAttempt",
    "patchNodeAttempt",
    "syncNodeRuns",
    "createCheckpoint",
    "readRunState",
    "withFencedTransaction",
    "settleTerminalAggregate",
    "recordReviewDecisionAndRequeue",
    "pauseForReview",
    "markReviewDecision",
    "requeueReview",
    "heartbeatLeaseProjection",
    "releaseLeaseProjection",
    "listEffectReceipts",
    "runIdempotently",
    "requestCancellation",
  ]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError(`workflow_run_persistence_${method}_required`);
    }
  }
  return value;
}
