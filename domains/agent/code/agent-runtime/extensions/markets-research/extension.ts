import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimePaths } from "../../lib/runtime-paths.mjs";

const { runsRoot } = runtimePaths;

const TOOL_PARAMS = Type.Object({
  runID: Type.String(),
  sessionID: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  idempotencyKey: Type.Optional(Type.String()),
  contextRefs: Type.Optional(Type.Array(Type.Any())),
  contextManifestRef: Type.Optional(Type.String()),
  contextBundleRef: Type.Optional(Type.String()),
});

const INVEST_FRAMEWORKS = [
  "stock-eval",
  "fundamental-analysis",
  "dcf-valuation",
  "stock-valuation",
  "financial-report-analyst",
  "earnings-call-analysis",
  "competitor-analysis",
  "sector-analysis",
  "research-bundle",
  "result-validator",
];

const DISPATCHER_LANES = {
  discover: ["idea-generation", "sector-overview", "themes", "supply-chain", "alt-plays"],
  analyze: ["initiating-coverage", "earnings-preview", "earnings-analysis", "financial-forensics", "business-model"],
  monitor: ["thesis-tracker", "catalyst-calendar", "morning-note", "watchlist", "event-radar"],
  macro: ["yield-curve", "trade-flows", "labor-market", "macro-read-through"],
};

function now() {
  return new Date().toISOString();
}

function safeRunID(value: string) {
  return String(value || "run").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function runArtifact(runID: string, name: string) {
  return join(runsRoot, safeRunID(runID), name);
}

function writeJSON(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function redactedPreview(value: unknown, maxChars = 420) {
  const text = String(value || "")
    .replace(/(api[_-]?key|token|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function contextSummary(params: any) {
  return {
    contextManifestRef: params.contextManifestRef || `runtime/agent/runs/${params.runID}/context-manifest.json`,
    contextBundleRef: params.contextBundleRef || `runtime/agent/runs/${params.runID}/context-bundle.json`,
    contextRefCount: Array.isArray(params.contextRefs) ? params.contextRefs.length : 0,
    rawProviderRequestIncluded: false,
    secretsIncluded: false,
  };
}

function classifyLane(prompt: string) {
  const text = prompt.toLowerCase();
  if (/macro|rates?|yield|curve|labor|employment|inflation|cross.?asset|read.?through|宏观|利率|通胀|跨资产/.test(text)) return "macro";
  if (/monitor|watch|tracker|thesis|catalyst|event|跟踪|观察|催化剂|反证/.test(text)) return "monitor";
  if (/discover|screen|scan|sector|theme|supply|idea|寻找|扫描|行业|主题|供应链|候选/.test(text)) return "discover";
  return "analyze";
}

function selectedFrameworks(prompt: string, lane: keyof typeof DISPATCHER_LANES) {
  const text = prompt.toLowerCase();
  const frameworks = new Set<string>();
  if (/earnings|财报|业绩|guidance|call/.test(text)) frameworks.add("earnings-call-analysis");
  if (/dcf|valuation|估值|wacc|multiple|pe\b|ev\/ebitda/.test(text)) frameworks.add("dcf-valuation");
  if (/forensic|fraud|accounting|quality|red flag|造假|会计|质量/.test(text)) frameworks.add("financial-report-analyst");
  if (/competitor|moat|竞争|护城河/.test(text)) frameworks.add("competitor-analysis");
  if (/sector|行业|主题/.test(text)) frameworks.add("sector-analysis");
  if (/thesis|观点|假设|反证/.test(text)) frameworks.add("research-bundle");
  for (const item of DISPATCHER_LANES[lane]) frameworks.add(item);
  return [...frameworks].slice(0, 8);
}

function buildPayloads(params: any) {
  const prompt = String(params.prompt || "");
  const lane = classifyLane(prompt) as keyof typeof DISPATCHER_LANES;
  const frameworks = selectedFrameworks(prompt, lane);
  const context = contextSummary(params);
  const hasUserContext = context.contextRefCount > 0;
  const generatedAt = now();
  const sourceReferences = [
    {
      name: "InvestSkill",
      url: "https://github.com/yennanliu/InvestSkill",
      usage: "prompt framework taxonomy only",
      runtimeCopied: false,
    },
    {
      name: "cc-equity-research",
      url: "https://github.com/prof-little-bear/cc-equity-research",
      usage: "dispatcher and workflow taxonomy reference only",
      runtimeCopied: false,
    },
  ];
  const summaryArtifactPath = `runtime/agent/runs/${params.runID}/markets-capability-summary.json`;
  const evidenceArtifactPath = `runtime/agent/runs/${params.runID}/equity-evidence-pack.json`;
  const draftArtifactPath = `runtime/agent/runs/${params.runID}/equity-research-draft.json`;
  const dispatcherArtifactPath = `runtime/agent/runs/${params.runID}/markets-dispatcher-plan.json`;
  const deferredProviderArtifactPath = `runtime/agent/runs/${params.runID}/markets-provider-deferred.json`;

  const dispatcher = {
    schemaVersion: "markets-dispatcher-plan-v1",
    runID: params.runID,
    sessionID: params.sessionID || null,
    status: "planned",
    userFacingLane: lane,
    userFacingTask: lane === "discover" ? "Discover" : lane === "monitor" ? "Monitor" : lane === "macro" ? "Macro" : "Analyze",
    internalWorkflowCount: frameworks.length,
    selectedFrameworks: frameworks,
    visibleSurface: ["Discover", "Analyze", "Monitor", "Macro"],
    rawSlashCommandsExposed: false,
    secondOrchestratorCreated: false,
    promptPreview: redactedPreview(prompt),
    generatedAt,
    artifactPath: dispatcherArtifactPath,
  };

  const evidence = {
    schemaVersion: "equity-evidence-pack-v1",
    runID: params.runID,
    sessionID: params.sessionID || null,
    status: hasUserContext ? "user_context_available" : "methodology_only_no_provider_evidence",
    researchEvidenceStatus: hasUserContext ? "user_context" : "empty_provider_evidence",
    readableEvidenceCount: 0,
    emptyEvidenceReason: hasUserContext ? null : "No equity provider evidence, SEC filing, transcript, or structured price snapshot was connected in this run.",
    sourceReferences,
    context,
    rawProviderPayloadIncluded: false,
    rawRequestBodyIncluded: false,
    secretsIncluded: false,
    generatedAt,
    artifactPath: evidenceArtifactPath,
  };

  const draft = {
    schemaVersion: "equity-research-draft-v1",
    runID: params.runID,
    sessionID: params.sessionID || null,
    status: "draft_only",
    title: "Equity research draft",
    lane,
    selectedFrameworks: frameworks,
    methodFrameworkStatus: "usable",
    researchEvidenceStatus: evidence.researchEvidenceStatus,
    priceSnapshotStatus: "provider_deferred",
    sections: [
      { id: "question", title: "Research question", status: "draft" },
      { id: "framework", title: "Framework", status: "usable_methodology" },
      { id: "evidence_needed", title: "Evidence needed", status: "needs_provider_or_user_material" },
      { id: "counter_evidence", title: "Counter-evidence", status: "needs_review" },
      { id: "next_loop", title: "Next loop", status: "ready_for_follow_up" },
    ],
    outputBoundary: {
      tradeExecutionBlocked: true,
      buyHoldSellActionHidden: true,
      concretePricesAllowed: false,
      sourceAttributionRequired: true,
    },
    promptPreview: redactedPreview(prompt),
    evidencePackPath: evidenceArtifactPath,
    dispatcherPlanPath: dispatcherArtifactPath,
    generatedAt,
    artifactPath: draftArtifactPath,
  };

  const providerDeferred = {
    schemaVersion: "markets-provider-deferred-v1",
    runID: params.runID,
    sessionID: params.sessionID || null,
    provider: "equity live provider",
    status: "deferred",
    reason: "Live drillr / equity MCP provider is not enabled in this pass. Adapter, auth, normalizer, gate, and QA are required before use.",
    liveMCPExecuted: false,
    rawProviderPayloadIncluded: false,
    generatedAt,
    artifactPath: deferredProviderArtifactPath,
  };

  const summary = {
    schemaVersion: "markets-capability-summary-v1",
    runID: params.runID,
    sessionID: params.sessionID || null,
    capabilityID: "markets-research",
    displayName: "Markets Research",
    packageTitle: "Markets Research 能力包",
    mountStatus: "mounted",
    dispatcherStatus: "planned",
    promptFrameworkStatus: "usable",
    transportStatus: "provider_deferred",
    provider: "none",
    providerDeferredReason: providerDeferred.reason,
    researchEvidenceStatus: evidence.researchEvidenceStatus,
    readableEvidenceCount: evidence.readableEvidenceCount,
    emptyEvidenceReason: evidence.emptyEvidenceReason,
    priceSnapshotStatus: "provider_deferred",
    allowResearchDraft: true,
    allowResearchConclusion: hasUserContext,
    allowConcretePrices: false,
    allowBuyHoldSellAction: false,
    sourceObservationCount: 0,
    selectedFrameworks: frameworks,
    lane,
    summary: hasUserContext
      ? "Markets Research methodology is available and user-provided context exists; provider-backed evidence still requires review."
      : "Markets Research methodology is available, but no provider-backed equity evidence or price snapshot was connected in this run.",
    productMutationPolicyRecommendation: hasUserContext ? "review_required" : "discarded",
    sourceReferences,
    artifacts: {
      dispatcherPlanPath: dispatcherArtifactPath,
      evidencePackPath: evidenceArtifactPath,
      draftPath: draftArtifactPath,
      providerDeferredPath: deferredProviderArtifactPath,
    },
    generatedAt,
    artifactPath: summaryArtifactPath,
  };

  return { dispatcher, evidence, draft, providerDeferred, summary };
}

export default function registerMarketsResearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "markets.equity_dispatcher.plan",
    description: "Plan a compact Markets Research dispatcher route without exposing raw slash commands.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const payloads = buildPayloads(params);
      writeJSON(runArtifact(params.runID, "markets-dispatcher-plan.json"), payloads.dispatcher);
      return {
        content: [{ type: "text", text: "Markets dispatcher plan written locally; raw slash commands are not exposed." }],
        details: { status: "completed", provider: "localArtifactProvider", artifactPath: payloads.dispatcher.artifactPath, summary: payloads.dispatcher },
      };
    },
  });

  pi.registerTool({
    name: "markets.equity_research.draft",
    description: "Write a local equity research draft and split evidence/price gate summary.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const payloads = buildPayloads(params);
      writeJSON(runArtifact(params.runID, "equity-evidence-pack.json"), payloads.evidence);
      writeJSON(runArtifact(params.runID, "equity-research-draft.json"), payloads.draft);
      writeJSON(runArtifact(params.runID, "markets-capability-summary.json"), payloads.summary);
      return {
        content: [{ type: "text", text: "Equity research draft written locally with evidence and price gates; no trading advice or live provider call executed." }],
        details: { status: "completed", provider: "localArtifactProvider", artifactPath: payloads.draft.artifactPath, summary: payloads.summary },
      };
    },
  });

  pi.registerTool({
    name: "markets.provider.drillr_deferred",
    description: "Record that live equity MCP provider integration is deferred until adapter, auth, normalizer, gates, and QA exist.",
    parameters: TOOL_PARAMS,
    execute: async (_toolCallID: string, params: any) => {
      const payloads = buildPayloads(params);
      writeJSON(runArtifact(params.runID, "markets-provider-deferred.json"), payloads.providerDeferred);
      return {
        content: [{ type: "text", text: "Markets provider remains deferred; no live MCP call executed." }],
        details: { status: "completed", provider: "localArtifactProvider", artifactPath: payloads.providerDeferred.artifactPath, summary: payloads.providerDeferred },
      };
    },
  });
}
