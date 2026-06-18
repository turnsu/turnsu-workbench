import { compactText, controlID, nowISO, safeArray } from "./schema-validator.mjs";

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function hasAudioVideoAttachment(attachments = []) {
  return attachments.some((attachment) => {
    const mime = String(attachment?.mimeType || "").toLowerCase();
    const name = String(attachment?.fileName || attachment?.originalPath || attachment?.artifactPath || "").toLowerCase();
    return mime.startsWith("audio/")
      || mime.startsWith("video/")
      || /\.(?:aac|aiff|amr|avi|flac|flv|m4a|m4v|mkv|mov|mp3|mp4|mpeg|mpg|ogg|opus|pcm|wav|webm|wma|wmv)$/.test(name);
  });
}

export function createTaskIntent(input) {
  const prompt = String(input.prompt || "");
  const text = prompt.toLowerCase();
  const attachments = safeArray(input.attachments);
  const contextRefs = safeArray(input.contextRefs);
  let taskType = "daily_intelligence";

  if (hasAudioVideoAttachment(attachments) && includesAny(text, [/meeting|minutes|transcript|asr|audio|video|会议|纪要|逐字稿|转写|录音|音频|视频|总结/])) {
    taskType = "office_meeting_minutes";
  } else if (includesAny(text, [/revision|revise|comment|review comments|批注|评论|修订|改写|修改/])) {
    taskType = "office_document_revision";
  } else if (includesAny(text, [/meeting|minutes|transcript|会议|纪要|逐字稿/])) {
    taskType = "office_meeting_minutes";
  } else if (includesAny(text, [/document|doc|prd|方案|文档|撰写|起草/])) {
    taskType = "office_document_generation";
  } else if (includesAny(text, [/feishu|lark|飞书|云文档|wiki/])) {
    taskType = "channel_feishu_dry_run";
  } else if (includesAny(text, [/\b(equity|stock|stocks|aapl|nvda|msft|earnings|sector|company deep dive|thesis tracker|cross-asset|read-through)\b|美股|股票|财报|行业|公司深度|跨市场/])) {
    taskType = "markets_equity_research";
  } else if (attachments.length > 0 || includesAny(text, [/image|图片|截图|视觉|vision/])) {
    taskType = "image_context_analysis";
  } else if (includesAny(text, [/长期|持续|监控|watch|background|提醒|定期/])) {
    taskType = "long_running_watch";
  } else if (includesAny(text, [/handoff|交接|复盘|总结|brief|memo/])) {
    taskType = "handoff_synthesis";
  } else if (includesAny(text, [/token|ticker|ca|合约|链上|on-?chain|币/])) {
    taskType = "token_onchain_review";
  } else if (includesAny(text, [/搜索|查找|找一下|search/])) {
    taskType = "retrieval_review";
  }

  return {
    schemaVersion: "agent-task-intent-v1",
    id: controlID("intent"),
    runID: input.runID,
    taskID: input.taskID,
    sessionID: input.sessionID,
    taskType,
    goal: compactText(prompt, 1200),
    responseMode: "agent_workspace",
    selectedSkills: safeArray(input.selectedSkillIDs),
    selectedExtensions: safeArray(input.selectedExtensionIDs),
    sourcePreparation: {
      promptProvided: prompt.trim().length > 0,
      attachmentCount: attachments.length,
      contextRefCount: contextRefs.length,
      publicSurfaceOnly: true,
    },
    constraints: [
      "frontend exposes skill/extension only",
      "live WeChat and live wechat-cli remain blocked",
      "trade, send message, and external publish remain blocked",
      "Office/Meeting/Feishu capabilities must enter through the unified runtime harness and stay draft/dry-run unless QA, Policy, and channel readiness pass",
      "secrets and raw provider request bodies are not persisted",
    ],
    createdAt: nowISO(),
  };
}
