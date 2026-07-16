export const HARD_GATE_CLASSES = [
  "PolicyDecision",
  "ContractDecision",
  "ClaimProvenanceDecision",
  "OutputSafetyDecision",
  "MutationCommitDecision",
];

export const BUSINESS_METADATA_FIELDS = [
  "freshness",
  "confidence",
  "risk",
  "sourceTrust",
  "parserWarning",
  "degraded",
  "usable",
  "emptyReason",
];

export function createGateEngine(deps) {
  return new GateEngine(deps);
}

export class GateEngine {
  constructor(deps = {}) {
    this.deps = deps;
  }

  guardFinalOutput(args) {
    return evaluateOutputSafetyDecision(args, this.deps);
  }

  productMutationPolicyForRun(toolObservations) {
    return deriveMutationCommitDecision(toolObservations, this.deps);
  }

  metadataSummary(toolObservations) {
    const gate = toolObservations?.cmcFreshnessGate || {};
    return {
      schemaVersion: "core-gate-metadata-summary-v1",
      freshness: gate.freshness || null,
      confidence: gate.confidence || null,
      parserEvidenceStatus: gate.parserEvidenceStatus || gate.researchEvidenceStatus || null,
      sourceTrust: toolObservations?.sourceTrust || null,
      degraded: gate.status === "degraded",
      emptyReason: gate.emptyEvidenceReason || gate.reason || null,
    };
  }
}

export function evaluateOutputSafetyDecision({ text, prompt, tools, toolObservations }, deps = {}) {
  const {
    now,
    stripProcessPreamble,
    internalSurfaceViolations,
    stripInternalSurface,
    isMarketSensitiveRun,
    skillHubReturnedTextCorpus,
    concreteMarketViolations,
    stripConcreteMarketViolationLines,
    degradedMarketFinalText,
  } = requireDeps(deps, [
    "now",
    "stripProcessPreamble",
    "internalSurfaceViolations",
    "stripInternalSurface",
    "isMarketSensitiveRun",
    "skillHubReturnedTextCorpus",
    "concreteMarketViolations",
    "stripConcreteMarketViolationLines",
    "degradedMarketFinalText",
  ]);
  const gate = toolObservations?.cmcFreshnessGate || { status: "blocked", allowConcretePrices: false, reason: "tool_observations_missing" };
  const preambleStripped = stripProcessPreamble(text);
  const rawViolations = internalSurfaceViolations(preambleStripped);
  const cleaned = stripInternalSurface(preambleStripped);
  const marketSensitive = isMarketSensitiveRun(prompt, tools);
  const skillHubReturnedCorpus = skillHubReturnedTextCorpus(toolObservations?.cmcSkillHub?.observations || []);
  const violations = marketSensitive && !gate.allowConcretePrices
    ? concreteMarketViolations(cleaned, { allowedCorpus: skillHubReturnedCorpus })
    : [];
  if (rawViolations.length || (marketSensitive && (!toolObservations || !gate.allowConcretePrices) && violations.length)) {
    const marketCleaned = violations.length
      ? stripConcreteMarketViolationLines(cleaned, { allowedCorpus: skillHubReturnedCorpus })
      : cleaned;
    return {
      text: marketSensitive && (!toolObservations || !gate.allowConcretePrices)
        ? (marketCleaned || degradedMarketFinalText({ prompt, tools, toolObservations, reason: violations[0] || rawViolations[0] }))
        : (marketCleaned || safeInternalSurfaceBlockedText()),
      outputGuard: {
        status: "rewritten",
        decisionClass: "OutputSafetyDecision",
        allowConcretePrices: Boolean(gate.allowConcretePrices),
        allowSkillHubReturnedPrices: Boolean(gate.allowSkillHubReturnedPrices),
        reason: rawViolations.length ? "raw_internal_fields_removed" : (!toolObservations ? "tool_observations_missing" : "concrete_market_values_without_fresh_gate"),
        violations: [...new Set([...rawViolations, ...violations])].slice(0, 8),
        checkedAt: now(),
      },
    };
  }
  return {
    text: cleaned || degradedMarketFinalText({ prompt, tools, toolObservations, reason: "empty_final_output" }),
    outputGuard: {
      status: "passed",
      decisionClass: "OutputSafetyDecision",
      allowConcretePrices: Boolean(gate.allowConcretePrices),
      allowSkillHubReturnedPrices: Boolean(gate.allowSkillHubReturnedPrices),
      reason: gate.reason || "ok",
      violations: [],
      checkedAt: now(),
    },
  };
}

function safeInternalSurfaceBlockedText() {
  return [
    "输出包含内部运行时字段，已被安全拦截。",
    "",
    "请重新生成不含内部工具、provider、artifact 路径或 schema 字段的公开摘要。",
  ].join("\n");
}

export function deriveMutationCommitDecision(toolObservations, deps = {}) {
  const now = deps.now || (() => new Date().toISOString());
  const gate = toolObservations?.cmcFreshnessGate || {};
  const marketsGate = toolObservations?.marketsResearch?.gate || null;
  const outputGuard = toolObservations?.outputGuard || {};
  if (marketsGate && marketsGate.productMutationPolicyRecommendation === "discarded") {
    return {
      status: "discarded",
      decisionClass: "MutationCommitDecision",
      reason: "markets_research_provider_evidence_or_price_snapshot_empty",
      decidedAt: now(),
    };
  }
  const evidenceInsufficient = gate.reason === "degraded_empty_evidence"
    || (gate.researchEvidenceStatus === "empty" && gate.priceSnapshotStatus !== "usable");
  const marketRewrite = outputGuard.status === "rewritten"
    && outputGuard.reason === "concrete_market_values_without_fresh_gate";
  if (evidenceInsufficient) {
    return {
      status: "discarded",
      decisionClass: "MutationCommitDecision",
      reason: gate.allowSkillHubResultDisplay
        ? "price_snapshot_empty_or_parser_evidence_empty"
        : "cmc_research_evidence_empty",
      decidedAt: now(),
    };
  }
  if (marketRewrite) {
    return {
      status: "discarded",
      decisionClass: "MutationCommitDecision",
      reason: "output_guard_rewritten_market_evidence_insufficient",
      decidedAt: now(),
    };
  }
  return {
    status: "importable",
    decisionClass: "MutationCommitDecision",
    reason: "cmc_evidence_or_price_snapshot_usable",
    decidedAt: now(),
  };
}

function requireDeps(deps, names) {
  for (const name of names) {
    if (typeof deps[name] !== "function") throw new Error(`core_gate_missing_dependency:${name}`);
  }
  return deps;
}
