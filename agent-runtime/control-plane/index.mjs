import { join } from "node:path";
import { createTaskIntent } from "./task-intent.mjs";
import { createExecutionProfile } from "./execution-profile.mjs";
import { createContextPlane } from "./context-plane.mjs";
import { createToolIntentPlan } from "./tool-intent-plan.mjs";
import { createPolicyDecisions } from "./policy-decision.mjs";
import { createApprovalDecisions } from "./approval-decision.mjs";
import { createModelRouteDecision } from "./model-route.mjs";
import { createPlannerEnvelope } from "./planner.mjs";
import { createQAGate } from "./qa-gate.mjs";
import { createRuntimeMetrics } from "./runtime-metrics.mjs";
import { createCheckpoint, createRetryLedger } from "./checkpoint.mjs";
import { artifactPath, nowISO, validateRequired, writeJsonArtifact } from "./schema-validator.mjs";

export function buildControlPlane(input) {
  const startedAt = nowISO();
  const {
    projectRoot,
    runDir,
    runID,
    taskID,
    sessionID,
    prompt,
    selectedSkillIDs = [],
    selectedExtensionIDs = [],
    attachments = [],
    contextRefs = [],
    tools = [],
    policyForTool,
    providerReadiness = [],
    piStatus = null,
  } = input;

  const taskIntent = createTaskIntent({ runID, taskID, sessionID, prompt, selectedSkillIDs, selectedExtensionIDs, attachments, contextRefs });
  const executionProfile = createExecutionProfile({ taskIntent, tools, attachments });
  const contextPlane = createContextPlane({ projectRoot, runID, taskID, sessionID, prompt, selectedSkillIDs, selectedExtensionIDs, attachments, contextRefs });
  const contextManifest = {
    ...contextPlane.contextManifest,
    artifactPath: `runtime/agent/runs/${runID}/context-manifest.json`,
  };
  const contextBundle = {
    ...contextPlane.contextBundle,
    artifactPath: `runtime/agent/runs/${runID}/context-bundle.json`,
  };
  const retrievalPlan = {
    ...contextPlane.retrievalPlan,
    artifactPath: `runtime/agent/runs/${runID}/retrieval-plan.json`,
  };
  const contextIndex = {
    ...contextPlane.contextIndex,
    artifactPath: `runtime/agent/runs/${runID}/context-index.json`,
  };
  const retrievalResults = {
    ...contextPlane.retrievalResults,
    artifactPath: `runtime/agent/runs/${runID}/retrieval-results.json`,
  };
  const contextPack = {
    ...contextPlane.contextPack,
    artifactPath: `runtime/agent/runs/${runID}/context-pack.json`,
  };
  const sourceTrustReport = {
    ...contextPlane.sourceTrustReport,
    artifactPath: `runtime/agent/runs/${runID}/source-trust-report.json`,
  };
  const memoryCompression = {
    ...contextPlane.memoryCompression,
    artifactPath: `runtime/agent/runs/${runID}/memory-compression.json`,
  };
  const contextGate = {
    ...contextPlane.contextGate,
    artifactPath: `runtime/agent/runs/${runID}/context-gate.json`,
  };
  const toolIntentPlan = createToolIntentPlan({ taskIntent, executionProfile, tools });
  const policyDecisions = createPolicyDecisions({ toolIntentPlan, policyForTool });
  const approvalDecisions = createApprovalDecisions({ policyDecisions });
  const modelRoute = createModelRouteDecision({ runID, taskIntent, executionProfile, providerReadiness, piStatus, attachments });
  const plannerEnvelope = createPlannerEnvelope({ taskIntent, executionProfile, contextManifest, toolIntentPlan });
  const qaGate = createQAGate({ runID, taskID, contextGate, policyDecisions, approvalDecisions, toolIntentPlan });
  const runtimeMetrics = createRuntimeMetrics({ runID, taskID, startedAt, contextBundle, toolIntentPlan, policyDecisions, approvalDecisions, modelRoute, qaGate });
  const completedStages = executionProfile.requiredStages.filter((stage) => stage !== "tool_execution" && stage !== "final_output");
  const checkpoint = createCheckpoint({ runID, taskID, executionProfile, completedStages, status: "control_plane_ready" });
  const retryLedger = createRetryLedger({ runID, taskID });
  const controlPlaneManifest = {
    schemaVersion: "agent-control-plane-manifest-v1",
    runID,
    taskID,
    sessionID,
    publicSurfaceOnly: true,
    internalToolsExposed: false,
    stages: executionProfile.requiredStages,
    artifacts: [
      "control-plane-manifest.json",
      "task-intent.json",
      "execution-profile.json",
      "planner-envelope.json",
      "planner-state.json",
      "task-graph.json",
      "agent-loop.ndjson",
      "planner-decisions.ndjson",
      "tool-intent-plan.json",
      "context-manifest.json",
      "context-bundle.json",
      "retrieval-plan.json",
      "context-index.json",
      "retrieval-results.json",
      "context-pack.json",
      "source-trust-report.json",
      "memory-compression.json",
      "context-gate.json",
      "policy-decisions.json",
      "approval-decisions.json",
      "model-route.json",
      "qa-gate.json",
      "runtime-metrics.json",
      "checkpoint.json",
      "retry-ledger.json",
    ].map((name) => ({ name, artifactPath: `runtime/agent/runs/${runID}/${name}` })),
    validations: [
      validateRequired("task-intent.json", taskIntent, ["schemaVersion", "runID", "taskID", "taskType"]),
      validateRequired("context-manifest.json", contextManifest, ["schemaVersion", "runID", "sources", "chunks"]),
      validateRequired("tool-intent-plan.json", toolIntentPlan, ["schemaVersion", "runID", "tools"]),
      validateRequired("qa-gate.json", qaGate, ["schemaVersion", "runID", "status"]),
    ],
    rawSecretsReturned: false,
    createdAt: nowISO(),
  };

  const writes = [
    ["control-plane-manifest.json", controlPlaneManifest],
    ["task-intent.json", taskIntent],
    ["execution-profile.json", executionProfile],
    ["planner-envelope.json", plannerEnvelope],
    ["tool-intent-plan.json", toolIntentPlan],
    ["context-manifest.json", contextManifest],
    ["context-bundle.json", contextBundle],
    ["retrieval-plan.json", retrievalPlan],
    ["context-index.json", contextIndex],
    ["retrieval-results.json", retrievalResults],
    ["context-pack.json", contextPack],
    ["source-trust-report.json", sourceTrustReport],
    ["memory-compression.json", memoryCompression],
    ["context-gate.json", contextGate],
    ["policy-decisions.json", policyDecisions],
    ["approval-decisions.json", approvalDecisions],
    ["model-route.json", modelRoute],
    ["qa-gate.json", qaGate],
    ["runtime-metrics.json", runtimeMetrics],
    ["checkpoint.json", checkpoint],
    ["retry-ledger.json", retryLedger],
  ];
  for (const [fileName, payload] of writes) {
    writeJsonArtifact(join(runDir, fileName), payload);
  }
  for (const [fileName, payload] of contextPlane.contextChunkArtifacts || []) {
    writeJsonArtifact(join(runDir, fileName), payload);
  }

  return {
    startedAt,
    controlPlaneManifest,
    taskIntent,
    executionProfile,
    plannerEnvelope,
    toolIntentPlan,
    policyDecisions,
    approvalDecisions,
    modelRoute,
    contextManifest,
    contextBundle,
    retrievalPlan,
    contextIndex,
    retrievalResults,
    contextPack,
    sourceTrustReport,
    memoryCompression,
    contextGate,
    qaGate,
    runtimeMetrics,
    checkpoint,
    retryLedger,
    tools: (toolIntentPlan.tools || []).map((item) => item.toolName),
    runArtifactRoot: artifactPath(projectRoot, runDir),
  };
}
