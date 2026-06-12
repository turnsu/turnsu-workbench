import { controlID, nowISO } from "./schema-validator.mjs";

export function defaultPolicyStatus(toolName) {
  if (toolName === "wechat_cli.live_command") return "blocked";
  if (["run_live_wechat_cli", "trade", "execute_trade", "send_message", "publish_external", "publish_content", "channel.feishu.publish_live", "channel.feishu.reply_live", "office.document.delete", "office.document.overwrite_live"].includes(toolName)) {
    return "blocked";
  }
  if (toolName === "read_live_wechat") return "pass";
  if (toolName.startsWith("cmc.")) return "pass";
  if (/^office\.(meeting_minutes|document|document_revision)\.draft$/.test(toolName)) return "pass";
  if (toolName === "channel.feishu.dry_run") return "pass";
  if (toolName === "computer_use.request") return "needs_confirmation";
  return "pass";
}

function reasonFor(status, toolName) {
  if (status === "pass") return "Local normalized read/write action within runtime artifact boundary.";
  if (status === "needs_confirmation") return "Action may leave local passive analysis or affect user desktop/provider state; confirmation artifact is required.";
  return `Sensitive action ${toolName} is blocked by the project safety boundary.`;
}

function displayTitleFor(toolIntent, status) {
  if (status === "blocked") return "已阻断敏感动作";
  if (status === "needs_confirmation") return "需要你确认";
  if (toolIntent.actionIntent === "import_user_or_fixture_wechat_export") return "导入微信导出记录";
  if (toolIntent.actionIntent === "external_provider_refresh") return "刷新 CMC 数据";
  if (toolIntent.actionIntent === "office_draft_artifact") return "生成办公草稿";
  if (toolIntent.actionIntent === "channel_feishu_dry_run") return "飞书通道预演";
  if (toolIntent.actionIntent === "live_wechat_read_only_refresh") return "读取本机微信";
  if (toolIntent.actionIntent === "write_local_runtime_artifact") return "写入本地结果";
  if (toolIntent.actionIntent === "read_local_or_normalized_data") return "读取本地上下文";
  return "本地能力可用";
}

function publicSummaryFor(toolIntent, status) {
  if (status === "blocked") return "这一步不会执行，可改用本地 fixture、导出文件或已归一化记录。";
  if (status === "needs_confirmation") return "Agent 已记录申请，等待确认前不会触达外部动作。";
  if (toolIntent.actionIntent === "external_provider_refresh") return "通过本地 daemon provider 刷新 CMC normalized artifact；Swift 不直连外部网络。";
  if (toolIntent.actionIntent === "office_draft_artifact") return "只写本地 Office/Meeting draft read model，不发布、不覆盖云文档。";
  if (toolIntent.actionIntent === "channel_feishu_dry_run") return "只写飞书通道 dry-run artifact；真实回复、发布或通知保持阻断。";
  if (toolIntent.actionIntent === "live_wechat_read_only_refresh") return "经本地 daemon 刷新只读 WeChat artifact，不发送、不外发原始聊天。";
  if (toolIntent.actionIntent === "import_user_or_fixture_wechat_export") return "只处理 fixture 或用户提供的导出文件，不运行 live wechat-cli。";
  if (toolIntent.actionIntent === "write_local_runtime_artifact") return "结果只写入本机 runtime artifact。";
  return "只读取本机项目中的归一化记录或 fixture。";
}

function severityFor(status, riskLevel) {
  if (status === "blocked") return "high";
  if (status === "needs_confirmation") return "medium";
  return riskLevel === "medium" ? "low" : "info";
}

export function createPolicyDecisions({ toolIntentPlan, policyForTool = defaultPolicyStatus }) {
  return (toolIntentPlan.tools || []).map((toolIntent) => {
    const status = policyForTool(toolIntent.toolName);
    const reason = reasonFor(status, toolIntent.toolName);
    return {
      schemaVersion: "agent-policy-decision-v2",
      id: controlID("policy"),
      action: toolIntent.toolName,
      actionIntent: toolIntent.actionIntent,
      status,
      reason,
      displayTitle: displayTitleFor(toolIntent, status),
      displayReason: publicSummaryFor(toolIntent, status),
      severity: severityFor(status, toolIntent.riskLevel),
      publicSummary: publicSummaryFor(toolIntent, status),
      riskLevel: toolIntent.riskLevel,
      audience: "local_user_private_workspace",
      payloadClass: toolIntent.payloadClass,
      sourceRecordRequired: toolIntent.sourceRecordRequired,
      safeAlternative:
        status === "blocked"
          ? "Use fixture/export/normalized artifact input instead of live external execution."
          : null,
      rawSecretsReturned: false,
      rawTranscriptIncluded: false,
      createdAt: nowISO(),
    };
  });
}
