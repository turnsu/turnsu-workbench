import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

import { memoryContractSummary } from "../memory/memory-contract.mjs";
import { subagentContractSummary } from "../subagents/subagent-contract.mjs";

export function classifyCapabilityLoop({ prompt, tools = [], selectedCapabilityIDs = [], selectedSkillIDs = [], selectedExtensionIDs = [] }) {
  const text = String(prompt || "").toLowerCase();
  const ids = [
    ...safeArray(selectedCapabilityIDs),
    ...safeArray(selectedSkillIDs),
    ...safeArray(selectedExtensionIDs),
  ].map((item) => String(item || ""));
  const hasCrypto = tools.some((tool) => /^cmc\.|^market\.|^onchain\.|^token\.|^wechat\./.test(String(tool)))
    || ids.some((id) => /cmc|crypto|token|onchain|wechat/i.test(id))
    || /btc|eth|sol|crypto|token|coinmarketcap|cmc|行情|链上|币|市场/.test(text);
  const hasOffice = tools.some((tool) => /^office\.|^channel\.feishu/.test(String(tool)))
    || ids.some((id) => /meeting|document|office|feishu|lark/i.test(id))
    || /meeting|minutes|document|doc|prd|feishu|lark|会议|纪要|文档|飞书/.test(text);
  const hasMarkets = tools.some((tool) => /^markets\./.test(String(tool)))
    || ids.some((id) => /equity|sector|earnings|thesis|macro-cross|markets|stock/i.test(id))
    || /\b(equity|stock|stocks|earnings|sector|company deep dive|thesis tracker|cross-asset|read-through)\b|美股|股票|财报|行业|公司深度|跨市场/.test(text);
  const active = [hasCrypto, hasOffice, hasMarkets].filter(Boolean).length;
  if (active > 1) return "multi_domain_loop";
  if (hasMarkets) return "markets_research_loop";
  if (hasOffice) return "office_work_loop";
  if (hasCrypto) return "crypto_market_loop";
  return "general_agent_loop";
}

export function capabilityLoopTitle(loopType) {
  switch (loopType) {
    case "crypto_market_loop": return "Crypto market loop";
    case "office_work_loop": return "Office writing loop";
    case "markets_research_loop": return "Markets research loop";
    case "multi_domain_loop": return "Multi-domain agent loop";
    default: return "Agent work loop";
  }
}

export function followUpSuggestionsForLoop(loopType) {
  if (loopType === "crypto_market_loop") {
    return [
      { suggestionID: "crypto-market-loop", title: "继续扫市场", prompt: "继续运行一轮 crypto 市场信息获取和分析，只输出研究候选、证据、反证和观察条件。" },
      { suggestionID: "crypto-thesis-review", title: "复核 thesis", prompt: "复核当前 crypto thesis：哪些证据支持、哪些证据反驳、下一步需要哪些 CMC 或群消息信息？" },
      { suggestionID: "crypto-human-review", title: "人工复核", prompt: "把当前结果整理成人工复核清单，标出需要确认的数据、价格门禁和风险边界。" },
    ];
  }
  if (loopType === "office_work_loop") {
    return [
      { suggestionID: "office-minutes", title: "整理会议纪要", prompt: "把当前材料整理成会议纪要、行动项和需要补充的问题。" },
      { suggestionID: "office-document", title: "起草文档", prompt: "基于当前材料起草一版结构化文档，保留待确认项，不执行真实发布。" },
      { suggestionID: "office-review", title: "复核交付", prompt: "复核当前草稿的事实、措辞、交付风险和飞书预览边界。" },
    ];
  }
  if (loopType === "markets_research_loop") {
    return [
      { suggestionID: "markets-evidence-gap", title: "补证据缺口", prompt: "继续追问当前 Markets 研究草稿：哪些结论缺少 provider evidence、SEC/财报/价格快照或反证？" },
      { suggestionID: "markets-cross-asset", title: "跨市场联动", prompt: "把当前股票/行业观点和 crypto、macro、risk sentiment 做一轮 cross-asset read-through，只输出研究假设和待验证项。" },
      { suggestionID: "markets-review-task", title: "生成复核任务", prompt: "把当前 Markets 结果整理成下一轮人工复核任务：证据、反证、催化剂、数据源和 stop rules。" },
    ];
  }
  if (loopType === "multi_domain_loop") {
    return [
      { suggestionID: "multi-split-work", title: "拆分成两条任务", prompt: "把当前任务拆成 crypto 分析和 office 草稿两条后续任务，并列出各自需要的证据。" },
      { suggestionID: "multi-review", title: "人工复核重点", prompt: "标出当前结果最需要人工复核的 market evidence、文档表达和发布风险。" },
      { suggestionID: "multi-next-loop", title: "继续组合分析", prompt: "继续沿当前目标推进一轮组合分析，但不要执行发布、发送或交易动作。" },
    ];
  }
  return [
    { suggestionID: "general-follow-up", title: "继续追问", prompt: "基于当前最终答案继续追问，要求补充证据和下一步建议。" },
    { suggestionID: "general-review", title: "要求复核", prompt: "复核当前答案是否有证据缺口、policy 风险或输出门禁改写。" },
    { suggestionID: "general-save-task", title: "保存后续任务", prompt: "把当前结果整理成一个可继续执行的后续任务。" },
  ];
}

export function publicCapabilityPackagesForLoop({ loopType, tools = [], selectedCapabilityIDs = [], selectedSkillIDs = [], selectedExtensionIDs = [], cmcCapabilitySummary = null }) {
  const packages = [];
  const add = (item) => {
    if (!packages.some((existing) => existing.packageID === item.packageID)) packages.push(item);
  };
  const capabilityIDs = safeArray(selectedCapabilityIDs);
  const hasCMC = tools.some((tool) => String(tool).startsWith("cmc.") || tool === "market.read_snapshot")
    || capabilityIDs.includes("cmc-skill-hub")
    || selectedExtensionIDs.includes("cmc-skill-hub")
    || loopType === "crypto_market_loop"
    || loopType === "multi_domain_loop";
  if (hasCMC) {
    add({
      packageID: "cmc-skill-hub",
      displayName: "CMC Skill Hub 能力包",
      domain: "Crypto",
      status: cmcCapabilitySummary?.skillHubDisplayStatus || cmcCapabilitySummary?.researchEvidenceStatus || "ready",
      summary: cmcCapabilitySummary?.summary ? redactedPreview(cmcCapabilitySummary.summary, 220) : "用于市场数据获取、研究摘要和交易机会复核。",
    });
  }
  const hasWechatReader = capabilityIDs.includes("wechat-cli-export-bridge")
    || selectedExtensionIDs.includes("wechat-cli-export-bridge")
    || tools.some((tool) => String(tool).startsWith("wechat."));
  if (hasWechatReader) {
    add({
      packageID: "wechat-message-reader",
      displayName: "微信群消息读取",
      domain: "Crypto",
      status: "background_source",
      summary: "只作为后台资料连接器，为当前任务提供群消息 evidence。",
    });
  }
  const hasOffice = loopType === "office_work_loop"
    || loopType === "multi_domain_loop"
    || capabilityIDs.includes("office-meeting-agent")
    || tools.some((tool) => String(tool).startsWith("office.") || String(tool).startsWith("channel.feishu"))
    || selectedSkillIDs.some((id) => /meeting|document|office|feishu/i.test(String(id)));
  if (hasOffice) {
    add({
      packageID: "office-meeting-agent",
      displayName: "Office / Meeting 能力包",
      domain: "Office",
      status: "draft_ready",
      summary: "用于会议纪要、文档草稿、文档改写和交付预览。",
    });
  }
  const hasMarkets = loopType === "markets_research_loop"
    || capabilityIDs.includes("markets-research")
    || selectedExtensionIDs.includes("markets-research")
    || tools.some((tool) => String(tool).startsWith("markets."))
    || selectedSkillIDs.some((id) => /equity|sector|earnings|thesis|macro-cross|markets/i.test(String(id)));
  if (hasMarkets) {
    add({
      packageID: "markets-research",
      displayName: "Markets Research 能力包",
      domain: "Markets",
      status: "draft_ready",
      summary: "用于股票、行业、财报、thesis tracker 和跨资产 read-through；live equity provider 当前保持 deferred。",
    });
  }
  if (tools.includes("channel.feishu.dry_run")) {
    add({
      packageID: "feishu-preview-channel",
      displayName: "飞书预览通道",
      domain: "Office",
      status: "dry_run_only",
      summary: "仅生成预览和确认材料；不执行真实发布或回复。",
    });
  }
  if (selectedSkillIDs.includes("image-analysis") || tools.includes("image.analyze_with_kimi")) {
    add({
      packageID: "local-image-analysis",
      displayName: "本地图片理解",
      domain: "Local",
      status: "ready",
      summary: "用于读取用户拖入的图片附件并生成任务上下文。",
    });
  }
  return packages;
}

export function buildCapabilityLoopReadModel({
  runID,
  taskID,
  sessionID,
  prompt,
  tools,
  selectedCapabilityIDs = [],
  selectedSkillIDs = [],
  selectedExtensionIDs = [],
  finalReadModel,
  cmcCapabilitySummary,
  harnessFinal,
}) {
  const loopType = classifyCapabilityLoop({ prompt, tools, selectedCapabilityIDs, selectedSkillIDs, selectedExtensionIDs });
  const reviewModel = harnessFinal?.reviewModel || null;
  const packages = publicCapabilityPackagesForLoop({ loopType, tools, selectedCapabilityIDs, selectedSkillIDs, selectedExtensionIDs, cmcCapabilitySummary });
  return {
    schemaVersion: "agent-capability-loop-read-model-v1",
    runID,
    taskID,
    sessionID,
    loopType,
    status: finalReadModel?.status || "completed",
    title: capabilityLoopTitle(loopType),
    userGoal: redactedPreview(prompt, 500),
    capabilityPackages: packages,
    finalReadModelPath: finalReadModel?.artifactPath || loopArtifactPath(runID, "agent-final-read-model.json"),
    review: {
      status: reviewModel?.status || "unknown",
      ready: Boolean(reviewModel),
      actionLabel: "Review",
      reviewReadModelPath: reviewModel?.artifactPath || loopArtifactPath(runID, "review-read-model.json"),
      mergeRecommendation: reviewModel?.mergeRecommendation || "unknown",
    },
    followUpSuggestions: followUpSuggestionsForLoop(loopType),
    cmcCapabilitySummaryPath: cmcCapabilitySummary ? loopArtifactPath(runID, "cmc-capability-summary.json") : null,
    memoryReadModelPath: loopArtifactPath(runID, "memory-read-model.json"),
    subagentCoordinationReadModelPath: loopArtifactPath(runID, "subagent-coordination-read-model.json"),
    generatedAt: new Date().toISOString(),
    artifactPath: loopArtifactPath(runID, "capability-loop-read-model.json"),
  };
}

export function buildMemoryReadModel({ runID, taskID, sessionID, prompt, finalReadModel, capabilityLoop, projectRoot, agentRuntimeRoot }) {
  const hermes = detectHermesMemoryAdapter({ projectRoot, agentRuntimeRoot });
  const memoryType = capabilityLoop.loopType === "office_work_loop"
    ? "office_drafting_context"
    : capabilityLoop.loopType === "crypto_market_loop"
      ? "crypto_research_context"
      : "agent_task_context";
  const writeStatus = "not_written";
  const writeReason = hermes.status === "adapter_unavailable"
    ? "hermes_adapter_unavailable"
    : "memory_review_required_before_persistence";
  return {
    schemaVersion: "agent-memory-read-model-v1",
    runID,
    taskID,
    sessionID,
    status: hermes.status,
    adapter: "Hermes agent memory",
    adapterPath: hermes.adapterPath,
    reason: hermes.reason,
    coreContract: memoryContractSummary({
      runID,
      status: hermes.status,
      writeStatus,
      reason: writeReason,
    }),
    writePolicy: {
      status: writeStatus,
      reason: writeReason,
      requiresHumanReview: true,
    },
    candidateMemories: [
      {
        memoryID: "candidate-user-goal",
        type: memoryType,
        title: "User goal",
        preview: redactedPreview(prompt, 280),
        sourceArtifactPath: loopArtifactPath(runID, "run-manifest.json"),
        reviewRequired: true,
      },
      {
        memoryID: "candidate-final-summary",
        type: "final_result_summary",
        title: "Final answer summary",
        preview: redactedPreview(finalReadModel?.finalText || "", 360),
        sourceArtifactPath: finalReadModel?.artifactPath || loopArtifactPath(runID, "agent-final-read-model.json"),
        reviewRequired: true,
      },
    ].filter((item) => item.preview),
    redaction: {
      rawProviderPayloadStored: false,
      secretsStored: false,
      privateTranscriptStored: false,
    },
    generatedAt: new Date().toISOString(),
    artifactPath: loopArtifactPath(runID, "memory-read-model.json"),
  };
}

export function buildSubagentCoordinationReadModel({ runID, taskID, sessionID, capabilityLoop, redact = defaultRedact }) {
  let tmuxStatus = "unavailable";
  let tmuxVersion = null;
  let reason = "tmux_not_detected";
  try {
    const result = spawnSync("tmux", ["-V"], { encoding: "utf8", timeout: 1000 });
    if (result.status === 0) {
      tmuxStatus = "available_read_only";
      tmuxVersion = String(result.stdout || "").trim() || null;
      reason = "tmux_detected_no_sessions_created";
    } else if (result.error?.message) {
      reason = result.error.message;
    } else if (result.stderr) {
      reason = redactedPreview(result.stderr, 160);
    }
  } catch (error) {
    reason = redact(error?.message || error);
  }
  return {
    schemaVersion: "agent-subagent-coordination-read-model-v1",
    runID,
    taskID,
    sessionID,
    status: tmuxStatus,
    coordinator: "tmux",
    tmuxVersion,
    namespace: "looloomi-agent",
    mode: "read_only_dry_run",
    reason,
    coreContract: subagentContractSummary({
      runID,
      status: "read_only_dry_run",
      reason,
    }),
    plannedRoles: capabilityLoop.loopType === "crypto_market_loop"
      ? ["planner", "market_researcher", "reviewer"]
      : capabilityLoop.loopType === "office_work_loop"
        ? ["planner", "document_drafter", "reviewer"]
        : ["planner", "worker", "reviewer"],
    allowedOperations: ["detect_tmux_version", "plan_namespaced_sessions"],
    blockedOperations: ["kill-session", "detach-client", "send-keys", "capture-pane_unrelated", "attach_unscoped_session"],
    sessions: [],
    generatedAt: new Date().toISOString(),
    artifactPath: loopArtifactPath(runID, "subagent-coordination-read-model.json"),
  };
}

export function writeCapabilityLoopReadModels(runDir, {
  runID,
  taskID,
  sessionID,
  prompt,
  tools,
  selectedCapabilityIDs = [],
  selectedSkillIDs = [],
  selectedExtensionIDs = [],
  finalReadModel,
  cmcCapabilitySummary,
  harnessFinal,
  projectRoot,
  agentRuntimeRoot,
  writeJSON,
  appendEvent,
  appendInvocationLedger,
  mainBranchID = (id) => `branch-main-${id}`,
  redact = defaultRedact,
}) {
  if (typeof writeJSON !== "function") throw new Error("core_capability_loop_missing_write_json");
  const capabilityLoop = buildCapabilityLoopReadModel({
    runID,
    taskID,
    sessionID,
    prompt,
    tools,
    selectedCapabilityIDs,
    selectedSkillIDs,
    selectedExtensionIDs,
    finalReadModel,
    cmcCapabilitySummary,
    harnessFinal,
  });
  const memoryReadModel = buildMemoryReadModel({
    runID,
    taskID,
    sessionID,
    prompt,
    finalReadModel,
    capabilityLoop,
    projectRoot,
    agentRuntimeRoot,
  });
  const subagentCoordination = buildSubagentCoordinationReadModel({
    runID,
    taskID,
    sessionID,
    capabilityLoop,
    redact,
  });
  writeJSON(join(runDir, "capability-loop-read-model.json"), capabilityLoop);
  writeJSON(join(runDir, "memory-read-model.json"), memoryReadModel);
  writeJSON(join(runDir, "subagent-coordination-read-model.json"), subagentCoordination);
  appendEvent?.(runDir, {
    type: "capability.loop_read_model.created",
    runID,
    taskID,
    stage: "capability_loop",
    status: capabilityLoop.loopType,
    artifactKind: "capability_loop_read_model",
    artifactPath: capabilityLoop.artifactPath,
  });
  appendEvent?.(runDir, {
    type: "memory.read_model.created",
    runID,
    taskID,
    stage: "memory",
    status: memoryReadModel.status,
    artifactKind: "memory_read_model",
    artifactPath: memoryReadModel.artifactPath,
  });
  appendEvent?.(runDir, {
    type: "subagent.coordination_read_model.created",
    runID,
    taskID,
    stage: "coordination",
    status: subagentCoordination.status,
    artifactKind: "subagent_coordination_read_model",
    artifactPath: subagentCoordination.artifactPath,
  });
  appendInvocationLedger?.(runDir, {
    type: "capability_loop_recorded",
    runID,
    taskID,
    sessionID,
    branchID: mainBranchID(runID),
    stage: "capability_loop",
    status: capabilityLoop.loopType,
    artifactPath: capabilityLoop.artifactPath,
  });
  appendInvocationLedger?.(runDir, {
    type: "memory_adapter_recorded",
    runID,
    taskID,
    sessionID,
    branchID: mainBranchID(runID),
    stage: "memory",
    status: memoryReadModel.status,
    artifactPath: memoryReadModel.artifactPath,
  });
  appendInvocationLedger?.(runDir, {
    type: "subagent_coordination_recorded",
    runID,
    taskID,
    sessionID,
    branchID: mainBranchID(runID),
    stage: "coordination",
    status: subagentCoordination.status,
    artifactPath: subagentCoordination.artifactPath,
  });
  return { capabilityLoop, memoryReadModel, subagentCoordination };
}

function detectHermesMemoryAdapter({ projectRoot, agentRuntimeRoot }) {
  const candidates = [
    join(agentRuntimeRoot, "extensions", "hermes-agent"),
    join(agentRuntimeRoot, "lib", "hermes-memory.mjs"),
    join(projectRoot, "Hermes"),
    join(projectRoot, "hermes"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found
    ? { status: "adapter_present_dry_run", adapterPath: relative(projectRoot, found), reason: "local_hermes_adapter_candidate_detected_but_not_writing_in_this_pass" }
    : { status: "adapter_unavailable", adapterPath: null, reason: "hermes_adapter_not_present_in_current_repository" };
}

function loopArtifactPath(runID, name) {
  return `runtime/agent/runs/${runID}/${name}`;
}

function redactedPreview(value, maxChars = 500) {
  return defaultRedact(value).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function defaultRedact(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/Authorization\s*[:=]\s*[^\s,}]+/gi, "Authorization=[redacted]");
}
