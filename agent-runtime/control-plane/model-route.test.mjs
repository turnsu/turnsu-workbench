#!/usr/bin/env node
import assert from "node:assert/strict";

import { createModelRouteDecision } from "./model-route.mjs";

const base = {
  runID: "run-model-route",
  taskIntent: {
    taskID: "task-model-route",
    taskType: "markets_equity_research",
    goal: "复核 BTC 与 equity macro thesis",
  },
  executionProfile: { modelRouteType: "text_planning_and_synthesis" },
  providerReadiness: [{ provider: "deepseek", role: "text", ready: true, model: "deepseek-v4-pro" }],
  piStatus: { initialized: true },
  attachments: [],
  tools: ["cmc.crypto_macro_overview"],
};

{
  const route = createModelRouteDecision({
    ...base,
    modelPreference: { mode: "explicit", textModel: "deepseek-v4-pro" },
  });
  assert.equal(route.schemaVersion, "agent-model-route-v3");
  assert.equal(route.selectionSource, "user_explicit");
  assert.equal(route.selectedTextModel, "deepseek-v4-pro");
  assert.deepEqual(route.eligibleFallbackModels, ["deepseek-v4-flash"]);
  assert.equal(route.fallbackPolicy.continueOnFailure, true);
  assert.equal(route.fallbackPolicy.deterministicOnlyAfterModelsExhausted, true);
}

{
  const route = createModelRouteDecision({
    ...base,
    modelPreference: { mode: "explicit", textModel: "deepseek-v4-flash" },
  });
  assert.equal(route.selectedTextModel, "deepseek-v4-flash");
  assert.deepEqual(route.eligibleFallbackModels, []);
}

{
  const route = createModelRouteDecision({ ...base, modelPreference: { mode: "auto" } });
  assert.equal(route.selectionSource, "auto");
  assert.equal(route.selectedTextModel, "deepseek-v4-pro");
  assert.deepEqual(route.eligibleFallbackModels, ["deepseek-v4-flash"]);
}

console.log("agent_runtime_control_plane_model_route=pass");
