import { join } from "node:path";

export function writeAgentFinalReadModelArtifact({ runDir, finalReadModel, writeJSON }) {
  if (!runDir) throw new Error("core_artifact_missing_run_dir");
  if (!finalReadModel || finalReadModel.schemaVersion !== "agent-final-read-model-v1") {
    throw new Error("core_artifact_invalid_final_read_model");
  }
  writeJSON(join(runDir, "agent-final-read-model.json"), finalReadModel);
  return {
    artifactKind: "final_read_model",
    artifactPath: finalReadModel.artifactPath,
    schemaVersion: finalReadModel.schemaVersion,
  };
}

export function coreArtifactBoundarySummary({ runID, finalReadModelPath, manifestPath }) {
  return {
    schemaVersion: "core-artifact-boundary-summary-v1",
    runID,
    finalReadModelPath,
    manifestPath,
    owner: "Agent Runtime Core",
  };
}

export async function writeAuthoritativeFinalOutput({
  runDir,
  runID,
  taskID,
  session,
  prompt,
  tools = [],
  selectedCapabilityIDs = [],
  selectedSkillIDs = [],
  selectedExtensionIDs = [],
  attachments = [],
  envelope = {},
  finalText,
  finalReadModel,
  finalReadModelPath,
  toolObservations,
  controlPlane,
  toolCalls = [],
  contextSummary,
  controlSummary,
  cmcCapabilitySummary,
  writeJSON,
  writeTextFile,
  readJSON,
  runManifestPath,
  writeRunManifest,
  appendEvent,
  now = () => new Date().toISOString(),
  safeId = (prefix) => `${prefix}-${Date.now()}`,
  recordFinalLoopStep,
  finalizeHarnessArtifacts,
  writeCapabilityLoopReadModels,
  saveFinalOutput,
  persistFinalSessionTask,
}) {
  if (!runDir) throw new Error("core_final_output_missing_run_dir");
  if (!finalReadModel || finalReadModel.schemaVersion !== "agent-final-read-model-v1") {
    throw new Error("core_final_output_invalid_final_read_model");
  }
  if (typeof writeTextFile !== "function" || typeof writeJSON !== "function") {
    throw new Error("core_final_output_missing_writers");
  }

  const finalOutputPath = `runtime/agent/runs/${runID}/final-output.md`;
  writeTextFile(join(runDir, "final-output.md"), `${finalText}\n`);
  writeAgentFinalReadModelArtifact({ runDir, finalReadModel, writeJSON });
  recordFinalLoopStep?.(runDir, { runID, taskID, finalReadModel, toolObservations });

  const harnessFinal = finalizeHarnessArtifacts?.(runDir, {
    runID,
    taskID,
    sessionID: session.sessionID,
    prompt,
    controlPlane,
    toolCalls,
    finalReadModel,
    toolObservations,
  });
  const capabilityHarness = writeCapabilityLoopReadModels?.(runDir, {
    runID,
    taskID,
    sessionID: session.sessionID,
    prompt,
    tools,
    selectedCapabilityIDs,
    selectedSkillIDs,
    selectedExtensionIDs,
    finalReadModel,
    cmcCapabilitySummary,
    harnessFinal,
  });

  await saveFinalOutput?.(runID, finalText, {
    sessionID: session.sessionID,
    taskID,
    artifactPath: finalOutputPath,
  });

  writeJSON(join(runDir, "runtime-metrics.json"), {
    ...controlPlane.runtimeMetrics,
    completedAt: now(),
    toolCallCount: toolCalls.length,
    completedToolCallCount: toolCalls.filter((call) => call.status === "completed").length,
    blockedToolCallCount: toolCalls.filter((call) => call.status === "blocked").length,
    waitingForApprovalToolCallCount: toolCalls.filter((call) => call.status === "waitingForApproval").length,
    failedToolCallCount: toolCalls.filter((call) => call.status === "failed").length,
    finalOutputBytes: Buffer.byteLength(finalText, "utf8"),
  });
  writeJSON(join(runDir, "checkpoint.json"), {
    ...controlPlane.checkpoint,
    status: "completed",
    currentStage: "final_output",
    completedStages: controlPlane.executionProfile.requiredStages,
    remainingStages: [],
    updatedAt: now(),
  });

  const existingManifest = readJSON?.(runManifestPath(runDir), {}) || {};
  writeRunManifest(runDir, {
    ...existingManifest,
    status: "completed",
    currentStage: "final_output",
    completedAt: now(),
    finalOutputPath,
    finalReadModelPath,
    productMutationPolicy: finalReadModel.productMutationPolicy,
    harnessSummary: harnessFinal ? {
      sessionTreePath: `runtime/agent/runs/${runID}/harness-session-tree.json`,
      branchLineagePath: `runtime/agent/runs/${runID}/harness-branch-lineage.json`,
      invocationLedgerPath: `runtime/agent/runs/${runID}/invocation-ledger.ndjson`,
      contextEventLogPath: `runtime/agent/runs/${runID}/context-event-log.ndjson`,
      compactionSummaryPath: harnessFinal.compactionSummary.artifactPath,
      reviewReadModelPath: harnessFinal.reviewModel.artifactPath,
      reviewStatus: harnessFinal.reviewModel.status,
    } : existingManifest.harnessSummary,
    capabilityLoopSummary: capabilityHarness ? {
      readModelPath: capabilityHarness.capabilityLoop.artifactPath,
      loopType: capabilityHarness.capabilityLoop.loopType,
      status: capabilityHarness.capabilityLoop.status,
      reviewStatus: capabilityHarness.capabilityLoop.review.status,
      capabilityPackageCount: capabilityHarness.capabilityLoop.capabilityPackages.length,
    } : existingManifest.capabilityLoopSummary,
    memorySummary: capabilityHarness ? {
      readModelPath: capabilityHarness.memoryReadModel.artifactPath,
      status: capabilityHarness.memoryReadModel.status,
      writePolicyStatus: capabilityHarness.memoryReadModel.writePolicy.status,
    } : existingManifest.memorySummary,
    subagentCoordinationSummary: capabilityHarness ? {
      readModelPath: capabilityHarness.subagentCoordination.artifactPath,
      status: capabilityHarness.subagentCoordination.status,
      mode: capabilityHarness.subagentCoordination.mode,
    } : existingManifest.subagentCoordinationSummary,
    toolCallCount: toolCalls.length,
    contextSummary,
    controlSummary: {
      ...controlSummary,
      stage: "completed",
      updatedAt: now(),
    },
  });

  const assistantMessage = {
    id: safeId("msg"),
    role: "assistant",
    content: [{ type: "text", text: finalText }],
    runID,
    createdAt: now(),
  };
  session.messages.push(assistantMessage);
  session.activeRunID = runID;
  session.status = "completed";
  session.updatedAt = now();

  const task = {
    taskID,
    sessionID: session.sessionID,
    runID,
    prompt,
    status: "completed",
    selectedToolNames: tools,
    selectedCapabilityIDs,
    selectedSkillIDs,
    selectedExtensionIDs,
    attachmentIDs: attachments.map((item) => item.attachmentID || item.id).filter(Boolean),
    artifactPath: `runtime/agent/runs/${runID}`,
    createdAt: envelope.createdAt,
    updatedAt: now(),
    isTest: process.env.WECHAT_AGENT_TEST_MODE === "1",
  };
  await persistFinalSessionTask?.({ session, task, assistantMessage });

  appendEvent?.(runDir, {
    type: "run.completed",
    runID,
    taskID,
    stage: "final_output",
    status: "completed",
    artifactKind: "final_output",
    artifactPath: finalOutputPath,
    finalReadModelPath,
    finalText,
  });

  return {
    schemaVersion: "agent-final-output-write-result-v1",
    finalOutputPath,
    finalReadModelPath,
    finalReadModel,
    harnessFinal,
    capabilityHarness,
    assistantMessage,
    session,
    task,
  };
}
