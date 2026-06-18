import { nowISO } from "./schema-validator.mjs";

const supportedTextModels = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);

function normalizeModelPreference(modelPreference = null) {
  const mode = String(modelPreference?.mode || "").toLowerCase() === "explicit" ? "explicit" : "auto";
  const textModel = supportedTextModels.has(String(modelPreference?.textModel || ""))
    ? String(modelPreference.textModel)
    : null;
  if (mode !== "explicit" || !textModel) {
    return {
      mode: "auto",
      textModel: null,
      fallbackPolicy: "continue_with_eligible_models",
      selectionSource: "auto",
    };
  }
  return {
    mode: "explicit",
    textModel,
    fallbackPolicy: "continue_with_eligible_models",
    selectionSource: "user_explicit",
  };
}

function taskPrefersPro({ taskIntent, executionProfile, tools = [] }) {
  const text = `${taskIntent?.taskType || ""} ${taskIntent?.goal || ""} ${executionProfile?.routeType || ""} ${tools.join(" ")}`.toLowerCase();
  return /crypto|cmc|market|markets|equity|earnings|sector|thesis|strategy|macro|office_document|meeting|long|btc|eth|股票|财报|会议|文档|策略|宏观|研究/.test(text);
}

function textRoutePlan({ modelPreference, taskIntent, executionProfile, tools }) {
  const preference = normalizeModelPreference(modelPreference);
  if (preference.mode === "explicit") {
    return {
      preference,
      selectedTextModel: preference.textModel,
      eligibleFallbackModels: preference.textModel === "deepseek-v4-pro" ? ["deepseek-v4-flash"] : [],
    };
  }
  const selectedTextModel = taskPrefersPro({ taskIntent, executionProfile, tools })
    ? "deepseek-v4-pro"
    : "deepseek-v4-flash";
  return {
    preference,
    selectedTextModel,
    eligibleFallbackModels: selectedTextModel === "deepseek-v4-pro"
      ? ["deepseek-v4-flash"]
      : ["deepseek-v4-pro"],
  };
}

export function createModelRouteDecision({ runID, taskIntent, executionProfile, providerReadiness = [], piStatus = null, attachments = [], modelPreference = null, tools = [] }) {
  const deepseek = providerReadiness.find((item) => item.provider === "deepseek");
  const kimi = providerReadiness.find((item) => item.provider === "kimi");
  const routePlan = textRoutePlan({ modelPreference, taskIntent, executionProfile, tools });
  return {
    schemaVersion: "agent-model-route-v3",
    runID,
    taskID: taskIntent.taskID,
    runtimeKernel: "agent_runtime_host",
    routeType: executionProfile.modelRouteType,
    selectedTextProvider: "deepseek",
    selectedTextModel: routePlan.selectedTextModel || deepseek?.model || null,
    selectionSource: routePlan.preference.selectionSource,
    requestedModelPreference: routePlan.preference,
    eligibleFallbackModels: routePlan.eligibleFallbackModels,
    selectedVisionProvider: attachments.length > 0 ? "kimi" : null,
    selectedVisionModel: attachments.length > 0 ? kimi?.model || null : null,
    providerReadiness,
    readinessStatus: deepseek?.ready ? "available" : "blocked_missing_provider_config",
    fallbackPolicy: {
      continueOnFailure: true,
      silentFallbackAllowed: false,
      deterministicOnlyAfterModelsExhausted: true,
      deterministicLocalSummaryAllowed: true,
      reason: "If model provider is missing, the UI must show blocked/degraded rather than pretending a live LLM answered.",
    },
    attempts: [],
    finalModel: null,
    fallbackUsed: false,
    userVisibleNoteRequired: false,
    piRuntime: piStatus,
    rawSecretsReturned: false,
    requestBodyReturned: false,
    createdAt: nowISO(),
  };
}
