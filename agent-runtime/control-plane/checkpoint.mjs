import { nowISO } from "./schema-validator.mjs";

export function createCheckpoint({ runID, taskID, executionProfile, completedStages = [], status = "running" }) {
  const stages = executionProfile?.requiredStages || [];
  return {
    schemaVersion: "agent-checkpoint-v1",
    runID,
    taskID,
    status,
    currentStage: completedStages.at(-1) || stages[0] || "unknown",
    completedStages,
    remainingStages: stages.filter((stage) => !completedStages.includes(stage)),
    resumeSupported: true,
    resumeMode: "artifact_replay_mvp",
    updatedAt: nowISO(),
  };
}

export function createRetryLedger({ runID, taskID }) {
  return {
    schemaVersion: "agent-retry-ledger-v1",
    runID,
    taskID,
    retries: [],
    automaticRetryEnabled: false,
    createdAt: nowISO(),
  };
}

