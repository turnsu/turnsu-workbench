const ZH_TITLES = new Map([
  ["Weekly Product Review", "每周产品复盘"],
  ["Meeting Follow-up", "会议跟进"],
  ["Pre-market Research", "盘前研究"],
  ["Customer Feedback Digest", "客户反馈摘要"],
  ["Earnings Brief", "财报速览"],
  ["Incident Review", "事件复盘"],
  ["Meeting action extractor", "会议行动项提取"],
]);

const PRODUCT_TITLES = new Map([
  ["Portable aggregate proof", "Weekly Product Review"],
  ["V1 proof meeting actions", "Meeting Follow-up"],
  ["Member B meeting actions", "Meeting Follow-up"],
]);

const PRODUCT_DESCRIPTIONS = new Map([
  ["Portable aggregate proof", "Summarize weekly product signals, decisions, risks, and next actions."],
  ["V1 proof meeting actions", "Turn meeting notes into reviewed actions with clear owners and dates."],
  ["Member B meeting actions", "Turn meeting notes into reviewed actions with clear owners and dates."],
]);

const ZH_DESCRIPTIONS = new Map([
  ["Weekly Product Review", "汇总本周产品进展、关键风险和决策，形成可供团队复核的周报。"],
  ["Meeting Follow-up", "把会议记录整理为明确的行动项、负责人和截止时间。"],
  ["Pre-market Research", "在开盘前整理关注列表、重要事件、市场背景和关键价位。"],
  ["Customer Feedback Digest", "聚合客户反馈，提炼主题、问题和后续机会。"],
  ["Earnings Brief", "提炼财报和电话会中的关键变化、风险与结论。"],
  ["Incident Review", "整理事件经过、影响、根因和后续行动。"],
  ["Meeting action extractor", "从会议记录中提取明确的后续行动，不会直接修改外部系统。"],
]);

const ZH_NODE_TITLES = new Map([
  ["Goal", "目标"],
  ["Result", "结果"],
  ["Input", "输入"],
  ["Output", "输出"],
  ["Human review", "人工复核"],
  ["Final answer", "最终结果"],
]);

const ZH_NODE_PURPOSES = new Map([
  ["The outcome this Loop should produce.", "说明这个 Loop 最终要完成的结果。"],
  ["The current Loop result.", "汇总当前 Loop 生成的最终结果。"],
]);

const ZH_FIELDS = new Map([
  ["Goal", "目标"],
  ["Transcript", "会议记录"],
  ["Product metrics", "产品指标"],
  ["Key updates", "关键进展"],
  ["Open risks and decisions", "待确认的风险与决策"],
]);

function normalizedProductTitle(sourceTitle) {
  if (/weekly product review/i.test(sourceTitle)) return "Weekly Product Review";
  if (/meeting follow[- ]?up|meeting actions?/i.test(sourceTitle)) return "Meeting Follow-up";
  if (/pre[- ]?market research/i.test(sourceTitle)) return "Pre-market Research";
  return PRODUCT_TITLES.get(sourceTitle) || sourceTitle;
}

const PRODUCT_ACTORS = new Map([
  ["proof-user-a", "Maya Chen"],
  ["proof-user-b", "Noah Patel"],
  ["proof-workspace-owner", "Maya Chen"],
]);

const ZH_ACTORS = new Map([
  ["Maya Chen", "陈茜"],
  ["Noah Patel", "周明"],
]);

export function productTitle(entity, locale) {
  const sourceTitle = String(entity?.title || entity?.name || "");
  const title = normalizedProductTitle(sourceTitle);
  return locale === "zh" ? ZH_TITLES.get(title) || title : title;
}

export function productDescription(entity, locale) {
  const sourceTitle = String(entity?.title || entity?.name || "");
  const title = normalizedProductTitle(sourceTitle);
  const description = PRODUCT_DESCRIPTIONS.get(sourceTitle) || String(entity?.description || entity?.releaseNotes || "");
  return locale === "zh" ? ZH_DESCRIPTIONS.get(title) || description : description;
}

export function productNodeTitle(node, locale) {
  const title = String(node?.title || "");
  return locale === "zh" ? ZH_NODE_TITLES.get(title) || title : title;
}

export function productNodePurpose(node, locale) {
  const purpose = String(node?.subtitle || node?.purpose || "");
  return locale === "zh" ? ZH_NODE_PURPOSES.get(purpose) || purpose : purpose;
}

export function productFieldLabel(label, locale) {
  const value = String(label || "");
  return locale === "zh" ? ZH_FIELDS.get(value) || value : value;
}

export function productActorName(value, locale) {
  const source = String(value || "").trim();
  const name = PRODUCT_ACTORS.get(source) || source;
  return locale === "zh" ? ZH_ACTORS.get(name) || name : name;
}
