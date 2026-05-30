import { controlID, nowISO, safeArray } from "./schema-validator.mjs";

export function classifyToolIntent(toolName) {
  if (/^wechat\.read|^market\.read|^onchain\.read|^cmc\.(read|detect|track)|^token\.resolve/.test(toolName)) {
    return { actionIntent: "read_local_or_normalized_data", riskLevel: "low", payloadClass: "normalized_or_fixture" };
  }
  if (/^crystal\.|^proposal\.|^handoff\.|^memory\./.test(toolName)) {
    return { actionIntent: "write_local_runtime_artifact", riskLevel: "low", payloadClass: "derived_private_artifact" };
  }
  if (toolName === "wechat_cli.import_export_file") {
    return { actionIntent: "import_user_or_fixture_wechat_export", riskLevel: "medium", payloadClass: "normalized_wechat_export" };
  }
  if (toolName === "image.analyze_with_kimi") {
    return { actionIntent: "provider_image_analysis", riskLevel: "medium", payloadClass: "user_attachment_hash_and_image" };
  }
  if (toolName === "computer_use.request") {
    return { actionIntent: "external_computer_use_request", riskLevel: "high", payloadClass: "user_confirmation_proposal" };
  }
  if (toolName === "wechat_cli.live_command") {
    return { actionIntent: "live_wechat_cli_read", riskLevel: "high", payloadClass: "live_private_data" };
  }
  if (toolName === "cmc.request_mcp_refresh") {
    return { actionIntent: "external_provider_refresh", riskLevel: "medium", payloadClass: "normalized_market_request" };
  }
  return { actionIntent: "unknown_tool_intent", riskLevel: "medium", payloadClass: "unknown" };
}

export function createToolIntentPlan({ taskIntent, executionProfile, tools = [] }) {
  const items = safeArray(tools).map((toolName, index) => {
    const intent = classifyToolIntent(toolName);
    return {
      id: controlID("tool-intent"),
      sequence: index + 1,
      toolName,
      ...intent,
      reason: "Resolved from selected skill/extension and prompt by the internal control plane.",
      sourceRecordRequired: intent.riskLevel !== "low",
      idempotencyScope: `${toolName}:${taskIntent.runID}`,
    };
  });

  return {
    schemaVersion: "agent-tool-intent-plan-v1",
    runID: taskIntent.runID,
    taskID: taskIntent.taskID,
    taskType: taskIntent.taskType,
    profileID: executionProfile.profileID,
    publicSurfaceOnly: true,
    internalToolsExposed: false,
    tools: items,
    createdAt: nowISO(),
  };
}
