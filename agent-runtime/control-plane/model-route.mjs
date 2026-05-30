import { nowISO } from "./schema-validator.mjs";

export function createModelRouteDecision({ runID, taskIntent, executionProfile, providerReadiness = [], piStatus = null, attachments = [] }) {
  const deepseek = providerReadiness.find((item) => item.provider === "deepseek");
  const kimi = providerReadiness.find((item) => item.provider === "kimi");
  return {
    schemaVersion: "agent-model-route-v2",
    runID,
    taskID: taskIntent.taskID,
    runtimeKernel: "agent_runtime_host",
    routeType: executionProfile.modelRouteType,
    selectedTextProvider: "deepseek",
    selectedTextModel: deepseek?.model || null,
    selectedVisionProvider: attachments.length > 0 ? "kimi" : null,
    selectedVisionModel: attachments.length > 0 ? kimi?.model || null : null,
    providerReadiness,
    readinessStatus: deepseek?.ready ? "available" : "blocked_missing_provider_config",
    fallbackPolicy: {
      silentFallbackAllowed: false,
      deterministicLocalSummaryAllowed: true,
      reason: "If model provider is missing, the UI must show blocked/degraded rather than pretending a live LLM answered.",
    },
    piRuntime: piStatus,
    rawSecretsReturned: false,
    requestBodyReturned: false,
    createdAt: nowISO(),
  };
}

