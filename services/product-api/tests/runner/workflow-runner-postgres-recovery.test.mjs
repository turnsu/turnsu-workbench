import assert from "node:assert/strict";
import test from "node:test";

import { createWorkflowRunner } from "../../src/runner/index.mjs";

test("WorkflowRunner recovers a native PostgreSQL aggregate through its explicit event-ledger port", async () => {
  let repositoryReads = 0;
  const runControl = runControlStub();
  const store = {
    persistenceDriver: "postgres",
    async withTransaction(work) { return work({}); },
    get repositories() {
      repositoryReads += 1;
      throw new Error("legacy_mongo_repository_fallback_reached");
    },
  };
  const runner = createWorkflowRunner({
    store,
    commandIntake: commandIntakeStub(),
    runControl,
    runPersistence: postgresPersistenceStub(),
    resolveExecution: async () => {
      throw new Error("recovery_should_not_schedule_a_waiting_review");
    },
    agentRuntime: { async buildAuthoritativeFinal() { return {}; } },
    scheduleOnStart: false,
    workerId: "postgres-native-ledger-test",
    idFactory: (kind) => `postgres-native-${kind}`,
  });

  assert.deepEqual(await runner.recover(), { recoveredRunIds: [] });
  assert.equal(runControl.claims, 1);
  assert.equal(repositoryReads, 0);
});

function commandIntakeStub() {
  return {
    async accept() { return null; },
    async start() { return null; },
    async requestCancellation() { return null; },
    async settle() { return null; },
    async recover() { return null; },
  };
}

function runControlStub() {
  let claims = 0;
  return {
    get claims() { return claims; },
    async claimRunJob() { claims += 1; return null; },
    async acquireLease() { return null; },
    async releaseLease() { return null; },
    async abandonRunJob() { return null; },
    async assertActiveFence() { return null; },
  };
}

function postgresPersistenceStub() {
  const unexpected = async () => {
    throw new Error("unexpected_postgres_persistence_operation");
  };
  return {
    durableBoundaryMode: "event",
    async loadRecoverableAggregates() {
      return [{
        run: {
          runId: "postgres-native-queued-run",
          stateModelVersion: 3,
          status: "queued",
          workspaceId: "workspace-postgres-native",
          requestedBy: "user-postgres-native",
          executionSnapshot: {
            schemaVersion: "workbench-v1",
            workflowId: "workflow-postgres-native",
            workflowRevisionId: "revision-postgres-native",
            graph: { nodes: [], edges: [] },
            inputForm: {},
            outputDefinition: {},
            runSettings: {},
            plan: {
              planId: "plan-postgres-native",
              workflowId: "workflow-postgres-native",
              workflowRevisionId: "revision-postgres-native",
              pinnedSkills: [],
              steps: [],
            },
            skillVersions: [],
            connectionBindings: [],
          },
        },
        latestDecision: null,
      }];
    },
    createAcceptedAggregate: unexpected,
    readInternalRun: unexpected,
    readPublicRun: unexpected,
    saveExecutionSnapshot: unexpected,
    transact: unexpected,
    appendRunEvent: unexpected,
    projectReadModel: unexpected,
    transitionRunState: unexpected,
    readReadModel: unexpected,
    listRunStateEvents: unexpected,
    listRunsByWorkflow: unexpected,
    listRecentRuns: unexpected,
    listRunEvents: unexpected,
    listNodeAttempts: unexpected,
    createNodeAttempt: unexpected,
    patchNodeAttempt: unexpected,
    syncNodeRuns: unexpected,
    createCheckpoint: unexpected,
    readRunState: unexpected,
    withFencedTransaction: unexpected,
    settleTerminalAggregate: unexpected,
    recordReviewDecisionAndRequeue: unexpected,
    pauseForReview: unexpected,
    markReviewDecision: unexpected,
    requeueReview: unexpected,
    heartbeatLeaseProjection: unexpected,
    releaseLeaseProjection: unexpected,
    listEffectReceipts: unexpected,
    runIdempotently: unexpected,
    requestCancellation: unexpected,
  };
}
