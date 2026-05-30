import { compactText, controlID, nowISO, safeArray } from "./schema-validator.mjs";

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function createTaskIntent(input) {
  const prompt = String(input.prompt || "");
  const text = prompt.toLowerCase();
  const attachments = safeArray(input.attachments);
  const contextRefs = safeArray(input.contextRefs);
  let taskType = "daily_intelligence";

  if (attachments.length > 0 || includesAny(text, [/image|图片|截图|视觉|vision/])) {
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
      "secrets and raw provider request bodies are not persisted",
    ],
    createdAt: nowISO(),
  };
}

