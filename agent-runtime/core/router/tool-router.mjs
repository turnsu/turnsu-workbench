export const externalCMCToolNames = new Set([
  "cmc.live_market_refresh",
  "cmc.daily_market_overview",
  "cmc.crypto_macro_overview",
  "cmc.detect_market_regime",
  "cmc.track_social_price_divergence",
  "cmc.classify_kline_pattern_quality",
  "cmc.read_market_evidence",
  "cmc.request_mcp_refresh",
]);

const AUDIO_VIDEO_EXTENSIONS = new Set(["aac", "aiff", "amr", "avi", "flac", "flv", "m4a", "m4v", "mkv", "mov", "mp3", "mp4", "mpeg", "mpg", "ogg", "opus", "pcm", "wav", "webm", "wma", "wmv"]);
const IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "webp"]);

function attachmentExtension(attachment = {}) {
  const value = String(attachment.fileName || attachment.originalPath || attachment.artifactPath || "");
  const match = value.toLowerCase().match(/\.([a-z0-9]+)(?:$|\?)/);
  return match ? match[1] : "";
}

export function isImageAttachment(attachment = {}) {
  const mime = String(attachment.mimeType || "").toLowerCase();
  return mime.startsWith("image/") || IMAGE_EXTENSIONS.has(attachmentExtension(attachment));
}

export function isAudioVideoAttachment(attachment = {}) {
  const mime = String(attachment.mimeType || "").toLowerCase();
  return mime.startsWith("audio/") || mime.startsWith("video/") || AUDIO_VIDEO_EXTENSIONS.has(attachmentExtension(attachment));
}

export function shouldRouteCloudASR({ prompt = "", attachments = [] } = {}) {
  const textValue = String(prompt || "").toLowerCase();
  const meetingIntent = /meeting|minutes|transcript|asr|audio|video|会议|纪要|逐字稿|转写|录音|音频|视频/.test(textValue);
  return meetingIntent && attachments.some(isAudioVideoAttachment);
}

export function toolsForSkill(skillID) {
  switch (skillID) {
    case "wechat-onchain-intelligence":
      return ["wechat.read_normalized_messages", "token.resolve_entities", "market.read_snapshot", "onchain.read_snapshot", "crystal.create_or_update", "proposal.create"];
    case "cmc-market-radar":
      return ["cmc.live_market_refresh", "cmc.daily_market_overview", "cmc.read_market_evidence", "market.read_snapshot", "crystal.create_or_update", "proposal.create"];
    case "market-regime-review":
      return ["cmc.live_market_refresh", "cmc.detect_market_regime", "market.read_snapshot", "proposal.create"];
    case "social-price-divergence":
      return ["cmc.live_market_refresh", "cmc.track_social_price_divergence", "market.read_snapshot", "proposal.create"];
    case "image-analysis":
      return ["image.analyze_with_kimi", "token.resolve_entities", "proposal.create"];
    case "long-task":
      return ["wechat.read_normalized_messages", "token.resolve_entities", "onchain.read_snapshot", "memory.save", "handoff.write"];
    case "handoff-writer":
      return ["handoff.write", "memory.save"];
    case "meeting-cloud-asr":
      return ["office.cloud_asr.transcribe"];
    case "meeting-minutes":
      return ["office.meeting_minutes.draft"];
    case "document-generation":
      return ["office.document.draft"];
    case "document-revision":
      return ["office.document_revision.draft"];
    case "feishu-agent-bridge":
      return ["channel.feishu.dry_run"];
    case "equity-company-deep-dive":
    case "equity-earnings-review":
    case "equity-thesis-tracker":
    case "equity-sector-scan":
    case "macro-cross-asset-readthrough":
      return ["markets.equity_dispatcher.plan", "markets.equity_research.draft", "markets.provider.drillr_deferred"];
    default:
      return [];
  }
}

export function toolsForExtension(extensionID) {
  switch (extensionID) {
    case "wechat-cli-export-bridge":
      return ["wechat_cli.import_export_file", "wechat.read_normalized_messages", "token.resolve_entities"];
    case "cmc-skill-hub":
      return ["cmc.live_market_refresh", "cmc.daily_market_overview", "cmc.read_market_evidence", "market.read_snapshot"];
    case "local-memory":
      return ["memory.save"];
    case "handoff-writer":
      return ["handoff.write"];
    case "office-meeting-agent":
      return ["office.meeting_minutes.draft", "office.document.draft", "office.document_revision.draft"];
    case "feishu-agent-bridge":
      return ["channel.feishu.dry_run"];
    case "markets-research":
      return ["markets.equity_dispatcher.plan", "markets.equity_research.draft", "markets.provider.drillr_deferred"];
    default:
      return [];
  }
}

export function preferredCMCTool(prompt, selectedSkillIDs = []) {
  const textValue = String(prompt || "").toLowerCase();
  const selected = new Set(selectedSkillIDs);
  if (/macro|宏观|etf|流动性|fear|greed|thesis|做空|\bshort\b|correlation|相关性|跨资产|反证/.test(textValue)) {
    return "cmc.crypto_macro_overview";
  }
  if (selected.has("market-regime-review") || /regime|体制|周期|风险偏好/.test(textValue)) {
    return "cmc.detect_market_regime";
  }
  if (/kline|k线|形态|突破|breakout|squeeze|挤压/.test(textValue)) {
    return "cmc.classify_kline_pattern_quality";
  }
  if (selected.has("social-price-divergence") || /social|社交|twitter|kol|分歧|背离/.test(textValue)) {
    return "cmc.track_social_price_divergence";
  }
  return "cmc.daily_market_overview";
}

export function cmcToolSelectionDiagnostic(prompt, selectedSkillIDs = [], selectedToolNames = [], finalTools = []) {
  const textValue = String(prompt || "").toLowerCase();
  const promptIntent = /macro|宏观|etf|流动性|fear|greed|thesis|做空|\bshort\b|correlation|相关性|跨资产|反证/.test(textValue)
    ? "macro_thesis"
    : /social|社交|twitter|kol|分歧|背离/.test(textValue)
      ? "social_price_divergence"
      : /regime|体制|周期|风险偏好/.test(textValue)
        ? "market_regime"
        : /kline|k线|形态|突破|breakout|squeeze|挤压/.test(textValue)
          ? "kline_pattern"
          : "general_market";
  const preferredTool = preferredCMCTool(prompt, selectedSkillIDs);
  const selectedExternal = finalTools.filter((tool) => externalCMCToolNames.has(tool));
  return {
    promptIntent,
    preferredTool,
    selectedExternalTools: selectedExternal,
    explicitExternalTools: selectedToolNames.filter((tool) => externalCMCToolNames.has(tool)),
    selectedSkillIDs,
    fanoutPruned: selectedExternal.length <= 1,
    reason: selectedExternal.length <= 1
      ? "single_preferred_cmc_tool_after_prune"
      : "multiple_explicit_cmc_tools_retained",
  };
}

export function pruneDefaultCMCToolFanout(selected, prompt, selectedSkillIDs = [], selectedToolNames = []) {
  const selectedExternal = [...selected].filter((tool) => externalCMCToolNames.has(tool));
  if (selectedExternal.length <= 1) return;
  const explicitExternal = selectedToolNames.filter((tool) => externalCMCToolNames.has(tool));
  const keep = new Set(explicitExternal.length ? explicitExternal : [preferredCMCTool(prompt, selectedSkillIDs)]);
  for (const tool of selectedExternal) {
    if (!keep.has(tool)) selected.delete(tool);
  }
}

function orderCloudASRBeforeOfficeDrafts(tools) {
  if (!tools.includes("office.cloud_asr.transcribe")) return tools;
  const priority = (tool) => {
    if (tool === "office.cloud_asr.transcribe") return 0;
    if (tool === "office.meeting_minutes.draft") return 1;
    if (tool.startsWith("office.")) return 2;
    return 3;
  };
  return [...tools].sort((a, b) => priority(a) - priority(b));
}

export function inferTools({ prompt, selectedToolNames = [], attachments = [], selectedSkillIDs = [], selectedExtensionIDs = [], projectToolNames = [] }) {
  const textValue = String(prompt || "").toLowerCase();
  const selected = new Set();
  for (const skillID of selectedSkillIDs) toolsForSkill(skillID).forEach((tool) => selected.add(tool));
  for (const extensionID of selectedExtensionIDs) toolsForExtension(extensionID).forEach((tool) => selected.add(tool));
  for (const legacyTool of selectedToolNames) {
    if (projectToolNames.includes(legacyTool)) selected.add(legacyTool);
  }
  if (attachments.some(isImageAttachment)) selected.add("image.analyze_with_kimi");
  if (shouldRouteCloudASR({ prompt, attachments })) selected.add("office.cloud_asr.transcribe");
  if (/cmc|coinmarketcap|market regime|行情|价格|市场|大盘|price|流动性/.test(textValue)) {
    selected.add("cmc.live_market_refresh");
    selected.add("cmc.daily_market_overview");
    selected.add("cmc.read_market_evidence");
    selected.add("market.read_snapshot");
  }
  if (/macro|宏观|etf|流动性|fear|greed|风险偏好/.test(textValue)) selected.add("cmc.crypto_macro_overview");
  if (/kline|k线|形态|突破|breakout|squeeze|挤压/.test(textValue)) selected.add("cmc.classify_kline_pattern_quality");
  if (/token|ca|合约|币|链上|on-?chain/.test(textValue)) {
    selected.add("token.resolve_entities");
    selected.add("market.read_snapshot");
    selected.add("onchain.read_snapshot");
  }
  if (/wechatcli|wechat cli|导出|export/.test(textValue)) selected.add("wechat_cli.import_export_file");
  if (/微信|wechat|群|消息/.test(textValue)) selected.add("wechat.read_normalized_messages");
  if (/crystal|情报|信号/.test(textValue)) selected.add("crystal.create_or_update");
  if (/handoff|交接|复盘|总结/.test(textValue)) selected.add("handoff.write");
  if (/memory|记忆|偏好/.test(textValue)) selected.add("memory.save");
  if (/meeting|minutes|transcript|会议|纪要|逐字稿/.test(textValue)) selected.add("office.meeting_minutes.draft");
  if (/document|doc|prd|方案|文档|撰写|起草/.test(textValue)) selected.add("office.document.draft");
  if (/revision|revise|comment|review comments|批注|评论|修订|改写|修改/.test(textValue)) selected.add("office.document_revision.draft");
  if (/feishu|lark|飞书|云文档|wiki/.test(textValue)) selected.add("channel.feishu.dry_run");
  if (/\b(equity|stock|stocks|aapl|nvda|msft|earnings|sector|company deep dive|thesis tracker|cross-asset|read-through)\b|美股|股票|财报|行业|公司深度|跨市场/.test(textValue)) {
    selected.add("markets.equity_dispatcher.plan");
    selected.add("markets.equity_research.draft");
    selected.add("markets.provider.drillr_deferred");
  }
  if (/computer use|computer|电脑|点击|操作电脑|控制桌面|mac ui/.test(textValue)) selected.add("computer_use.request");
  if (selected.size === 0) {
    selected.add("wechat.read_normalized_messages");
    selected.add("crystal.create_or_update");
    selected.add("proposal.create");
  }
  pruneDefaultCMCToolFanout(selected, prompt, selectedSkillIDs, selectedToolNames);
  return orderCloudASRBeforeOfficeDrafts([...selected]);
}
