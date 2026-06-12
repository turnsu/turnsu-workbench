import { controlID, nowISO, safeArray } from "./schema-validator.mjs";

export function classifyToolIntent(toolName) {
  if (/^wechat\.read|^market\.read|^onchain\.read|^token\.resolve/.test(toolName)) {
    return { actionIntent: "read_local_or_normalized_data", riskLevel: "low", payloadClass: "normalized_or_fixture" };
  }
  if (toolName === "read_live_wechat") {
    return { actionIntent: "live_wechat_read_only_refresh", riskLevel: "medium", payloadClass: "local_private_summary_artifact" };
  }
  if (/^cmc\./.test(toolName)) {
    return { actionIntent: "external_provider_refresh", riskLevel: "low", payloadClass: "normalized_market_snapshot" };
  }
  if (/^crystal\.|^proposal\.|^handoff\.|^memory\./.test(toolName)) {
    return { actionIntent: "write_local_runtime_artifact", riskLevel: "low", payloadClass: "derived_private_artifact" };
  }
  if (/^office\.(meeting_minutes|document|document_revision)\.draft$/.test(toolName)) {
    return { actionIntent: "office_draft_artifact", riskLevel: "medium", payloadClass: "bounded_office_context" };
  }
  if (/^markets\.(equity_dispatcher|equity_research)\./.test(toolName)) {
    return { actionIntent: "markets_research_draft_artifact", riskLevel: "medium", payloadClass: "bounded_market_research_context" };
  }
  if (toolName === "markets.provider.drillr_deferred") {
    return { actionIntent: "deferred_equity_provider_marker", riskLevel: "medium", payloadClass: "provider_deferred_summary" };
  }
  if (toolName === "channel.feishu.dry_run") {
    return { actionIntent: "channel_feishu_dry_run", riskLevel: "medium", payloadClass: "redacted_channel_action_plan" };
  }
  if (/^channel\.feishu\.(publish_live|reply_live)$/.test(toolName)) {
    return { actionIntent: "publish_customer_visible", riskLevel: "high", payloadClass: "external_channel_action" };
  }
  if (/^office\.document\.(delete|overwrite_live)$/.test(toolName)) {
    return { actionIntent: "destructive_office_action", riskLevel: "high", payloadClass: "external_or_destructive_office_action" };
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
