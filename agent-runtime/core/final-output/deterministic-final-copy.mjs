export function isMarketSensitiveRun(prompt, tools = []) {
  const textValue = `${prompt || ""} ${tools.join(" ")}`.toLowerCase();
  return /cmc|coinmarketcap|行情|价格|价位|市场|交易|btc|eth|sol|pepe|support|resistance|breakout|breakdown|price|market|k线|支撑|阻力|突破|跌破|站稳|equity|stock|stocks|earnings|sector|valuation|company|thesis|美股|股票|财报|行业|估值|公司/.test(textValue);
}

export function shouldIncludeSafetyBoundary(prompt, tools = [], policies = []) {
  const textValue = `${prompt || ""} ${tools.join(" ")}`.toLowerCase();
  const highImpactPrompt = /(交易|下单|买入|卖出|杠杆|仓位|发送|微信|发布|飞书|外部|删除|清空|覆盖|trade|order|buy|sell|leverage|position|send|publish|delete|overwrite)/i.test(textValue);
  return highImpactPrompt || policies.some((item) => item.status === "blocked" || item.status === "needs_confirmation");
}

export function buildDeterministicAssistantText({
  prompt = "",
  tools = [],
  policies = [],
  attachments = [],
  selectedSkillIDs = [],
  selectedExtensionIDs = [],
  toolObservations = null,
} = {}, deps = {}) {
  const {
    cmcFreshnessGate,
    buildCMCCapabilitySummary,
    displayGateReason,
    displayProvider,
    displayFreshness,
    redact,
    publicSkillHubSummary,
    cmcCapabilitySummaryLine,
  } = requireFinalCopyDeps(deps);
  const safePolicies = Array.isArray(policies) ? policies : [];
  const safeAttachments = Array.isArray(attachments) ? attachments : [];
  const interrupting = safePolicies.filter((item) => item.status === "needs_confirmation");
  const blocked = safePolicies.filter((item) => item.status === "blocked");
  const marketSensitive = isMarketSensitiveRun(prompt, tools);
  const officeRun = tools.some((tool) => tool.startsWith("office.") || tool.startsWith("channel.feishu."));
  const marketsRun = tools.some((tool) => tool.startsWith("markets."));
  const hasCmcTools = tools.some((tool) => tool.startsWith("cmc.") || tool === "market.read_snapshot");
  const marketsSummary = toolObservations?.marketsResearch?.summary || null;
  const marketsGate = toolObservations?.marketsResearch?.gate || null;
  const cloudASRSummary = toolObservations?.cloudASR?.summary || null;
  const gate = toolObservations?.cmcFreshnessGate || cmcFreshnessGate();
  const skillHub = toolObservations?.cmcSkillHub?.observations?.[0] || null;
  const cmcSummary = buildCMCCapabilitySummary({ toolObservations, tools, selectedSkillIDs, selectedExtensionIDs });
  const allowSkillHubDisplay = Boolean(cmcSummary.allowSkillHubResultDisplay);
  const gateReasonText = displayGateReason(gate.reason);
  const providerText = displayProvider(gate.provider);
  const freshnessText = displayFreshness(gate.freshness || "missing");
  const creditExhausted = /CREDIT_EXHAUSTED|credit exhausted|weekly limit/i.test(String(gate.reason || ""));
  const evidenceEmpty = gate.researchEvidenceStatus === "empty" || gate.reason === "degraded_empty_evidence";
  const rawSkillHubSummary = redact(skillHub?.summary || "").trim();
  const skillHubRenderText = Array.isArray(cmcSummary.renderBlocks) && cmcSummary.renderBlocks.length
    ? cmcSummary.renderBlocks.map((block) => block?.body).filter(Boolean).slice(0, 2).join("；")
    : "";
  const skillHubDisplayText = skillHubRenderText
    || cmcSummary.displayableResultText
    || (rawSkillHubSummary ? publicSkillHubSummary(rawSkillHubSummary) : "");
  const allowSkillHubReturnedPrices = Boolean(cmcSummary.allowSkillHubReturnedPrices);
  const marketLine = gate.allowConcretePrices
    ? `市场数据：${providerText} · ${freshnessText} · 可引用快照中的具体数字。`
    : allowSkillHubDisplay
      ? allowSkillHubReturnedPrices
        ? `市场数据：${providerText} · ${freshnessText} · 可展示 CMC Skill Hub 返回内容中的原文数字；未获得 App 可引用价格快照，因此不新增具体价位。`
        : `市场数据：${providerText} · ${freshnessText} · 未获得 App 可引用价格快照，因此不输出具体价格或价位。`
      : gate.allowResearchConclusion
        ? `市场数据：${providerText} · ${freshnessText} · 可引用 Skill Hub 研究证据，但不输出具体价格或关键价位。`
        : evidenceEmpty
          ? `市场数据：${providerText} · ${freshnessText} · CMC Skill Hub transport 成功，但未返回可展示结果或可引用价格快照。`
      : `市场数据：${providerText} · ${freshnessText} · 不输出具体价格或关键价位。`;
  const evidenceLines = [];
  if (skillHub?.readableEvidence?.length) {
    for (const section of skillHub.readableEvidence.slice(0, 4)) {
      for (const bullet of (section.bullets || []).slice(0, 4)) {
        evidenceLines.push(`- ${section.title}：${bullet}`);
      }
    }
  }
  const publicCapabilityLines = [];
  if (tools.some((tool) => tool.startsWith("cmc.") || tool === "market.read_snapshot")) {
    publicCapabilityLines.push(`- ${cmcCapabilitySummaryLine(cmcSummary)}`);
  }
  if (tools.some((tool) => tool.startsWith("wechat.") || tool.startsWith("wechat_cli."))) {
    publicCapabilityLines.push("- WeChat 能力包：只读取本地/导出/只读刷新产物；发送保持阻断。");
  }
  if (tools.some((tool) => tool.startsWith("office."))) {
    publicCapabilityLines.push(cloudASRSummary
      ? `- Office / Meeting 能力包：${cloudASRSummary.userVisibleLabel || "云端转写"} · ${cloudASRSummary.cloudASRStatus || cloudASRSummary.status}；草稿仅写本地结果，不发布、不覆盖云文档。`
      : "- Office / Meeting 能力包：只生成本地草稿结果；不发布、不覆盖云文档。");
  }
  if (tools.some((tool) => tool.startsWith("channel.feishu."))) {
    publicCapabilityLines.push("- Feishu 通道：仅生成 dry-run 预演结果；未执行真实通道调用、未回复、未发布、未通知。");
  }
  if (marketsRun) {
    publicCapabilityLines.push("- Markets Research 能力包：已生成本地研究草稿和证据/价格门禁摘要；股票 live provider 当前未启用。");
  }
  const marketsLine = marketsRun
    ? `Markets 数据：${marketsGate?.promptFrameworkStatus || "usable"} framework · evidence ${marketsGate?.researchEvidenceStatus || "empty_provider_evidence"} · prices ${marketsGate?.priceSnapshotStatus || "provider_deferred"}。`
    : null;
  const conclusionLine = marketsRun
    ? "已生成 Markets Research 本地研究草稿；当前只有方法论框架和用户上下文检查，未接入股票 provider evidence 或独立价格快照，因此不输出买卖动作、仓位或具体交易价位。"
    : officeRun && !marketSensitive
    ? "已通过统一 Agent 运行时生成本地 Office/Meeting 草稿或 Feishu 预演结果；最终答案仍来自权威最终读模型，未执行任何外部发布、回复或覆盖。"
      : gate.allowConcretePrices
      ? "已读取可用市场快照，可以作为研究上下文使用。"
      : allowSkillHubDisplay
        ? allowSkillHubReturnedPrices
          ? "CMC Skill Hub 调用成功，返回了可展示结果；仅保留 Skill Hub 返回文本中的原文数字，本轮不新增关键价位或交易区间。"
          : "CMC Skill Hub 调用成功，返回了可展示结果；本轮不引用具体价格、关键价位或交易区间。"
        : evidenceEmpty
        ? "CMC Skill Hub transport 成功，但本轮未返回可展示 summary、conclusion 或 readable evidence。"
        : gate.allowResearchConclusion && skillHub
        ? "已调用 CMC Skill Hub 能力包，可以基于返回的研究证据输出结论。"
        : `当前没有可用的实时市场快照，只能给出定性判断；${gateReasonText}`;
  const actionLine = marketsRun
    ? "- 可以继续补充公司材料、财报 transcript、SEC filing 或结构化价格源；下一轮再升级为证据驱动的研究结论。"
    : officeRun && !marketSensitive
    ? "- 可以继续复核 draft artifact、补充证据或发起 review branch；真实 Feishu 发布/回复仍需后续 QA、Policy 和 channel readiness。"
    : gate.allowConcretePrices
      ? "- 可以基于这次快照继续做情报卡、观察列表或交接包。"
      : allowSkillHubDisplay
        ? "- 可以围绕 Skill Hub 返回结果继续追问；如需价位、支撑阻力或区间，先补充可引用价格快照。"
      : evidenceEmpty
        ? "- 本轮先不生成情报卡、观察列表或交接包；需要重新选择更匹配的 CMC skill 或刷新价格/研究源。"
        : gate.allowResearchConclusion && skillHub
        ? "- 可以直接基于 Skill Hub skill 返回结果继续做研究筛选、情报卡或交接包。"
        : creditExhausted
          ? "- 等 CMC Skill Marketplace 周额度恢复，或配置单独的 CMC REST key 作为 fallback 后再刷新。"
          : "- 配置 CMC Skill Marketplace MCP 或 CMC REST key 后重新刷新，再生成包含具体行情数据的结论。";
  const dataLines = [];
  if (hasCmcTools && marketSensitive && !gate.allowConcretePrices) {
    dataLines.push(allowSkillHubReturnedPrices
      ? "- 价格快照：未获得 App 可引用价格快照；如正文包含数字，仅来自 CMC Skill Hub 返回文本，App 不新增关键价位、支撑阻力或交易区间。"
      : "- 价格快照：未获得 App 可引用价格快照，因此不输出具体价格或价位。");
  }
  if (hasCmcTools && marketSensitive && cmcSummary.parserEvidenceStatus === "empty" && allowSkillHubDisplay) {
    dataLines.push("- 结构化证据：App 未解析出结构化 evidence sections；这只影响证据分组展示，不阻止 Skill Hub 返回结果展示。");
  }
  if (hasCmcTools && marketSensitive && cmcSummary.skillHubDisplayStatus === "empty" && toolObservations?.cmcSkillHub?.available) {
    dataLines.push("- Skill Hub 返回：transport 成功，但本轮没有可展示 summary、conclusion 或 readable evidence。");
  }
  if (marketsRun) {
    dataLines.push(`- Equity provider：${marketsSummary?.providerDeferredReason || "live provider deferred；本轮未连接结构化股票数据源。"}`);
    dataLines.push("- 价格快照：未获得独立 equity price snapshot，因此不输出支撑阻力、入场出场、止损止盈或交易区间。");
  }
  if (cloudASRSummary) {
    dataLines.push(`- 云端转写：${cloudASRSummary.userVisibleLabel || "阿里云百炼"} · ${cloudASRSummary.cloudASRStatus || cloudASRSummary.status} · segment ${cloudASRSummary.segmentCount || 0}。`);
    if (cloudASRSummary.needsTranscriptReview) {
      dataLines.push("- 转写复核：需要人工检查 transcript 后再作为会议纪要依据。");
    }
  }
  const lines = [
    "## 结论",
    conclusionLine,
    "",
    "## 关键证据",
    hasCmcTools && marketSensitive ? `- ${marketLine}` : null,
    marketsLine ? `- ${marketsLine}` : null,
    skillHub && skillHubDisplayText ? `- Skill Hub 返回：${skillHub.status}${skillHub.confidence ? ` · ${skillHub.confidence}` : ""} · ${skillHubDisplayText}` : null,
    ...(publicCapabilityLines.length ? publicCapabilityLines : ["- 能力包：已通过本地 runtime harness 记录允许的读取、草稿或预演动作。"]),
    safeAttachments.length > 0 ? `- 附件：${safeAttachments.length} 个，已进入本地附件记录。` : "- 附件：无。",
    ...(evidenceLines.length ? ["", "## Skill Hub 返回摘录", ...evidenceLines] : []),
    ...(dataLines.length ? ["", "## 数据说明", ...dataLines] : []),
    "",
    "## 行动建议",
    actionLine,
    ...(shouldIncludeSafetyBoundary(prompt, tools, safePolicies)
      ? [
          "",
          "## 安全边界",
          interrupting.length > 0 ? `- 需要确认：${interrupting.map((item) => item.action).join(", ")}` : "- 高影响动作需要确认后才会执行。",
          blocked.length > 0 ? `- 已阻断：${blocked.map((item) => item.action).join(", ")}` : "- 没有执行交易、发送或外部发布。",
        ]
      : []),
  ];
  return lines.filter((line) => line !== null).join("\n");
}

export function buildDegradedMarketFinalText({ prompt = "", tools = [], toolObservations = null, reason = null } = {}, deps = {}) {
  const {
    cmcFreshnessGate,
    buildCMCCapabilitySummary,
    displayGateReason,
    displayProvider,
    displayFreshness,
  } = requireFinalCopyDeps(deps, [
    "cmcFreshnessGate",
    "buildCMCCapabilitySummary",
    "displayGateReason",
    "displayProvider",
    "displayFreshness",
  ]);
  const gate = toolObservations?.cmcFreshnessGate || cmcFreshnessGate();
  const provider = displayProvider(gate.provider);
  const freshness = displayFreshness(gate.freshness || "missing");
  const creditExhausted = /CREDIT_EXHAUSTED|credit exhausted|weekly limit/i.test(String(gate.reason || reason || ""));
  const called = tools.filter((tool) => tool.startsWith("cmc.") || tool === "market.read_snapshot").length
    ? "已尝试读取市场数据与本地快照"
    : "市场工具未形成可信快照";
  const cmcSummary = buildCMCCapabilitySummary({ toolObservations, tools });
  const allowSkillHubReturnedPrices = Boolean(cmcSummary.allowSkillHubReturnedPrices);
  const skillHubRenderText = Array.isArray(cmcSummary.renderBlocks) && cmcSummary.renderBlocks.length
    ? cmcSummary.renderBlocks.map((block) => block?.body).filter(Boolean).slice(0, 2).join("；")
    : "";
  if (cmcSummary.allowSkillHubResultDisplay) {
    return [
      "## 结论",
      allowSkillHubReturnedPrices
        ? "CMC Skill Hub 调用成功，返回了可展示结果；仅保留 Skill Hub 返回文本中的原文数字，本轮不新增关键价位或交易区间。"
        : "CMC Skill Hub 调用成功，返回了可展示结果；本轮不引用具体价格、关键价位或交易区间。",
      "",
      "## 关键证据",
      `- Skill Hub 返回：${skillHubRenderText || cmcSummary.displayableResultText}`,
      `- 市场数据状态：${provider} · ${freshness}。`,
      "",
      "## 数据说明",
      allowSkillHubReturnedPrices
        ? "- 价格快照：未获得 App 可引用价格快照；如正文包含数字，仅来自 CMC Skill Hub 返回文本，App 不新增关键价位、支撑阻力或交易区间。"
        : "- 价格快照：未获得 App 可引用价格快照，因此不输出具体价格或价位。",
      cmcSummary.parserEvidenceStatus === "empty"
        ? "- 结构化证据：App 未解析出结构化 evidence sections；这只影响证据分组展示，不阻止 Skill Hub 返回结果展示。"
        : "- 结构化证据：已解析出 Skill Hub readable evidence。",
      "",
      "## 行动建议",
      "- 可以围绕 Skill Hub 返回结果继续追问；如需价位、支撑阻力或区间，先补充可引用价格快照。",
    ].join("\n");
  }
  const evidenceEmpty = gate.researchEvidenceStatus === "empty" || gate.reason === "degraded_empty_evidence";
  if (evidenceEmpty) {
    return [
      "## 结论",
      "CMC Skill Hub transport 成功，但本轮未返回可展示 summary、conclusion 或 readable evidence；同时未获得 App 可引用价格快照。",
      "",
      "## 关键证据",
      `- 市场数据状态：${provider} · ${freshness}。`,
      `- 数据缺口：${gate.emptyEvidenceReason || "Skill Hub 返回为空或没有可展示内容"}。`,
      `- 本轮调用：${called}。`,
      "",
      "## 行动建议",
      "- 重新选择更匹配的 CMC macro/regime skill，或补充 CMC quotes/latest、REST 价格源后再生成结论。",
      "- 本轮不生成情报卡、观察列表、交接包或交易相关建议。",
    ].join("\n");
  }
  if (gate.allowResearchConclusion && !gate.allowConcretePrices) {
    return [
      "## 结论",
      "已读取可用 CMC Skill Hub 研究证据，但本轮没有通过具体价格门禁；可以输出候选、证据和风险边界，不引用价格、关键价位、支撑阻力或交易区间。",
      "",
      "## 关键证据",
      `- 市场数据状态：${provider} · ${freshness}。`,
      "- 数据边界：Skill Hub 返回的是研究证据包，不是可引用价格快照。",
      `- 本轮调用：${called}。`,
      "",
      "## 行动建议",
      "- 基于候选与证据继续做研究筛选；如需关键价位，先补充 CMC quotes/latest 或 REST 价格源。",
      "- 不把任何数字当作实时价格或交易条件。",
    ].join("\n");
  }
  return [
    "## 结论",
    "当前市场数据没有通过实时数据门禁，只能给出定性判断；本轮不引用具体价格、关键价位、支撑阻力或交易区间。",
    "",
    "## 关键证据",
    `- 市场数据状态：${provider} · ${freshness}。`,
    `- 数据缺口：${displayGateReason(gate.reason || reason)}。`,
    `- 本轮调用：${called}。`,
    "",
    "## 行动建议",
    creditExhausted
      ? "- 等 CMC Skill Marketplace 周额度恢复，或配置单独的 CMC REST key 作为 fallback 后再刷新。"
      : "- 先完成 CMC Skill Marketplace MCP 或 CMC REST 的 fresh refresh，再重新生成含具体行情的研究结论。",
    "- 在刷新成功前，可以保留方向性观察，但不要把任何数字当作实时行情或交易条件。",
  ].join("\n");
}

function requireFinalCopyDeps(deps, names = [
  "cmcFreshnessGate",
  "buildCMCCapabilitySummary",
  "displayGateReason",
  "displayProvider",
  "displayFreshness",
  "redact",
  "publicSkillHubSummary",
  "cmcCapabilitySummaryLine",
]) {
  for (const name of names) {
    if (typeof deps[name] !== "function") throw new Error(`core_final_copy_missing_dependency:${name}`);
  }
  return deps;
}
