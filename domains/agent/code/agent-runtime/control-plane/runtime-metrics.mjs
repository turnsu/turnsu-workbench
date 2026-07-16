import { nowISO } from "./schema-validator.mjs";

export function createRuntimeMetrics({ runID, taskID, startedAt, contextBundle, toolIntentPlan, policyDecisions, approvalDecisions, modelRoute, qaGate }) {
  const completedAt = nowISO();
  const durationMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
  return {
    schemaVersion: "agent-runtime-metrics-v1",
    runID,
    taskID,
    startedAt,
    completedAt,
    durationMs,
    plannerDecisions: 1,
    contextSources: contextBundle?.includedSources?.length || 0,
    contextChunks: contextBundle?.includedChunks?.length || 0,
    contextBudget: contextBundle?.budget || null,
    toolIntentCount: toolIntentPlan?.tools?.length || 0,
    policyDecisionCount: policyDecisions.length,
    blockedPolicyCount: policyDecisions.filter((item) => item.status === "blocked").length,
    approvalDecisionCount: approvalDecisions.length,
    modelReadinessStatus: modelRoute?.readinessStatus || "unknown",
    qaGateStatus: qaGate?.status || "unknown",
    workerDecisions: [{ mode: "sequential_mvp", workersStarted: 0, workersRecorded: 1 }],
    artifactContractVersion: "agent-control-plane-mvp-2026-05-29",
    rawSecretsReturned: false,
  };
}

