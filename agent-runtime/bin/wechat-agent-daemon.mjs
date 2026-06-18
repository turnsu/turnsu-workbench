#!/usr/bin/env node
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { ProxyAgent } from "undici";
import { buildControlPlane } from "../control-plane/index.mjs";
import { AgentMongoStore } from "../lib/mongo-store.mjs";
import {
  cmcToolSelectionDiagnostic as coreCMCToolSelectionDiagnostic,
  externalCMCToolNames as coreExternalCMCToolNames,
  inferTools as coreInferTools,
  preferredCMCTool as corePreferredCMCTool,
  pruneDefaultCMCToolFanout as corePruneDefaultCMCToolFanout,
  toolsForExtension as coreToolsForExtension,
  toolsForSkill as coreToolsForSkill,
} from "../core/router/tool-router.mjs";
import { createGateEngine } from "../core/gates/gate-engine.mjs";
import { buildAgentFinalReadModelV1 } from "../core/final-output/final-read-model.mjs";
import {
  buildDegradedMarketFinalText as coreBuildDegradedMarketFinalText,
  buildDeterministicAssistantText as coreBuildDeterministicAssistantText,
  isMarketSensitiveRun as coreIsMarketSensitiveRun,
  shouldIncludeSafetyBoundary as coreShouldIncludeSafetyBoundary,
} from "../core/final-output/deterministic-final-copy.mjs";
import { writeAgentFinalReadModelArtifact, writeAuthoritativeFinalOutput } from "../core/artifacts/artifact-writer.mjs";
import { createPiBackedAgentRuntime, createPiKernelAdapter, nodeSatisfiesPiEngine, PI_KERNEL_SDK_VERSION } from "../kernels/pi/pi-kernel-adapter.mjs";
import { createAgentRuntimeCore } from "../core/run-loop/agent-runtime-core.mjs";
import { writeCapabilityLoopReadModels as writeCoreCapabilityLoopReadModels } from "../core/capability/capability-loop-read-model.mjs";
import { cmcSkillForTool as coreCmcSkillForTool, executeRuntimeToolViaCore } from "../core/providers/runtime-tool-executor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentRuntimeRoot = resolve(__dirname, "..");
const projectRoot = resolve(agentRuntimeRoot, "..");
const runtimeRoot = resolve(projectRoot, "runtime", "agent");
const sessionsRoot = join(runtimeRoot, "sessions");
const tasksRoot = join(runtimeRoot, "tasks");
const runsRoot = join(runtimeRoot, "runs");
const attachmentsRoot = join(runtimeRoot, "attachments");
const opsRoot = resolve(projectRoot, "runtime", "ops");
const opsHealthRoot = join(opsRoot, "health");
const opsMetricsRoot = join(opsRoot, "metrics");
const opsEventsRoot = join(opsRoot, "events");
const opsPolicyRoot = join(opsRoot, "policy");
const registryPath = join(agentRuntimeRoot, "runtime", "capability-registry.json");
const capabilityCatalogPath = join(agentRuntimeRoot, "runtime", "capability-catalog.json");
const publicSurfacePath = join(agentRuntimeRoot, "runtime", "public-surface.json");
const providersPath = join(agentRuntimeRoot, "runtime", "model-providers.json");
const configuredHost = process.env.WECHAT_AGENT_DAEMON_HOST || "127.0.0.1";
const host = "127.0.0.1";
const port = Number(process.env.WECHAT_AGENT_DAEMON_PORT || "8797");
const hostPolicyWarning = ["127.0.0.1", "localhost", "::1"].includes(configuredHost) ? null : `WECHAT_AGENT_DAEMON_HOST=${configuredHost} ignored; daemon binds 127.0.0.1 only.`;
const authTokenPath = join(runtimeRoot, "auth-token.json");
const maxRequestBodyBytes = Number(process.env.WECHAT_AGENT_MAX_BODY_BYTES || `${1024 * 1024}`);
const cmcBaseURL = String(process.env.CMC_BASE_URL || "https://pro-api.coinmarketcap.com").replace(/\/+$/, "");
const defaultCmcMcpEndpoint = String(process.env.CMC_MCP_ENDPOINT || "https://mcp.coinmarketcap.com/skill-hub/stream").replace(/\/+$/, "");
const cmcHTTPProxy = String(process.env.CMC_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || "").trim();
const cmcRefreshTTLSeconds = Number(process.env.CMC_REFRESH_TTL_SECONDS || "900");
const cmcDefaultSymbols = (process.env.CMC_DEFAULT_SYMBOLS || "BTC,ETH,SOL").split(",").map((item) => item.trim()).filter(Boolean);
const cmcProviderOrder = (process.env.CMC_PROVIDER_ORDER || "mcp_http,mcp_bridge,rest,normalized,fixture")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
const cmcSkillHubBridgeCmd = String(process.env.CMC_SKILL_HUB_BRIDGE_CMD || "").trim();
const mongoStore = new AgentMongoStore();

const blockedActions = new Set([
  "trade",
  "execute_trade",
  "send_message",
  "publish_external",
  "publish_content",
  "run_live_wechat_cli",
  "wechat_cli.live_command",
  "channel.feishu.publish_live",
  "channel.feishu.reply_live",
  "office.document.delete",
  "office.document.overwrite_live",
]);
const localPassTools = new Set([
  "wechat.read_normalized_messages",
  "read_live_wechat",
  "token.resolve_entities",
  "market.read_snapshot",
  "onchain.read_snapshot",
  "crystal.create_or_update",
  "proposal.create",
  "memory.save",
  "handoff.write",
  "image.analyze_with_kimi",
  "wechat_cli.import_export_file",
  "cmc.live_market_refresh",
  "cmc.daily_market_overview",
  "cmc.crypto_macro_overview",
  "cmc.read_market_evidence",
  "cmc.detect_market_regime",
  "cmc.track_social_price_divergence",
  "cmc.classify_kline_pattern_quality",
  "cmc.request_mcp_refresh",
  "office.cloud_asr.transcribe",
  "office.meeting_minutes.draft",
  "office.document.draft",
  "office.document_revision.draft",
  "channel.feishu.dry_run",
  "markets.equity_dispatcher.plan",
  "markets.equity_research.draft",
  "markets.provider.drillr_deferred",
]);

const projectToolNames = [
  "wechat.read_normalized_messages",
  "token.resolve_entities",
  "market.read_snapshot",
  "onchain.read_snapshot",
  "crystal.create_or_update",
  "proposal.create",
  "memory.save",
  "handoff.write",
  "image.analyze_with_kimi",
  "computer_use.request",
  "wechat_cli.import_export_file",
  "wechat_cli.live_command",
  "cmc.live_market_refresh",
  "cmc.daily_market_overview",
  "cmc.crypto_macro_overview",
  "cmc.read_market_evidence",
  "cmc.detect_market_regime",
  "cmc.track_social_price_divergence",
  "cmc.classify_kline_pattern_quality",
  "cmc.request_mcp_refresh",
  "office.cloud_asr.transcribe",
  "office.meeting_minutes.draft",
  "office.document.draft",
  "office.document_revision.draft",
  "channel.feishu.dry_run",
  "markets.equity_dispatcher.plan",
  "markets.equity_research.draft",
  "markets.provider.drillr_deferred",
  "channel.feishu.publish_live",
  "channel.feishu.reply_live",
  "office.document.delete",
  "office.document.overwrite_live",
];

const piAgentDir = join(runtimeRoot, "pi-agent-home");
const piExtensionPath = join(agentRuntimeRoot, "extensions", "wechat-onchain-tools.ts");
const extensionPackagesRoot = join(agentRuntimeRoot, "extensions");
const piSkillPath = join(agentRuntimeRoot, "skills");
const piPromptPath = join(agentRuntimeRoot, "prompts");

function discoverExtensionPackages() {
  if (!existsSync(extensionPackagesRoot)) return [];
  return readdirSync(extensionPackagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageRoot = join(extensionPackagesRoot, entry.name);
      const manifest = readJSON(join(packageRoot, "manifest.json"), null);
      const extensionPath = join(packageRoot, "extension.ts");
      return {
        id: manifest?.id || entry.name,
        packageRoot,
        extensionPath,
        manifest,
        available: existsSync(extensionPath),
      };
    })
    .filter((item) => item.available);
}

function discoverExtensionPaths() {
  return [
    piExtensionPath,
    ...discoverExtensionPackages().map((item) => item.extensionPath),
  ];
}

const piRuntime = createPiBackedAgentRuntime({
  projectRoot,
  agentRuntimeRoot,
  piAgentDir,
  piExtensionPath,
  piSkillPath,
  piPromptPath,
  projectToolNames,
  discoverExtensionPaths,
  discoverExtensionPackages,
  now,
  redact,
  safeId,
});
const piKernel = createPiKernelAdapter(piRuntime);
const agentRuntimeCore = createAgentRuntimeCore({
  router: {
    inferTools: coreInferTools,
    cmcToolSelectionDiagnostic: coreCMCToolSelectionDiagnostic,
  },
  gateEngine: {
    guardFinalOutput: (args) => createDaemonGateEngine().guardFinalOutput(args),
    productMutationPolicyForRun: (toolObservations) => createDaemonGateEngine().productMutationPolicyForRun(toolObservations),
  },
  piKernel,
  finalOutput: {
    buildAgentFinalReadModelV1,
    buildDeterministicAssistantText: coreBuildDeterministicAssistantText,
    buildDegradedMarketFinalText: coreBuildDegradedMarketFinalText,
  },
  artifacts: { writeAgentFinalReadModelArtifact, writeAuthoritativeFinalOutput, writeCapabilityLoopReadModels: writeCoreCapabilityLoopReadModels },
  providerExecutor: { executeRuntimeToolViaCore },
  capabilityCatalog: readJSON(capabilityCatalogPath, { capabilities: [] }),
});
const terminalEventTypes = new Set(["run.completed", "run.failed", "run.cancelled"]);

function ensureDirs() {
  for (const path of [runtimeRoot, sessionsRoot, tasksRoot, runsRoot, attachmentsRoot, opsRoot, opsHealthRoot, opsMetricsRoot, opsEventsRoot, opsPolicyRoot]) {
    mkdirSync(path, { recursive: true });
  }
}

function now() {
  return new Date().toISOString();
}

function json(res, status, body) {
  const data = Buffer.from(`${JSON.stringify(body, null, 2)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
  });
  res.end(data);
}

function text(res, status, body) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function safeId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRunDir(runID) {
  const dir = resolve(runsRoot, runID.replace(/[^A-Za-z0-9_.-]/g, "_"));
  if (!isInside(runsRoot, dir)) throw new Error("unsafe_run_id");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionPath(sessionID) {
  return join(sessionsRoot, `${sessionID}.json`);
}

function taskPath(taskID) {
  return join(tasksRoot, `${taskID}.json`);
}

function readJSON(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

const pendingMongoPersists = new Set();

function persistMongo(label, promise) {
  const pending = Promise.resolve(promise)
    .catch((error) => {
      console.error(`mongo_persist_failed:${label}:${redact(error?.message || error)}`);
    })
    .finally(() => pendingMongoPersists.delete(pending));
  pendingMongoPersists.add(pending);
}

async function flushMongoPersists() {
  if (!pendingMongoPersists.size) return;
  await Promise.allSettled([...pendingMongoPersists]);
}

function removeRunArtifacts(runID) {
  if (!runID) return;
  const dir = resolve(runsRoot, String(runID).replace(/[^A-Za-z0-9_.-]/g, "_"));
  if (!isInside(runsRoot, dir) || !existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

function appendNDJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

function loadOrCreateAuthToken() {
  const existing = readJSON(authTokenPath, null);
  if (typeof existing?.token === "string" && existing.token.length >= 32) return existing.token;
  const token = randomBytes(32).toString("base64url");
  writeJSON(authTokenPath, {
    schemaVersion: "agent-daemon-auth-token-v1",
    token,
    audience: "local-swift-client",
    createdAt: now(),
  });
  return token;
}

function expectedAuthToken() {
  return String(process.env.WECHAT_AGENT_AUTH_TOKEN || "").trim() || loadOrCreateAuthToken();
}

function isAllowedHostHeader(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    "127.0.0.1",
    "localhost",
    "::1",
    "[::1]",
  ]);
  return allowed.has(raw);
}

function isAllowedOrigin(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return true;
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
    "null",
  ]);
  return allowed.has(raw);
}

function authFailure(req, url) {
  if (!isAllowedHostHeader(req.headers.host)) {
    return { status: 403, body: { error: "invalid_host", message: "Host header is not allowed for local daemon." } };
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    return { status: 403, body: { error: "invalid_origin", message: "Origin is not allowed for local daemon." } };
  }
  if (req.method === "GET" && url.pathname === "/health") return null;
  const expected = expectedAuthToken();
  const provided = String(req.headers.authorization || "").trim();
  if (provided !== `Bearer ${expected}`) {
    return { status: 401, body: { error: "unauthorized", message: "Local daemon authorization required." } };
  }
  return null;
}

function publicHealth() {
  ensureDirs();
  return {
    schemaVersion: "agent-runtime-host-public-health-v1",
    status: "available",
    daemon: {
      pid: process.pid,
      host,
      port,
      startedAt: daemonStartedAt,
    },
    auth: {
      required: true,
      tokenArtifactPath: "runtime/agent/auth-token.json",
    },
    providers: [],
    capabilities: [],
    skills: [],
    extensions: [],
    templates: [],
    tools: [],
    policy: {
      liveWechat: "read_only_auto_refresh_when_enabled",
      liveWechatCLI: "raw_cli_command_blocked",
      trade: "blocked",
      sendMessage: "blocked",
      publishExternal: "blocked",
      computerUse: "needs_confirmation",
    },
    warning: hostPolicyWarning,
    internalToolsExposed: false,
  };
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function publicSurface() {
  const fallback = { schemaVersion: "agent-public-surface-v1", skills: [], extensions: [], templates: [] };
  const surface = readJSON(publicSurfacePath, fallback);
  const packages = discoverExtensionPackages()
    .map((item) => item.manifest)
    .filter(Boolean);
  const packageStatuses = extensionPackageStatuses();
  const extensionIDs = new Set((surface.extensions || []).map((item) => item.extensionID));
  const packageExtensions = packages
    .filter((manifest) => manifest.publicExtension && !extensionIDs.has(manifest.publicExtension.extensionID))
    .map((manifest) => manifest.publicExtension);
  const packageSkills = packages.flatMap((manifest) => manifest.publicSkills || []);
  const skillIDs = new Set((surface.skills || []).map((item) => item.skillID));
  const enrichExtension = (extension) => {
    const packageStatus = packageStatuses.find((item) => item.extensionID === extension.extensionID || item.id === extension.extensionID);
    if (!packageStatus) return extension;
    return {
      ...extension,
      status: packageStatus.publicStatus,
      permissionSummary: packageStatus.publicSummary || extension.permissionSummary,
    };
  };
  return {
    ...surface,
    skills: [...(surface.skills || []), ...packageSkills.filter((skill) => !skillIDs.has(skill.skillID))],
    extensions: [...(surface.extensions || []), ...packageExtensions].map(enrichExtension),
    providers: [...providerReadiness(), cmcProviderReadiness(), wechatProviderReadiness()],
    extensionPackages: packageStatuses,
    internalToolsExposed: false,
  };
}

function appendEvent(runDir, event) {
  const full = {
    eventID: safeId("evt"),
    timestamp: now(),
    ...event,
  };
  appendNDJSON(join(runDir, "events.ndjson"), full);
  persistMongo("event", mongoStore.appendEvent(full));
  return full;
}

function artifactRef(runID, name, kind = "artifact", stage = null) {
  return {
    name,
    kind,
    stage,
    artifactPath: `runtime/agent/runs/${runID}/${name}`,
  };
}

function runManifestPath(runDir) {
  return join(runDir, "run-manifest.json");
}

function writeRunManifest(runDir, manifest) {
  writeJSON(runManifestPath(runDir), {
    schemaVersion: "agent-run-manifest-v1",
    updatedAt: now(),
    ...manifest,
  });
}

function loopArtifactPath(runID, name) {
  return `runtime/agent/runs/${runID}/${name}`;
}

function rootSubtaskID() {
  return "subtask-root";
}

function safeBranchSegment(value) {
  return String(value || "run").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 96) || "run";
}

function mainBranchID(runID) {
  return `branch-main-${safeBranchSegment(runID)}`;
}

function reviewBranchID(runID) {
  return `branch-review-${safeBranchSegment(runID)}`;
}

function reviewRunID(runID) {
  return `review-${safeBranchSegment(runID)}`;
}

function harnessArtifactRefs(runID) {
  return [
    artifactRef(runID, "harness-session-tree.json", "harness_session_tree", "harness"),
    artifactRef(runID, "harness-branch-lineage.json", "harness_branch_lineage", "harness"),
    artifactRef(runID, "invocation-ledger.ndjson", "invocation_ledger", "harness"),
    artifactRef(runID, "context-event-log.ndjson", "context_event_log", "context"),
    artifactRef(runID, "compaction-summary.json", "compaction_summary", "context"),
    artifactRef(runID, "review-read-model.json", "review_read_model", "review"),
  ];
}

function capabilityLoopArtifactRefs(runID) {
  return [
    artifactRef(runID, "capability-loop-read-model.json", "capability_loop_read_model", "capability_loop"),
    artifactRef(runID, "memory-read-model.json", "memory_read_model", "memory"),
    artifactRef(runID, "subagent-coordination-read-model.json", "subagent_coordination_read_model", "coordination"),
    artifactRef(runID, "markets-capability-summary.json", "markets_capability_summary", "tool_execution"),
    artifactRef(runID, "equity-research-draft.json", "equity_research_draft", "tool_execution"),
    artifactRef(runID, "equity-evidence-pack.json", "equity_evidence_pack", "tool_execution"),
  ];
}

function redactedPreview(value, maxChars = 500) {
  const textValue = redact(String(value || "")).replace(/\s+/g, " ").trim();
  return textValue.length > maxChars ? `${textValue.slice(0, maxChars - 1)}…` : textValue;
}

function appendInvocationLedger(runDir, event) {
  const runID = event.runID || readJSON(runManifestPath(runDir), {})?.runID || "unknown-run";
  const full = {
    schemaVersion: "agent-invocation-ledger-event-v1",
    eventID: safeId("invoke"),
    timestamp: now(),
    runID,
    taskID: event.taskID || null,
    sessionID: event.sessionID || null,
    branchID: event.branchID || mainBranchID(runID),
    type: event.type,
    status: event.status || null,
    stage: event.stage || null,
    action: event.action || null,
    toolName: event.toolName || null,
    artifactPath: event.artifactPath || null,
  };
  if (event.reason) full.reason = redactedPreview(event.reason, 400);
  if (event.details) full.details = event.details;
  appendNDJSON(join(runDir, "invocation-ledger.ndjson"), full);
  return full;
}

function initializeHarnessArtifacts(runDir, { runID, taskID, sessionID, prompt }) {
  const createdAt = now();
  const branchID = mainBranchID(runID);
  const branch = {
    branchID,
    runID,
    parentBranchID: null,
    branchType: "main",
    status: "active",
    sourceStepID: "step-plan-0",
    finalReadModelPath: null,
    reviewReadModelPath: null,
    createdAt,
    updatedAt: createdAt,
  };
  writeJSON(join(runDir, "harness-session-tree.json"), {
    schemaVersion: "agent-harness-session-tree-v1",
    sessionID,
    rootRunID: runID,
    activeBranchID: branchID,
    branches: [branch],
    reviewBranches: [],
    terminalBranches: [],
    createdAt,
    updatedAt: createdAt,
    artifactPath: loopArtifactPath(runID, "harness-session-tree.json"),
  });
  writeJSON(join(runDir, "harness-branch-lineage.json"), {
    schemaVersion: "agent-harness-branch-lineage-v1",
    sessionID,
    runID,
    branchID,
    parentBranchID: null,
    sourceRunID: null,
    sourceStepID: "step-plan-0",
    branchType: "main",
    mergeTargetBranchID: null,
    mergeDecision: "not_applicable",
    mergeReason: "main_branch_is_authoritative_until_explicit_merge_policy_exists",
    relatedBranches: [],
    createdAt,
    updatedAt: createdAt,
    artifactPath: loopArtifactPath(runID, "harness-branch-lineage.json"),
  });
  appendInvocationLedger(runDir, {
    type: "accepted",
    runID,
    taskID,
    sessionID,
    branchID,
    stage: "start",
    status: "accepted",
    artifactPath: loopArtifactPath(runID, "harness-session-tree.json"),
    details: {
      promptPreview: redactedPreview(prompt, 240),
    },
  });
  appendInvocationLedger(runDir, {
    type: "branch_created",
    runID,
    taskID,
    sessionID,
    branchID,
    stage: "harness",
    status: "active",
    artifactPath: loopArtifactPath(runID, "harness-branch-lineage.json"),
    details: { branchType: "main" },
  });
  appendInvocationLedger(runDir, {
    type: "planner_started",
    runID,
    taskID,
    sessionID,
    branchID,
    stage: "planner",
    status: "running",
    artifactPath: loopArtifactPath(runID, "planner-state.json"),
  });
  return { branchID };
}

function recordContextHarnessEvent(runDir, { runID, taskID, sessionID, branchID = mainBranchID(runID), stage = "plan", controlPlane }) {
  const contextPack = controlPlane?.contextPack || {};
  const retrievalPlan = controlPlane?.retrievalPlan || {};
  const contextGate = controlPlane?.contextGate || {};
  const sourceTrustReport = controlPlane?.sourceTrustReport || {};
  const selectedChunkIDs = Array.isArray(retrievalPlan.selectedChunkIDs)
    ? retrievalPlan.selectedChunkIDs
    : (contextPack.selectedChunks || []).map((chunk) => chunk.chunkID).filter(Boolean);
  const excludedChunkIDs = Array.isArray(retrievalPlan.excludedChunkIDs)
    ? retrievalPlan.excludedChunkIDs
    : (contextPack.excludedChunkRefs || []).map((chunk) => chunk.chunkID).filter(Boolean);
  const sources = Array.isArray(sourceTrustReport.sources) ? sourceTrustReport.sources : [];
  const privacy = contextGate.privacy || {};
  const privacyActions = [];
  if (privacy.rawPrivateTranscriptIncluded === false) privacyActions.push("raw_private_transcript_excluded");
  if (privacy.fullRawContentIncluded === false) privacyActions.push("full_raw_content_excluded");
  if (privacy.secretMaterialIncluded === false) privacyActions.push("secret_material_excluded");
  const gateReasons = [
    contextGate.reason,
    contextGate.missingSourceCount ? `missing_sources:${contextGate.missingSourceCount}` : null,
    contextGate.staleChunkCount ? `stale_chunks:${contextGate.staleChunkCount}` : null,
  ].filter(Boolean);
  const event = {
    schemaVersion: "agent-context-event-v1",
    eventID: safeId("ctxevt"),
    runID,
    taskID,
    sessionID,
    branchID,
    stage,
    selectedChunkIDs,
    excludedChunkIDs,
    budget: retrievalPlan.budget || controlPlane?.contextBundle?.budget || null,
    sourceTrustSummary: {
      sourceCount: sources.length,
      reportPath: loopArtifactPath(runID, "source-trust-report.json"),
      trustedSourceCount: sources.filter((source) => Number(source.score || source.sourceTrustScore || 0) >= 0.5).length,
      degradedSourceCount: sources.filter((source) => source.freshness === "stale" || source.freshness === "degraded").length,
    },
    privacyActions,
    gateReasons,
    contextPackPath: loopArtifactPath(runID, "context-pack.json"),
    createdAt: now(),
  };
  appendNDJSON(join(runDir, "context-event-log.ndjson"), event);
  appendInvocationLedger(runDir, {
    type: "context_loaded",
    runID,
    taskID,
    sessionID,
    branchID,
    stage: "context",
    status: contextGate.status || "unknown",
    artifactPath: event.contextPackPath,
    details: {
      selectedChunkCount: selectedChunkIDs.length,
      excludedChunkCount: excludedChunkIDs.length,
    },
  });
  return event;
}

function updateHarnessTree(runDir, runID, updater) {
  const treePath = join(runDir, "harness-session-tree.json");
  const tree = readJSON(treePath, null);
  if (!tree) return null;
  const updated = updater(tree) || tree;
  updated.updatedAt = now();
  writeJSON(treePath, updated);
  return updated;
}

function buildReviewReadModel({ runID, taskID, sessionID, finalReadModel, toolObservations }) {
  const gate = finalReadModel?.cmcGateSummary || {};
  const policy = finalReadModel?.productMutationPolicy || {};
  const findings = [];
  if (policy.status === "discarded") {
    findings.push({
      findingID: "mutation-policy-discarded",
      severity: "high",
      title: "Product mutations are not importable",
      detail: policy.reason || "product_mutation_policy_discarded",
      artifactPath: finalReadModel?.artifactPath || loopArtifactPath(runID, "agent-final-read-model.json"),
    });
  }
  if (gate.emptyEvidenceReason) {
    findings.push({
      findingID: "cmc-evidence-empty",
      severity: "high",
      title: "CMC evidence is empty or unparseable",
      detail: gate.emptyEvidenceReason,
      artifactPath: loopArtifactPath(runID, "tool-observations.json"),
    });
  }
  if (finalReadModel?.outputGuardStatus === "rewritten") {
    findings.push({
      findingID: "final-output-rewritten",
      severity: "medium",
      title: "Final output was rewritten by output guard",
      detail: finalReadModel.outputGuardReason || "output_guard_rewritten",
      artifactPath: finalReadModel?.artifactPath || loopArtifactPath(runID, "agent-final-read-model.json"),
    });
  }
  const status = policy.status === "discarded"
    ? "insufficient_evidence"
    : finalReadModel?.outputGuardStatus === "rewritten"
      ? "needs_revision"
      : "pass";
  const mergeRecommendation = policy.status === "discarded"
    ? "discard"
    : finalReadModel?.outputGuardStatus === "rewritten"
      ? "revise"
      : "keep_main";
  return {
    schemaVersion: "agent-review-read-model-v1",
    reviewRunID: reviewRunID(runID),
    sourceRunID: runID,
    sourceBranchID: mainBranchID(runID),
    status,
    findings,
    checkedArtifacts: [
      { name: "agent-final-read-model.json", artifactPath: loopArtifactPath(runID, "agent-final-read-model.json"), status: finalReadModel ? "checked" : "missing" },
      { name: "tool-observations.json", artifactPath: loopArtifactPath(runID, "tool-observations.json"), status: toolObservations ? "checked" : "missing" },
      { name: "context-pack.json", artifactPath: loopArtifactPath(runID, "context-pack.json"), status: "checked" },
      { name: "harness-branch-lineage.json", artifactPath: loopArtifactPath(runID, "harness-branch-lineage.json"), status: "checked" },
    ],
    cmcGateSummary: finalReadModel?.cmcGateSummary || null,
    outputGuardStatus: finalReadModel?.outputGuardStatus || toolObservations?.outputGuard?.status || "unknown",
    mutationPolicyAssessment: {
      status: policy.status || "unknown",
      reason: policy.reason || null,
      importAllowed: policy.status === "importable",
    },
    mergeRecommendation,
    generatedAt: now(),
    artifactPath: loopArtifactPath(runID, "review-read-model.json"),
  };
}

function buildCompactionSummary({ runID, taskID, sessionID, prompt, controlPlane, toolCalls, finalReadModel, toolObservations, branchLineage }) {
  const selectedEvidenceIDs = [
    ...(controlPlane?.retrievalPlan?.selectedChunkIDs || []),
    ...(toolObservations?.observations || []).map((item) => item.toolName).filter(Boolean),
  ];
  return {
    schemaVersion: "agent-compaction-summary-v1",
    runID,
    taskID,
    sessionID,
    status: "ready",
    userGoal: {
      summary: redactedPreview(prompt, 500),
      constraints: [
        "agent-final-read-model-v1 remains the only final answer authority",
        "review branch is read-only and cannot import product mutations",
        "raw private transcript and provider request bodies are excluded",
      ],
    },
    artifactPaths: [
      loopArtifactPath(runID, "run-manifest.json"),
      loopArtifactPath(runID, "context-pack.json"),
      loopArtifactPath(runID, "tool-observations.json"),
      loopArtifactPath(runID, "agent-final-read-model.json"),
      loopArtifactPath(runID, "harness-session-tree.json"),
      loopArtifactPath(runID, "harness-branch-lineage.json"),
      loopArtifactPath(runID, "review-read-model.json"),
    ],
    selectedEvidenceIDs: [...new Set(selectedEvidenceIDs)].slice(0, 100),
    cmcGateSummary: finalReadModel?.cmcGateSummary || null,
    qaDecision: {
      status: controlPlane?.qaGate?.status || "unknown",
      reason: controlPlane?.qaGate?.reason || null,
      artifactPath: loopArtifactPath(runID, "qa-gate.json"),
    },
    policyDecisions: (controlPlane?.policyDecisions || []).map((item) => ({
      action: item.action,
      status: item.status,
      reason: item.reason,
      riskLevel: item.riskLevel,
    })),
    toolFailures: (toolCalls || [])
      .filter((call) => call.status === "failed" || call.status === "blocked")
      .map((call) => ({
        toolName: call.toolName,
        status: call.status,
        reason: redactedPreview(call.outputSummary, 240),
        artifactPath: call.detailsArtifactPath || call.artifactPath || null,
      })),
    missingInputs: [
      ...(controlPlane?.contextManifest?.missingSources || []).map((item) => redactedPreview(item.sourceID || item.label || item, 160)),
      ...(toolObservations?.cmcFreshnessGate?.emptyEvidenceReason ? [toolObservations.cmcFreshnessGate.emptyEvidenceReason] : []),
    ],
    branchLineage,
    finalReadModelPath: finalReadModel?.artifactPath || loopArtifactPath(runID, "agent-final-read-model.json"),
    redaction: {
      rawPrivateTranscriptIncluded: false,
      providerRequestBodyIncluded: false,
      secretsIncluded: false,
      personalMetadataRedacted: true,
    },
    generatedAt: now(),
    artifactPath: loopArtifactPath(runID, "compaction-summary.json"),
  };
}

function finalizeHarnessArtifacts(runDir, { runID, taskID, sessionID, prompt, controlPlane, toolCalls, finalReadModel, toolObservations }) {
  const finishedAt = now();
  const mainID = mainBranchID(runID);
  const reviewID = reviewBranchID(runID);
  const reviewModel = buildReviewReadModel({ runID, taskID, sessionID, finalReadModel, toolObservations });
  writeJSON(join(runDir, "review-read-model.json"), reviewModel);
  const lineage = readJSON(join(runDir, "harness-branch-lineage.json"), {
    schemaVersion: "agent-harness-branch-lineage-v1",
    sessionID,
    runID,
    branchID: mainID,
    parentBranchID: null,
    sourceRunID: null,
    sourceStepID: "step-plan-0",
    branchType: "main",
    mergeTargetBranchID: null,
    mergeDecision: "not_applicable",
    mergeReason: "main_branch_is_authoritative_until_explicit_merge_policy_exists",
    relatedBranches: [],
  });
  const reviewLineage = {
    runID: reviewModel.reviewRunID,
    branchID: reviewID,
    parentBranchID: mainID,
    sourceRunID: runID,
    sourceStepID: "step-final-output",
    branchType: "review",
    mergeTargetBranchID: mainID,
    mergeDecision: "pending",
    mergeReason: "deterministic_review_branch_does_not_auto_merge",
    reviewReadModelPath: reviewModel.artifactPath,
    createdAt: finishedAt,
  };
  writeJSON(join(runDir, "harness-branch-lineage.json"), {
    ...lineage,
    relatedBranches: [reviewLineage],
    updatedAt: finishedAt,
  });
  updateHarnessTree(runDir, runID, (tree) => {
    const existingReviewBranches = Array.isArray(tree.reviewBranches) ? tree.reviewBranches : [];
    const reviewBranch = {
      branchID: reviewID,
      runID: reviewModel.reviewRunID,
      parentBranchID: mainID,
      branchType: "review",
      status: "completed",
      sourceStepID: "step-final-output",
      finalReadModelPath: null,
      reviewReadModelPath: reviewModel.artifactPath,
      createdAt: finishedAt,
      updatedAt: finishedAt,
    };
    return {
      ...tree,
      activeBranchID: mainID,
      branches: (tree.branches || []).map((branch) => branch.branchID === mainID
        ? {
            ...branch,
            status: "completed",
            finalReadModelPath: finalReadModel?.artifactPath || loopArtifactPath(runID, "agent-final-read-model.json"),
            updatedAt: finishedAt,
          }
        : branch),
      reviewBranches: [
        ...existingReviewBranches.filter((branch) => branch.branchID !== reviewID),
        reviewBranch,
      ],
      terminalBranches: [mainID],
    };
  });
  appendInvocationLedger(runDir, {
    type: "review_requested",
    runID,
    taskID,
    sessionID,
    branchID: mainID,
    stage: "review",
    status: "completed",
    artifactPath: reviewModel.artifactPath,
  });
  appendInvocationLedger(runDir, {
    type: "branch_created",
    runID,
    taskID,
    sessionID,
    branchID: reviewID,
    stage: "review",
    status: "completed",
    artifactPath: reviewModel.artifactPath,
    details: { branchType: "review", sourceBranchID: mainID },
  });
  const compactionSummary = buildCompactionSummary({
    runID,
    taskID,
    sessionID,
    prompt,
    controlPlane,
    toolCalls,
    finalReadModel,
    toolObservations,
    branchLineage: readJSON(join(runDir, "harness-branch-lineage.json"), null),
  });
  writeJSON(join(runDir, "compaction-summary.json"), compactionSummary);
  appendNDJSON(join(runDir, "context-event-log.ndjson"), {
    schemaVersion: "agent-context-event-v1",
    eventID: safeId("ctxevt"),
    runID,
    taskID,
    sessionID,
    branchID: mainID,
    stage: "compact",
    selectedChunkIDs: controlPlane?.retrievalPlan?.selectedChunkIDs || [],
    excludedChunkIDs: controlPlane?.retrievalPlan?.excludedChunkIDs || [],
    budget: controlPlane?.retrievalPlan?.budget || null,
    sourceTrustSummary: {
      sourceCount: controlPlane?.sourceTrustReport?.sources?.length || 0,
      reportPath: loopArtifactPath(runID, "source-trust-report.json"),
    },
    privacyActions: ["raw_private_transcript_excluded", "provider_request_body_excluded", "secrets_excluded"],
    gateReasons: compactionSummary.missingInputs || [],
    contextPackPath: loopArtifactPath(runID, "context-pack.json"),
    compactionSummaryPath: compactionSummary.artifactPath,
    createdAt: now(),
  });
  appendInvocationLedger(runDir, {
    type: "final_selected",
    runID,
    taskID,
    sessionID,
    branchID: mainID,
    stage: "final_output",
    status: finalReadModel?.status || "completed",
    artifactPath: finalReadModel?.artifactPath || loopArtifactPath(runID, "agent-final-read-model.json"),
    details: {
      outputGuardStatus: finalReadModel?.outputGuardStatus || "unknown",
      productMutationPolicy: finalReadModel?.productMutationPolicy?.status || "unknown",
    },
  });
  appendInvocationLedger(runDir, {
    type: "run_completed",
    runID,
    taskID,
    sessionID,
    branchID: mainID,
    stage: "final_output",
    status: "completed",
    artifactPath: loopArtifactPath(runID, "run-manifest.json"),
  });
  return { reviewModel, compactionSummary };
}

function recordHarnessFailure(runDir, { runID, taskID, sessionID, reason }) {
  appendInvocationLedger(runDir, {
    type: "run_failed",
    runID,
    taskID,
    sessionID,
    branchID: mainBranchID(runID),
    stage: "failed",
    status: "failed",
    reason,
  });
  updateHarnessTree(runDir, runID, (tree) => ({
    ...tree,
    branches: (tree.branches || []).map((branch) => branch.branchID === mainBranchID(runID)
      ? { ...branch, status: "failed", updatedAt: now() }
      : branch),
    terminalBranches: [mainBranchID(runID)],
  }));
}

function expectedToolResultContract(toolName, policyDecision = null) {
  if (toolName?.startsWith("cmc.")) {
    return {
      contractID: "cmc-evidence-or-price-snapshot-v1",
      requiredFields: ["transportStatus", "researchEvidenceStatus", "priceSnapshotStatus"],
      successCondition: "Transport success is insufficient; usable research evidence or a usable price snapshot is required for market conclusions.",
      actionIntent: policyDecision?.actionIntent || "read_market_evidence",
    };
  }
  if (toolName === "market.read_snapshot") {
    return {
      contractID: "market-snapshot-read-v1",
      requiredFields: ["provider", "freshness", "assets"],
      successCondition: "Snapshot may support prices only when freshness and concrete price integrity pass.",
      actionIntent: policyDecision?.actionIntent || "read_market_snapshot",
    };
  }
  return {
    contractID: "runtime-tool-summary-v1",
    requiredFields: ["status", "outputSummary", "detailsArtifactPath"],
    successCondition: "Tool result is usable only after policy, redaction, and output guard checks.",
    actionIntent: policyDecision?.actionIntent || "runtime_tool_action",
  };
}

function initializeAgentLoopArtifacts(runDir, { runID, taskID, sessionID, prompt, controlPlane, tools }) {
  const planID = safeId("plan");
  const createdAt = now();
  const root = rootSubtaskID();
  const goal = String(prompt || "").trim();
  const evidenceRequirements = tools.some((tool) => tool.startsWith("cmc.") || tool === "market.read_snapshot")
    ? [
        {
          requirementID: "cmc-research-or-price-evidence",
          status: "pending",
          description: "CMC runs must distinguish provider transport from usable research evidence and usable price snapshots.",
        },
      ]
    : [];
  const plannerState = {
    schemaVersion: "agent-planner-state-v1",
    runID,
    taskID,
    sessionID,
    planID,
    goal,
    currentStepID: "step-plan-0",
    subtasks: [
      {
        subtaskID: root,
        title: goal.slice(0, 120) || controlPlane?.taskIntent?.taskType || "Agent task",
        status: "running",
        toolNames: tools,
        evidenceRequirements: evidenceRequirements.map((item) => item.requirementID),
        createdAt,
        updatedAt: createdAt,
      },
    ],
    dependencies: [],
    nextActions: tools.map((toolName) => ({
      actionID: `action-${toolName.replace(/[^A-Za-z0-9_.-]/g, "_")}`,
      subtaskID: root,
      kind: "tool_call",
      toolName,
      status: "pending",
    })),
    evidenceRequirements,
    blockedReasons: [],
    revisionCount: 0,
    status: "running",
    createdAt,
    updatedAt: createdAt,
    artifactPath: loopArtifactPath(runID, "planner-state.json"),
  };
  const taskGraph = {
    schemaVersion: "agent-task-graph-v1",
    runID,
    taskID,
    planID,
    nodes: plannerState.subtasks,
    edges: [],
    rootSubtaskID: root,
    status: "running",
    createdAt,
    updatedAt: createdAt,
    artifactPath: loopArtifactPath(runID, "task-graph.json"),
  };
  writeJSON(join(runDir, "planner-state.json"), plannerState);
  writeJSON(join(runDir, "task-graph.json"), taskGraph);
  const firstDecision = {
    schemaVersion: "agent-planner-decision-v1",
    decisionID: safeId("decision"),
    runID,
    taskID,
    planID,
    stepID: "step-plan-0",
    subtaskID: root,
    decision: "start_sequential_loop",
    selectedTools: tools,
    reason: "Initial implementation records a deterministic sequential loop while preserving future replan/resume artifacts.",
    createdAt,
  };
  appendNDJSON(join(runDir, "planner-decisions.ndjson"), firstDecision);
  appendNDJSON(join(runDir, "agent-loop.ndjson"), {
    schemaVersion: "agent-loop-event-v1",
    eventID: safeId("loop"),
    runID,
    taskID,
    planID,
    stepID: "step-plan-0",
    subtaskID: root,
    type: "plan_started",
    status: "running",
    artifactRefs: [
      loopArtifactPath(runID, "planner-state.json"),
      loopArtifactPath(runID, "task-graph.json"),
      loopArtifactPath(runID, "planner-decisions.ndjson"),
    ],
    createdAt,
  });
  mkdirSync(join(runDir, "observations"), { recursive: true });
  mkdirSync(join(runDir, "step-results"), { recursive: true });
  return { plannerState, taskGraph };
}

function updatePlannerLoopStatus(runDir, { status, currentStepID = null, evidenceRequirements = null, blockedReasons = null }) {
  const plannerStatePath = join(runDir, "planner-state.json");
  const taskGraphPath = join(runDir, "task-graph.json");
  const plannerState = readJSON(plannerStatePath, null);
  const taskGraph = readJSON(taskGraphPath, null);
  if (plannerState) {
    const updatedAt = now();
    const root = rootSubtaskID();
    writeJSON(plannerStatePath, {
      ...plannerState,
      status,
      currentStepID: currentStepID || plannerState.currentStepID,
      evidenceRequirements: evidenceRequirements || plannerState.evidenceRequirements,
      blockedReasons: blockedReasons || plannerState.blockedReasons || [],
      subtasks: (plannerState.subtasks || []).map((item) => item.subtaskID === root ? { ...item, status, updatedAt } : item),
      updatedAt,
    });
  }
  if (taskGraph) {
    const updatedAt = now();
    const root = rootSubtaskID();
    writeJSON(taskGraphPath, {
      ...taskGraph,
      status,
      nodes: (taskGraph.nodes || []).map((item) => item.subtaskID === root ? { ...item, status, updatedAt } : item),
      updatedAt,
    });
  }
}

function recordToolLoopStep(runDir, { runID, taskID, call, policyDecision = null }) {
  if (!call?.id) return;
  const stepID = `step-${call.id}`;
  const observationID = `obs-${call.id}`;
  const createdAt = now();
  const observation = {
    schemaVersion: "agent-observation-v1",
    observationID,
    runID,
    taskID,
    stepID,
    subtaskID: rootSubtaskID(),
    source: "tool_call",
    toolName: call.toolName,
    status: call.status,
    outputSummary: call.outputSummary,
    detailsArtifactPath: call.detailsArtifactPath,
    redactionStatus: call.redactionStatus,
    usableForPlanning: call.status === "completed",
    createdAt,
    artifactPath: loopArtifactPath(runID, `observations/${observationID}.json`),
  };
  const stepResult = {
    schemaVersion: "agent-step-result-v1",
    stepID,
    runID,
    taskID,
    subtaskID: rootSubtaskID(),
    action: {
      kind: "tool_call",
      toolName: call.toolName,
      permission: call.permission,
      status: call.status,
    },
    expectedResultContract: expectedToolResultContract(call.toolName, policyDecision),
    observationID,
    observationPath: observation.artifactPath,
    status: call.status,
    createdAt,
    artifactPath: loopArtifactPath(runID, `step-results/${stepID}.json`),
  };
  writeJSON(join(runDir, "observations", `${observationID}.json`), observation);
  writeJSON(join(runDir, "step-results", `${stepID}.json`), stepResult);
  appendNDJSON(join(runDir, "agent-loop.ndjson"), {
    schemaVersion: "agent-loop-event-v1",
    eventID: safeId("loop"),
    runID,
    taskID,
    stepID,
    subtaskID: rootSubtaskID(),
    type: "action_observed",
    status: call.status,
    action: stepResult.action,
    expectedResultContract: stepResult.expectedResultContract.contractID,
    observationPath: observation.artifactPath,
    resultPath: stepResult.artifactPath,
    createdAt,
  });
  appendNDJSON(join(runDir, "planner-decisions.ndjson"), {
    schemaVersion: "agent-planner-decision-v1",
    decisionID: safeId("decision"),
    runID,
    taskID,
    stepID,
    subtaskID: rootSubtaskID(),
    decision: call.status === "completed" ? "continue_after_observation" : "continue_with_degraded_observation",
    reason: call.outputSummary || call.status,
    createdAt,
  });
}

function recordFinalLoopStep(runDir, { runID, taskID, finalReadModel, toolObservations }) {
  const stepID = "step-final-output";
  const createdAt = now();
  const cmcGate = toolObservations?.cmcFreshnessGate || {};
  const status = finalReadModel?.status || "completed";
  const evidenceRequirements = [
    {
      requirementID: "cmc-research-or-price-evidence",
      status: cmcGate.allowResearchConclusion || cmcGate.allowConcretePrices ? "satisfied" : "missing_or_empty",
      researchEvidenceStatus: cmcGate.researchEvidenceStatus || null,
      priceSnapshotStatus: cmcGate.priceSnapshotStatus || null,
      readableEvidenceCount: Number(cmcGate.readableEvidenceCount || 0),
      emptyEvidenceReason: cmcGate.emptyEvidenceReason || null,
    },
  ];
  const stepResult = {
    schemaVersion: "agent-step-result-v1",
    stepID,
    runID,
    taskID,
    subtaskID: rootSubtaskID(),
    action: {
      kind: "final_output",
      status,
      outputGuardStatus: finalReadModel?.outputGuardStatus || toolObservations?.outputGuard?.status || "unknown",
      productMutationPolicy: finalReadModel?.productMutationPolicy?.status || "unknown",
    },
    evidenceRequirements,
    finalReadModelPath: finalReadModel?.artifactPath || loopArtifactPath(runID, "agent-final-read-model.json"),
    status,
    createdAt,
    artifactPath: loopArtifactPath(runID, "step-results/step-final-output.json"),
  };
  writeJSON(join(runDir, "step-results", "step-final-output.json"), stepResult);
  appendNDJSON(join(runDir, "agent-loop.ndjson"), {
    schemaVersion: "agent-loop-event-v1",
    eventID: safeId("loop"),
    runID,
    taskID,
    stepID,
    subtaskID: rootSubtaskID(),
    type: "finalized",
    status,
    resultPath: stepResult.artifactPath,
    finalReadModelPath: stepResult.finalReadModelPath,
    createdAt,
  });
  appendNDJSON(join(runDir, "planner-decisions.ndjson"), {
    schemaVersion: "agent-planner-decision-v1",
    decisionID: safeId("decision"),
    runID,
    taskID,
    stepID,
    subtaskID: rootSubtaskID(),
    decision: "finish",
    reason: finalReadModel?.productMutationPolicy?.reason || finalReadModel?.outputGuardReason || "final_read_model_written",
    createdAt,
  });
  updatePlannerLoopStatus(runDir, {
    status,
    currentStepID: stepID,
    evidenceRequirements,
    blockedReasons: finalReadModel?.productMutationPolicy?.status === "discarded"
      ? [finalReadModel.productMutationPolicy.reason || "product_mutations_discarded"]
      : [],
  });
}

function readControlState(runDir) {
  return readJSON(join(runDir, "control-state.json"), { action: "running", updatedAt: now() });
}

function writeControlState(runDir, action) {
  const state = { schemaVersion: "agent-run-control-state-v1", action, updatedAt: now() };
  writeJSON(join(runDir, "control-state.json"), state);
  return state;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function ensureMongoReady({ attempts = 10, delayMs = 500 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await mongoStore.connect();
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error(`mongodb_unavailable:${lastError?.message || lastError}`);
}

async function waitIfPausedOrCancelled(runDir, runID, taskID) {
  let pauseLogged = false;
  while (true) {
    const state = readControlState(runDir);
    if (state.action === "cancel") {
      appendEvent(runDir, { type: "run.cancelled", runID, taskID, stage: "cancelled", status: "cancelled", reason: "User cancelled the run." });
      return "cancelled";
    }
    if (state.action !== "pause") return "running";
    if (!pauseLogged) {
      appendEvent(runDir, { type: "run.paused", runID, taskID, stage: "paused", status: "paused", reason: "User paused the run." });
      pauseLogged = true;
    }
    await sleep(250);
  }
}

function safeToolDetail(value) {
  const seen = new WeakSet();
  function visit(item, key = "") {
    if (item === null || item === undefined) return item;
    if (typeof item === "string") {
      if (/text|content|excerpt|sender|from|authorization|cookie|api.?key|request/i.test(key)) {
        return "[REDACTED]";
      }
      return redact(item).slice(0, 300);
    }
    if (typeof item !== "object") return item;
    if (seen.has(item)) return "[Circular]";
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 8).map((entry) => visit(entry, key));
    const output = {};
    for (const [childKey, childValue] of Object.entries(item)) {
      if (/authorization|cookie|api.?key|requestBody|rawRequest|rawTranscript/i.test(childKey)) {
        output[childKey] = "[REDACTED]";
      } else if (/preview|messages|message|text|content|excerpt|sender|from/i.test(childKey)) {
        output[childKey] = "[REDACTED]";
      } else {
        output[childKey] = visit(childValue, childKey);
      }
    }
    return output;
  }
  return visit(value);
}

function summarizeToolResult(toolName, result) {
  const details = result?.details || {};
  const summary = details?.summary || details;
  const count = summary?.messageCount ?? summary?.count ?? summary?.payload?.crystals?.length ?? summary?.payload?.tasks?.length;
  const artifact = details?.artifactPath || summary?.artifactPath || summary?.marketSnapshotArtifact || summary?.path;
  if (count !== undefined && artifact) return `${toolName} completed; ${count} item(s), artifact ${artifact}.`;
  if (artifact) return `${toolName} completed; artifact ${artifact}.`;
  if (typeof result?.outputSummary === "string" && !result.outputSummary.trim().startsWith("{")) return redact(result.outputSummary).slice(0, 240);
  return `${toolName} completed within local runtime boundary.`;
}

function writeToolDetails(runDir, callID, toolName, result) {
  const detailsDir = join(runDir, "tool-details");
  mkdirSync(detailsDir, { recursive: true });
  const path = join(detailsDir, `${callID}.json`);
  const payload = {
    schemaVersion: "agent-tool-call-details-v1",
    toolName,
    status: result?.status || "completed",
    details: safeToolDetail(result?.details || {}),
    redactionStatus: "redacted_summary_only",
    rawPrivateTranscriptIncluded: false,
    rawProviderRequestIncluded: false,
    generatedAt: now(),
  };
  writeJSON(path, payload);
  return relative(projectRoot, path).replaceAll("\\", "/");
}

function providerReadiness() {
  const providers = readJSON(providersPath, { providers: [] }).providers || [];
  return providers.map((provider) => {
    const missingEnv = (provider.requiredEnv || []).filter((name) => !String(process.env[name] || "").trim());
    const baseUrl = String(process.env[provider.baseUrlEnv] || provider.defaultBaseUrl || "").replace(/\/+$/, "");
    const model = String(process.env[provider.defaultModelEnv] || provider.defaultModel || "");
    return {
      provider: provider.provider,
      role: provider.role,
      ready: missingEnv.length === 0 && Boolean(baseUrl),
      missingEnv,
      apiKeyEnv: provider.apiKeyEnv,
      baseUrlConfigured: Boolean(baseUrl),
      model,
      rawSecretsReturned: false,
      requestBodyReturned: false,
    };
  });
}

function extensionPackageStatuses(piStatus = null) {
  const status = piStatus || piKernel.status();
  const registered = new Set(status?.registeredTools || []);
  return discoverExtensionPackages().map((item) => {
    const manifest = item.manifest || {};
    const internalTools = Array.isArray(manifest.internalTools) ? manifest.internalTools : [];
    const missingInternalTools = internalTools.filter((tool) => !registered.has(tool));
    const initialized = Boolean(status?.initialized);
    let configuredState = "mounted";
    let publicStatus = item.available ? "available" : "missing";
    let publicSummary = manifest.publicExtension?.permissionSummary || "能力包已挂载。";

    if (manifest.id === "cmc-skill-hub") {
      const readiness = cmcProviderReadiness();
      configuredState = readiness.connectionState;
      publicStatus = readiness.ready ? "configured" : "degraded";
      if (readiness.mcpHttpConfigured) {
        publicSummary = "CMC MCP 已配置；后端会优先通过 MCP 刷新行情。";
      } else if (readiness.mcpBridgeConfigured) {
        publicSummary = "CMC bridge 已配置；后端会通过 bridge 刷新行情。";
      } else if (readiness.restAPIKeyConfigured) {
        publicSummary = "CMC REST fallback 已配置；MCP 未配置。";
      } else {
        publicSummary = "CMC MCP 未配置；当前只能降级到本地缓存或样例数据。";
      }
    }

    if (manifest.id === "wechat-cli") {
      configuredState = wechatLiveEnabled() ? "read_only_live_refresh_configured" : "read_only_live_refresh_disabled";
      publicStatus = "available";
      publicSummary = wechatLiveEnabled()
        ? "WeChatCLI 只读刷新已启用；发送和外部发布保持阻断。"
        : "WeChatCLI 能力包已挂载；live 只读刷新未启用。";
    }

    if (initialized && missingInternalTools.length) {
      publicStatus = "degraded";
      configuredState = "tool_registration_incomplete";
      publicSummary = "能力包已发现，但部分声明工具没有成功注册。";
    }

    return {
      id: item.id,
      extensionID: manifest.publicExtension?.extensionID || item.id,
      title: manifest.publicExtension?.title || manifest.title || item.id,
      mountState: item.available ? "mounted" : "missing_extension_entry",
      configuredState,
      publicStatus,
      publicSummary,
      manifestToolCount: internalTools.length,
      registeredToolCount: internalTools.filter((tool) => registered.has(tool)).length,
      missingInternalTools,
      piInitialized: initialized,
      rawSecretsReturned: false,
      requestBodyReturned: false,
    };
  });
}

function cmcAPIKeyConfigured() {
  return Boolean(String(process.env.CMC_PRO_API_KEY || process.env.COINMARKETCAP_API_KEY || "").trim());
}

function cmcMcpAPIKeys() {
  const values = [
    process.env.CMC_MCP_API_KEY,
    process.env.CMC_MCP_API_KEYS,
    process.env.CMC_PRO_API_KEY,
    process.env.COINMARKETCAP_API_KEY,
  ];
  const seen = new Set();
  const keys = [];
  for (const value of values) {
    for (const item of String(value || "").split(/[,\s]+/)) {
      const key = item.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function cmcMcpAPIKey() {
  return cmcMcpAPIKeys()[0] || "";
}

function cmcMcpEndpointURL() {
  return String(process.env.CMC_MCP_ENDPOINT || defaultCmcMcpEndpoint || "https://mcp.coinmarketcap.com/skill-hub/stream").replace(/\/+$/, "");
}

function cmcMcpConfigured() {
  return Boolean(cmcMcpEndpointURL() && cmcMcpAPIKey());
}

let cmcProxyDispatcher = null;

function isLoopbackURL(value) {
  try {
    const url = new URL(String(value));
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function cmcFetchOptions(options = {}, targetURL = null) {
  if (!cmcHTTPProxy || isLoopbackURL(targetURL)) return options;
  cmcProxyDispatcher ||= new ProxyAgent(cmcHTTPProxy);
  return {
    ...options,
    dispatcher: cmcProxyDispatcher,
  };
}

function cmcBridgeConfigured() {
  return Boolean(cmcSkillHubBridgeCommand());
}

function cmcSkillHubBridgeCommand() {
  return String(process.env.CMC_SKILL_HUB_BRIDGE_CMD || cmcSkillHubBridgeCmd || "").trim();
}

function cmcCLIStatus() {
  const raw = String(process.env.CMC_CLI_CMD || process.env.CMC_CLI_PATH || "cmc").trim();
  const parts = splitCommandLine(raw);
  const [cmd, ...extraArgs] = parts.length ? parts : ["cmc"];
  try {
    const res = spawnSync(cmd, [...extraArgs, "--version"], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME || "",
        LANG: process.env.LANG || "en_US.UTF-8",
      },
    });
    const versionText = `${res.stdout || ""}${res.stderr || ""}`.trim().split(/\r?\n/)[0] || null;
    return {
      configured: !res.error && res.status === 0,
      status: !res.error && res.status === 0 ? "available" : "not_installed",
      version: versionText ? redact(versionText).slice(0, 120) : null,
    };
  } catch {
    return { configured: false, status: "not_installed", version: null };
  }
}

function cmcProviderReadiness() {
  const normalizedPath = join(projectRoot, "runtime", "market", "cmc-skill-hub.normalized.json");
  const mcpKeyCount = cmcMcpAPIKeys().length;
  const configuredProviders = [
    cmcMcpConfigured() ? "mcp_http" : null,
    cmcBridgeConfigured() ? "mcp_bridge" : null,
    cmcAPIKeyConfigured() ? "rest" : null,
    existsSync(normalizedPath) ? "normalized" : null,
  ].filter(Boolean);
  const liveConfigured = cmcMcpConfigured() || cmcBridgeConfigured() || cmcAPIKeyConfigured();
  const connectionState = cmcMcpConfigured()
    ? "configured"
    : cmcBridgeConfigured()
      ? "configured"
      : cmcAPIKeyConfigured()
        ? "fallback_rest_configured"
        : existsSync(normalizedPath)
          ? "degraded_normalized_file"
          : "missing_key";
  return {
    provider: "coinmarketcap",
    role: "market_data",
    ready: liveConfigured,
    state: liveConfigured ? "configured" : "degraded",
    connectionState,
    configured: liveConfigured,
    connected: false,
    degraded: !liveConfigured,
    missingEnv: liveConfigured ? [] : ["CMC_MCP_API_KEY or CMC_SKILL_HUB_BRIDGE_CMD or CMC_PRO_API_KEY"],
    apiKeyEnv: "CMC_MCP_API_KEY",
    baseUrlConfigured: Boolean(cmcBaseURL),
    model: null,
    providerType: cmcMcpConfigured() ? "mcpHttpProvider" : cmcBridgeConfigured() ? "mcpBridgeProvider" : cmcAPIKeyConfigured() ? "cmcRestProvider" : "normalizedFileProvider",
    providerOrder: cmcProviderOrder,
    mcpEndpointConfigured: Boolean(cmcMcpEndpointURL()),
    mcpHttpConfigured: cmcMcpConfigured(),
    mcpKeyCount,
    mcpBridgeConfigured: cmcBridgeConfigured(),
    restAPIKeyConfigured: cmcAPIKeyConfigured(),
    cliConfigured: cmcCLIStatus().configured,
    configuredProviders,
    ttlSeconds: cmcRefreshTTLSeconds,
    rawSecretsReturned: false,
    requestBodyReturned: false,
  };
}

function wechatProviderReadiness() {
  return {
    provider: "wechat-cli",
    role: "local_private_messages",
    ready: wechatLiveEnabled(),
    missingEnv: wechatLiveEnabled() ? [] : ["WECHAT_LIVE_ENABLED"],
    apiKeyEnv: null,
    baseUrlConfigured: false,
    model: null,
    mode: "read_only_auto_refresh_when_enabled",
    autoInjectIntoModel: "summary_artifact_only",
    rawTranscriptReturned: false,
  };
}

function bridgeHealth() {
  const bridgeRoot = join(projectRoot, "runtime", "bridges");
  const configured = [
    cmcMcpConfigured()
      ? {
        id: "cmc-mcp-http",
        name: "CoinMarketCap MCP",
        kind: "mcp_streamable_http",
        status: "configured",
        freshness: "unknown",
        permission: "local_read_provider_refresh",
        lastRunAt: null,
        lastSuccessAt: null,
        artifactPath: "runtime/market/cmc-skill-hub.normalized.json",
        blockedReason: null,
        lastError: null,
      }
      : null,
    cmcBridgeConfigured()
      ? {
        id: "cmc-skill-hub-bridge",
        name: "CoinMarketCap Skill Hub bridge",
        kind: "mcp_bridge_command",
        status: "configured",
        freshness: "unknown",
        permission: "local_read_provider_refresh",
        lastRunAt: null,
        lastSuccessAt: null,
        artifactPath: "runtime/market/cmc-skill-hub.normalized.json",
        blockedReason: null,
        lastError: null,
      }
      : null,
  ].filter(Boolean);
  if (!existsSync(bridgeRoot)) return configured;
  return [
    ...configured,
    ...readdirSync(bridgeRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(bridgeRoot, name);
      const payload = readJSON(path, {});
      return {
        id: payload.id || name.replace(/\.json$/, ""),
        name: payload.name || name,
        kind: payload.kind || "external_agent",
        status: payload.status || "unknown",
        freshness: payload.freshness || "unknown",
        permission: payload.permission || "local_read",
        lastRunAt: payload.lastRunAt || null,
        lastSuccessAt: payload.lastSuccessAt || null,
        artifactPath: payload.artifactPath || `runtime/bridges/${name}`,
        blockedReason: payload.blockedReason || null,
        lastError: payload.lastError || null,
      };
    }),
  ];
}

function health() {
  ensureDirs();
  const registry = readJSON(registryPath, { capabilities: [], tools: [] });
  const surface = publicSurface();
  const status = {
    schemaVersion: "agent-runtime-host-health-v1",
    status: "available",
    daemon: {
      pid: process.pid,
      host,
      port,
      startedAt: daemonStartedAt,
      runtimeRoot,
    },
    runtimeHost: {
      framework: "@earendil-works/pi-coding-agent",
      sdkVersion: PI_KERNEL_SDK_VERSION,
      nodeVersion: process.version,
      requiredNodeVersion: ">=22.19.0",
      initialized: piKernel.status().initialized,
      extensionPackages: discoverExtensionPackages().map((item) => item.id),
      controlPlane: {
        status: "available",
        artifactContract: "agent-control-plane-manifest-v1",
        runArtifacts: "runtime/agent/runs/{runID}",
      },
      contextPlane: {
        status: "available",
        visibility: "internal",
        publicSurfaceExposed: false,
      },
    },
    piRuntime: piKernel.status(),
    providers: [...providerReadiness(), cmcProviderReadiness(), wechatProviderReadiness()],
    bridges: bridgeHealth(),
    capabilities: registry.capabilities || [],
    skills: surface.skills || [],
    extensions: surface.extensions || [],
    templates: surface.templates || [],
    tools: [],
    internalToolsExposed: false,
    policy: {
      liveWechat: "read_only_auto_refresh_when_enabled",
      liveWechatCLI: "raw_cli_command_blocked",
      trade: "blocked",
      sendMessage: "blocked",
      publishExternal: "blocked",
      computerUse: "needs_confirmation",
    },
  };
  writeOpsStatus(status);
  return status;
}

function writeOpsStatus(status, runSummary = null) {
  ensureDirs();
  const generatedAt = now();
  const providers = [...providerReadiness(), cmcProviderReadiness(), wechatProviderReadiness()].map((provider) => {
    if (provider.provider !== "coinmarketcap" || !runSummary || runSummary.provider !== "mcpProvider" && runSummary.provider !== "cmcRestProvider" && runSummary.provider !== "normalizedFileProvider" && runSummary.provider !== "fixtureProvider") {
      return provider;
    }
    const ok = runSummary.status === "enabled" || runSummary.status === "ok";
    return {
      ...provider,
      ready: ok && ["mcpProvider", "cmcRestProvider"].includes(runSummary.provider),
      connected: ok && ["mcpProvider", "cmcRestProvider"].includes(runSummary.provider),
      degraded: !ok || !["mcpProvider", "cmcRestProvider"].includes(runSummary.provider),
      state: ok ? "connected" : "degraded",
      connectionState: ok ? "connected" : "tool_execution_failed",
      providerType: runSummary.providerType || provider.providerType,
      lastRunAt: runSummary.updatedAt || generatedAt,
      lastSuccessAt: ok ? (runSummary.updatedAt || generatedAt) : null,
      lastError: ok ? null : runSummary.reason || null,
      assetCount: runSummary.assetCount ?? null,
    };
  });
  const marketDataGate = cmcFreshnessGate();
  const extensionPackages = extensionPackageStatuses(status?.piRuntime || piKernel.status());
  writeJSON(join(opsRoot, "provider-status.json"), {
    schemaVersion: "agent-ops-provider-status-v1",
    generatedAt,
    providers,
    extensionPackages,
    missingProviderCount: providers.filter((item) => !item.ready).length,
    marketDataGate,
    source: "agent_runtime_host",
  });
  writeJSON(join(opsRoot, "dependency-status.json"), {
    schemaVersion: "agent-ops-dependency-status-v1",
    generatedAt,
    runtimeHost: status?.runtimeHost || null,
    node: {
      version: process.version,
      required: ">=22.19.0",
      satisfiesRequired: nodeSatisfiesPiEngine(process.version),
    },
    piFramework: {
      package: "@earendil-works/pi-coding-agent",
      version: PI_KERNEL_SDK_VERSION,
      productFacingName: "Agent Runtime Host",
    },
    rawToolExposure: "hidden_from_frontend",
  });
  writeJSON(join(opsHealthRoot, "agent-runtime-host.json"), {
    schemaVersion: "agent-ops-health-v1",
    generatedAt,
    status: status?.status || "available",
    runtimeHost: status?.runtimeHost || null,
    runSummary,
    healthInputs: [
      "runtime/agent/runs",
      "runtime/ops/provider-status.json",
      "runtime/ops/policy/latest-policy-summary.json",
    ],
  });
  writeJSON(join(opsPolicyRoot, "latest-policy-summary.json"), {
    schemaVersion: "agent-ops-policy-summary-v1",
    generatedAt,
    policy: status?.policy || {
      liveWechat: "read_only_auto_refresh_when_enabled",
      liveWechatCLI: "raw_cli_command_blocked",
      trade: "blocked",
      sendMessage: "blocked",
      publishExternal: "blocked",
      computerUse: "needs_confirmation",
    },
    sensitiveActions: ["trade", "send_message", "publish_external", "computer_use.request", "destructive_file_operation"],
    defaultBoundary: "local_read_market_refresh_pass",
  });
  return true;
}

function toolsForSkill(skillID) {
  return coreToolsForSkill(skillID);
}

function toolsForExtension(extensionID) {
  return coreToolsForExtension(extensionID);
}

const externalCMCToolNames = coreExternalCMCToolNames;

function preferredCMCTool(prompt, selectedSkillIDs = []) {
  return corePreferredCMCTool(prompt, selectedSkillIDs);
}

function cmcToolSelectionDiagnostic(prompt, selectedSkillIDs = [], selectedToolNames = [], finalTools = []) {
  return coreCMCToolSelectionDiagnostic(prompt, selectedSkillIDs, selectedToolNames, finalTools);
}

function pruneDefaultCMCToolFanout(selected, prompt, selectedSkillIDs, selectedToolNames) {
  return corePruneDefaultCMCToolFanout(selected, prompt, selectedSkillIDs, selectedToolNames);
}

function inferTools(prompt, selectedToolNames = [], attachments = [], selectedSkillIDs = [], selectedExtensionIDs = []) {
  return agentRuntimeCore.planTools({ prompt, selectedToolNames, attachments, selectedSkillIDs, selectedExtensionIDs, projectToolNames }).tools;
}

function policyForTool(name) {
  if (blockedActions.has(name)) return "blocked";
  if (name === "computer_use.request") return "needs_confirmation";
  if (localPassTools.has(name)) return "pass";
  return "needs_confirmation";
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let total = 0;
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!["GET", "HEAD"].includes(req.method || "") && contentType && !contentType.includes("application/json")) {
      reject(new HttpError(415, "unsupported_media_type", "Only application/json request bodies are accepted."));
      return;
    }
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxRequestBodyBytes) {
        reject(new HttpError(413, "request_body_too_large", "Request body exceeds local daemon limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch (error) {
        reject(new HttpError(400, "invalid_json", "Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function plannerEnvelope({ prompt, tools, attachments, sessionID, runID, selectedSkillIDs = [], selectedExtensionIDs = [] }) {
  return {
    schemaVersion: "planner-envelope-v1",
    goal: prompt,
    taskType: "wechat_onchain_agent_workspace",
    successCriteria: [
      "stream assistant response into Agent console",
      "record tool calls and policy decisions",
      "write local run artifacts",
      "preserve sensitive action boundaries",
    ],
    constraints: [
      "live WeChat refresh is read-only and may run automatically when WECHAT_LIVE_ENABLED=true; only summary artifact metadata enters model context",
      "do not trade, send messages, or publish externally",
      "API keys are read from environment only",
      "raw request bodies and authorization headers are not persisted",
    ],
    selectedSkills: selectedSkillIDs,
    selectedExtensions: selectedExtensionIDs,
    publicSurfaceOnly: true,
    capabilitiesNeeded: [
      { capabilityId: "planner-runtime", reason: "Build internal auditable orchestration trace.", loadMode: "always_on", contextCost: "low" },
      { capabilityId: "policy-gate", reason: "Gate sensitive tool actions.", loadMode: "always_on", contextCost: "low" },
      { capabilityId: "model-provider", reason: "Stream text response and analyze images when configured.", loadMode: "lazy", contextCost: "medium" },
      { capabilityId: "tool-runner", reason: "Expose Pi-style tool calls.", loadMode: "lazy", contextCost: "medium" },
      { capabilityId: "attachment-runtime", reason: "Analyze image attachments.", loadMode: attachments.length > 0 ? "lazy" : "always_on", contextCost: "low" },
    ],
    internalToolPlan: tools.map((toolName) => ({
      toolIntent: toolName === "computer_use.request" ? "external_web" : "write_private",
      toolName,
      reason: `Resolved internally from selected skill/extension and prompt context.`,
      policyCheckRequired: policyForTool(toolName) !== "pass",
    })),
    parallelizableWorkers: attachments.length > 0 ? [{ component: "image_analysis", reason: "Analyze image attachments before text synthesis.", writeScope: "runtime/agent/attachments" }] : [],
    policyRisks: tools.map((toolName) => ({ actionIntent: toolName, reason: policyForTool(toolName) })),
    requiredArtifacts: [
      "events.ndjson",
      "planner-envelope.json",
      "tool-calls.json",
      "model-route.json",
      "attachments.json",
      "policy-decisions.json",
      "product-mutations.json",
      "final-output.md",
      "agent-final-read-model.json",
    ],
    stopConditions: ["policy blocked", "provider unavailable", "run cancelled"],
    fixedWorkflow: false,
    rawSecretsReturned: false,
    rawTranscriptIncluded: false,
    sessionID,
    runID,
    createdAt: now(),
  };
}

function toolCallsFor(tools) {
  return tools.map((toolName) => ({
    id: safeId("tool"),
    toolName,
    status: policyForTool(toolName) === "blocked" ? "blocked" : "completed",
    permission: policyForTool(toolName),
    inputSummary: "Generated from selected skill/extension and prompt context.",
    outputSummary:
      policyForTool(toolName) === "pass"
        ? `Local artifact boundary accepted for ${toolName}.`
        : `No execution performed; ${toolName} requires ${policyForTool(toolName)}.`,
    artifactPath: "runtime/agent/runs/{runID}/tool-calls.json",
    createdAt: now(),
  }));
}

async function callOpenAICompatible({ providerName, messages, model, stream = true }) {
  const providers = readJSON(providersPath, { providers: [] }).providers || [];
  const provider = providers.find((item) => item.provider === providerName);
  if (!provider) return { status: "blocked", reason: "provider_missing" };
  const apiKey = String(process.env[provider.apiKeyEnv] || "").trim();
  const baseUrl = String(process.env[provider.baseUrlEnv] || provider.defaultBaseUrl || "").replace(/\/+$/, "");
  const selectedModel = model || String(process.env[provider.defaultModelEnv] || provider.defaultModel || "");
  const temperature = providerName === "kimi" ? 1 : 0.2;
  if (!apiKey || !baseUrl || !selectedModel) {
    return { status: "blocked", reason: "blocked_missing_provider_config", provider: providerName, model: selectedModel };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.WECHAT_AGENT_MODEL_TIMEOUT_MS || "120000"));
  try {
    const response = await fetch(`${baseUrl}${provider.chatCompletionsPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: selectedModel,
        messages,
        stream,
        temperature,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText = (await response.text()).slice(0, 500);
      return { status: "blocked", reason: "provider_http_error", provider: providerName, model: selectedModel, statusCode: response.status, errorPreview: redact(errorText) };
    }
    if (!stream) {
      const payload = await response.json();
      return { status: "completed", provider: providerName, model: selectedModel, text: payload?.choices?.[0]?.message?.content || "" };
    }
    return { status: "streaming", provider: providerName, model: selectedModel, response };
  } catch (error) {
    return { status: "blocked", reason: "provider_request_failed", provider: providerName, model: selectedModel, errorPreview: redact(String(error?.message || error)) };
  } finally {
    clearTimeout(timeout);
  }
}

function redact(value) {
  return String(value)
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9._-]{12,}/g, "sk-[REDACTED]")
    .slice(0, 800);
}

function safeStreamVisibleText(text) {
  const cleaned = stripInternalSurface(stripProcessPreamble(text));
  // Hold a trailing partial XML-ish tag until the next chunk proves it is normal prose.
  // This prevents chunks like "<func" from flashing before the full <function_calls> block
  // can be recognized and removed.
  return cleaned.replace(/<[/A-Za-z_][^>\n]{0,120}$/i, "");
}

async function streamProviderToEvents(providerResult, runDir, runID = null, taskID = null) {
  if (providerResult.status !== "streaming") {
    appendEvent(runDir, { type: "model.blocked", runID, taskID, stage: "model_route", status: providerResult.status, reason: providerResult.reason, provider: providerResult.provider, model: providerResult.model, errorPreview: providerResult.errorPreview });
    return "";
  }
  let finalText = "";
  let visibleText = "";
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of providerResult.response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const payload = JSON.parse(data);
        const delta = payload?.choices?.[0]?.delta?.content || "";
        if (delta) {
          finalText += delta;
          const nextVisibleText = safeStreamVisibleText(finalText);
          if (nextVisibleText.startsWith(visibleText)) {
            const visibleDelta = nextVisibleText.slice(visibleText.length);
            if (visibleDelta) {
              appendEvent(runDir, { type: "assistant.delta", runID, taskID, stage: "model_stream", delta: visibleDelta, provider: providerResult.provider, model: providerResult.model });
            }
          }
          visibleText = nextVisibleText;
        }
      } catch {
        appendEvent(runDir, { type: "assistant.delta.raw", runID, taskID, stage: "model_stream", delta: redact(data), provider: providerResult.provider, model: providerResult.model });
      }
    }
  }
  return finalText;
}

function modelAttemptCandidates(modelRoute = {}) {
  const candidates = [
    modelRoute.selectedTextModel,
    ...(Array.isArray(modelRoute.eligibleFallbackModels) ? modelRoute.eligibleFallbackModels : []),
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return [...new Set(candidates)];
}

function modelFailureNote(modelRoute = {}) {
  const attempts = Array.isArray(modelRoute.attempts) ? modelRoute.attempts : [];
  if (attempts.length && attempts.every((item) => item.status !== "completed")) {
    return "模型调用失败；以下仅为本地结构化摘要，不是 LLM 研究结论。";
  }
  if (modelRoute.fallbackUsed && modelRoute.finalModel && modelRoute.selectedTextModel) {
    return `模型路由：${modelRoute.finalModel} · fallback from ${modelRoute.selectedTextModel}。`;
  }
  return "";
}

function finalizeModelRoute(modelRoute, attempts, finalModel = null) {
  const fallbackUsed = Boolean(finalModel && modelRoute?.selectedTextModel && finalModel !== modelRoute.selectedTextModel);
  return {
    ...modelRoute,
    attempts,
    finalModel,
    fallbackUsed,
    userVisibleNoteRequired: fallbackUsed || (attempts.length > 0 && attempts.every((item) => item.status !== "completed")),
    completedAt: now(),
  };
}

async function callTextModelWithFallback({ modelRoute, messages, runDir, runID, taskID }) {
  const candidates = modelAttemptCandidates(modelRoute);
  const attempts = [];
  for (const model of candidates) {
    appendEvent(runDir, { type: "model.attempt.started", runID, taskID, stage: "model_route", provider: "deepseek", model });
    const providerResult = await callOpenAICompatible({
      providerName: "deepseek",
      model,
      stream: true,
      messages,
    });
    if (providerResult.status !== "streaming") {
      attempts.push({
        provider: providerResult.provider || "deepseek",
        model,
        status: "failed",
        reason: providerResult.reason || providerResult.status || "provider_unavailable",
        statusCode: providerResult.statusCode || null,
        errorPreview: providerResult.errorPreview || null,
        attemptedAt: now(),
      });
      appendEvent(runDir, { type: "model.attempt.failed", runID, taskID, stage: "model_route", provider: "deepseek", model, status: providerResult.status, reason: providerResult.reason, errorPreview: providerResult.errorPreview });
      continue;
    }
    const text = await streamProviderToEvents(providerResult, runDir, runID, taskID);
    if (String(text || "").trim()) {
      attempts.push({
        provider: "deepseek",
        model,
        status: "completed",
        reason: "ok",
        attemptedAt: now(),
      });
      return { text, modelRoute: finalizeModelRoute(modelRoute, attempts, model) };
    }
    attempts.push({
      provider: "deepseek",
      model,
      status: "failed",
      reason: "empty_model_output",
      attemptedAt: now(),
    });
    appendEvent(runDir, { type: "model.attempt.failed", runID, taskID, stage: "model_route", provider: "deepseek", model, status: "failed", reason: "empty_model_output" });
  }
  return { text: "", modelRoute: finalizeModelRoute(modelRoute, attempts, null) };
}

function finalCopyDeps() {
  return {
    cmcFreshnessGate,
    buildCMCCapabilitySummary,
    displayGateReason,
    displayProvider,
    displayFreshness,
    redact,
    publicSkillHubSummary,
    cmcCapabilitySummaryLine,
  };
}

function deterministicAssistantText(prompt, tools, policies, attachments, selectedSkillIDs = [], selectedExtensionIDs = [], toolObservations = null) {
  return agentRuntimeCore.buildDeterministicAssistantText({
    prompt,
    tools,
    policies,
    attachments,
    selectedSkillIDs,
    selectedExtensionIDs,
    toolObservations,
  }, finalCopyDeps());
}

function isMarketSensitiveRun(prompt, tools = []) {
  return coreIsMarketSensitiveRun(prompt, tools);
}

function shouldIncludeSafetyBoundary(prompt, tools = [], policies = []) {
  return coreShouldIncludeSafetyBoundary(prompt, tools, policies);
}

function stripProcessPreamble(text) {
  const processLine = /^(我将|我会|先|接下来).*(刷新|扫描|读取|拉取|调用|静默|过程|计划|上下文验证|开始).*[。.]?$/;
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^(计划|上下文验证)\s*\d*[:：]?/.test(trimmed)) return false;
      if (processLine.test(trimmed)) return false;
      if (/整个过程.*最终/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function internalSurfaceViolations(text) {
  const value = String(text || "");
  const patterns = [
    [/<\/?looloomi-tool-calls\b/i, "raw_tool_call_markup"],
    [/<\/?function_calls\b/i, "raw_function_call_markup"],
    [/<\/?invoke\b/i, "raw_function_invoke_markup"],
    [/<\/?callname\b/i, "raw_tool_name_markup"],
    [/\binvokename\s*=/i, "raw_function_name"],
    [/\bparametername\s*=/i, "raw_function_parameter"],
    [/\bparameters?\s*=/i, "raw_tool_parameters"],
    [/<\/?parameter\b/i, "raw_tool_parameter_markup"],
    [/\bruntime\/(?:agent|market|runs|ops)\//i, "raw_runtime_path"],
    [/\/Users\/[^\s]+/i, "raw_local_path"],
    [/\b(?:tool-observations|tool-calls|run-manifest|context-bundle|final-output|provider-status)\.json\b/i, "raw_artifact_filename"],
    [/\b(?:artifactPath|detailsArtifactPath|runID|taskID|sessionID|schemaVersion|cmcFreshnessGate|outputGuard|artifactKind|inputSummary|outputSummary|redactionStatus)\b/i, "raw_backend_field"],
    [/\b(?:mcpProvider|cmcRestProvider|normalizedFileProvider|fixtureProvider|mcpHttpProvider|drillrProviderDeferred|drillr)\b/i, "raw_provider_id"],
    [/^\s*[-*]?\s*(?:Skill|Extension)\s*[：:]\s*(?:自动判断|[a-z0-9_.-]+(?:\s*,\s*[a-z0-9_.-]+)*)\s*$/im, "raw_public_capability_id_list"],
    [/\b(?:cmc-skill-hub|cmc-market-radar|wechat-cli-export-bridge|wechat-onchain-intelligence|market-regime-review|social-price-divergence|office-meeting-agent|feishu-agent-bridge|markets-research|equity-company-deep-dive|equity-earnings-review|equity-thesis-tracker|equity-sector-scan|macro-cross-asset-readthrough|cc-equity-research|InvestSkill)\b/i, "raw_public_capability_id"],
    [/\bmarkets\.[a-z0-9_.-]+\b/i, "raw_internal_tool_id"],
  ];
  return patterns.filter(([pattern]) => pattern.test(value)).map(([, label]) => label);
}

function stripInternalSurface(text) {
  let value = String(text || "")
    .replace(/<looloomi-tool-calls[\s\S]*?(?:<\/looloomi-tool-calls>|$)/gi, "")
    .replace(/<function_calls[\s\S]*?(?:<\/function_calls>|$)/gi, "")
    .replace(/<invoke\b[\s\S]*?(?:<\/invoke>|$)/gi, "");
  return value
    .split(/\r?\n/)
    .filter((line) => !internalSurfaceViolations(line).length)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function displayProvider(provider) {
  switch (provider) {
    case "cmcRestProvider": return "CoinMarketCap 实时接口";
    case "mcpProvider": return "CoinMarketCap MCP";
    case "normalizedFileProvider": return "本地缓存";
    case "fixtureProvider": return "样例数据";
    case null:
    case undefined:
    case "":
      return "未连接";
    default:
      return "市场数据源";
  }
}

function displayFreshness(freshness) {
  switch (freshness) {
    case "fresh": return "最新";
    case "degraded": return "降级";
    case "stale": return "过期";
    case "fixture": return "样例";
    case "missing": return "缺失";
    default: return freshness ? "状态未知" : "缺失";
  }
}

function displayGateReason(reason) {
  const value = String(reason || "");
  if (!value) return "缺少可验证的实时市场数据。";
  if (/CREDIT_EXHAUSTED|credit exhausted|weekly limit/i.test(value)) return "CMC Skill Marketplace MCP 已连接，但本周调用额度已用完。";
  if (value.includes("provider_not_live")) return "当前只读到本地缓存或样例数据，不能作为实时行情。";
  if (value.includes("snapshot_expired")) return "市场快照已过期。";
  if (value.includes("provider_missing") || value.includes("schema_missing")) return "市场快照缺少可信来源标识。";
  if (value.includes("asset_live_or_price_invalid")) return "资产价格或实时标识未通过校验。";
  if (value.includes("tool_observations_missing")) return "本轮缺少可信工具观测记录。";
  if (value.includes("concrete_market_values_without_fresh_gate")) return "输出包含未经实时数据门禁确认的具体价位。";
  return "实时数据门禁未通过。";
}

function publicSkillHubSummary(summary) {
  const value = redact(summary || "").trim();
  if (!value) return "CMC Skill Hub 调用成功，但 App 未解析到更具体的结构化结论。";
  if (/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+ returned CMC Skill Hub evidence\./i.test(value)) {
    return "CMC Skill Hub 调用成功，返回通用结果摘要；App 未解析到更具体的结构化结论。";
  }
  return value.replace(/\b(?:daily_market_overview|crypto_macro_overview|detect_market_regime|track_social_price_divergence|classify_kline_pattern_quality|build_daily_market_brief)\b/gi, "CMC Skill Hub");
}

function marketNumberTokenVariants(value) {
  const cleaned = String(value || "")
    .replace(/[$¥,\s]/g, "")
    .replace(/[^\d.-]/g, "")
    .replace(/\.$/, "");
  if (!cleaned || cleaned === "." || cleaned === "-") return [];
  const variants = new Set([cleaned]);
  const numeric = Number(cleaned);
  if (Number.isFinite(numeric)) variants.add(String(numeric));
  return [...variants].filter(Boolean);
}

function marketNumberTokens(text) {
  const pattern = /[$¥]?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\b\d{4,}(?:\.\d+)?\b|\b0\.\d{4,}\b|\b\d{1,3}\.\d{1,8}\b/g;
  const matches = String(text || "").match(pattern) || [];
  return [...new Set(matches.flatMap((item) => marketNumberTokenVariants(item)))];
}

function marketNumberTokenSet(text) {
  return new Set(marketNumberTokens(text));
}

function lineNumbersAllowedBySkillHub(line, allowedTokens) {
  const lineTokens = marketNumberTokens(line);
  return lineTokens.length > 0 && lineTokens.every((token) => allowedTokens.has(token));
}

function concreteMarketViolations(text, { allowedCorpus = "" } = {}) {
  const value = String(text || "");
  const marketTerms = /(价位|价格|支撑|阻力|突破|跌破|站稳|回踩|区间|关键位|止盈|止损|entry|exit|support|resistance|breakout|breakdown|price|level)/i;
  const concreteNumber = /([$¥]?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\b\d{4,}(?:\.\d+)?\b|\b0\.\d{4,}\b|\b\d{1,3}\.\d{1,8}\b)/;
  const violations = [];
  const allowedTokens = marketNumberTokenSet(allowedCorpus);
  for (const line of value.split(/\r?\n/)) {
    if (marketTerms.test(line) && concreteNumber.test(line)) {
      if (lineNumbersAllowedBySkillHub(line, allowedTokens)) continue;
      violations.push(redact(line.trim()).slice(0, 180));
    }
  }
  if (/82,?800/.test(value) && !allowedTokens.has("82800")) violations.push("untrusted_82800_regression");
  return [...new Set(violations)].slice(0, 8);
}

function stripConcreteMarketViolationLines(text, { allowedCorpus = "" } = {}) {
  const allowedTokens = marketNumberTokenSet(allowedCorpus);
  const marketTerms = /(价位|价格|支撑|阻力|突破|跌破|站稳|回踩|区间|关键位|止盈|止损|entry|exit|support|resistance|breakout|breakdown|price|level)/i;
  const concreteNumber = /([$¥]?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\b\d{4,}(?:\.\d+)?\b|\b0\.\d{4,}\b|\b\d{1,3}\.\d{1,8}\b)/;
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => {
      if (!marketTerms.test(line) || !concreteNumber.test(line)) return true;
      return lineNumbersAllowedBySkillHub(line, allowedTokens);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function degradedMarketFinalText({ prompt, tools, toolObservations, reason }) {
  return agentRuntimeCore.buildDegradedMarketFinalText({ prompt, tools, toolObservations, reason }, finalCopyDeps());
}

function createDaemonGateEngine() {
  return createGateEngine({
    now,
    stripProcessPreamble,
    internalSurfaceViolations,
    stripInternalSurface,
    isMarketSensitiveRun,
    skillHubReturnedTextCorpus,
    concreteMarketViolations,
    stripConcreteMarketViolationLines,
    degradedMarketFinalText,
  });
}

function guardFinalOutput({ text, prompt, tools, toolObservations }) {
  return agentRuntimeCore.guardFinalOutput({ text, prompt, tools, toolObservations });
}

function sanitizePublicFinalText(text) {
  const rawCapabilityLine = /^\s*[-*]?\s*(?:Skill|Extension)\s*[：:]\s*(?:自动判断|[a-z0-9_.-]+(?:\s*,\s*[a-z0-9_.-]+)*)\s*$/i;
  const rawCapabilityID = /\b(?:cmc-skill-hub|cmc-market-radar|wechat-cli-export-bridge|wechat-onchain-intelligence|market-regime-review|social-price-divergence|office-meeting-agent|feishu-agent-bridge|markets-research|equity-company-deep-dive|equity-earnings-review|equity-thesis-tracker|equity-sector-scan|macro-cross-asset-readthrough|cc-equity-research|InvestSkill|mcpProvider|cmcRestProvider|normalizedFileProvider|fixtureProvider|mcpHttpProvider|drillrProviderDeferred|drillr|markets\.[a-z0-9_.-]+)\b/i;
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !rawCapabilityLine.test(line) && !rawCapabilityID.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function productMutationPolicyForRun(toolObservations) {
  return agentRuntimeCore.productMutationPolicyForRun(toolObservations);
}

function buildAgentFinalReadModel({ runID, taskID, sessionID, status, finalText, finalTextSource, toolObservations, artifactPath }) {
  return agentRuntimeCore.buildFinalReadModel({
    runID,
    taskID,
    sessionID,
    status,
    finalText,
    finalTextSource,
    toolObservations,
    artifactPath,
    now,
  });
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasCMCCapability(tools = [], selectedSkillIDs = [], selectedExtensionIDs = [], observations = []) {
  return observations.length > 0
    || selectedExtensionIDs.includes("cmc-skill-hub")
    || selectedSkillIDs.some((item) => /^cmc-|market-|social-price/i.test(String(item)))
    || tools.some((tool) => String(tool).startsWith("cmc.") || tool === "market.read_snapshot");
}

function buildCMCCapabilitySummary({ runID = null, toolObservations = null, tools = [], selectedSkillIDs = [], selectedExtensionIDs = [] } = {}) {
  const gate = toolObservations?.cmcFreshnessGate || {};
  const observations = safeArray(toolObservations?.cmcSkillHub?.observations);
  const picked = observations.find((item) => Number(item?.readableEvidenceCount || 0) > 0) || observations[0] || null;
  const readableEvidence = safeArray(picked?.readableEvidence);
  const readableEvidenceCount = firstNumber(picked?.readableEvidenceCount, gate.readableEvidenceCount, gate.researchEvidence?.readableEvidenceCount);
  const mounted = hasCMCCapability(tools, selectedSkillIDs, selectedExtensionIDs, observations);
  const transportStatus = gate.transportStatus
    || (observations.length > 0 ? "ok" : gate.status === "pass" ? "ok" : gate.status || "missing");
  const researchEvidenceStatus = gate.researchEvidenceStatus
    || gate.researchEvidence?.status
    || (readableEvidenceCount > 0 ? "usable" : observations.length > 0 ? "empty" : "missing");
  const priceSnapshotStatus = gate.priceSnapshotStatus
    || gate.priceSnapshot?.status
    || (gate.allowConcretePrices ? "usable" : "blocked");
  const display = gate.skillHubDisplay || skillHubDisplayCandidate(observations);
  const skillHubDisplayStatus = gate.skillHubDisplayStatus || display.status || "missing";
  const allowSkillHubResultDisplay = Boolean(
    gate.allowSkillHubResultDisplay ?? display.allow
  );
  const displayableResultText = gate.displayableResultText
    || display.displayableResultText
    || display.text
    || null;
  const displayableResultSource = gate.displayableResultSource
    || display.displayableResultSource
    || display.source
    || null;
  const parserEvidenceStatus = gate.parserEvidenceStatus
    || display.parserEvidenceStatus
    || (readableEvidenceCount > 0 ? "usable" : observations.length > 0 ? "empty" : "missing");
  const returnedPrice = skillHubReturnedPriceMetadata(observations);
  const allowSkillHubReturnedPrices = Boolean(gate.allowSkillHubReturnedPrices ?? returnedPrice.allowSkillHubReturnedPrices);
  const skillHubReturnedPriceTokenCount = firstNumber(gate.skillHubReturnedPriceTokenCount, returnedPrice.skillHubReturnedPriceTokenCount);
  const returnedContent = buildCMCReturnedContent(picked);
  const renderBlocks = buildCMCRenderBlocks(observations);
  const diagnostics = {
    parserEvidenceStatus,
    researchEvidenceStatus,
    priceSnapshotStatus,
    assetCount: firstNumber(gate.assetCount, gate.priceSnapshot?.assetCount),
    emptyEvidenceReason: picked?.emptyEvidenceReason || gate.emptyEvidenceReason || gate.researchEvidence?.emptyEvidenceReason || null,
    freshness: gate.freshness || null,
    confidence: picked?.confidence || null,
    risk: gate.risk || null,
    sourceTrust: gate.sourceTrust || null,
    degraded: gate.status === "degraded",
  };
  const claimPolicy = {
    appMayAddConcretePrices: Boolean(gate.allowConcretePrices),
    providerReturnedNumbersMayRender: allowSkillHubReturnedPrices,
    appMayAddTradingLevels: Boolean(gate.allowConcretePrices),
  };
  return {
    schemaVersion: "cmc-capability-summary-v1",
    renderSchemaVersion: "cmc-render-result-v1",
    capabilityID: "cmc-skill-hub",
    displayName: "CMC Skill Hub",
    packageTitle: "CMC Skill Hub 能力包",
    runID,
    mountStatus: mounted ? "mounted" : "not_mounted",
    transportStatus,
    provider: gate.provider || picked?.provider || null,
    skill: picked?.skill || null,
    status: picked?.status || gate.status || "unknown",
    confidence: picked?.confidence || null,
    summary: picked?.summary || (observations.length > 0 ? toolObservations?.cmcSkillHub?.instruction || null : null),
    returnedContent,
    renderBlocks,
    diagnostics,
    claimPolicy,
    readableEvidence,
    readableEvidenceCount,
    skillHubDisplayStatus,
    allowSkillHubResultDisplay,
    displayableResultText,
    displayableResultSource,
    parserEvidenceStatus,
    allowSkillHubReturnedPrices,
    skillHubReturnedPriceTokenCount,
    skillHubReturnedTextSource: gate.skillHubReturnedTextSource || returnedPrice.skillHubReturnedTextSource,
    skillHubReturnedTextCharCount: firstNumber(gate.skillHubReturnedTextCharCount, returnedPrice.skillHubReturnedTextCharCount),
    researchEvidenceStatus,
    emptyEvidenceReason: picked?.emptyEvidenceReason || gate.emptyEvidenceReason || gate.researchEvidence?.emptyEvidenceReason || null,
    priceSnapshotStatus,
    assetCount: firstNumber(gate.assetCount, gate.priceSnapshot?.assetCount),
    allowResearchConclusion: Boolean(gate.allowResearchConclusion),
    allowConcretePrices: Boolean(gate.allowConcretePrices),
    missingOrStaleInputs: safeArray(picked?.missingOrStaleInputs || gate.missingOrStaleInputs),
    notableAnomalies: safeArray(picked?.notableAnomalies || gate.notableAnomalies),
    generatedAt: now(),
    sourceObservationCount: observations.length,
    workspaceMutationPolicy: {
      scope: "persistent_workspace_state_only",
      displayEligibleEvenWhenDiscarded: true,
    },
  };
}

function cmcCapabilitySummaryLine(summary) {
  const mountText = summary.mountStatus === "mounted" ? "已挂载" : "未挂载";
  const transportText = summary.transportStatus === "ok" ? "transport ok" : `transport ${summary.transportStatus || "missing"}`;
  const resultText = summary.allowSkillHubResultDisplay || summary.skillHubDisplayStatus === "usable"
    ? "结果可展示"
    : summary.skillHubDisplayStatus === "empty"
      ? "结果为空"
      : summary.skillHubDisplayStatus === "failed"
        ? "结果失败"
        : "结果缺失";
  const pricesText = summary.priceSnapshotStatus === "usable" || summary.allowConcretePrices
    ? "价格可用"
    : summary.priceSnapshotStatus === "empty"
      ? "价格为空"
      : "价格被拦截";
  return `CMC Skill Hub 能力包：${mountText}，${transportText}，${resultText}，${pricesText}。`;
}

async function runAgentTask({ session, prompt, selectedToolNames = [], selectedCapabilityIDs = [], selectedSkillIDs = [], selectedExtensionIDs = [], attachments = [], contextRefs = [], modelPreference = null, runID = safeId("run"), taskID = safeId("task") }) {
  const runDir = safeRunDir(runID);
  writeControlState(runDir, "running");
  const coreRoutePlan = agentRuntimeCore.planTools({ prompt, selectedToolNames, selectedCapabilityIDs, attachments, selectedSkillIDs, selectedExtensionIDs, projectToolNames });
  const inferredTools = coreRoutePlan.tools;
  const toolSelectionDiagnostic = coreRoutePlan.diagnostics;
  writeJSON(join(runDir, "core-route-plan.json"), {
    ...coreRoutePlan,
    runID,
    taskID,
    artifactPath: `runtime/agent/runs/${runID}/core-route-plan.json`,
    generatedAt: now(),
  });
  let piStatus = { initialized: false, lastError: null };
  try {
    await piKernel.ensure();
    piStatus = piKernel.status();
  } catch (error) {
    piStatus = { ...piKernel.status(), lastError: redact(error?.stack || error?.message || error) };
  }

  const controlPlane = buildControlPlane({
    projectRoot,
    runDir,
    runID,
    taskID,
    sessionID: session.sessionID,
    prompt,
    selectedSkillIDs,
    selectedCapabilityIDs,
    selectedExtensionIDs,
    attachments,
    contextRefs,
    tools: inferredTools,
    policyForTool,
    providerReadiness: providerReadiness(),
    piStatus,
    modelPreference,
  });
  const tools = controlPlane.tools;
  const policies = controlPlane.policyDecisions;
  const liveWechat = maybeRefreshLiveWechatForRun(tools);
  const envelope = controlPlane.plannerEnvelope;
  const modelRoute = controlPlane.modelRoute;
  const contextSummary = {
    schemaVersion: "agent-context-plane-summary-v1",
    runID,
    taskID,
    status: controlPlane.contextGate.status,
    sourceCount: controlPlane.contextManifest.sourceCount || 0,
    chunkCount: controlPlane.contextManifest.chunkCount || 0,
    selectedChunkCount: controlPlane.contextBundle.includedChunks?.length || 0,
    missingSourceCount: controlPlane.contextGate.missingSourceCount || 0,
    staleChunkCount: controlPlane.contextGate.staleChunkCount || 0,
    retrievalStrategy: controlPlane.retrievalResults?.strategy || controlPlane.retrievalPlan?.strategy || null,
    sourceTrustCount: controlPlane.sourceTrustReport?.sources?.length || 0,
    contextIndexPath: `runtime/agent/runs/${runID}/context-index.json`,
    retrievalResultsPath: `runtime/agent/runs/${runID}/retrieval-results.json`,
    contextPackPath: `runtime/agent/runs/${runID}/context-pack.json`,
    sourceTrustReportPath: `runtime/agent/runs/${runID}/source-trust-report.json`,
    memoryCompressionPath: `runtime/agent/runs/${runID}/memory-compression.json`,
    privacy: controlPlane.contextGate.privacy,
    artifactPath: `runtime/agent/runs/${runID}/context-bundle.json`,
    updatedAt: now(),
  };
  const controlSummary = {
    schemaVersion: "agent-control-plane-summary-v1",
    runID,
    taskID,
    taskType: controlPlane.taskIntent.taskType,
    profileID: controlPlane.executionProfile.profileID,
    stage: "prepared",
    toolIntentCount: controlPlane.toolIntentPlan.tools?.length || 0,
    policyDecisionCount: policies.length,
    blockedPolicyCount: policies.filter((item) => item.status === "blocked").length,
    approvalDecisionCount: controlPlane.approvalDecisions.length,
    qaStatus: controlPlane.qaGate.status,
    modelReadinessStatus: modelRoute.readinessStatus,
    artifactPath: `runtime/agent/runs/${runID}/control-plane-manifest.json`,
    updatedAt: now(),
  };
  writeJSON(join(runDir, "context-summary.json"), contextSummary);
  writeJSON(join(runDir, "control-summary.json"), controlSummary);
  initializeAgentLoopArtifacts(runDir, {
    runID,
    taskID,
    sessionID: session.sessionID,
    prompt,
    controlPlane,
    tools,
  });
  const harness = initializeHarnessArtifacts(runDir, {
    runID,
    taskID,
    sessionID: session.sessionID,
    prompt,
  });
  recordContextHarnessEvent(runDir, {
    runID,
    taskID,
    sessionID: session.sessionID,
    branchID: harness.branchID,
    stage: "plan",
    controlPlane,
  });
  writeRunManifest(runDir, {
    runID,
    taskID,
    sessionID: session.sessionID,
    status: "running",
    currentStage: "prepared",
    publicSurfaceOnly: true,
    internalToolsExposed: false,
    selectedSkillIDs,
    selectedExtensionIDs,
    contextSummary,
    controlSummary,
    artifacts: [
      artifactRef(runID, "run-manifest.json", "manifest", "run"),
      artifactRef(runID, "control-summary.json", "summary", "control"),
      artifactRef(runID, "context-summary.json", "summary", "context"),
      artifactRef(runID, "core-route-plan.json", "core_route_plan", "router"),
      artifactRef(runID, "control-plane-manifest.json", "control", "control"),
      artifactRef(runID, "task-intent.json", "control", "intent"),
      artifactRef(runID, "execution-profile.json", "control", "profile"),
      artifactRef(runID, "planner-envelope.json", "control", "planner"),
      artifactRef(runID, "planner-state.json", "planner_state", "planner"),
      artifactRef(runID, "task-graph.json", "task_graph", "planner"),
      artifactRef(runID, "agent-loop.ndjson", "agent_loop", "planner"),
      artifactRef(runID, "planner-decisions.ndjson", "planner_decisions", "planner"),
      ...harnessArtifactRefs(runID),
      ...capabilityLoopArtifactRefs(runID),
      artifactRef(runID, "tool-intent-plan.json", "control", "tool_plan"),
      artifactRef(runID, "context-manifest.json", "context", "context"),
      artifactRef(runID, "context-bundle.json", "context", "context"),
      artifactRef(runID, "retrieval-plan.json", "context", "context"),
      artifactRef(runID, "context-index.json", "context_index", "context"),
      artifactRef(runID, "retrieval-results.json", "retrieval_results", "context"),
      artifactRef(runID, "context-pack.json", "context_pack", "context"),
      artifactRef(runID, "source-trust-report.json", "source_trust", "context"),
      artifactRef(runID, "memory-compression.json", "memory_compression", "context"),
      artifactRef(runID, "context-gate.json", "context", "context_gate"),
      artifactRef(runID, "policy-decisions.json", "policy", "policy"),
      artifactRef(runID, "approval-decisions.json", "approval", "approval"),
      artifactRef(runID, "model-route.json", "model", "model_route"),
      artifactRef(runID, "qa-gate.json", "qa", "qa"),
      artifactRef(runID, "runtime-metrics.json", "metrics", "metrics"),
      artifactRef(runID, "checkpoint.json", "checkpoint", "checkpoint"),
      artifactRef(runID, "retry-ledger.json", "retry", "retry"),
      artifactRef(runID, "tool-calls.json", "tool_calls", "tool_execution"),
      artifactRef(runID, "tool-observations.json", "tool_observations", "tool_execution"),
      artifactRef(runID, "cloud-asr-summary.json", "cloud_asr_summary", "tool_execution"),
      artifactRef(runID, "cloud-asr-transcript.json", "cloud_asr_transcript", "tool_execution"),
      artifactRef(runID, "meeting-source-pack.json", "meeting_source_pack", "context"),
      artifactRef(runID, "cmc-capability-summary.json", "cmc_capability_summary", "tool_execution"),
      artifactRef(runID, "final-output.md", "final_output", "final_output"),
      artifactRef(runID, "agent-final-read-model.json", "final_read_model", "final_output"),
    ],
    redactionStatus: "summary_only",
  });

  writeJSON(join(runDir, "attachments.json"), attachments);
  appendEvent(runDir, { type: "run.started", runID, taskID, sessionID: session.sessionID, stage: "start", status: "running", artifactKind: "run_manifest", artifactPath: `runtime/agent/runs/${runID}/run-manifest.json` });
  appendEvent(runDir, { type: "core.route_plan.created", runID, taskID, stage: "router", status: "completed", artifactKind: "core_route_plan", artifactPath: `runtime/agent/runs/${runID}/core-route-plan.json`, compatibilityMode: coreRoutePlan.compatibilityMode });
  appendEvent(runDir, { type: "control_plane.manifest.created", runID, taskID, stage: "control", status: "completed", artifactKind: "control_manifest", artifactPath: `runtime/agent/runs/${runID}/control-plane-manifest.json` });
  appendEvent(runDir, { type: "task.intent.created", runID, taskID, stage: "intent", status: controlPlane.taskIntent.taskType, artifactKind: "task_intent", artifactPath: `runtime/agent/runs/${runID}/task-intent.json` });
  appendEvent(runDir, { type: "context_plane.bundle.created", runID, taskID, stage: "context", status: controlPlane.contextGate.status, reason: controlPlane.contextGate.reason, artifactKind: "context_bundle", artifactPath: `runtime/agent/runs/${runID}/context-bundle.json`, contextSourceCount: contextSummary.sourceCount, contextChunkCount: contextSummary.chunkCount });
  appendEvent(runDir, { type: "planner.envelope.created", runID, taskID, stage: "planner", status: "completed", artifactKind: "planner", artifactPath: `runtime/agent/runs/${runID}/planner-envelope.json` });
  appendEvent(runDir, { type: "planner.loop.created", runID, taskID, stage: "planner", status: "running", artifactKind: "planner_loop", artifactPath: `runtime/agent/runs/${runID}/planner-state.json` });
  appendEvent(runDir, { type: "qa.gate", runID, taskID, stage: "qa", artifactKind: "qa_gate", artifactPath: `runtime/agent/runs/${runID}/qa-gate.json`, status: controlPlane.qaGate.status });
  for (const policy of policies) appendEvent(runDir, { type: "policy.decision", runID, taskID, stage: "policy", artifactKind: "policy", ...policy });

  const toolCalls = [];
  for (const toolName of tools) {
    const controlState = await waitIfPausedOrCancelled(runDir, runID, taskID);
    if (controlState === "cancelled") {
      const cancelledTask = {
        taskID,
        sessionID: session.sessionID,
        runID,
        prompt,
        status: "cancelled",
        selectedToolNames: tools,
        selectedSkillIDs,
        selectedExtensionIDs,
        attachmentIDs: attachments.map((item) => item.attachmentID || item.id).filter(Boolean),
        artifactPath: `runtime/agent/runs/${runID}`,
        createdAt: envelope.createdAt,
        updatedAt: now(),
      };
      writeJSON(taskPath(taskID), cancelledTask);
      await mongoStore.saveTask(cancelledTask);
      writeRunManifest(runDir, {
        ...readJSON(runManifestPath(runDir), {}),
        status: "cancelled",
        currentStage: "cancelled",
        completedAt: now(),
      });
      return { session, task: cancelledTask, runID, toolCalls, policies, modelRoute };
    }
    const policyDecision = policies.find((item) => item.action === toolName);
    const policy = policyDecision?.status || policyForTool(toolName);
    const baseCall = {
      id: safeId("tool"),
      toolName,
      status: policy === "blocked" ? "blocked" : "running",
      permission: policy,
      inputSummary: policyDecision?.actionIntent || "Generated from selected skill/extension and prompt context.",
      outputSummary: "",
      artifactPath: `runtime/agent/runs/${runID}/tool-calls.json`,
      detailsArtifactPath: null,
      redactionStatus: "summary_only",
      createdAt: now(),
    };
    appendEvent(runDir, { type: "tool.call.started", runID, taskID, stage: "tool_execution", action: toolName, actionIntent: policyDecision?.actionIntent, riskLevel: policyDecision?.riskLevel, artifactKind: "tool_calls", ...baseCall });
    appendInvocationLedger(runDir, {
      type: "tool_action_started",
      runID,
      taskID,
      sessionID: session.sessionID,
      branchID: harness.branchID,
      stage: "tool_execution",
      status: baseCall.status,
      action: toolName,
      toolName,
      artifactPath: baseCall.artifactPath,
      details: {
        actionIntent: policyDecision?.actionIntent || null,
        riskLevel: policyDecision?.riskLevel || null,
        permission: policy,
      },
    });
    if (policy !== "pass") {
      const skippedCall = {
        ...baseCall,
        status: policy === "blocked" ? "blocked" : "waitingForApproval",
        outputSummary: policy === "blocked"
          ? `No execution performed; ${toolName} is blocked by policy.`
          : `No execution performed; ${toolName} requires confirmation.`,
      };
      toolCalls.push(skippedCall);
      recordToolLoopStep(runDir, { runID, taskID, call: skippedCall, policyDecision });
      appendInvocationLedger(runDir, {
        type: "tool_action_completed",
        runID,
        taskID,
        sessionID: session.sessionID,
        branchID: harness.branchID,
        stage: "tool_execution",
        status: skippedCall.status,
        action: toolName,
        toolName,
        artifactPath: skippedCall.artifactPath,
        reason: skippedCall.outputSummary,
      });
      appendEvent(runDir, { type: "tool.call.skipped", runID, taskID, stage: "tool_execution", action: toolName, actionIntent: policyDecision?.actionIntent, riskLevel: policyDecision?.riskLevel, toolName, status: policy, permission: policy });
      continue;
    }
    try {
      const result = await executeRuntimeTool(toolName, {
        runID,
        sessionID: session.sessionID,
        prompt,
        idempotencyKey: `${toolName}:${runID}`,
        contextRefs,
        attachments,
        contextManifestRef: `runtime/agent/runs/${runID}/context-manifest.json`,
        contextBundleRef: `runtime/agent/runs/${runID}/context-bundle.json`,
      });
      const detailsArtifactPath = writeToolDetails(runDir, baseCall.id, toolName, result);
      const completedCall = {
        ...baseCall,
        status: result.status === "blocked_missing_provider_config" ? "blocked" : result.status === "needs_confirmation" ? "waitingForApproval" : result.status || "completed",
        outputSummary: summarizeToolResult(toolName, result),
        detailsArtifactPath,
        redactionStatus: "redacted_summary_only",
      };
      toolCalls.push(completedCall);
      recordToolLoopStep(runDir, { runID, taskID, call: completedCall, policyDecision });
      appendInvocationLedger(runDir, {
        type: "tool_action_completed",
        runID,
        taskID,
        sessionID: session.sessionID,
        branchID: harness.branchID,
        stage: "tool_execution",
        status: completedCall.status,
        action: toolName,
        toolName,
        artifactPath: completedCall.detailsArtifactPath || completedCall.artifactPath,
        reason: completedCall.outputSummary,
      });
    } catch (error) {
      const detailsArtifactPath = writeToolDetails(runDir, baseCall.id, toolName, { status: "failed", details: { error: redact(error?.stack || error?.message || error) } });
      const failedCall = {
        ...baseCall,
        status: "failed",
        outputSummary: redact(error?.stack || error?.message || error),
        detailsArtifactPath,
        redactionStatus: "redacted_error_summary",
      };
      toolCalls.push(failedCall);
      recordToolLoopStep(runDir, { runID, taskID, call: failedCall, policyDecision });
      appendInvocationLedger(runDir, {
        type: "tool_action_completed",
        runID,
        taskID,
        sessionID: session.sessionID,
        branchID: harness.branchID,
        stage: "tool_execution",
        status: "failed",
        action: toolName,
        toolName,
        artifactPath: failedCall.detailsArtifactPath,
        reason: failedCall.outputSummary,
      });
    }
  }
  writeJSON(join(runDir, "tool-calls.json"), toolCalls);
  await mongoStore.saveToolCalls(runID, toolCalls);
  for (const call of toolCalls) appendEvent(runDir, { type: "tool.call", runID, taskID, stage: "tool_execution", action: call.toolName, artifactKind: "tool_calls", ...call });
  const toolObservations = buildToolObservations(runDir, runID, toolCalls, policies, contextSummary, toolSelectionDiagnostic);
  appendEvent(runDir, { type: "tool.observations.created", runID, taskID, stage: "tool_execution", status: toolObservations.cmcFreshnessGate.status, artifactKind: "tool_observations", artifactPath: `runtime/agent/runs/${runID}/tool-observations.json`, concreteMarketPricesAllowed: toolObservations.cmcFreshnessGate.allowConcretePrices });
  const cmcCapabilitySummary = buildCMCCapabilitySummary({ runID, toolObservations, tools, selectedSkillIDs, selectedExtensionIDs });
  writeJSON(join(runDir, "cmc-capability-summary.json"), cmcCapabilitySummary);
  appendEvent(runDir, { type: "cmc.capability_summary.created", runID, taskID, stage: "tool_execution", status: cmcCapabilitySummary.skillHubDisplayStatus || cmcCapabilitySummary.researchEvidenceStatus || "unknown", artifactKind: "cmc_capability_summary", artifactPath: `runtime/agent/runs/${runID}/cmc-capability-summary.json`, transportStatus: cmcCapabilitySummary.transportStatus, readableEvidenceCount: cmcCapabilitySummary.readableEvidenceCount, allowSkillHubResultDisplay: cmcCapabilitySummary.allowSkillHubResultDisplay, allowSkillHubReturnedPrices: cmcCapabilitySummary.allowSkillHubReturnedPrices, allowConcretePrices: cmcCapabilitySummary.allowConcretePrices });
  const marketsCapabilitySummary = toolObservations.marketsResearch?.summary || null;
  if (marketsCapabilitySummary?.schemaVersion === "markets-capability-summary-v1") {
    writeJSON(join(runDir, "markets-capability-summary.json"), marketsCapabilitySummary);
    appendEvent(runDir, {
      type: "markets.capability_summary.created",
      runID,
      taskID,
      stage: "tool_execution",
      status: marketsCapabilitySummary.researchEvidenceStatus || "unknown",
      artifactKind: "markets_capability_summary",
      artifactPath: `runtime/agent/runs/${runID}/markets-capability-summary.json`,
      transportStatus: marketsCapabilitySummary.transportStatus,
      priceSnapshotStatus: marketsCapabilitySummary.priceSnapshotStatus,
      allowConcretePrices: marketsCapabilitySummary.allowConcretePrices,
    });
  }
  const strategyTaskType = maybeWriteStrategyResult(runDir, runID, prompt, selectedSkillIDs, toolObservations);
  if (strategyTaskType) appendEvent(runDir, { type: "cmc.strategy_result.created", runID, taskID, stage: "tool_execution", status: "completed", artifactKind: "strategy_result", artifactPath: `runtime/agent/runs/${runID}/cmc-strategist-result.json`, taskType: strategyTaskType });

  let finalText = "";
  const marketSensitiveRun = isMarketSensitiveRun(prompt, tools);
  const shouldCallLive = process.env.WECHAT_AGENT_MOCK_PROVIDER !== "1"
    && (!marketSensitiveRun || toolObservations.cmcFreshnessGate.status === "pass");
  let activeModelRoute = modelRoute;
  if (shouldCallLive) {
    const messages = [
      { role: "system", content: readFileSync(join(agentRuntimeRoot, "prompts", "agent-system.md"), "utf8") },
      { role: "user", content: `User prompt:\n${prompt}\n\nSelected skills:\n${selectedSkillIDs.join(", ")}\n\nSelected extensions:\n${selectedExtensionIDs.join(", ")}\n\nModel preference:\n${JSON.stringify(modelPreference || { mode: "auto" })}\n\nContext bundle artifact:\nruntime/agent/runs/${runID}/context-bundle.json\n\nTool observations artifact:\nruntime/agent/runs/${runID}/tool-observations.json\n\nContext bundle summary:\n${String(controlPlane.contextBundle.modelContext || "").slice(0, 3500)}\n\nTool observations:\n${JSON.stringify(toolObservations, null, 2).slice(0, 12000)}${liveWechat?.contextText || ""}` },
    ];
    const modelCall = await callTextModelWithFallback({
      modelRoute: activeModelRoute,
      messages,
      runDir,
      runID,
      taskID,
    });
    finalText = modelCall.text;
    activeModelRoute = modelCall.modelRoute;
    Object.assign(modelRoute, activeModelRoute);
    writeJSON(join(runDir, "model-route.json"), activeModelRoute);
  }
  if (!finalText.trim()) {
    finalText = deterministicAssistantText(prompt, tools, policies, attachments, selectedSkillIDs, selectedExtensionIDs, toolObservations);
    const note = modelFailureNote(activeModelRoute);
    if (note) finalText = `${note}\n\n${finalText}`;
    for (const segment of finalText.match(/.{1,80}(\s|$)/g) || [finalText]) {
      appendEvent(runDir, { type: "assistant.delta", runID, taskID, stage: "model_stream", delta: segment });
    }
    if (shouldCallLive && (!activeModelRoute.attempts || !activeModelRoute.attempts.length)) {
      activeModelRoute = finalizeModelRoute(activeModelRoute, [], null);
      Object.assign(modelRoute, activeModelRoute);
      writeJSON(join(runDir, "model-route.json"), activeModelRoute);
    }
  }
  const guardedFinal = guardFinalOutput({ text: finalText, prompt, tools, toolObservations });
  const sanitizedFinalText = sanitizePublicFinalText(guardedFinal.text);
  finalText = sanitizedFinalText || guardedFinal.text;
  if (sanitizedFinalText !== guardedFinal.text) {
    guardedFinal.outputGuard = {
      ...guardedFinal.outputGuard,
      status: "rewritten",
      reason: guardedFinal.outputGuard.reason && guardedFinal.outputGuard.reason !== "ok"
        ? guardedFinal.outputGuard.reason
        : "raw_public_capability_ids_removed",
      violations: [...new Set([...(guardedFinal.outputGuard.violations || []), "raw_public_capability_id"])].slice(0, 8),
      checkedAt: now(),
    };
  }
  toolObservations.outputGuard = guardedFinal.outputGuard;
  toolObservations.modelRouteSummary = {
    schemaVersion: activeModelRoute.schemaVersion || "agent-model-route-v3",
    selectedTextProvider: activeModelRoute.selectedTextProvider || null,
    selectedTextModel: activeModelRoute.selectedTextModel || null,
    selectionSource: activeModelRoute.selectionSource || null,
    finalModel: activeModelRoute.finalModel || null,
    fallbackUsed: Boolean(activeModelRoute.fallbackUsed),
    userVisibleNoteRequired: Boolean(activeModelRoute.userVisibleNoteRequired),
    attemptCount: Array.isArray(activeModelRoute.attempts) ? activeModelRoute.attempts.length : 0,
  };
  toolObservations.modelUsePolicy.allowSkillHubResultDisplay = Boolean(toolObservations.cmcFreshnessGate.allowSkillHubResultDisplay);
  toolObservations.modelUsePolicy.allowCMCRenderBlocks = Array.isArray(cmcCapabilitySummary.renderBlocks) && cmcCapabilitySummary.renderBlocks.length > 0;
  toolObservations.modelUsePolicy.cmcRenderSchemaVersion = cmcCapabilitySummary.renderSchemaVersion || null;
  toolObservations.modelUsePolicy.cmcRenderBlockCount = Array.isArray(cmcCapabilitySummary.renderBlocks) ? cmcCapabilitySummary.renderBlocks.length : 0;
  toolObservations.modelUsePolicy.skillHubDisplayStatus = toolObservations.cmcFreshnessGate.skillHubDisplayStatus || "unknown";
  toolObservations.modelUsePolicy.displayableResultSource = toolObservations.cmcFreshnessGate.displayableResultSource || null;
  toolObservations.modelUsePolicy.allowSkillHubReturnedPrices = Boolean(toolObservations.cmcFreshnessGate.allowSkillHubReturnedPrices);
  toolObservations.modelUsePolicy.skillHubReturnedPriceTokenCount = Number(toolObservations.cmcFreshnessGate.skillHubReturnedPriceTokenCount || 0);
  toolObservations.modelUsePolicy.skillHubReturnedTextSource = toolObservations.cmcFreshnessGate.skillHubReturnedTextSource || null;
  toolObservations.modelUsePolicy.liveResearchAllowed = Boolean(
    toolObservations.cmcFreshnessGate.allowSkillHubResultDisplay
    || toolObservations.cmcFreshnessGate.allowResearchConclusion
  );
  toolObservations.modelUsePolicy.concreteMarketPricesAllowed = Boolean(toolObservations.cmcFreshnessGate.allowConcretePrices);
  toolObservations.modelUsePolicy.marketsResearchDraftAllowed = Boolean(toolObservations.marketsResearch?.gate?.allowResearchDraft);
  toolObservations.modelUsePolicy.marketsResearchConclusionAllowed = Boolean(toolObservations.marketsResearch?.gate?.allowResearchConclusion);
  toolObservations.modelUsePolicy.marketsConcretePricesAllowed = false;
  writeJSON(join(runDir, "tool-observations.json"), toolObservations);
  if (guardedFinal.outputGuard.status === "rewritten") {
    appendEvent(runDir, {
      type: "output.guard.rewritten",
      runID,
      taskID,
      stage: "final_output",
      status: "rewritten",
      artifactKind: "tool_observations",
      artifactPath: `runtime/agent/runs/${runID}/tool-observations.json`,
      concreteMarketPricesAllowed: false,
    });
  }

  const finalReadModelPath = `runtime/agent/runs/${runID}/agent-final-read-model.json`;
  const finalReadModel = buildAgentFinalReadModel({
    runID,
    taskID,
    sessionID: session.sessionID,
    status: "completed",
    finalText,
    finalTextSource: "final_output_artifact",
    toolObservations,
    artifactPath: finalReadModelPath,
  });
  const finalWrite = await agentRuntimeCore.writeAuthoritativeFinalOutput({
    runDir,
    runID,
    taskID,
    session,
    prompt,
    tools,
    selectedCapabilityIDs,
    selectedSkillIDs,
    selectedExtensionIDs,
    attachments,
    envelope,
    finalText,
    finalReadModel,
    finalReadModelPath,
    toolObservations,
    controlPlane,
    toolCalls,
    contextSummary,
    controlSummary,
    cmcCapabilitySummary,
    writeJSON,
    writeTextFile: (path, text) => writeFileSync(path, text, "utf8"),
    readJSON,
    runManifestPath,
    writeRunManifest,
    appendEvent,
    now,
    safeId,
    recordFinalLoopStep,
    finalizeHarnessArtifacts,
    writeCapabilityLoopReadModels: (targetRunDir, args) => agentRuntimeCore.writeCapabilityLoopReadModels(targetRunDir, {
      ...args,
      projectRoot,
      agentRuntimeRoot,
      writeJSON,
      appendEvent,
      appendInvocationLedger,
      mainBranchID,
      redact,
    }),
    saveFinalOutput: (targetRunID, targetFinalText, metadata) => mongoStore.saveFinalOutput(targetRunID, targetFinalText, metadata),
    persistFinalSessionTask: async ({ session: completedSession, task }) => {
      writeJSON(sessionPath(completedSession.sessionID), completedSession);
      await mongoStore.saveSession(completedSession);
      writeJSON(taskPath(task.taskID), task);
      await mongoStore.saveTask(task);
    },
  });
  const task = finalWrite.task;
  writeOpsStatus(health(), {
    runID,
    taskID,
    status: toolObservations.cmcFreshnessGate.status === "pass" ? "ok" : "degraded",
    provider: toolObservations.cmcFreshnessGate.provider,
    providerType: toolObservations.cmcFreshnessGate.provider === "mcpProvider" ? "mcpHttpProvider" : undefined,
    assetCount: toolObservations.cmcFreshnessGate.assetCount,
    selectedSkills: selectedSkillIDs,
    selectedExtensions: selectedExtensionIDs,
    internalToolCount: tools.length,
    artifactPath: `runtime/agent/runs/${runID}`,
    updatedAt: now(),
  });
  return { session, task, runID, toolCalls, policies, modelRoute };
}

async function createSession(body = {}) {
  const session = {
    schemaVersion: "agent-session-v1",
    sessionID: safeId("session"),
    title: body.title || "新建 Agent 会话",
    createdAt: now(),
    updatedAt: now(),
    status: "idle",
    activeRunID: null,
    messages: [],
    isTest: process.env.WECHAT_AGENT_TEST_MODE === "1" || /^(async-)?smoke-check$/i.test(String(body.title || "")),
  };
  writeJSON(sessionPath(session.sessionID), session);
  return mongoStore.createSession(session);
}

async function listSessions() {
  return mongoStore.listSessions();
}

async function getSession(sessionID) {
  const session = await mongoStore.getSession(sessionID);
  if (session) return session;
  return readJSON(sessionPath(sessionID));
}

async function renameSession(sessionID, body = {}) {
  const session = await mongoStore.renameSession(sessionID, body.title || body.name || "");
  if (!session) throw new HttpError(404, "session_not_found", "Session not found or title is empty.");
  writeJSON(sessionPath(sessionID), session);
  return session;
}

async function listTasks() {
  return mongoStore.listTasks();
}

async function deleteSession(sessionID) {
  const result = await mongoStore.deleteSession(sessionID);
  for (const runID of result.deletedRunIDs || []) removeRunArtifacts(runID);
  rmSync(sessionPath(sessionID), { force: true });
  return { schemaVersion: "agent-delete-result-v1", kind: "session", id: sessionID, deletedRunCount: (result.deletedRunIDs || []).length, status: "deleted" };
}

async function deleteTask(taskID) {
  const result = await mongoStore.deleteTask(taskID);
  if (result.runID) removeRunArtifacts(result.runID);
  rmSync(taskPath(taskID), { force: true });
  return { schemaVersion: "agent-delete-result-v1", kind: "task", id: taskID, runID: result.runID, status: "deleted" };
}

async function deleteRun(runID) {
  await mongoStore.deleteRun(runID);
  removeRunArtifacts(runID);
  return { schemaVersion: "agent-delete-result-v1", kind: "run", id: runID, status: "deleted" };
}

async function resetRuntimeData() {
  await mongoStore.resetAll();
  rmSync(sessionsRoot, { recursive: true, force: true });
  rmSync(tasksRoot, { recursive: true, force: true });
  rmSync(runsRoot, { recursive: true, force: true });
  rmSync(attachmentsRoot, { recursive: true, force: true });
  ensureDirs();
  return { schemaVersion: "agent-runtime-reset-result-v1", status: "reset", resetAt: now() };
}

async function postMessage(sessionID, body) {
  const existing = await getSession(sessionID);
  const session = existing || await createSession({ title: "Agent 会话" });
  const userMessage = {
    id: safeId("msg"),
    role: "user",
    content: [{ type: "text", text: body.prompt || body.message || "" }],
    attachments: body.attachments || [],
    contextRefs: body.contextRefs || [],
    createdAt: now(),
  };
  session.messages.push(userMessage);
  session.status = "running";
  session.updatedAt = now();
  writeJSON(sessionPath(session.sessionID), session);
  await mongoStore.saveSession(session);
  const result = await runAgentTask({
    session,
    prompt: userMessage.content[0].text,
    selectedToolNames: body.selectedToolNames || [],
    selectedCapabilityIDs: body.selectedCapabilityIDs || [],
    selectedSkillIDs: body.selectedSkillIDs || [],
    selectedExtensionIDs: body.selectedExtensionIDs || [],
    attachments: body.attachments || [],
    contextRefs: body.contextRefs || [],
    modelPreference: body.modelPreference || null,
  });
  return { ...result, message: userMessage };
}

async function postMessageAsync(sessionID, body) {
  const existing = await getSession(sessionID);
  const session = existing || await createSession({ title: "Agent 会话" });
  const runID = safeId("run");
  const taskID = safeId("task");
  const userMessage = {
    id: safeId("msg"),
    role: "user",
    content: [{ type: "text", text: body.prompt || body.message || "" }],
    attachments: body.attachments || [],
    contextRefs: body.contextRefs || [],
    runID,
    createdAt: now(),
  };
  session.messages.push(userMessage);
  session.status = "running";
  session.activeRunID = runID;
  session.updatedAt = now();
  writeJSON(sessionPath(session.sessionID), session);
  const task = {
    taskID,
    sessionID: session.sessionID,
    runID,
    prompt: userMessage.content[0].text,
    status: "running",
    selectedToolNames: [],
    selectedCapabilityIDs: body.selectedCapabilityIDs || [],
    selectedSkillIDs: body.selectedSkillIDs || [],
    selectedExtensionIDs: body.selectedExtensionIDs || [],
    modelPreference: body.modelPreference || null,
    attachmentIDs: (body.attachments || []).map((item) => item.attachmentID || item.id).filter(Boolean),
    artifactPath: `runtime/agent/runs/${runID}`,
    createdAt: now(),
    updatedAt: now(),
    isTest: process.env.WECHAT_AGENT_TEST_MODE === "1",
  };
  safeRunDir(runID);
  writeControlState(safeRunDir(runID), "running");
  writeJSON(taskPath(taskID), task);
  await mongoStore.saveSession(session);
  await mongoStore.saveTask(task);
  setTimeout(() => {
    runAgentTask({
      session,
      prompt: userMessage.content[0].text,
      selectedToolNames: body.selectedToolNames || [],
      selectedCapabilityIDs: body.selectedCapabilityIDs || [],
      selectedSkillIDs: body.selectedSkillIDs || [],
      selectedExtensionIDs: body.selectedExtensionIDs || [],
      attachments: body.attachments || [],
      contextRefs: body.contextRefs || [],
      modelPreference: body.modelPreference || null,
      runID,
      taskID,
    }).catch((error) => {
      const runDir = safeRunDir(runID);
      appendEvent(runDir, { type: "run.failed", runID, taskID, stage: "failed", status: "failed", errorPreview: redact(error?.stack || error?.message || error) });
      recordHarnessFailure(runDir, {
        runID,
        taskID,
        sessionID: session.sessionID,
        reason: error?.stack || error?.message || error,
      });
      writeRunManifest(runDir, {
        ...readJSON(runManifestPath(runDir), {}),
        runID,
        taskID,
        sessionID: session.sessionID,
        status: "failed",
        currentStage: "failed",
        completedAt: now(),
        errorPreview: redact(error?.message || error),
      });
    });
  }, 0);
  return {
    schemaVersion: "agent-async-message-response-v1",
    session,
    task,
    runID,
    taskID,
    eventsURL: `/runs/${runID}/events`,
    artifactPath: `runtime/agent/runs/${runID}`,
    acceptedAt: now(),
  };
}

function sendEvents(req, res, runID) {
  const path = join(safeRunDir(runID), "events.ndjson");
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let sentLines = 0;
  let closed = false;
  req.on("close", () => { closed = true; });

  const flush = () => {
    if (closed) return true;
    if (!existsSync(path)) {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ type: "run.waiting", runID, timestamp: now() })}\n\n`);
      return false;
    }
    const textValue = readFileSync(path, "utf8");
    const lines = textValue.split(/\r?\n/).filter(Boolean);
    const nextLines = lines.slice(sentLines);
    sentLines = lines.length;
    let terminal = false;
    for (const line of nextLines) {
      res.write(`data: ${line}\n\n`);
      try {
        const payload = JSON.parse(line);
        if (terminalEventTypes.has(payload.type)) terminal = true;
      } catch {
        // Ignore malformed historical event lines.
      }
    }
    if (terminal) {
      res.end();
      return true;
    }
    return false;
  };
  if (flush()) return;
  const timer = setInterval(() => {
    if (flush() || closed) clearInterval(timer);
  }, 250);
}

// --- Live WeChat read via local wechat-cli (read-only, user-authorized) --------------
// Resolves the runnable wechat-cli (Python source via WECHAT_CLI_PYTHON+WECHAT_CLI_ENTRY,
// a prebuilt WECHAT_CLI_BIN, or `wechat-cli` on PATH), runs read-only commands with
// `--format json`, and projects the result into the project's fixture-shaped messages file
// at runtime/wechat/messages.live.json (consumed by the Swift WeChatFixtureFileAdapter).
function resolveWechatCliCommand() {
  const py = (process.env.WECHAT_CLI_PYTHON || "").trim();
  const entry = (process.env.WECHAT_CLI_ENTRY || "").trim();
  const bin = (process.env.WECHAT_CLI_BIN || process.env.WECHAT_CLI_PATH || "").trim();
  if (py && entry) return { cmd: py, baseArgs: [entry] };
  if (bin) return { cmd: bin, baseArgs: [] };
  return { cmd: "wechat-cli", baseArgs: [] };
}

function wechatLiveEnabled() {
  return String(process.env.WECHAT_LIVE_ENABLED || "").trim().toLowerCase() === "true";
}

function runWechatCli(args, timeoutMs = 30000) {
  const subcommand = String(args?.[0] || "");
  if (!["sessions", "history"].includes(subcommand)) {
    return { ok: false, reason: "wechat_cli_command_not_allowed" };
  }
  if (args.some((arg) => /[\r\n]/.test(String(arg)))) {
    return { ok: false, reason: "wechat_cli_arg_not_allowed" };
  }
  const { cmd, baseArgs } = resolveWechatCliCommand();
  let res;
  try {
    res = spawnSync(cmd, [...baseArgs, ...args, "--format", "json"], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME || "",
        LANG: process.env.LANG || "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL || "",
        PYTHONIOENCODING: "utf-8",
        WECHAT_CLI_HOME: process.env.WECHAT_CLI_HOME || "",
      },
    });
  } catch (error) {
    return { ok: false, reason: "spawn_failed", detail: redact(String(error?.message || error)) };
  }
  if (res.error) return { ok: false, reason: "spawn_failed", detail: redact(String(res.error.message || res.error)) };
  if (res.status !== 0) {
    return { ok: false, reason: "wechat_cli_error", code: res.status, stderr: redact((res.stderr || "").trim()).slice(0, 400) };
  }
  try {
    return { ok: true, data: JSON.parse(res.stdout || "null") };
  } catch (error) {
    return { ok: false, reason: "json_parse_failed", detail: redact(String(error?.message)) };
  }
}

function liveToIso(value) {
  if (value == null) return now();
  if (typeof value === "number") return new Date(value > 1e12 ? value : value * 1000).toISOString();
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return liveToIso(Number(s));
  const d = new Date(s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? now() : d.toISOString();
}

function sanitizeSymbols(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const symbols = raw
    .map((item) => String(item || "").trim().toUpperCase())
    .filter((item) => /^[A-Z0-9]{2,16}$/.test(item));
  return [...new Set(symbols.length ? symbols : cmcDefaultSymbols)].slice(0, 50);
}

function cmcAPIKey() {
  return String(process.env.CMC_PRO_API_KEY || process.env.COINMARKETCAP_API_KEY || "").trim();
}

const cmcKnownSymbolIDs = new Map(Object.entries({
  BTC: "1",
  ETH: "1027",
  SOL: "5426",
  BNB: "1839",
  XRP: "52",
  ADA: "2010",
  DOGE: "74",
  TRX: "1958",
  LINK: "1975",
  AVAX: "5805",
  TON: "11419",
  SUI: "20947",
  PEPE: "24478",
  ARB: "11841",
  OP: "11840",
}));

function cmcIDsForSymbols(symbols) {
  return sanitizeSymbols(symbols)
    .map((symbol) => cmcKnownSymbolIDs.get(symbol))
    .filter(Boolean)
    .join(",");
}

function cmcMcpToolText(tool) {
  return [
    tool?.name,
    tool?.title,
    tool?.description,
    tool?.inputSchema ? JSON.stringify(tool.inputSchema) : "",
  ].filter(Boolean).join(" ").toLowerCase();
}

function cmcMcpToolByName(tools, names) {
  const wanted = new Set(names.map((name) => String(name || "").toLowerCase()));
  const list = Array.isArray(tools) ? tools : [];
  return list.find((tool) => wanted.has(String(tool?.name || "").toLowerCase())) || null;
}

function selectCMCMcpTool(tools, kind, skill = "daily_market_overview") {
  const list = Array.isArray(tools) ? tools : [];
  const scored = list.map((tool) => {
    const textValue = cmcMcpToolText(tool);
    let score = 0;
    if (kind === "quotes") {
      if (/quotes?.?latest|latest.?quotes?|cryptocurrency.*quotes?|quotes?.*cryptocurrency/.test(textValue)) score += 8;
      if (/price|market.*data|symbol/.test(textValue)) score += 2;
      if (/global|fear|greed|news/.test(textValue)) score -= 4;
    }
    if (kind === "global") {
      if (/global.?metrics|global.*market|market.?metrics/.test(textValue)) score += 8;
      if (/quotes?.?latest/.test(textValue)) score += 1;
    }
    if (kind === "fear_greed") {
      if (/fear.*greed|greed.*fear|sentiment/.test(textValue)) score += 8;
    }
    if (kind === "skill") {
      const skillTerms = String(skill || "").replaceAll("_", " ").split(/\s+/).filter(Boolean);
      score += skillTerms.filter((term) => textValue.includes(term)).length * 2;
      if (/overview|regime|divergence|macro|daily|technical|kline/.test(textValue)) score += 1;
    }
    return { tool, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.tool || null;
}

function unwrapCMCResultEnvelope(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return value;
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return unwrapCMCResultEnvelope(JSON.parse(trimmed), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (typeof value !== "object") return value;
  if (typeof value.raw_output === "string") return unwrapCMCResultEnvelope(value.raw_output, depth + 1);
  if (typeof value.rawOutput === "string") return unwrapCMCResultEnvelope(value.rawOutput, depth + 1);
  if (typeof value.text === "string" && Object.keys(value).length === 1) return unwrapCMCResultEnvelope(value.text, depth + 1);
  return value;
}

function buildCMCMcpArguments(tool, { symbols, skill, prompt }) {
  const props = tool?.inputSchema?.properties || {};
  const args = {};
  const symbolList = sanitizeSymbols(symbols);
  for (const name of Object.keys(props)) {
    const lower = name.toLowerCase();
    if (lower === "preview") args[name] = true;
    else if (lower === "id") args[name] = cmcIDsForSymbols(symbolList);
    else if (lower === "symbol") args[name] = symbolList[0];
    else if (lower === "symbols") args[name] = symbolList;
    else if (lower === "query") args[name] = prompt || symbolList.join(" OR ");
    else if (lower === "convert" || lower === "currency") args[name] = "USD";
    else if (lower === "time_window" || lower === "timewindow") args[name] = "30d";
    else if (lower === "lookback_hours") args[name] = 24;
    else if (lower === "max_posts") args[name] = 10;
    else if (lower === "timeframe") args[name] = "4h";
    else if (lower === "base_asset") args[name] = symbolList[0];
  }
  if (!Object.keys(props).length) {
    return { preview: true, symbol: symbolList[0], symbols: symbolList, convert: "USD", query: prompt || symbolList.join(", ") };
  }
  for (const required of tool?.inputSchema?.required || []) {
    if (args[required] !== undefined) continue;
    const lower = String(required).toLowerCase();
    if (lower.includes("preview")) args[required] = true;
    else if (lower === "id") args[required] = cmcIDsForSymbols(symbolList);
    else if (lower.includes("symbol")) args[required] = symbolList[0];
    else if (lower.includes("query") || lower.includes("claim")) args[required] = prompt || `${symbolList[0]} market overview`;
    else if (lower.includes("time")) args[required] = "30d";
  }
  return args;
}

function cmcSkillHubDiscoveryQuery(skill, symbols = []) {
  const symbolText = sanitizeSymbols(symbols).slice(0, 5).join(", ") || "BTC, ETH, SOL";
  switch (String(skill || "")) {
    case "daily_market_overview":
      return `daily_market_overview preview broad crypto market evidence for ${symbolText}`;
    case "crypto_macro_overview":
      return `crypto_macro_overview preview macro crypto market evidence for ${symbolText}`;
    case "detect_market_regime":
      return `detect_market_regime preview crypto market regime evidence for ${symbolText}`;
    case "track_social_price_divergence":
      return `track_social_price_divergence preview social price divergence evidence for ${symbolText}`;
    case "classify_kline_pattern_quality":
      return `classify_kline_pattern_quality preview kline pattern quality evidence for ${symbolText}`;
    default:
      return `${skill || "daily_market_overview"} preview crypto research evidence for ${symbolText}`;
  }
}

function buildCMCSkillHubFindArguments(tool, { skill, symbols, prompt }) {
  const props = tool?.inputSchema?.properties || {};
  const symbolList = sanitizeSymbols(symbols);
  const query = cmcSkillHubDiscoveryQuery(skill, symbolList);
  if (!Object.keys(props).length) return { query, top_k: 8 };
  const args = {};
  for (const name of Object.keys(props)) {
    const lower = name.toLowerCase();
    if (lower === "query" || lower === "q") args[name] = query;
    else if (lower === "top_k" || lower === "topk" || lower === "limit") args[name] = 8;
  }
  for (const required of tool?.inputSchema?.required || []) {
    if (args[required] !== undefined) continue;
    const lower = String(required).toLowerCase();
    if (lower.includes("query") || lower === "q") args[required] = query;
    else if (lower.includes("top")) args[required] = 8;
  }
  return args;
}

function selectCMCSkillHubCandidate(payload, requestedSkill) {
  const unwrapped = unwrapCMCResultEnvelope(payload);
  const result = unwrapCMCResultEnvelope(unwrapped?.result);
  const data = unwrapCMCResultEnvelope(result?.data || unwrapped?.data);
  const candidates = firstArray(unwrapped?.candidates, data?.candidates, result?.candidates, unwrapped?.data?.candidates, unwrapped?.result?.candidates);
  if (!candidates.length) return null;
  const requested = String(requestedSkill || "").toLowerCase();
  return candidates.find((candidate) => String(candidate?.uniqueName || candidate?.unique_name || "").toLowerCase() === requested)
    || candidates.find((candidate) => cmcMcpToolText({
      name: candidate?.uniqueName || candidate?.unique_name,
      description: candidate?.skillDescription || candidate?.description,
      inputSchema: candidate?.inputSchema,
    }).includes(requested.replaceAll("_", " ")))
    || candidates[0];
}

function cmcSkillHubPayloadError(payload) {
  const unwrapped = unwrapCMCResultEnvelope(payload);
  const error = unwrapped?.error || unwrapped?.data?.error || unwrapped?.result?.error;
  if (!error) return null;
  return {
    code: String(error.code || "cmc_skill_hub_error"),
    message: redact(String(error.message || error.reason || "CMC Skill Hub returned an error.")),
  };
}

function skillHubEvidenceLabel(key) {
  const normalized = String(key || "").replace(/[_-]+/g, " ").trim().toLowerCase();
  const labels = {
    summary: "摘要",
    conclusion: "结论",
    market_read: "市场读数",
    "market read": "市场读数",
    evidence_pack: "证据包",
    "evidence pack": "证据包",
    raw_evidence: "原始证据",
    "raw evidence": "原始证据",
    decision_report: "决策报告",
    "decision report": "决策报告",
    notable_anomalies: "异常信号",
    "notable anomalies": "异常信号",
    anomalies: "异常信号",
    action_guidance: "行动提示",
    "action guidance": "行动提示",
    source_attribution: "来源说明",
    "source attribution": "来源说明",
    missing_or_stale_inputs: "缺失或过期输入",
    "missing or stale inputs": "缺失或过期输入",
    coverage_diagnostics: "覆盖诊断",
    "coverage diagnostics": "覆盖诊断",
    confirmation_triggers: "确认触发",
    "confirmation triggers": "确认触发",
    invalidation_triggers: "失效触发",
    "invalidation triggers": "失效触发",
    primary_conflicts: "冲突信号",
    "primary conflicts": "冲突信号",
    macro_news: "宏观新闻",
    "macro news": "宏观新闻",
    regime: "市场体制",
    primary_driver: "主驱动",
    "primary driver": "主驱动",
    risk_bias: "风险偏向",
    "risk bias": "风险偏向",
    composite_score: "综合评分",
    "composite score": "综合评分",
    confidence: "置信度",
    status: "状态",
    timestamp: "时间",
  };
  return labels[normalized] || String(key || "证据").replace(/[_-]+/g, " ");
}

function safeSkillHubEvidenceText(value, maxLength = 420) {
  const textValue = redact(value)
    .replace(/\s+/g, " ")
    .replace(/\b(?:schemaVersion|artifactPath|runID|taskID|sessionID|inputSchema|requestBody|parameters)\b/gi, "")
    .trim();
  return textValue.slice(0, maxLength);
}

function skillHubEvidenceValueText(value, depth = 0) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return safeSkillHubEvidenceText(value);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 4)
      .map((item) => skillHubEvidenceValueText(item, depth + 1))
      .filter(Boolean)
      .join("；");
  }
  if (typeof value === "object") {
    const title = value.title || value.name || value.label || value.symbol || value.asset || value.metric || value.topic;
    const summary = value.summary || value.conclusion || value.takeaway || value.description || value.value || value.signal || value.status;
    if (title || summary) {
      return safeSkillHubEvidenceText([title, summary].filter(Boolean).join("："));
    }
    if (depth >= 2) return safeSkillHubEvidenceText(JSON.stringify(value));
    return Object.entries(value)
      .filter(([key]) => !/key|secret|token|auth|cookie|request|parameter|schema|raw_output|input_schema/i.test(key))
      .slice(0, 5)
      .map(([key, item]) => {
        const text = skillHubEvidenceValueText(item, depth + 1);
        return text ? `${skillHubEvidenceLabel(key)}：${text}` : "";
      })
      .filter(Boolean)
      .join("；");
  }
  return "";
}

function addSkillHubEvidenceSection(sections, title, value, maxBullets = 5) {
  const bullets = [];
  const push = (item) => {
    const text = skillHubEvidenceValueText(item);
    if (text && !bullets.includes(text)) bullets.push(text);
  };
  if (Array.isArray(value)) {
    value.slice(0, maxBullets).forEach(push);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/key|secret|token|auth|cookie|request|parameter|schema|raw_output|input_schema/i.test(key)) continue;
      const text = skillHubEvidenceValueText(item);
      if (text) bullets.push(`${skillHubEvidenceLabel(key)}：${text}`);
      if (bullets.length >= maxBullets) break;
    }
  } else {
    push(value);
  }
  const cleanBullets = bullets.map((item) => safeSkillHubEvidenceText(item)).filter(Boolean).slice(0, maxBullets);
  if (cleanBullets.length) sections.push({ title, bullets: cleanBullets });
}

function readableSkillHubEvidence(payload, data, result) {
  const sections = [];
  const marketRead = data?.market_read && typeof data.market_read === "object" ? data.market_read : {};
  addSkillHubEvidenceSection(sections, "Skill Hub 原始摘要", [
    data?.summary,
    marketRead?.summary,
    data?.conclusion,
    data?.decision_report?.conclusion,
    result?.summary,
  ].filter(Boolean), 4);
  addSkillHubEvidenceSection(sections, "市场读数", marketRead, 6);
  addSkillHubEvidenceSection(sections, "证据包", data?.evidence_pack || result?.evidence_pack || data?.raw_evidence || result?.raw_evidence, 8);
  addSkillHubEvidenceSection(sections, "异常与冲突", firstArray(data?.notable_anomalies, data?.anomalies, result?.notable_anomalies, marketRead?.primary_conflicts), 6);
  addSkillHubEvidenceSection(sections, "触发条件", [
    ...firstArray(marketRead?.confirmation_triggers, data?.confirmation_triggers),
    ...firstArray(marketRead?.invalidation_triggers, data?.invalidation_triggers),
  ], 6);
  addSkillHubEvidenceSection(sections, "覆盖与缺口", [
    ...firstArray(data?.missing_or_stale_inputs, data?.missingOrStaleInputs),
    data?.coverage_diagnostics,
    result?.coverage_diagnostics,
  ].filter(Boolean), 6);
  addSkillHubEvidenceSection(sections, "来源说明", firstArray(data?.source_attribution, data?.coverage_diagnostics?.source_attribution, result?.source_attribution), 4);
  return sections.slice(0, 6);
}

function cmcSkillHubResultSummary(payload, { skill, symbols, generatedAt }) {
  const unwrapped = unwrapCMCResultEnvelope(payload);
  const result = unwrapCMCResultEnvelope(unwrapped?.result || unwrapped);
  const data = unwrapCMCResultEnvelope(result?.data || unwrapped?.data || {});
  const marketRead = data?.market_read && typeof data.market_read === "object" ? data.market_read : {};
  const conclusionText = data?.conclusion || data?.decision_report?.conclusion || result?.conclusion || null;
  const textSummary = String(
    data?.summary
    || marketRead?.summary
    || conclusionText
    || result?.summary
    || `${skill} returned CMC Skill Hub evidence.`,
  );
  const pickArray = (...values) => values.find((value) => Array.isArray(value) && value.length) || [];
  const readableEvidence = readableSkillHubEvidence(payload, data, result);
  const readableEvidenceCount = readableEvidence.reduce((count, section) => count + (Array.isArray(section?.bullets) ? section.bullets.length : 0), 0);
  return {
    source: "CMC Skill Hub MCP",
    protocol: "skill_hub",
    resultType: result?.type || "skill_result",
    skill: result?.skill_id || data?.skill_id || skill,
    symbols,
    status: data?.status || result?.status || "ok",
    confidence: data?.confidence || result?.confidence || null,
    timestamp: result?.timestamp || data?.timestamp || data?.observedAt || generatedAt,
    summary: redact(textSummary).slice(0, 1600),
    conclusion: conclusionText ? redact(conclusionText).slice(0, 1600) : null,
    marketRead: {
      summary: marketRead.summary ? redact(marketRead.summary).slice(0, 1600) : null,
      regime: marketRead.regime || marketRead.macro_regime || null,
      primaryDriver: marketRead.primary_driver || null,
      riskBias: marketRead.risk_bias || null,
      compositeScore: marketRead.composite_score ?? null,
      primaryConflicts: pickArray(marketRead.primary_conflicts, data?.primary_conflicts).slice(0, 6),
      confirmationTriggers: pickArray(marketRead.confirmation_triggers, data?.confirmation_triggers).slice(0, 6),
      invalidationTriggers: pickArray(marketRead.invalidation_triggers, data?.invalidation_triggers).slice(0, 6),
    },
    readableEvidence,
    readableEvidenceCount,
    emptyEvidenceReason: readableEvidenceCount > 0 ? null : "skill_hub_returned_no_readable_evidence",
    notableAnomalies: pickArray(data?.notable_anomalies, data?.anomalies, result?.notable_anomalies).slice(0, 6),
    missingOrStaleInputs: pickArray(data?.missing_or_stale_inputs, data?.missingOrStaleInputs).slice(0, 8),
    rawSecretsReturned: false,
    requestBodyReturned: false,
  };
}

function buildCMCSkillHubExecutionParameters(candidate, { symbols, skill, prompt }) {
  return buildCMCMcpArguments({ inputSchema: candidate?.inputSchema || {} }, {
    symbols,
    skill: candidate?.uniqueName || candidate?.unique_name || skill,
    prompt,
  });
}

function buildCMCSkillHubExecuteArguments(tool, candidate, parameters) {
  const props = tool?.inputSchema?.properties || {};
  const uniqueName = candidate?.uniqueName || candidate?.unique_name;
  if (!Object.keys(props).length) return { unique_name: uniqueName, parameters };
  const args = {};
  for (const name of Object.keys(props)) {
    const lower = name.toLowerCase();
    if (lower === "unique_name" || lower === "uniquename" || lower === "name") args[name] = uniqueName;
    else if (lower === "parameters" || lower === "params" || lower === "arguments") args[name] = parameters;
  }
  for (const required of tool?.inputSchema?.required || []) {
    if (args[required] !== undefined) continue;
    const lower = String(required).toLowerCase();
    if (lower.includes("unique") || lower === "name") args[required] = uniqueName;
    else if (lower.includes("param") || lower.includes("arg")) args[required] = parameters;
  }
  return args;
}

function parseMcpHTTPPayload(textValue) {
  const trimmed = String(textValue || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const dataLines = trimmed.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s*/, "").trim())
    .filter((line) => line && line !== "[DONE]");
  let last = null;
  for (const line of dataLines) {
    try {
      last = JSON.parse(line);
    } catch {
      // Ignore non-JSON SSE keepalive data.
    }
  }
  if (last) return last;
  throw new Error("mcp_response_parse_failed");
}

function mcpContentError(result) {
  if (!result || typeof result !== "object") return null;
  const content = Array.isArray(result.content) ? result.content : [];
  const textValue = content
    .map((part) => part?.type === "text" ? String(part.text || "") : "")
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!result.isError && !/^error:/i.test(textValue)) return null;
  const message = redact(textValue.replace(/^error:\s*/i, "").trim() || "MCP returned an error.");
  const lower = message.toLowerCase();
  const reason = lower.includes("subscription plan") && lower.includes("support")
    ? "cmc_mcp_subscription_unsupported"
    : "cmc_mcp_tool_error";
  return { reason, message };
}

async function cmcMcpRequest(method, params = {}, { sessionID = null, notification = false, apiKey = null } = {}) {
  const key = String(apiKey || cmcMcpAPIKey()).trim();
  if (!key) return { ok: false, reason: "missing_cmc_mcp_api_key" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.CMC_MCP_REQUEST_TIMEOUT_MS || "25000"));
  const id = notification ? undefined : safeId("mcp");
  const body = notification
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id, method, params };
  try {
    const endpointURL = cmcMcpEndpointURL();
    const response = await fetch(endpointURL, cmcFetchOptions({
      method: "POST",
      headers: {
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
        "X-CMC-MCP-API-KEY": key,
        ...(sessionID ? { "Mcp-Session-Id": sessionID } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }, endpointURL));
    const responseSessionID = response.headers.get("mcp-session-id") || response.headers.get("Mcp-Session-Id") || sessionID;
    const textValue = await response.text();
    let payload = null;
    try {
      payload = textValue ? parseMcpHTTPPayload(textValue) : null;
    } catch (error) {
      return { ok: false, reason: "cmc_mcp_json_parse_failed", statusCode: response.status, sessionID: responseSessionID, errorPreview: redact(String(error?.message || error)) };
    }
    if (!response.ok) {
      return { ok: false, reason: "cmc_mcp_http_error", statusCode: response.status, sessionID: responseSessionID, errorPreview: redact(payload?.error?.message || textValue) };
    }
    if (payload?.error) {
      return { ok: false, reason: "cmc_mcp_rpc_error", statusCode: response.status, sessionID: responseSessionID, errorPreview: redact(payload.error.message || JSON.stringify(payload.error)) };
    }
    const result = payload?.result ?? payload;
    const contentError = mcpContentError(result);
    if (contentError) {
      return { ok: false, reason: contentError.reason, statusCode: response.status, sessionID: responseSessionID, errorPreview: contentError.message };
    }
    return { ok: true, payload: result, sessionID: responseSessionID };
  } catch (error) {
    return { ok: false, reason: "cmc_mcp_request_failed", errorPreview: redact(String(error?.message || error)) };
  } finally {
    clearTimeout(timeout);
  }
}

async function cmcMcpClient({ apiKey = null } = {}) {
  const init = await cmcMcpRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "looloomi-agent-runtime", version: "0.1.0" },
  }, { apiKey });
  let sessionID = init.sessionID || null;
  if (init.ok) {
    await cmcMcpRequest("notifications/initialized", {}, { sessionID, notification: true, apiKey });
  }
  const listed = await cmcMcpRequest("tools/list", {}, { sessionID, apiKey });
  const listedPayload = extractMcpToolPayload(listed.payload);
  const toolList = Array.isArray(listedPayload?.tools)
    ? listedPayload.tools
    : Array.isArray(listedPayload?.data?.tools)
      ? listedPayload.data.tools
      : Array.isArray(listedPayload)
      ? listedPayload
      : [];
  return {
    ok: listed.ok,
    reason: listed.reason || init.reason,
    statusCode: listed.statusCode || init.statusCode,
    errorPreview: listed.errorPreview || init.errorPreview,
    sessionID: listed.sessionID || sessionID,
    tools: listed.ok ? toolList : [],
  };
}

function extractMcpToolPayload(callPayload) {
  if (!callPayload) return null;
  if (callPayload.structuredContent) return callPayload.structuredContent;
  if (callPayload.data) return callPayload.data;
  const content = Array.isArray(callPayload.content) ? callPayload.content : [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      const trimmed = part.text.trim();
      if (!trimmed) continue;
      try {
        return JSON.parse(trimmed);
      } catch {
        return { status: "ok", data: { market_read: { summary: trimmed } } };
      }
    }
  }
  return callPayload;
}

async function callCMCMcpTool(tool, args, sessionID, { apiKey = null } = {}) {
  if (!tool?.name) return { ok: false, reason: "cmc_mcp_tool_missing" };
  const called = await cmcMcpRequest("tools/call", { name: tool.name, arguments: args }, { sessionID, apiKey });
  if (!called.ok) return called;
  return { ok: true, payload: extractMcpToolPayload(called.payload), sessionID: called.sessionID };
}

function cmcQuoteItems(payload) {
  if (Array.isArray(payload)) return payload;
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  return Object.values(data).flatMap((value) => Array.isArray(value) ? value : [value]);
}

function cmcUSDQuote(item) {
  if (item && item.quote === undefined && item.price !== undefined) {
    return {
      price: item.price,
      percent_change_24h: item.percent_change_24h,
      volume_24h: item.volume_24h || item.volume24h || 0,
      market_cap: item.market_cap || item.marketCap || 0,
      last_updated: item.last_updated || item.last_updated_time,
    };
  }
  return item?.quote?.USD || item?.quote?.usd || {};
}

async function cmcFetch(path, params = {}) {
  const key = cmcAPIKey();
  if (!key) return { ok: false, reason: "missing_cmc_api_key" };
  const url = new URL(path, `${cmcBaseURL}/`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value).trim()) url.searchParams.set(name, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.CMC_REQUEST_TIMEOUT_MS || "20000"));
  try {
    const response = await fetch(url, cmcFetchOptions({
      headers: {
        "accept": "application/json",
        "X-CMC_PRO_API_KEY": key,
      },
      signal: controller.signal,
    }, url));
    const textValue = await response.text();
    let payload = null;
    try {
      payload = textValue ? JSON.parse(textValue) : null;
    } catch {
      return { ok: false, reason: "cmc_json_parse_failed", statusCode: response.status, errorPreview: redact(textValue) };
    }
    if (!response.ok) {
      return { ok: false, reason: "cmc_http_error", statusCode: response.status, errorPreview: redact(payload?.status?.error_message || textValue) };
    }
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, reason: "cmc_request_failed", errorPreview: redact(String(error?.message || error)) };
  } finally {
    clearTimeout(timeout);
  }
}

function marketSnapshotFromCMC({ symbols, quotesPayload, globalPayload, fearGreedPayload, generatedAt = now(), provider = "cmcRestProvider", sourceName = "CoinMarketCap Pro API", quoteSource = "CoinMarketCap Pro API / cryptocurrency quotes latest" }) {
  const expiresAt = new Date(Date.parse(generatedAt) + Math.max(60, cmcRefreshTTLSeconds) * 1000).toISOString();
  const items = cmcQuoteItems(quotesPayload).filter((item) => symbols.includes(String(item?.symbol || "").toUpperCase()));
  const assets = items.map((item) => {
    const quote = cmcUSDQuote(item);
    return {
      symbol: String(item.symbol || "").toUpperCase(),
      name: String(item.name || item.symbol || "Unknown"),
      priceUSD: Number(quote.price || 0),
      percentChange24h: Number(quote.percent_change_24h || 0),
      volume24hUSD: Number(quote.volume_24h || 0),
      marketCapUSD: Number(quote.market_cap || 0),
      source: quoteSource,
      isLive: true,
      observedAt: quote.last_updated || item.last_updated || generatedAt,
    };
  });
  const globalUSD = globalPayload?.data?.quote?.USD || {};
  const fearGreed = fearGreedPayload?.data || {};
  return {
    schemaVersion: "market-data-snapshot-v2",
    status: assets.length ? "enabled" : "degraded",
    sourceName,
    provider,
    generatedAt,
    observedAt: generatedAt,
    expiresAt,
    freshness: assets.length ? "fresh" : "degraded",
    lastVerifiedAt: generatedAt,
    assets,
    evidence: [
      assets.length
        ? `CoinMarketCap quotes/latest returned ${assets.length} asset(s): ${assets.map((item) => item.symbol).join(", ")}.`
        : "CoinMarketCap quotes/latest returned no usable assets.",
      globalUSD.total_market_cap ? `Global crypto market cap USD ${Math.round(Number(globalUSD.total_market_cap)).toLocaleString("en-US")}.` : "Global market metrics unavailable or empty.",
      fearGreed.value ? `Fear and Greed value ${fearGreed.value}${fearGreed.value_classification ? ` (${fearGreed.value_classification})` : ""}.` : "Fear and Greed unavailable or empty.",
    ],
    upstreamStatus: assets.length ? `${provider}_ok` : `${provider}_empty`,
  };
}

function normalizedEvidenceFromCMCSnapshot(snapshot, globalPayload, fearGreedPayload, { provider = "cmcRestProvider", skill = "daily_market_overview", sourceAttribution = null } = {}) {
  return {
    schemaVersion: "cmc-skill-hub-normalized-v2",
    provider,
    skill,
    status: snapshot.status === "enabled" ? "ok" : "degraded",
    observedAt: snapshot.observedAt,
    generatedAt: snapshot.generatedAt,
    expiresAt: snapshot.expiresAt,
    freshness: snapshot.freshness,
    watchlist: snapshot.assets,
    market_read: {
      summary: snapshot.evidence[0] || "CoinMarketCap market evidence refreshed.",
      globalMarketCapUSD: Number(globalPayload?.data?.quote?.USD?.total_market_cap || 0),
      fearGreedValue: Number(fearGreedPayload?.data?.value || 0),
      fearGreedClassification: fearGreedPayload?.data?.value_classification || null,
    },
    action_guidance: [
      "Research context only; not a trading, leverage, position sizing, or execution instruction.",
      `Use concrete prices only while provider=${provider} and freshness=fresh.`,
    ],
    source_attribution: sourceAttribution || [
      "CoinMarketCap Pro API cryptocurrency quotes latest",
      "CoinMarketCap Pro API global metrics quotes latest",
      "CoinMarketCap Pro API fear-and-greed latest",
    ],
    missing_or_stale_inputs: snapshot.status === "enabled" ? [] : ["quotes_latest_empty"],
  };
}

function splitCommandLine(value) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const char of String(value || "")) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function cmcSkillForTool(toolName, fallback = "daily_market_overview") {
  return coreCmcSkillForTool(toolName, fallback);
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length) return value;
  }
  return [];
}

function normalizeCMCBridgeEvidence(payload, { skill, symbols, generatedAt }) {
  const unwrapped = unwrapCMCResultEnvelope(payload);
  const result = unwrapCMCResultEnvelope(unwrapped?.result);
  const data = unwrapCMCResultEnvelope(result?.data || unwrapped?.data || result || unwrapped?.evidence || unwrapped || {});
  if (data?.schemaVersion && String(data.schemaVersion).startsWith("cmc-skill-hub-normalized")) {
    return {
      ...data,
      provider: "mcpProvider",
      skill: data.skill || skill,
      status: data.status || "ok",
      generatedAt: data.generatedAt || generatedAt,
      observedAt: data.observedAt || generatedAt,
      expiresAt: data.expiresAt || new Date(Date.parse(generatedAt) + Math.max(60, cmcRefreshTTLSeconds) * 1000).toISOString(),
      freshness: data.freshness || "fresh",
    };
  }
  const assets = firstArray(data.watchlist, data.trader_readouts, data.assets, data.market?.assets, payload?.watchlist, payload?.assets)
    .map((asset) => ({
      symbol: String(asset?.symbol || asset?.asset || "").toUpperCase(),
      name: String(asset?.name || asset?.symbol || asset?.asset || "Unknown"),
      priceUSD: Number(asset?.priceUSD ?? asset?.price_usd ?? asset?.price ?? 0),
      percentChange24h: Number(asset?.percentChange24h ?? asset?.percent_change_24h ?? asset?.change24h ?? 0),
      volume24hUSD: Number(asset?.volume24hUSD ?? asset?.volume_24h ?? asset?.volume24h ?? 0),
      marketCapUSD: Number(asset?.marketCapUSD ?? asset?.market_cap ?? asset?.marketCap ?? 0),
      observedAt: asset?.observedAt || data.observedAt || generatedAt,
      confidence: asset?.confidence || null,
      thesis: asset?.thesis || asset?.trader_takeaway || null,
      setupType: asset?.setup_type || asset?.source_lane || null,
    }))
    .filter((asset) => asset.symbol && (symbols.length === 0 || symbols.includes(asset.symbol)));
  const summary = data.summary || data.decision_report?.conclusion || data.market_read?.summary || data.raw_evidence?.summary || payload?.summary || `${skill} returned CMC Skill Hub evidence.`;
  return {
    schemaVersion: "cmc-skill-hub-normalized-v2",
    provider: "mcpProvider",
    skill,
    status: data.status === "degraded" || data.status === "blocked" ? data.status : "ok",
    confidence: data.confidence || null,
    observedAt: data.observedAt || payload?.observedAt || generatedAt,
    generatedAt,
    expiresAt: data.expiresAt || new Date(Date.parse(generatedAt) + Math.max(60, cmcRefreshTTLSeconds) * 1000).toISOString(),
    freshness: "fresh",
    watchlist: assets,
    market_read: {
      summary,
      rawStatus: data.status || payload?.status || "ok",
      regime: data.market_read?.regime || null,
      primaryDriver: data.market_read?.primary_driver || null,
      riskBias: data.market_read?.risk_bias || null,
    },
    action_guidance: firstArray(data.action_guidance).length ? firstArray(data.action_guidance) : [
      "Research context only; not a trading, leverage, position sizing, or execution instruction.",
      "Use concrete numbers only while provider=mcpProvider and freshness=fresh.",
    ],
    source_attribution: firstArray(data.source_attribution, data.coverage_diagnostics?.source_attribution).length
      ? firstArray(data.source_attribution, data.coverage_diagnostics?.source_attribution)
      : ["CoinMarketCap Crypto Skill Hub MCP"],
    missing_or_stale_inputs: firstArray(data.missing_or_stale_inputs),
    rawBridgeStatus: payload?.status || data.status || "ok",
  };
}

function marketSnapshotFromNormalizedEvidence(evidence, providerOverride = null, generatedAt = now()) {
  const provider = providerOverride || evidence?.provider || "normalizedFileProvider";
  const sourceGeneratedAt = evidence?.generatedAt || evidence?.observedAt || generatedAt;
  const expiresAt = evidence?.expiresAt || new Date(Date.parse(sourceGeneratedAt) + Math.max(60, cmcRefreshTTLSeconds) * 1000).toISOString();
  const expiresAtMs = Date.parse(expiresAt);
  const upstreamWarnings = firstArray(evidence?.upstreamWarnings, evidence?.upstream_warnings);
  const missingOrStaleInputs = firstArray(evidence?.missing_or_stale_inputs, evidence?.missingOrStaleInputs);
  const liveProvider = ["mcpProvider", "cmcRestProvider"].includes(provider);
  const liveResearchFresh = liveProvider
    && ["ok", "partial"].includes(String(evidence?.status || "").toLowerCase())
    && Number.isFinite(expiresAtMs)
    && expiresAtMs >= Date.now();
  const watchlist = Array.isArray(evidence?.watchlist) ? evidence.watchlist : [];
  const assets = watchlist.map((asset) => ({
    symbol: String(asset?.symbol || "").toUpperCase(),
    name: String(asset?.name || asset?.symbol || "Unknown"),
    priceUSD: Number(asset?.priceUSD || 0),
    percentChange24h: Number(asset?.percentChange24h || 0),
    volume24hUSD: Number(asset?.volume24hUSD || 0),
    marketCapUSD: Number(asset?.marketCapUSD || 0),
    source: provider === "mcpProvider" ? "CoinMarketCap Crypto Skill Hub MCP bridge" : `cmc_skill_hub_${provider}`,
    isLive: Boolean(liveResearchFresh),
    hasConcretePrice: Number(asset?.priceUSD || 0) > 0,
    confidence: asset?.confidence || null,
    thesis: asset?.thesis || null,
    setupType: asset?.setupType || null,
    observedAt: asset?.observedAt || evidence?.observedAt || sourceGeneratedAt,
  }));
  const fixture = provider === "fixtureProvider";
  return {
    schemaVersion: "market-data-snapshot-v2",
    status: liveResearchFresh ? "enabled" : "degraded",
    sourceName: provider === "mcpProvider" ? "CoinMarketCap Crypto Skill Hub MCP" : `CMC Skill Hub ${provider}`,
    provider,
    generatedAt: sourceGeneratedAt,
    observedAt: evidence?.observedAt || sourceGeneratedAt,
    expiresAt,
    freshness: fixture ? "fixture" : liveResearchFresh ? "fresh" : "degraded",
    lastVerifiedAt: sourceGeneratedAt,
    assets,
    evidence: [
      evidence?.market_read?.summary || "CMC Skill Hub evidence normalized locally.",
      ...firstArray(evidence?.action_guidance),
    ],
    missingOrStaleInputs,
    upstreamWarnings,
    upstreamStatus: liveResearchFresh ? `${provider}_ok` : `${provider}_degraded`,
  };
}

function writeCMCMarketArtifacts(snapshot, evidence) {
  const marketRoot = join(projectRoot, "runtime", "market");
  const snapshotPath = join(marketRoot, "latest-market-snapshot.json");
  const normalizedPath = join(marketRoot, "cmc-skill-hub.normalized.json");
  writeJSON(snapshotPath, snapshot);
  writeJSON(normalizedPath, evidence);
  return {
    artifact: "runtime/market/latest-market-snapshot.json",
    normalizedArtifact: "runtime/market/cmc-skill-hub.normalized.json",
  };
}

function runCMCBridge({ skill, symbols, prompt, runID, generatedAt }) {
  const parts = splitCommandLine(cmcSkillHubBridgeCommand());
  if (!parts.length) return { ok: false, reason: "cmc_mcp_bridge_not_configured" };
  if (parts.some((part) => /[\r\n]/.test(part))) return { ok: false, reason: "cmc_mcp_bridge_command_invalid" };
  const [cmd, ...args] = parts;
  const request = {
    schemaVersion: "cmc-skill-hub-bridge-request-v1",
    runID,
    skill,
    parameters: {
      preview: true,
      symbols,
      symbol: symbols[0],
      query: prompt || symbols.join(", "),
    },
    generatedAt,
  };
  let res;
  try {
    res = spawnSync(cmd, args, {
      input: `${JSON.stringify(request)}\n`,
      encoding: "utf8",
      timeout: Number(process.env.CMC_SKILL_HUB_BRIDGE_TIMEOUT_MS || "30000"),
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME || "",
        LANG: process.env.LANG || "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL || "",
        NODE_ENV: process.env.NODE_ENV || "production",
      },
    });
  } catch (error) {
    return { ok: false, reason: "cmc_mcp_bridge_spawn_failed", errorPreview: redact(String(error?.message || error)) };
  }
  if (res.error) return { ok: false, reason: "cmc_mcp_bridge_spawn_failed", errorPreview: redact(String(res.error.message || res.error)) };
  if (res.status !== 0) return { ok: false, reason: "cmc_mcp_bridge_error", statusCode: res.status, errorPreview: redact((res.stderr || "").trim()) };
  try {
    return { ok: true, payload: JSON.parse(res.stdout || "null") };
  } catch (error) {
    return { ok: false, reason: "cmc_mcp_bridge_json_parse_failed", errorPreview: redact(String(error?.message || error)) };
  }
}

function cmcMcpShouldTryNextKey(result) {
  if (!result || result.status === "ok") return false;
  if ([401, 403, 429].includes(Number(result.statusCode))) return true;
  const text = `${result.reason || ""} ${result.errorPreview || ""}`.toLowerCase();
  return /quota|rate.?limit|too many requests|exhaust|credit|subscription|plan|unauthori[sz]ed|forbidden|auth|api.?key|cmc_mcp_subscription_unsupported/.test(text);
}

async function refreshCMCViaMcpHTTP(options, warnings) {
  const symbols = sanitizeSymbols(options.symbols || options.symbol || options.query);
  const generatedAt = now();
  const keys = cmcMcpAPIKeys();
  if (!cmcMcpEndpointURL() || !keys.length) {
    return { status: "degraded", provider: "mcpProvider", providerType: "mcpHttpProvider", symbols, generatedAt, artifact: null, rawSecretsReturned: false, reason: "missing_cmc_mcp_api_key" };
  }

  let lastResult = null;
  for (let index = 0; index < keys.length; index += 1) {
    const attemptWarnings = [];
    const result = await refreshCMCViaMcpHTTPWithKey(options, attemptWarnings, {
      apiKey: keys[index],
      keyIndex: index,
      keyCount: keys.length,
    });
    if (result.status === "ok") {
      warnings.push(...attemptWarnings);
      if (index > 0) warnings.push("cmc_mcp_key_fallback_used");
      return {
        ...result,
        mcpKeyCount: keys.length,
        mcpKeyFallbackUsed: index > 0,
        upstreamWarnings: [...new Set([...(result.upstreamWarnings || []), ...attemptWarnings, ...(index > 0 ? ["cmc_mcp_key_fallback_used"] : [])])],
      };
    }
    lastResult = result;
    warnings.push(...attemptWarnings, `cmc_mcp_key_${index + 1}_${result.reason || "degraded"}`);
    if (!cmcMcpShouldTryNextKey(result)) break;
  }

  return {
    ...(lastResult || { status: "degraded", provider: "mcpProvider", providerType: "mcpHttpProvider", symbols, generatedAt, artifact: null, rawSecretsReturned: false, reason: "cmc_mcp_all_keys_failed" }),
    mcpKeyCount: keys.length,
    mcpKeyFallbackUsed: keys.length > 1,
    upstreamWarnings: [...new Set([...(lastResult?.upstreamWarnings || []), ...warnings, keys.length > 1 ? "cmc_mcp_key_fallback_attempted" : null].filter(Boolean))],
  };
}

async function refreshCMCViaMcpHTTPWithKey(options, warnings, { apiKey }) {
  const symbols = sanitizeSymbols(options.symbols || options.symbol || options.query);
  const generatedAt = now();
  const skill = options.skill || cmcSkillForTool(options.toolName);
  if (!apiKey) {
    return { status: "degraded", provider: "mcpProvider", providerType: "mcpHttpProvider", symbols, generatedAt, artifact: null, rawSecretsReturned: false, reason: "missing_cmc_mcp_api_key" };
  }
  const client = await cmcMcpClient({ apiKey });
  if (!client.ok) {
    writeOpsStatus(health(), { status: "degraded", provider: "mcpProvider", providerType: "mcpHttpProvider", reason: client.reason, updatedAt: generatedAt });
    return { status: "degraded", provider: "mcpProvider", providerType: "mcpHttpProvider", symbols, generatedAt, artifact: null, rawSecretsReturned: false, reason: client.reason || "cmc_mcp_tools_list_failed", statusCode: client.statusCode, errorPreview: client.errorPreview };
  }

  const findSkillTool = cmcMcpToolByName(client.tools, ["find_skill"]);
  const executeSkillTool = cmcMcpToolByName(client.tools, ["execute_skill"]);
  if (findSkillTool && executeSkillTool) {
    const discovered = await callCMCMcpTool(
      findSkillTool,
      buildCMCSkillHubFindArguments(findSkillTool, { symbols, skill, prompt: options.prompt || options.query }),
      client.sessionID,
      { apiKey },
    );
    if (discovered.ok) {
      const discoveryError = cmcSkillHubPayloadError(discovered.payload);
      if (discoveryError) {
        warnings.push(discoveryError.code);
        const degradedDiscovery = {
          status: "degraded",
          provider: "mcpProvider",
          providerType: "mcpHttpProvider",
          protocol: "skill_hub",
          symbols,
          generatedAt,
          artifact: null,
          rawSecretsReturned: false,
          reason: discoveryError.code,
          errorPreview: discoveryError.message,
        };
        if (cmcMcpShouldTryNextKey(degradedDiscovery)) return degradedDiscovery;
      } else {
      const candidate = selectCMCSkillHubCandidate(discovered.payload, skill);
      const uniqueName = candidate?.uniqueName || candidate?.unique_name;
      if (uniqueName) {
        const parameters = buildCMCSkillHubExecutionParameters(candidate, { symbols, skill: uniqueName, prompt: options.prompt || options.query });
        const executed = await callCMCMcpTool(
          executeSkillTool,
          buildCMCSkillHubExecuteArguments(executeSkillTool, candidate, parameters),
          client.sessionID,
          { apiKey },
        );
        if (executed.ok) {
          const executionError = cmcSkillHubPayloadError(executed.payload);
          if (executionError) {
            writeOpsStatus(health(), {
              status: "degraded",
              provider: "mcpProvider",
              providerType: "mcpHttpProvider",
              protocol: "skill_hub",
              symbols,
              skill: uniqueName,
              reason: executionError.code,
              errorPreview: executionError.message,
              updatedAt: generatedAt,
            });
            return {
              status: "degraded",
              provider: "mcpProvider",
              providerType: "mcpHttpProvider",
              protocol: "skill_hub",
              skill: uniqueName,
              symbols,
              generatedAt,
              artifact: null,
              rawSecretsReturned: false,
              reason: executionError.code,
              errorPreview: executionError.message,
            };
          }
          const skillHubResult = cmcSkillHubResultSummary(executed.payload, { skill: uniqueName, symbols, generatedAt });
          const evidence = normalizeCMCBridgeEvidence(executed.payload, { skill: uniqueName, symbols, generatedAt });
          const snapshot = marketSnapshotFromNormalizedEvidence(evidence, "mcpProvider", generatedAt);
          const artifacts = writeCMCMarketArtifacts(snapshot, evidence);
          writeOpsStatus(health(), {
            status: snapshot.status,
            provider: "mcpProvider",
            providerType: "mcpHttpProvider",
            protocol: "skill_hub",
            symbols,
            skill: uniqueName,
            assetCount: snapshot.assets.length,
            artifactPath: artifacts.artifact,
            updatedAt: generatedAt,
          });
          return {
            status: snapshot.status === "enabled" ? "ok" : "degraded",
            provider: "mcpProvider",
            providerType: "mcpHttpProvider",
            protocol: "skill_hub",
            skill: uniqueName,
            symbols,
            assets: snapshot.assets.length,
            skillHubResult,
            ...artifacts,
            freshness: snapshot.freshness,
            generatedAt,
            upstreamWarnings: warnings,
            rawSecretsReturned: false,
          };
        }
        const degradedExecution = {
          status: "degraded",
          provider: "mcpProvider",
          providerType: "mcpHttpProvider",
          protocol: "skill_hub",
          skill: uniqueName,
          symbols,
          generatedAt,
          artifact: null,
          rawSecretsReturned: false,
          reason: executed.reason || "cmc_skill_hub_execute_failed",
          statusCode: executed.statusCode,
          errorPreview: executed.errorPreview,
        };
        if (cmcMcpShouldTryNextKey(degradedExecution)) return degradedExecution;
        warnings.push(degradedExecution.reason);
      } else {
        warnings.push("cmc_skill_hub_candidate_missing");
      }
      }
    } else {
      const degradedDiscoveryCall = {
        status: "degraded",
        provider: "mcpProvider",
        providerType: "mcpHttpProvider",
        protocol: "skill_hub",
        symbols,
        generatedAt,
        artifact: null,
        rawSecretsReturned: false,
        reason: discovered.reason || "cmc_skill_hub_find_failed",
        statusCode: discovered.statusCode,
        errorPreview: discovered.errorPreview,
      };
      if (cmcMcpShouldTryNextKey(degradedDiscoveryCall)) return degradedDiscoveryCall;
      warnings.push(degradedDiscoveryCall.reason);
    }
  }

  const quotesTool = selectCMCMcpTool(client.tools, "quotes", skill);
  if (quotesTool) {
    const quotes = await callCMCMcpTool(quotesTool, buildCMCMcpArguments(quotesTool, { symbols, skill, prompt: options.prompt || options.query }), client.sessionID, { apiKey });
    if (quotes.ok) {
      const globalTool = selectCMCMcpTool(client.tools, "global", skill);
      const fearTool = selectCMCMcpTool(client.tools, "fear_greed", skill);
      const [globalMetrics, fearGreed] = await Promise.all([
        globalTool ? callCMCMcpTool(globalTool, buildCMCMcpArguments(globalTool, { symbols, skill, prompt: options.prompt || options.query }), client.sessionID, { apiKey }) : Promise.resolve({ ok: false, reason: "cmc_mcp_global_tool_missing" }),
        fearTool ? callCMCMcpTool(fearTool, buildCMCMcpArguments(fearTool, { symbols, skill, prompt: options.prompt || options.query }), client.sessionID, { apiKey }) : Promise.resolve({ ok: false, reason: "cmc_mcp_fear_greed_tool_missing" }),
      ]);
      const snapshot = marketSnapshotFromCMC({
        symbols,
        quotesPayload: quotes.payload,
        globalPayload: globalMetrics.ok ? globalMetrics.payload : null,
        fearGreedPayload: fearGreed.ok ? fearGreed.payload : null,
        generatedAt,
        provider: "mcpProvider",
        sourceName: "CoinMarketCap MCP",
        quoteSource: "CoinMarketCap MCP cryptocurrency quotes latest",
      });
      const evidence = normalizedEvidenceFromCMCSnapshot(snapshot, globalMetrics.ok ? globalMetrics.payload : null, fearGreed.ok ? fearGreed.payload : null, {
        provider: "mcpProvider",
        skill,
        sourceAttribution: [
          "CoinMarketCap MCP tools/list",
          `CoinMarketCap MCP tool ${quotesTool.name}`,
          ...(globalTool ? [`CoinMarketCap MCP tool ${globalTool.name}`] : []),
          ...(fearTool ? [`CoinMarketCap MCP tool ${fearTool.name}`] : []),
        ],
      });
      const artifacts = writeCMCMarketArtifacts(snapshot, evidence);
      const status = snapshot.status === "enabled" ? "ok" : "degraded";
      writeOpsStatus(health(), {
        status: snapshot.status,
        provider: "mcpProvider",
        providerType: "mcpHttpProvider",
        symbols,
        skill,
        assetCount: snapshot.assets.length,
        artifactPath: artifacts.artifact,
        updatedAt: generatedAt,
      });
      return {
        status,
        provider: "mcpProvider",
        providerType: "mcpHttpProvider",
        skill,
        symbols,
        assets: snapshot.assets.length,
        ...artifacts,
        freshness: snapshot.freshness,
        generatedAt,
        upstreamWarnings: [...warnings, ...[globalMetrics, fearGreed].filter((item) => !item.ok).map((item) => item.reason)],
        rawSecretsReturned: false,
      };
    }
    const degradedQuotes = {
      status: "degraded",
      provider: "mcpProvider",
      providerType: "mcpHttpProvider",
      symbols,
      generatedAt,
      artifact: null,
      rawSecretsReturned: false,
      reason: quotes.reason || "cmc_mcp_quotes_tool_failed",
      statusCode: quotes.statusCode,
      errorPreview: quotes.errorPreview,
    };
    if (cmcMcpShouldTryNextKey(degradedQuotes)) return degradedQuotes;
    warnings.push(degradedQuotes.reason);
  }

  const skillTool = selectCMCMcpTool(client.tools, "skill", skill);
  if (!skillTool) {
    return { status: "degraded", provider: "mcpProvider", providerType: "mcpHttpProvider", symbols, generatedAt, artifact: null, rawSecretsReturned: false, reason: "cmc_mcp_usable_tool_missing", availableToolCount: client.tools.length };
  }
  const broad = await callCMCMcpTool(skillTool, buildCMCMcpArguments(skillTool, { symbols, skill, prompt: options.prompt || options.query }), client.sessionID, { apiKey });
  if (!broad.ok) {
    return { status: "degraded", provider: "mcpProvider", providerType: "mcpHttpProvider", symbols, generatedAt, artifact: null, rawSecretsReturned: false, reason: broad.reason || "cmc_mcp_skill_tool_failed", statusCode: broad.statusCode, errorPreview: broad.errorPreview };
  }
  const evidence = normalizeCMCBridgeEvidence(broad.payload, { skill, symbols, generatedAt });
  const snapshot = marketSnapshotFromNormalizedEvidence(evidence, "mcpProvider", generatedAt);
  const artifacts = writeCMCMarketArtifacts(snapshot, evidence);
  writeOpsStatus(health(), {
    status: snapshot.status,
    provider: "mcpProvider",
    providerType: "mcpHttpProvider",
    symbols,
    skill,
    assetCount: snapshot.assets.length,
    artifactPath: artifacts.artifact,
    updatedAt: generatedAt,
  });
  return {
    status: snapshot.status === "enabled" ? "ok" : "degraded",
    provider: "mcpProvider",
    providerType: "mcpHttpProvider",
    skill,
    symbols,
    assets: snapshot.assets.length,
    ...artifacts,
    freshness: snapshot.freshness,
    generatedAt,
    upstreamWarnings: warnings,
    rawSecretsReturned: false,
  };
}

async function refreshCMCViaBridge(options, warnings) {
  const symbols = sanitizeSymbols(options.symbols || options.symbol || options.query);
  const generatedAt = now();
  const skill = options.skill || cmcSkillForTool(options.toolName);
  const bridge = runCMCBridge({ skill, symbols, prompt: options.prompt || options.query, runID: options.runID, generatedAt });
  if (!bridge.ok) return { status: "degraded", provider: "mcpProvider", symbols, generatedAt, artifact: null, rawSecretsReturned: false, ...bridge };
  const evidence = normalizeCMCBridgeEvidence(bridge.payload, { skill, symbols, generatedAt });
  const snapshot = marketSnapshotFromNormalizedEvidence(evidence, "mcpProvider", generatedAt);
  const artifacts = writeCMCMarketArtifacts(snapshot, evidence);
  writeOpsStatus(health(), {
    status: snapshot.status,
    provider: "mcpProvider",
    symbols,
    skill,
    assetCount: snapshot.assets.length,
    artifactPath: artifacts.artifact,
    updatedAt: generatedAt,
  });
  return {
    status: snapshot.status === "enabled" ? "ok" : "degraded",
    provider: "mcpProvider",
    skill,
    symbols,
    assets: snapshot.assets.length,
    ...artifacts,
    freshness: snapshot.freshness,
    generatedAt,
    upstreamWarnings: warnings,
    rawSecretsReturned: false,
  };
}

async function refreshCMCViaRest(options, warnings) {
  const symbols = sanitizeSymbols(options.symbols || options.symbol || options.query);
  const generatedAt = now();
  if (!cmcAPIKey()) {
    return { status: "degraded", reason: "missing_cmc_api_key", provider: "cmcRestProvider", symbols, generatedAt, artifact: null, rawSecretsReturned: false };
  }
  const quotes = await cmcFetch("/v3/cryptocurrency/quotes/latest", { symbol: symbols.join(","), convert: "USD" });
  if (!quotes.ok) {
    const result = { status: "degraded", provider: "cmcRestProvider", symbols, generatedAt, ...quotes, artifact: null, rawSecretsReturned: false };
    writeOpsStatus(health(), { status: "degraded", provider: "cmcRestProvider", reason: result.reason, updatedAt: generatedAt });
    return result;
  }
  const [globalMetrics, fearGreed] = await Promise.all([
    cmcFetch("/v1/global-metrics/quotes/latest", { convert: "USD" }),
    cmcFetch("/v3/fear-and-greed/latest", {}),
  ]);
  const snapshot = marketSnapshotFromCMC({
    symbols,
    quotesPayload: quotes.payload,
    globalPayload: globalMetrics.ok ? globalMetrics.payload : null,
    fearGreedPayload: fearGreed.ok ? fearGreed.payload : null,
    generatedAt,
  });
  const marketRoot = join(projectRoot, "runtime", "market");
  const evidence = normalizedEvidenceFromCMCSnapshot(snapshot, globalMetrics.ok ? globalMetrics.payload : null, fearGreed.ok ? fearGreed.payload : null);
  const artifacts = writeCMCMarketArtifacts(snapshot, evidence);
  writeOpsStatus(health(), {
    status: snapshot.status,
    provider: "cmcRestProvider",
    symbols,
    assetCount: snapshot.assets.length,
    artifactPath: artifacts.artifact,
    updatedAt: generatedAt,
  });
  return {
    status: snapshot.status === "enabled" ? "ok" : "degraded",
    provider: "cmcRestProvider",
    symbols,
    assets: snapshot.assets.length,
    ...artifacts,
    freshness: snapshot.freshness,
    generatedAt,
    upstreamWarnings: [...warnings, ...[globalMetrics, fearGreed].filter((item) => !item.ok).map((item) => item.reason)],
    rawSecretsReturned: false,
  };
}

function refreshCMCFromNormalizedFile(options, warnings) {
  const normalizedPath = join(projectRoot, "runtime", "market", "cmc-skill-hub.normalized.json");
  const generatedAt = now();
  if (!existsSync(normalizedPath)) {
    return { status: "degraded", reason: "normalized_cmc_file_missing", provider: "normalizedFileProvider", generatedAt, artifact: null, rawSecretsReturned: false };
  }
  const source = readJSON(normalizedPath, null);
  const evidence = {
    ...(source || {}),
    provider: "normalizedFileProvider",
    status: source?.status === "ok" ? "degraded" : (source?.status || "degraded"),
    freshness: source?.freshness === "fixture" ? "fixture" : "degraded",
    generatedAt: source?.generatedAt || generatedAt,
    observedAt: source?.observedAt || source?.generatedAt || generatedAt,
    expiresAt: source?.expiresAt || generatedAt,
    missing_or_stale_inputs: [...new Set([...firstArray(source?.missing_or_stale_inputs), ...warnings, "normalized_file_provider_not_live"])],
    upstreamWarnings: warnings,
  };
  const snapshot = marketSnapshotFromNormalizedEvidence(evidence, "normalizedFileProvider", generatedAt);
  const artifacts = writeCMCMarketArtifacts(snapshot, evidence);
  writeOpsStatus(health(), { status: "degraded", provider: "normalizedFileProvider", artifactPath: artifacts.artifact, updatedAt: generatedAt });
  return {
    status: "degraded",
    provider: "normalizedFileProvider",
    assets: snapshot.assets.length,
    ...artifacts,
    freshness: snapshot.freshness,
    generatedAt,
    upstreamWarnings: warnings,
    rawSecretsReturned: false,
  };
}

function refreshCMCFromFixture(options, warnings) {
  const generatedAt = now();
  const fixturePath = join(agentRuntimeRoot, "extensions", "cmc-skill-hub", "fixtures", "market-evidence.sample.json");
  const source = readJSON(fixturePath, { status: "degraded", watchlist: [], market_read: { summary: "CMC fixture unavailable." } });
  const evidence = {
    ...source,
    provider: "fixtureProvider",
    status: "degraded",
    freshness: "fixture",
    generatedAt,
    observedAt: generatedAt,
    expiresAt: generatedAt,
    missing_or_stale_inputs: [...new Set([...firstArray(source?.missing_or_stale_inputs), ...warnings, "fixture_provider_not_live"])],
    upstreamWarnings: warnings,
  };
  const snapshot = marketSnapshotFromNormalizedEvidence(evidence, "fixtureProvider", generatedAt);
  const artifacts = writeCMCMarketArtifacts(snapshot, evidence);
  writeOpsStatus(health(), { status: "degraded", provider: "fixtureProvider", artifactPath: artifacts.artifact, updatedAt: generatedAt });
  return {
    status: "degraded",
    reason: "using_fixture_provider",
    provider: "fixtureProvider",
    assets: snapshot.assets.length,
    ...artifacts,
    freshness: "fixture",
    generatedAt,
    upstreamWarnings: warnings,
    rawSecretsReturned: false,
  };
}

async function refreshCMCLive(options = {}) {
  const warnings = [];
  const requestedOrder = Array.isArray(options.providerOrder) ? options.providerOrder : cmcProviderOrder;
  const order = requestedOrder.length ? requestedOrder : ["mcp_http", "mcp_bridge", "rest", "normalized", "fixture"];
  let lastResult = null;
  for (const provider of order) {
    if (["mcp_http", "mcphttp", "mcp_server", "mcp"].includes(provider)) {
      const result = await refreshCMCViaMcpHTTP(options, warnings);
      if (result.status === "ok") return result;
      warnings.push(result.reason || "mcp_http_degraded");
      lastResult = result;
      continue;
    }
    if (["mcp_bridge", "mcp", "bridge"].includes(provider)) {
      const result = await refreshCMCViaBridge(options, warnings);
      if (result.status === "ok") return result;
      warnings.push(result.reason || "mcp_bridge_degraded");
      lastResult = result;
      continue;
    }
    if (["rest", "cmc_rest", "cmcrest"].includes(provider)) {
      const result = await refreshCMCViaRest(options, warnings);
      if (result.status === "ok") return result;
      warnings.push(result.reason || "cmc_rest_degraded");
      lastResult = result;
      continue;
    }
    if (["normalized", "normalized_file", "file"].includes(provider)) {
      const result = refreshCMCFromNormalizedFile(options, warnings);
      if (result.artifact) return result;
      warnings.push(result.reason || "normalized_file_degraded");
      lastResult = result;
      continue;
    }
    if (["fixture", "fixture_provider"].includes(provider)) {
      return refreshCMCFromFixture(options, warnings);
    }
  }
  if (lastResult) {
    writeOpsStatus(health(), { status: "degraded", provider: lastResult.provider, reason: lastResult.reason, updatedAt: now() });
    return { ...lastResult, upstreamWarnings: warnings };
  }
  return refreshCMCFromFixture(options, warnings);
}

function refreshWechatLive(options = {}) {
  if (!wechatLiveEnabled()) {
    return { status: "disabled", reason: "WECHAT_LIVE_ENABLED 不是 true", artifact: null };
  }
  const sessionLimit = Number(options.sessionLimit || 12);
  const perChatLimit = Number(options.perChatLimit || 30);
  const sessionsRes = runWechatCli(["sessions", "--limit", String(sessionLimit)]);
  if (!sessionsRes.ok) {
    return { status: "degraded", step: "sessions", ...sessionsRes, hint: "确认已运行 `sudo wechat-cli init` 且微信在运行。", artifact: null };
  }
  const rawSessions = Array.isArray(sessionsRes.data) ? sessionsRes.data : (sessionsRes.data?.sessions || []);
  const groups = [];
  const messages = [];
  const failures = [];
  let mid = 1;
  for (const s of rawSessions) {
    const chat = String(s.chat || s.display || s.username || "").trim();
    if (!chat) continue;
    groups.push({
      id: createHash("md5").update(String(s.username || chat)).digest("hex").slice(0, 12),
      name: chat,
      memberCount: Number(s.member_count || 0),
      unreadCount: Number(s.unread || 0),
      collection: s.is_group ? "GROUPS" : "CONTACTS",
      colorHex: "#50B4FF",
    });
    const histRes = runWechatCli(["history", chat, "--limit", String(perChatLimit)]);
    if (!histRes.ok) { failures.push({ chat, ...histRes }); continue; }
    const lines = histRes.data?.messages || [];
    for (const ln of lines) {
      const text = String(ln.content ?? ln.text ?? ln.message ?? ln.summary ?? "").trim();
      if (!text) continue;
      const sender = String(ln.sender ?? ln.sender_name ?? ln.talker ?? ln.from ?? chat);
      const iso = liveToIso(ln.timestamp ?? ln.create_time ?? ln.time);
      messages.push({
        id: `live-${String(mid++).padStart(8, "0")}`,
        title: text.slice(0, 80),
        excerpt: text.slice(0, 200),
        groupName: chat,
        sender,
        timestamp: iso.slice(11, 16),
        sentAt: iso,
        sourceDateText: `${iso.slice(0, 10)} ${iso.slice(11, 16)}`,
        weight: Math.max(1, Math.min(20, Math.round(text.length / 8))),
        tags: [],
      });
    }
  }
  const out = {
    notes: [
      "Live WeChat via local wechat-cli (read-only, on-device).",
      `generatedAt ${now()}`,
      `sessions ${rawSessions.length} · messages ${messages.length}`,
    ],
    groups,
    messages,
    source: "wechat_cli_live",
    generatedAt: now(),
  };
  const outPath = join(projectRoot, "runtime", "wechat", "messages.live.json");
  writeJSON(outPath, out);
  return {
    status: messages.length ? "ok" : "empty",
    sessions: rawSessions.length,
    messages: messages.length,
    failures: failures.length ? failures : undefined,
    artifact: relative(projectRoot, outPath),
  };
}

function maybeRefreshLiveWechatForRun(tools) {
  if (!tools.includes("wechat.read_normalized_messages")) return null;
  if (!wechatLiveEnabled()) return null;
  const result = refreshWechatLive({});
  return {
    result,
    contextText: `\n\nRead-only WeChat refresh artifact:\nstatus=${result.status}; sessions=${result.sessions || 0}; messages=${result.messages || 0}; artifact=${result.artifact || "none"}.\nRaw WeChat message text is not included in this model context.\n`,
  };
}

// --- CMC strategist result emission --------------------------------------------------
// On a strategist task, write runtime/agent/runs/{runID}/cmc-strategist-result.json so the
// workbench renders a decision-support conclusion card. Uses reproducible fixtures (labeled
// dataFreshness=fixture) until live CMC + a model produce real strategyReadModels.
const STRATEGIST_FIXTURES = {
  alpha_discovery: {
    schemaVersion: "cmc-strategist-result-v1", taskType: "alpha_discovery",
    title: "HOME 永续挤压候选，等待回踩", verdict: "研究候选成立，但不追高，等待关键回踩区确认。",
    confidence: 0.72, dataFreshness: "fixture",
    decisionProblem: "市场 risk-off（恐惧 36），晨扫把 HOME 标了出来——已 +187%/30d、funding 深度为负。这是真 alpha，还是该回避的 blow-off 顶？",
    subject: { symbol: "HOME", name: "Defi App", instrument: "spot/perp", directionContext: "watch_long_setup" },
    candidateSignals: [
      { label: "Perp 挤压", value: "OI +201% · funding -0.31%", interpretation: "拥挤且可能继续挤压，但不是低风险追高点。" },
      { label: "Spot 确认", value: "spot CVD -$0.56M", interpretation: "perp 主导、spot 未确认，结构偏脆弱。" },
      { label: "Profile", value: "Vol/MC 83.5%", interpretation: "$160M 市值 · +187%/30d，热钱换手高。" }
    ],
    keyLevels: [
      { label: "回踩区", price: 0.038, upperPrice: 0.0405, role: "wait_for_entry_review", condition: "价格回踩且结构未破坏", invalidatesBelow: 0.035 },
      { label: "失效区", price: 0.035, role: "invalidation", condition: "跌破则候选作废" }
    ],
    scenarios: [
      { id: "A", label: "继续挤压", if: "守住回踩区，OI 不塌，funding 修复", then: "继续观察上方流动性区", bias: "constructive", confidence: 0.55, triggered: true },
      { id: "B", label: "假突破回落", if: "spot 持续不确认", then: "回到区间下沿，候选转弱", bias: "cautious", confidence: 0.3 },
      { id: "C", label: "结构破坏", if: "跌破 0.035 失效区", then: "候选作废，移出观察", bias: "bearish", confidence: 0.15 }
    ],
    counterEvidence: [
      { label: "Spot 确认不足", detail: "spot CVD 未确认，结构偏 perp-led", severity: "medium" },
      { label: "流动性缺口", detail: "缺少 live liquidation map，挤压上限不确定", severity: "low" }
    ],
    sourceMap: [{ label: "CMC 市场证据", artifactPath: "runtime/agent/runs/{runID}/cmc-daily_market_overview.json", freshness: "fixture", provider: "fixtureProvider" }],
    riskBoundary: { tradeInstruction: "blocked", summary: "仅做研究与决策支持，不生成下单、仓位或杠杆指令。", warnings: ["杠杆会放大亏损", "缺少 live liquidation map 时必须标记数据缺口"] },
    followUps: [{ label: "跟踪回踩区", condition: "价格进入 0.038–0.0405 且 funding 正常化", suggestedSkillIDs: ["cmc-market-radar"] }],
    takeaway: "发现 + 纪律：扫描在变明显前就捞出 HOME；深度分析拒绝追顶、标出 0.035 这条决定性价位。回踩到该位即是有依据的入场，而非追高 FOMO。"
  },
  perp_trade_review: {
    schemaVersion: "cmc-strategist-result-v1", taskType: "perp_trade_review",
    title: "ZEC 永续：场景化复核", verdict: "结构偏弱、拥挤度高；$517 是决定性价位，跌破则级联，守住可观望。",
    confidence: 0.61, dataFreshness: "fixture",
    decisionProblem: "我做空 ZEC 且在盈利。挤压会不会回来碾我，还是这就是 breakdown——哪条线告诉我答案？",
    subject: { symbol: "ZEC", name: "Zcash", instrument: "perp", directionContext: "user_short" },
    candidateSignals: [
      { label: "Regime", value: "1.88:1 → 1.08:1", interpretation: "多头挤压设置失败：上方弹药 -36%、下方 +46%。" },
      { label: "决定性价位", value: "$517.26 · $727.7M", interpretation: "仅 -2.38%，是决定方向的那条线。" },
      { label: "场景", value: "破 → $499 → $477", interpretation: "明确每个结果的含义。" }
    ],
    keyLevels: [
      { label: "决定性价位", price: 517.26, role: "make_or_break", condition: "跌破且 OI 扩张则级联", invalidatesBelow: 517 },
      { label: "上方反转", price: 568.88, role: "breakout", condition: "收复则转多" }
    ],
    scenarios: [
      { id: "A", label: "守住", if: "$517 守住，OI 企稳", then: "long → $549 → $568", bias: "constructive", confidence: 0.3 },
      { id: "B", label: "级联", if: "跌破 $517.26，OI 扩张", then: "short → $499 → $477", bias: "bearish", confidence: 0.45, triggered: true },
      { id: "C", label: "区间", if: "$517–$553 震荡", then: "观望", bias: "neutral", confidence: 0.25 }
    ],
    counterEvidence: [
      { label: "Funding 拥挤", detail: "多头资金成本高，回调会被放大", severity: "high" },
      { label: "清算数据缺失", detail: "无 live liquidation map，squeeze 风险无法量化", severity: "medium" }
    ],
    sourceMap: [{ label: "CMC 永续结构", artifactPath: "runtime/agent/runs/{runID}/cmc-perp_structure_review.json", freshness: "fixture", provider: "fixtureProvider" }],
    riskBoundary: { tradeInstruction: "blocked", summary: "仅复核结构并给出条件式判断，不构成买卖、加减仓或杠杆指令。", warnings: ["你的 entry/leverage 仅作为上下文展示", "高 funding 环境下回调会被放大"] },
    followUps: [{ label: "盯 $517.26 与 OI", condition: "价位跌破或 OI 快速扩张", suggestedSkillIDs: ["cmc-market-radar", "market-regime-review"] }],
    takeaway: "不靠猜：一条决定性价位 + 双向场景图。价位跌破、级联兑现——是看得见的结构在做决定，而非希望。"
  },
  macro_thesis_review: {
    schemaVersion: "cmc-strategist-result-v1", taskType: "macro_thesis_review",
    title: "BTC 宏观做空 thesis：流出仍在，反证增多", verdict: "空头逻辑尚未失效，但 LTH 增持与稳定币流动性构成反证，转为观察。",
    confidence: 0.54, dataFreshness: "fixture",
    decisionProblem: "BTC 连续两周被 ETF 抽走机构资金，但美股科技在拉升、加密通常跟随 risk-on。信这股「流血」去做空，还是尊重涨势按兵不动？",
    subject: { symbol: "BTC", name: "Bitcoin", instrument: "macro", directionContext: "short_thesis_watch" },
    candidateSignals: [
      { label: "ETF 流出", value: "近 5 日净流出 $1.5B", interpretation: "机构需求持续走弱，支持空头。" },
      { label: "跨资产", value: "BTC/Nasdaq 0.58 → -0.15", interpretation: "与科技脱钩，risk-on beta 失效。" },
      { label: "AUM", value: "$105.2B → $102.96B", interpretation: "资金面持续抽离。" }
    ],
    keyLevels: [{ label: "Thesis 失效价", price: 72000, role: "invalidation", condition: "收复并站稳则 thesis 失效" }],
    scenarios: [
      { id: "A", label: "流出延续", if: "ETF 持续净流出且无 LTH 接力", then: "空头逻辑增强", bias: "bearish", confidence: 0.5, triggered: true },
      { id: "B", label: "反证占优", if: "LTH 加速增持 + 稳定币流动性回升", then: "thesis 转中性，需重评", bias: "cautious", confidence: 0.5 }
    ],
    counterEvidence: [
      { label: "LTH 增持", detail: "长期持有者持续增持，吸收抛压", severity: "high" },
      { label: "稳定币流动性", detail: "稳定币供应回升，潜在买盘待命", severity: "medium" }
    ],
    sourceMap: [{ label: "ETF / AUM 证据", artifactPath: "runtime/agent/runs/{runID}/cmc-macro_flow_review.json", freshness: "fixture", provider: "fixtureProvider" }],
    riskBoundary: { tradeInstruction: "blocked", summary: "仅做宏观决策支持与监控，不生成做空、对冲或杠杆指令。", warnings: ["宏观事件可能快速逆转流向", "缺少实时链上数据时标记为 data_gap"] },
    followUps: [{ label: "监控 ETF 流与 LTH", condition: "未来 72h ETF 转净流入或 LTH 停止增持", suggestedSkillIDs: ["cmc-market-radar", "market-regime-review"] }],
    takeaway: "做空 melt-up 靠证据不靠胆量：实时看着基本面恶化（流出累积、AUM 下降、与科技脱钩），并正面回应黄金反证。"
  },
};

function detectStrategistTaskType(prompt, selectedSkillIDs = []) {
  const p = String(prompt || "").toLowerCase();
  if (/perp|永续|持仓|squeeze|breakdown|止盈|加减仓/.test(p)) return "perp_trade_review";
  if (/macro|宏观|etf|thesis|做空|\bshort\b|correlation|相关性|跨资产/.test(p)) return "macro_thesis_review";
  if (/alpha|scanner|候选|扫描|discover|顶部|fomo/.test(p)) return "alpha_discovery";
  if (selectedSkillIDs.some((s) => String(s).startsWith("cmc-"))) return "alpha_discovery";
  return null;
}

function marketSnapshotIntegrity(snapshot) {
  const reasons = [];
  if (!snapshot) {
    return { valid: false, reasons: ["market_snapshot_missing"], provider: null, freshness: "missing", assetCount: 0 };
  }
  const provider = snapshot.provider || null;
  const schemaVersion = snapshot.schemaVersion || null;
  const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
  const evidenceItems = Array.isArray(snapshot.evidence) ? snapshot.evidence.filter(Boolean) : [];
  const upstreamWarnings = firstArray(snapshot.upstreamWarnings, snapshot.upstream_warnings, snapshot.missingOrStaleInputs, snapshot.missing_or_stale_inputs);
  const expiresAtMs = Date.parse(snapshot.expiresAt || "");
  const observedAtMs = Date.parse(snapshot.observedAt || snapshot.generatedAt || "");
  const realProvider = ["cmcRestProvider", "mcpProvider"].includes(provider);
  if (schemaVersion !== "market-data-snapshot-v2") reasons.push("schema_missing_or_unsupported");
  if (!provider) reasons.push("provider_missing");
  if (provider && !realProvider) reasons.push(`provider_not_live:${provider}`);
  if (snapshot.status !== "enabled") reasons.push(`status_not_enabled:${snapshot.status || "missing"}`);
  if (snapshot.freshness !== "fresh") reasons.push(`freshness_not_fresh:${snapshot.freshness || "missing"}`);
  if (!Number.isFinite(expiresAtMs)) reasons.push("expires_at_missing_or_invalid");
  if (!Number.isFinite(observedAtMs)) reasons.push("observed_at_missing_or_invalid");
  if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) reasons.push("snapshot_expired");
  const allowResearchWithoutAssets = provider === "mcpProvider" && evidenceItems.length > 0;
  if (!assets.length && !allowResearchWithoutAssets) reasons.push("assets_missing");
  const badLiveAssets = assets.filter((asset) => asset?.isLive !== true || !asset?.symbol);
  if (badLiveAssets.length) reasons.push("asset_live_or_symbol_invalid");
  const concretePriceReasons = [...reasons];
  if (!assets.length) concretePriceReasons.push("assets_missing", "asset_price_missing_or_invalid");
  const badPriceAssets = assets.filter((asset) => {
    const price = Number(asset?.priceUSD || 0);
    return !Number.isFinite(price) || price <= 0;
  });
  if (badPriceAssets.length) concretePriceReasons.push("asset_price_missing_or_invalid");
  const liveResearchValid = reasons.length === 0;
  const concretePriceValid = concretePriceReasons.length === 0;
  return {
    valid: concretePriceValid,
    liveResearchValid,
    concretePriceValid,
    reasons: [...new Set([...upstreamWarnings, ...reasons])],
    concretePriceReasons: [...new Set([...upstreamWarnings, ...concretePriceReasons])],
    provider,
    freshness: snapshot.freshness || "unknown",
    sourceName: snapshot.sourceName || "unknown",
    assetCount: assets.length,
    generatedAt: snapshot.generatedAt || null,
    observedAt: snapshot.observedAt || null,
    expiresAt: snapshot.expiresAt || null,
    realProvider,
  };
}

function cmcFreshnessGate() {
  const snapshot = readJSON(join(projectRoot, "runtime", "market", "latest-market-snapshot.json"), null);
  const integrity = marketSnapshotIntegrity(snapshot);
  const status = integrity.liveResearchValid ? "pass" : (snapshot ? "degraded" : "blocked");
  const allowConcretePrices = Boolean(integrity.concretePriceValid);
  return {
    status,
    provider: integrity.provider,
    freshness: integrity.freshness,
    sourceName: integrity.sourceName || "unknown",
    assetCount: integrity.assetCount,
    generatedAt: integrity.generatedAt || null,
    observedAt: integrity.observedAt || null,
    expiresAt: integrity.expiresAt || null,
    allowLiveResearch: Boolean(integrity.liveResearchValid),
    allowConcretePrices,
    reason: integrity.liveResearchValid
      ? (allowConcretePrices ? "fresh_live_market_snapshot" : "fresh_live_research_snapshot_no_concrete_prices")
      : integrity.reasons.join(","),
    integrityReasons: integrity.liveResearchValid && !allowConcretePrices ? ["asset_price_missing_or_invalid"] : integrity.reasons,
    concretePriceReasons: integrity.concretePriceReasons,
  };
}

function countReadableEvidence(observations = []) {
  return observations.reduce((total, item) => {
    if (Number.isFinite(Number(item?.readableEvidenceCount))) return total + Number(item.readableEvidenceCount);
    const sections = Array.isArray(item?.readableEvidence) ? item.readableEvidence : [];
    return total + sections.reduce((count, section) => count + (Array.isArray(section?.bullets) ? section.bullets.length : 0), 0);
  }, 0);
}

function skillHubObservationSucceeded(item) {
  return /^(ok|completed|success|usable)$/i.test(String(item?.status || ""));
}

function readableEvidenceDisplayText(item) {
  const sections = Array.isArray(item?.readableEvidence) ? item.readableEvidence : [];
  for (const section of sections) {
    const title = safeSkillHubEvidenceText(section?.title || "Skill Hub 返回摘录");
    const bullets = Array.isArray(section?.bullets) ? section.bullets.map((bullet) => safeSkillHubEvidenceText(bullet)).filter(Boolean) : [];
    if (bullets.length) return `${title}：${bullets.slice(0, 2).join("；")}`;
  }
  return "";
}

function readableEvidenceCorpusText(item) {
  const sections = Array.isArray(item?.readableEvidence) ? item.readableEvidence : [];
  const parts = [];
  for (const section of sections) {
    const title = safeSkillHubEvidenceText(section?.title || "Skill Hub 返回摘录");
    const bullets = Array.isArray(section?.bullets) ? section.bullets.map((bullet) => safeSkillHubEvidenceText(bullet)).filter(Boolean) : [];
    if (title && bullets.length) parts.push(`${title}：${bullets.join("；")}`);
  }
  return parts.join("\n");
}

function displayableSkillHubText(item) {
  const evidenceText = readableEvidenceDisplayText(item);
  if (evidenceText) {
    return { text: evidenceText, source: "readableEvidence" };
  }
  const candidates = [
    ["summary", item?.summary],
    ["conclusion", item?.conclusion],
    ["marketRead", item?.marketRead?.summary],
  ];
  let genericSummary = null;
  for (const [source, value] of candidates) {
    const rawText = redact(value || "").trim();
    const text = rawText ? publicSkillHubSummary(rawText) : "";
    if (text) {
      if (source === "summary" && isGenericSkillHubSummary(rawText)) {
        genericSummary = { text, source: "genericSummary" };
        continue;
      }
      return {
        text,
        source,
      };
    }
  }
  if (genericSummary) return genericSummary;
  return { text: "", source: "none" };
}

function skillHubReturnedTextCorpus(observations = []) {
  const parts = [];
  for (const item of observations.filter((entry) => skillHubObservationSucceeded(entry))) {
    const evidence = readableEvidenceCorpusText(item);
    if (evidence) parts.push(evidence);
    for (const value of [item?.summary, item?.conclusion, item?.marketRead?.summary]) {
      const text = safeSkillHubEvidenceText(value, 1600);
      if (text) parts.push(text);
    }
  }
  return [...new Set(parts)].join("\n");
}

function skillHubReturnedPriceMetadata(observations = []) {
  const corpus = skillHubReturnedTextCorpus(observations);
  const tokens = marketNumberTokens(corpus);
  return {
    corpus,
    allowSkillHubReturnedPrices: tokens.length > 0,
    skillHubReturnedPriceTokenCount: tokens.length,
    skillHubReturnedTextSource: corpus ? "cmc_skill_hub_returned_text" : "none",
    skillHubReturnedTextCharCount: corpus.length,
  };
}

function normalizedReadableEvidenceSections(item) {
  return safeArray(item?.readableEvidence)
    .map((section) => ({
      title: safeSkillHubEvidenceText(section?.title || "Skill Hub 返回摘录"),
      bullets: safeArray(section?.bullets).map((bullet) => safeSkillHubEvidenceText(bullet)).filter(Boolean),
    }))
    .filter((section) => section.title || section.bullets.length);
}

function buildCMCReturnedContent(item) {
  if (!item) {
    return { summary: null, conclusion: null, marketRead: null, readableEvidence: [] };
  }
  const summary = publicSkillHubSummary(item?.summary || "");
  const conclusion = safeSkillHubEvidenceText(item?.conclusion || "", 1200);
  const marketRead = safeSkillHubEvidenceText(item?.marketRead?.summary || item?.market_read?.summary || "", 1200);
  return {
    summary: summary || null,
    conclusion: conclusion || null,
    marketRead: marketRead || null,
    readableEvidence: normalizedReadableEvidenceSections(item),
  };
}

function buildCMCRenderBlocks(observations = []) {
  const blocks = [];
  for (const item of observations.filter((entry) => skillHubObservationSucceeded(entry))) {
    const returnedContent = buildCMCReturnedContent(item);
    const observedAt = item?.observedAt || item?.generatedAt || null;
    const source = "CMC Skill Hub MCP";
    if (returnedContent.summary) {
      blocks.push({
        type: isGenericSkillHubSummary(item?.summary) ? "provider_generic_summary" : "provider_summary",
        title: "CMC Skill Hub 返回",
        body: returnedContent.summary,
        source,
        observedAt,
      });
    }
    if (returnedContent.conclusion && returnedContent.conclusion !== returnedContent.summary) {
      blocks.push({
        type: "provider_conclusion",
        title: "CMC Skill Hub 结论",
        body: returnedContent.conclusion,
        source,
        observedAt,
      });
    }
    if (returnedContent.marketRead && returnedContent.marketRead !== returnedContent.summary && returnedContent.marketRead !== returnedContent.conclusion) {
      blocks.push({
        type: "provider_market_read",
        title: "CMC Skill Hub Market Read",
        body: returnedContent.marketRead,
        source,
        observedAt,
      });
    }
    for (const section of returnedContent.readableEvidence.slice(0, 4)) {
      if (!section.bullets.length) continue;
      blocks.push({
        type: "provider_evidence",
        title: section.title || "CMC Skill Hub 证据",
        body: section.bullets.slice(0, 4).join("\n"),
        source,
        observedAt,
      });
    }
  }
  const seen = new Set();
  return blocks.filter((block) => {
    const key = `${block.type}:${block.title}:${block.body}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(block.body);
  }).slice(0, 8);
}

function skillHubDisplayCandidate(observations = []) {
  const validObservations = observations.filter((item) => skillHubObservationSucceeded(item));
  for (const item of validObservations) {
    const display = displayableSkillHubText(item);
    if (display.text) {
      return {
        status: "usable",
        allow: true,
        text: display.text,
        source: display.source,
        observation: item,
      };
    }
  }
  if (observations.length > 0 && validObservations.length === 0) {
    return { status: "failed", allow: false, text: "", source: "none", observation: observations[0] || null };
  }
  return { status: "empty", allow: false, text: "", source: "none", observation: null };
}

function isGenericSkillHubSummary(summary) {
  return /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+ returned CMC Skill Hub evidence\./i.test(String(summary || ""));
}

function buildSplitCMCGate(baseGate, cmcSkillHubObservations = []) {
  const snapshot = readJSON(join(projectRoot, "runtime", "market", "latest-market-snapshot.json"), null);
  const hasSkillHubTransport = cmcSkillHubObservations.length > 0;
  const readableEvidenceCount = countReadableEvidence(cmcSkillHubObservations);
  const display = skillHubDisplayCandidate(cmcSkillHubObservations);
  const returnedPrice = skillHubReturnedPriceMetadata(cmcSkillHubObservations);
  const allowSkillHubResultDisplay = Boolean(display.allow);
  const hasConcretePrice = Boolean(baseGate.allowConcretePrices);
  const transportStatus = baseGate.provider === "mcpProvider" || baseGate.provider === "cmcRestProvider"
    ? (baseGate.status === "blocked" ? "failed" : "ok")
    : baseGate.provider ? "degraded" : "failed";
  const priceSnapshotStatus = hasConcretePrice
    ? "usable"
    : baseGate.assetCount > 0
      ? "degraded"
      : "empty";
  const researchEvidenceStatus = readableEvidenceCount > 0
    ? "usable"
    : hasSkillHubTransport
      ? "empty"
      : baseGate.allowLiveResearch && baseGate.assetCount > 0
        ? "not_requested"
        : "degraded";
  const emptyEvidenceReason = readableEvidenceCount > 0
    ? null
    : hasSkillHubTransport
      ? "skill_hub_transport_ok_but_no_readable_evidence"
      : baseGate.assetCount === 0
        ? "market_snapshot_assets_missing"
        : null;
  const noDisplayableSkillHubResult = hasSkillHubTransport && !allowSkillHubResultDisplay && readableEvidenceCount === 0;
  const allowResearchConclusion = allowSkillHubResultDisplay || researchEvidenceStatus === "usable" || priceSnapshotStatus === "usable";
  return {
    ...baseGate,
    status: noDisplayableSkillHubResult ? "degraded" : baseGate.status,
    transportStatus,
    skillHubDisplay: {
      status: display.status,
      allowSkillHubResultDisplay,
      displayableResultText: display.text || null,
      displayableResultSource: display.source,
      parserEvidenceStatus: readableEvidenceCount > 0 ? "usable" : "empty",
      allowSkillHubReturnedPrices: returnedPrice.allowSkillHubReturnedPrices,
      skillHubReturnedPriceTokenCount: returnedPrice.skillHubReturnedPriceTokenCount,
      skillHubReturnedTextSource: returnedPrice.skillHubReturnedTextSource,
      skillHubReturnedTextCharCount: returnedPrice.skillHubReturnedTextCharCount,
    },
    researchEvidence: {
      status: researchEvidenceStatus,
      readableEvidenceCount,
      emptyEvidenceReason,
      source: hasSkillHubTransport ? "cmc_skill_hub" : "market_snapshot",
      allowResearchConclusion,
    },
    priceSnapshot: {
      status: priceSnapshotStatus,
      assetCount: Number(baseGate.assetCount || 0),
      allowConcretePrices: hasConcretePrice,
      provider: baseGate.provider || null,
      freshness: baseGate.freshness || null,
    },
    researchEvidenceStatus,
    readableEvidenceCount,
    emptyEvidenceReason,
    priceSnapshotStatus,
    skillHubDisplayStatus: display.status,
    allowSkillHubResultDisplay,
    displayableResultText: display.text || null,
    displayableResultSource: display.source,
    parserEvidenceStatus: readableEvidenceCount > 0 ? "usable" : "empty",
    allowSkillHubReturnedPrices: returnedPrice.allowSkillHubReturnedPrices,
    skillHubReturnedPriceTokenCount: returnedPrice.skillHubReturnedPriceTokenCount,
    skillHubReturnedTextSource: returnedPrice.skillHubReturnedTextSource,
    skillHubReturnedTextCharCount: returnedPrice.skillHubReturnedTextCharCount,
    allowResearchConclusion,
    allowLiveResearch: Boolean(baseGate.allowLiveResearch || allowSkillHubResultDisplay),
    allowConcretePrices: hasConcretePrice,
    reason: noDisplayableSkillHubResult ? "skill_hub_transport_ok_no_displayable_content" : baseGate.reason,
    integrityReasons: noDisplayableSkillHubResult
      ? [...new Set([...(baseGate.integrityReasons || []), "skill_hub_no_displayable_content"])]
      : baseGate.integrityReasons,
    snapshotEvidenceCount: Array.isArray(snapshot?.evidence) ? snapshot.evidence.filter(Boolean).length : 0,
  };
}

function buildToolObservations(runDir, runID, toolCalls, policies, contextSummary, toolSelectionDiagnostic = null) {
  const observations = toolCalls.map((call) => {
    const detailPath = call.detailsArtifactPath ? resolve(projectRoot, call.detailsArtifactPath) : null;
    return {
      toolName: call.toolName,
      status: call.status,
      permission: call.permission,
      outputSummary: call.outputSummary,
      detailsArtifactPath: call.detailsArtifactPath,
      details: detailPath && isInside(projectRoot, detailPath) ? readJSON(detailPath, null)?.details || null : null,
      redactionStatus: call.redactionStatus,
    };
  });
  const cmcSkillHubObservations = observations
    .filter((item) => item.toolName?.startsWith("cmc.") && item.details?.skillHubResult)
    .map((item) => ({
      toolName: item.toolName,
      status: item.status,
      ...item.details.skillHubResult,
    }));
  const cmcGate = buildSplitCMCGate(cmcFreshnessGate(), cmcSkillHubObservations);
  const marketsSummary = readJSON(join(runDir, "markets-capability-summary.json"), null);
  const marketsRun = observations.some((item) => String(item.toolName || "").startsWith("markets."));
  const cloudASRSummary = readJSON(join(runDir, "cloud-asr-summary.json"), null);
  const cloudASRRun = observations.some((item) => item.toolName === "office.cloud_asr.transcribe") || Boolean(cloudASRSummary);
  const payload = {
    schemaVersion: "agent-tool-observations-v1",
    runID,
    generatedAt: now(),
    contextSummary,
    toolSelectionDiagnostic,
    cmcFreshnessGate: cmcGate,
    cmcGate,
    cmcSkillHub: {
      available: cmcSkillHubObservations.length > 0,
      observations: cmcSkillHubObservations,
      instruction: cmcSkillHubObservations.length
        ? cmcGate.allowSkillHubResultDisplay
          ? "Use the CMC Skill Hub returned summary, conclusion, or readable evidence as displayable result. Do not require asset price arrays before answering. Do not invent concrete prices."
          : "CMC Skill Hub transport succeeded, but no displayable summary, conclusion, or readable evidence was returned in this run."
        : "No CMC Skill Hub MCP skill result is available in this run.",
    },
    marketsResearch: marketsRun
      ? {
          available: Boolean(marketsSummary),
          summary: marketsSummary,
          gate: {
            status: marketsSummary?.researchEvidenceStatus === "user_context" ? "pass" : "degraded",
            transportStatus: marketsSummary?.transportStatus || "provider_deferred",
            promptFrameworkStatus: marketsSummary?.promptFrameworkStatus || "usable",
            researchEvidenceStatus: marketsSummary?.researchEvidenceStatus || "empty_provider_evidence",
            readableEvidenceCount: Number(marketsSummary?.readableEvidenceCount || 0),
            emptyEvidenceReason: marketsSummary?.emptyEvidenceReason || "equity_provider_evidence_unavailable",
            priceSnapshotStatus: marketsSummary?.priceSnapshotStatus || "provider_deferred",
            allowResearchDraft: marketsSummary?.allowResearchDraft !== false,
            allowResearchConclusion: Boolean(marketsSummary?.allowResearchConclusion),
            allowConcretePrices: false,
            allowBuyHoldSellAction: false,
            productMutationPolicyRecommendation: marketsSummary?.productMutationPolicyRecommendation || "discarded",
          },
          instruction: "Use Markets Research as a methodology draft unless user context or provider evidence is explicitly available. Do not expose raw dispatcher names, provider IDs, CLI commands, or BUY/HOLD/SELL action advice.",
        }
      : {
          available: false,
          observations: [],
          instruction: "No Markets Research result is available in this run.",
        },
    cloudASR: cloudASRRun
      ? {
          available: Boolean(cloudASRSummary),
          summary: cloudASRSummary,
          gate: {
            status: cloudASRSummary?.status || "degraded",
            cloudASRStatus: cloudASRSummary?.cloudASRStatus || "unknown",
            provider: cloudASRSummary?.provider || "阿里云百炼",
            model: cloudASRSummary?.model || null,
            cloudUpload: cloudASRSummary?.cloudUpload === true,
            uploadProvider: cloudASRSummary?.uploadProvider || "aliyun-oss",
            segmentCount: Number(cloudASRSummary?.segmentCount || 0),
            needsTranscriptReview: cloudASRSummary?.needsTranscriptReview !== false,
            rawAudioStored: false,
            rawProviderRequestIncluded: false,
            secretsIncluded: false,
          },
          instruction: cloudASRSummary?.status === "completed"
            ? "Use the bounded Cloud ASR transcript chunks as meeting source context. Label transcription as cloud ASR via Alibaba Bailian and do not expose provider internals."
            : "Cloud ASR did not produce usable transcript chunks. Do not fabricate a transcript; ask for transcript review or another audio/video upload.",
        }
      : {
          available: false,
          observations: [],
          instruction: "No Cloud ASR transcript is available in this run.",
        },
    policyDecisions: policies.map((item) => ({
      action: item.action,
      status: item.status,
      reason: item.reason,
      riskLevel: item.riskLevel,
    })),
    observations,
    modelUsePolicy: {
      rawPrivateTranscriptIncluded: false,
      rawSecretsIncluded: false,
      allowSkillHubResultDisplay: Boolean(cmcGate.allowSkillHubResultDisplay),
      skillHubDisplayStatus: cmcGate.skillHubDisplayStatus || "unknown",
      displayableResultSource: cmcGate.displayableResultSource || null,
      allowSkillHubReturnedPrices: Boolean(cmcGate.allowSkillHubReturnedPrices),
      skillHubReturnedPriceTokenCount: Number(cmcGate.skillHubReturnedPriceTokenCount || 0),
      skillHubReturnedTextSource: cmcGate.skillHubReturnedTextSource || null,
      liveResearchAllowed: Boolean(cmcGate.allowSkillHubResultDisplay || cmcGate.allowResearchConclusion),
      concreteMarketPricesAllowed: cmcGate.allowConcretePrices,
      marketsResearchDraftAllowed: Boolean(marketsSummary?.allowResearchDraft),
      marketsResearchConclusionAllowed: Boolean(marketsSummary?.allowResearchConclusion),
      marketsConcretePricesAllowed: false,
      cloudASRUploadAllowed: cloudASRRun,
      cloudASRStatus: cloudASRSummary?.cloudASRStatus || "not_requested",
      cloudASRUserVisibleLabel: cloudASRSummary?.userVisibleLabel || null,
      instruction: cmcGate.allowConcretePrices
        ? "Concrete CMC prices may be cited with provider/freshness attribution."
        : cmcGate.allowSkillHubResultDisplay
          ? (cmcGate.allowSkillHubReturnedPrices
              ? "Display the CMC Skill Hub returned summary, conclusion, or readable evidence. Preserve numbers already present in the returned Skill Hub text and label them as CMC Skill Hub returned content. Do not add new concrete prices, key levels, support/resistance, or trade levels."
              : "Display the CMC Skill Hub returned summary, conclusion, or readable evidence. State that no app-referenceable price snapshot is available; do not invent concrete prices, key levels, support/resistance, or trade levels.")
          : cmcGate.allowResearchConclusion
            ? "Use CMC Skill Hub MCP skill results as returned research evidence; do not invent concrete prices, key levels, or trade levels that are not present in the skill result."
          : cmcGate.emptyEvidenceReason
            ? "State that CMC Skill Hub transport succeeded but returned no displayable summary, conclusion, readable evidence, or price snapshot in this run."
          : "Do not output concrete prices, key levels, trade levels, or live/fresh claims.",
    },
    outputGuard: {
      status: "pending",
      allowConcretePrices: cmcGate.allowConcretePrices,
      allowSkillHubReturnedPrices: Boolean(cmcGate.allowSkillHubReturnedPrices),
      violations: [],
    },
  };
  writeJSON(join(runDir, "tool-observations.json"), payload);
  return payload;
}

async function executeRuntimeTool(toolName, params) {
  return agentRuntimeCore.executeRuntimeTool(toolName, params, {
    refreshCMCLive,
    cmcDefaultSymbols,
  });
}

function maybeWriteStrategyResult(runDir, runID, prompt, selectedSkillIDs, toolObservations) {
  const taskType = detectStrategistTaskType(prompt, selectedSkillIDs);
  if (!taskType) return null;
  const gate = toolObservations?.cmcFreshnessGate || cmcFreshnessGate();
  if (!gate.allowConcretePrices) return null;
  const snapshot = readJSON(join(projectRoot, "runtime", "market", "latest-market-snapshot.json"), null);
  const asset = Array.isArray(snapshot?.assets) ? snapshot.assets[0] : null;
  if (!asset) return null;
  const titleByTask = {
    alpha_discovery: `${asset.symbol} live CMC research candidate`,
    perp_trade_review: `${asset.symbol} live CMC structure review`,
    macro_thesis_review: `${asset.symbol} live CMC macro review`,
  };
  const withRun = {
    schemaVersion: "cmc-strategist-result-v1",
    taskType,
    title: titleByTask[taskType] || `${asset.symbol} live CMC review`,
    verdict: "Live market evidence is available for research review; execution remains blocked.",
    confidence: 0.62,
    dataFreshness: "fresh",
    decisionProblem: "Use fresh CMC provider observations as research context without producing trade instructions.",
    subject: { symbol: asset.symbol, name: asset.name, instrument: "spot", directionContext: "research_only" },
    candidateSignals: [
      { label: "CMC price", value: `$${Number(asset.priceUSD || 0).toLocaleString("en-US", { maximumFractionDigits: 6 })}`, interpretation: "Fresh provider reference price, not an entry or exit instruction." },
      { label: "24h change", value: `${Number(asset.percentChange24h || 0).toFixed(2)}%`, interpretation: "Short-window market context from CMC quotes/latest." },
      { label: "Volume", value: `$${Math.round(Number(asset.volume24hUSD || 0)).toLocaleString("en-US")}`, interpretation: "Liquidity context only." }
    ],
    keyLevels: [
      { label: "Reference price", price: Number(asset.priceUSD || 0), role: "reference_only", condition: "Fresh CMC snapshot; not an order level." }
    ],
    scenarios: [
      { id: "A", label: "Continue research", if: "CMC snapshot remains fresh and corroborating evidence exists", then: "Keep as monitored research candidate", bias: "neutral", confidence: 0.62, triggered: true },
      { id: "B", label: "Degrade", if: "Provider freshness expires or source conflicts appear", then: "Remove concrete levels and rerun refresh", bias: "cautious", confidence: 0.38 }
    ],
    counterEvidence: [
      { label: "Execution blocked", detail: "This card cannot generate orders, position sizing, leverage, or message publishing.", severity: "high" }
    ],
    sourceMap: [{ label: "CMC live market snapshot", artifactPath: "runtime/market/latest-market-snapshot.json", freshness: "fresh", provider: gate.provider }],
    riskBoundary: { tradeInstruction: "blocked", summary: "Research-only decision support. No trading, messaging, or external publishing.", warnings: ["Prices are valid only while the CMC freshness gate remains pass."] },
    followUps: [{ label: "Refresh CMC", condition: "Snapshot expires or the thesis changes", suggestedSkillIDs: ["cmc-market-radar"] }],
    takeaway: "Fresh CMC evidence is present; use it for research context while keeping execution decisions outside the agent.",
  };
  writeJSON(join(runDir, "cmc-strategist-result.json"), {
    schemaVersion: "cmc-skill-hub-result-v1",
    runID,
    provider: gate.provider,
    skillName: taskType,
    strategyReadModel: withRun,
    generatedAt: now(),
  });
  return taskType;
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  try {
    const failure = authFailure(req, url);
    if (failure) return json(res, failure.status, failure.body);
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, publicHealth());
    if (req.method === "GET" && url.pathname === "/capabilities") {
      return json(res, 200, publicSurface());
    }
    if (req.method === "POST" && url.pathname === "/cmc/live/refresh") {
      const body = await readBody(req).catch((error) => {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
      });
      return json(res, 200, await refreshCMCLive(body || {}));
    }
    if (req.method === "POST" && url.pathname === "/wechat/live/refresh") {
      const body = await readBody(req).catch((error) => {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
      });
      return json(res, 200, refreshWechatLive(body || {}));
    }
    if (req.method === "GET" && url.pathname === "/sessions") {
      return json(res, 200, { schemaVersion: "agent-session-list-v1", sessions: await listSessions() });
    }
    if (req.method === "POST" && url.pathname === "/sessions") {
      return json(res, 200, await createSession(await readBody(req)));
    }
    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      const session = await getSession(sessionMatch[1]);
      return session ? json(res, 200, session) : json(res, 404, { error: "session_not_found" });
    }
    if (req.method === "PATCH" && sessionMatch) {
      return json(res, 200, await renameSession(sessionMatch[1], await readBody(req)));
    }
    if (req.method === "DELETE" && sessionMatch) {
      return json(res, 200, await deleteSession(sessionMatch[1]));
    }
    if (req.method === "GET" && url.pathname === "/tasks") {
      return json(res, 200, { schemaVersion: "agent-task-list-v1", tasks: await listTasks() });
    }
    const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
    if (req.method === "DELETE" && taskMatch) {
      return json(res, 200, await deleteTask(taskMatch[1]));
    }
    const messageMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
    if (req.method === "POST" && messageMatch) {
      return json(res, 200, await postMessage(messageMatch[1], await readBody(req)));
    }
    const asyncMessageMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages\/async$/);
    if (req.method === "POST" && asyncMessageMatch) {
      return json(res, 202, await postMessageAsync(asyncMessageMatch[1], await readBody(req)));
    }
    const eventsMatch = url.pathname.match(/^\/runs\/([^/]+)\/events$/);
    if (req.method === "GET" && eventsMatch) return sendEvents(req, res, eventsMatch[1]);
    const controlMatch = url.pathname.match(/^\/runs\/([^/]+)\/(pause|resume|cancel)$/);
    if (req.method === "POST" && controlMatch) {
      const runDir = safeRunDir(controlMatch[1]);
      const type = `run.${controlMatch[2]}`;
      const state = writeControlState(runDir, controlMatch[2]);
      const event = appendEvent(runDir, { type, status: controlMatch[2], stage: "control", reason: `User requested ${controlMatch[2]}.`, controlState: state });
      return json(res, 200, event);
    }
    const runMatch = url.pathname.match(/^\/runs\/([^/]+)$/);
    if (req.method === "DELETE" && runMatch) {
      return json(res, 200, await deleteRun(runMatch[1]));
    }
    if (req.method === "POST" && url.pathname === "/admin/runtime/reset") {
      return json(res, 200, await resetRuntimeData());
    }
    text(res, 404, "not found\n");
  } catch (error) {
    if (error instanceof HttpError) {
      return json(res, error.status, { error: error.code, message: error.message });
    }
    json(res, 500, { error: "daemon_error", message: redact(error?.message || error) });
  }
}

async function smokeCheck() {
  ensureDirs();
  process.env.WECHAT_AGENT_MOCK_PROVIDER = process.env.WECHAT_AGENT_MOCK_PROVIDER || "1";
  await ensureMongoReady();
  await piKernel.ensure();
  const session = await createSession({ title: "smoke-check" });
  const result = await postMessage(session.sessionID, {
    prompt: "用 Agent 操作台检查 BTC 微信和链上信号，生成 Crystal/Proposal/Handoff 建议。",
    selectedSkillIDs: ["wechat-onchain-intelligence", "cmc-market-radar", "handoff-writer"],
    selectedExtensionIDs: ["wechat-cli-export-bridge", "cmc-skill-hub"],
    attachments: [],
    contextRefs: [],
  });
  console.log(`sessionID=${session.sessionID}`);
  console.log(`runID=${result.runID}`);
  console.log(`taskID=${result.task.taskID}`);
  console.log(`events=${join(runsRoot, result.runID, "events.ndjson")}`);
  const observations = readJSON(join(runsRoot, result.runID, "tool-observations.json"), null);
  if (!observations?.schemaVersion || !observations?.cmcFreshnessGate) {
    throw new Error("smoke_missing_tool_observations");
  }
  if (!observations.cmcFreshnessGate.researchEvidence || !observations.cmcFreshnessGate.priceSnapshot) {
    throw new Error("smoke_missing_cmc_split_gate");
  }
  assertRunContextArtifacts(result.runID);
  assertRunLoopArtifacts(result.runID);
  assertRunHarnessArtifacts(result.runID);
  assertRunCapabilityLoopArtifacts(result.runID, "crypto_market_loop");
  console.log("status=completed");
}

function assertRunContextArtifacts(runID) {
  const runDir = join(runsRoot, runID);
  const required = [
    "context-index.json",
    "retrieval-results.json",
    "context-pack.json",
    "source-trust-report.json",
    "memory-compression.json",
  ];
  for (const name of required) {
    if (!existsSync(join(runDir, name))) throw new Error(`context_artifact_missing:${name}`);
  }
  const contextIndex = readJSON(join(runDir, "context-index.json"), null);
  const retrievalResults = readJSON(join(runDir, "retrieval-results.json"), null);
  const contextPack = readJSON(join(runDir, "context-pack.json"), null);
  const sourceTrustReport = readJSON(join(runDir, "source-trust-report.json"), null);
  if (!Array.isArray(contextIndex?.chunks) || !contextIndex.chunks.length) throw new Error("context_index_chunks_missing");
  if (!Array.isArray(retrievalResults?.rankedChunks) || !retrievalResults.rankedChunks.length) throw new Error("retrieval_results_ranked_chunks_missing");
  if (!Array.isArray(contextPack?.selectedChunks) || !contextPack.selectedChunks.length) throw new Error("context_pack_selected_chunks_missing");
  if (!Array.isArray(sourceTrustReport?.sources) || !sourceTrustReport.sources.length) throw new Error("source_trust_sources_missing");
}

function assertRunLoopArtifacts(runID) {
  const runDir = join(runsRoot, runID);
  const required = [
    "planner-state.json",
    "task-graph.json",
    "agent-loop.ndjson",
    "planner-decisions.ndjson",
    "step-results/step-final-output.json",
  ];
  for (const name of required) {
    if (!existsSync(join(runDir, name))) throw new Error(`loop_artifact_missing:${name}`);
  }
  const loopLines = readFileSync(join(runDir, "agent-loop.ndjson"), "utf8").split(/\r?\n/).filter(Boolean);
  if (!loopLines.some((line) => /"type":"action_observed"/.test(line)) || !loopLines.some((line) => /"type":"finalized"/.test(line))) {
    throw new Error("loop_artifact_missing_action_or_final_event");
  }
}

function assertRunHarnessArtifacts(runID) {
  const runDir = join(runsRoot, runID);
  const required = [
    "harness-session-tree.json",
    "harness-branch-lineage.json",
    "invocation-ledger.ndjson",
    "context-event-log.ndjson",
    "compaction-summary.json",
    "review-read-model.json",
  ];
  for (const name of required) {
    if (!existsSync(join(runDir, name))) throw new Error(`harness_artifact_missing:${name}`);
  }
  const tree = readJSON(join(runDir, "harness-session-tree.json"), null);
  const lineage = readJSON(join(runDir, "harness-branch-lineage.json"), null);
  const compaction = readJSON(join(runDir, "compaction-summary.json"), null);
  const review = readJSON(join(runDir, "review-read-model.json"), null);
  if (tree?.schemaVersion !== "agent-harness-session-tree-v1") throw new Error("harness_session_tree_schema_missing");
  if (!Array.isArray(tree.branches) || !tree.branches.some((branch) => branch.branchType === "main" && branch.status === "completed")) {
    throw new Error("harness_session_tree_main_completed_missing");
  }
  if (!Array.isArray(tree.reviewBranches) || !tree.reviewBranches.some((branch) => branch.branchType === "review" && branch.reviewReadModelPath)) {
    throw new Error("harness_session_tree_review_branch_missing");
  }
  if (lineage?.schemaVersion !== "agent-harness-branch-lineage-v1" || lineage.branchType !== "main") {
    throw new Error("harness_branch_lineage_schema_missing");
  }
  if (!Array.isArray(lineage.relatedBranches) || !lineage.relatedBranches.some((branch) => branch.branchType === "review" && branch.mergeDecision === "pending")) {
    throw new Error("harness_branch_lineage_review_pending_missing");
  }
  const ledgerLines = readFileSync(join(runDir, "invocation-ledger.ndjson"), "utf8").split(/\r?\n/).filter(Boolean);
  const ledgerEvents = ledgerLines.map((line) => JSON.parse(line));
  for (const type of ["accepted", "context_loaded", "planner_started", "tool_action_started", "tool_action_completed", "review_requested", "branch_created", "final_selected", "run_completed"]) {
    if (!ledgerEvents.some((event) => event.type === type && event.runID && event.sessionID && event.branchID && event.timestamp)) {
      throw new Error(`harness_invocation_ledger_missing:${type}`);
    }
  }
  const contextEvents = readFileSync(join(runDir, "context-event-log.ndjson"), "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (!contextEvents.some((event) => event.stage === "plan" && Array.isArray(event.selectedChunkIDs) && event.contextPackPath)) {
    throw new Error("harness_context_event_plan_missing");
  }
  if (!contextEvents.some((event) => event.stage === "compact" && event.compactionSummaryPath)) {
    throw new Error("harness_context_event_compact_missing");
  }
  if (compaction?.schemaVersion !== "agent-compaction-summary-v1" || !compaction.finalReadModelPath || compaction.redaction?.secretsIncluded !== false) {
    throw new Error("harness_compaction_summary_invalid");
  }
  if (review?.schemaVersion !== "agent-review-read-model-v1" || review.sourceRunID !== runID || !review.reviewRunID || review.mutationPolicyAssessment?.importAllowed !== (review.mutationPolicyAssessment?.status === "importable")) {
    throw new Error("harness_review_read_model_invalid");
  }
}

function assertRunCapabilityLoopArtifacts(runID, expectedLoopType = null) {
  const runDir = join(runsRoot, runID);
  const required = [
    "capability-loop-read-model.json",
    "memory-read-model.json",
    "subagent-coordination-read-model.json",
  ];
  for (const name of required) {
    if (!existsSync(join(runDir, name))) throw new Error(`capability_loop_artifact_missing:${name}`);
  }
  const capabilityLoop = readJSON(join(runDir, "capability-loop-read-model.json"), null);
  const memoryReadModel = readJSON(join(runDir, "memory-read-model.json"), null);
  const subagentCoordination = readJSON(join(runDir, "subagent-coordination-read-model.json"), null);
  if (capabilityLoop?.schemaVersion !== "agent-capability-loop-read-model-v1" || capabilityLoop.runID !== runID) {
    throw new Error("capability_loop_read_model_invalid");
  }
  if (expectedLoopType && capabilityLoop.loopType !== expectedLoopType) {
    throw new Error(`capability_loop_type_mismatch:${expectedLoopType}:${capabilityLoop.loopType}`);
  }
  if (!Array.isArray(capabilityLoop.followUpSuggestions) || capabilityLoop.followUpSuggestions.length < 2 || !capabilityLoop.review?.reviewReadModelPath) {
    throw new Error("capability_loop_actions_missing");
  }
  if (memoryReadModel?.schemaVersion !== "agent-memory-read-model-v1" || !memoryReadModel.writePolicy || memoryReadModel.writePolicy.status !== "not_written") {
    throw new Error("memory_read_model_invalid");
  }
  if (memoryReadModel.coreContract?.schemaVersion !== "core-memory-contract-summary-v1" || memoryReadModel.coreContract.owner !== "Agent Runtime Core") {
    throw new Error("memory_core_contract_missing");
  }
  if (memoryReadModel.redaction?.secretsStored !== false || memoryReadModel.redaction?.rawProviderPayloadStored !== false) {
    throw new Error("memory_read_model_redaction_invalid");
  }
  if (subagentCoordination?.schemaVersion !== "agent-subagent-coordination-read-model-v1" || subagentCoordination.mode !== "read_only_dry_run") {
    throw new Error("subagent_coordination_read_model_invalid");
  }
  if (subagentCoordination.coreContract?.schemaVersion !== "core-subagent-contract-summary-v1" || subagentCoordination.coreContract.owner !== "Agent Runtime Core") {
    throw new Error("subagent_core_contract_missing");
  }
  if (!Array.isArray(subagentCoordination.blockedOperations) || !subagentCoordination.blockedOperations.includes("send-keys")) {
    throw new Error("subagent_coordination_safety_boundary_missing");
  }
  const manifest = readJSON(join(runDir, "run-manifest.json"), null);
  if (!manifest?.capabilityLoopSummary?.readModelPath || !manifest?.memorySummary?.readModelPath || !manifest?.subagentCoordinationSummary?.readModelPath) {
    throw new Error("manifest_missing_capability_loop_summaries");
  }
}

async function asyncSmokeCheck() {
  ensureDirs();
  process.env.WECHAT_AGENT_MOCK_PROVIDER = process.env.WECHAT_AGENT_MOCK_PROVIDER || "1";
  await ensureMongoReady();
  await piKernel.ensure();
  const session = await createSession({ title: "async-smoke-check" });
  const response = await postMessageAsync(session.sessionID, {
    prompt: "用 Agent 实时流检查 BTC 微信和链上信号，生成可追踪摘要。",
    selectedSkillIDs: ["wechat-onchain-intelligence", "cmc-market-radar"],
    selectedExtensionIDs: ["wechat-cli-export-bridge", "cmc-skill-hub"],
    attachments: [],
    contextRefs: [],
  });
  const eventsPath = join(runsRoot, response.runID, "events.ndjson");
  const startedAt = Date.now();
  let types = [];
  while (Date.now() - startedAt < 15000) {
    if (existsSync(eventsPath)) {
      types = readFileSync(eventsPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line).type; } catch { return null; }
        })
        .filter(Boolean);
      if (types.includes("run.completed") || types.includes("run.failed") || types.includes("run.cancelled")) break;
    }
    await sleep(200);
  }
  if (!types.includes("run.started") || !types.some((type) => String(type).includes("context_plane")) || !types.includes("run.completed")) {
    throw new Error(`async_smoke_missing_events:${types.join(",")}`);
  }
  assertRunContextArtifacts(response.runID);
  assertRunLoopArtifacts(response.runID);
  assertRunCapabilityLoopArtifacts(response.runID, "crypto_market_loop");
  console.log(`async_smoke=pass`);
  console.log(`runID=${response.runID}`);
  console.log(`taskID=${response.taskID}`);
  console.log(`eventsURL=${response.eventsURL}`);
  console.log(`artifactPath=${response.artifactPath}`);
}

async function withFakeCMCMcpServer(callback, options = {}) {
  const server = createServer(async (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let rpc = {};
      try { rpc = JSON.parse(body || "{}"); } catch {}
      const send = (result, status = 200) => {
        res.writeHead(status, { "content-type": "application/json", "mcp-session-id": "fake-cmc-session" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      };
      if (rpc.method === "initialize") {
        return send({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-cmc-mcp", version: "test" } });
      }
      if (rpc.method === "notifications/initialized") {
        res.writeHead(202, { "content-type": "application/json", "mcp-session-id": "fake-cmc-session" });
        return res.end("");
      }
      if (rpc.method === "tools/list") {
        return send({
          tools: [
            {
              name: "find_skill",
              description: "Search CMC Crypto Skill Hub skills.",
              inputSchema: { type: "object", properties: { query: { type: "string" }, top_k: { type: "integer" } }, required: ["query"] },
            },
            {
              name: "execute_skill",
              description: "Execute a selected CMC Crypto Skill Hub skill.",
              inputSchema: { type: "object", properties: { unique_name: { type: "string" }, parameters: { type: "object" } }, required: ["unique_name", "parameters"] },
            },
            {
              name: "cryptocurrency_quotes_latest",
              description: "CoinMarketCap cryptocurrency quotes latest price market data by symbol.",
              inputSchema: { type: "object", properties: { symbol: { type: "string" }, convert: { type: "string" } }, required: ["symbol"] },
            },
            {
              name: "global_metrics_quotes_latest",
              description: "CoinMarketCap global metrics quotes latest market metrics.",
              inputSchema: { type: "object", properties: { convert: { type: "string" } } },
            },
            {
              name: "fear_and_greed_latest",
              description: "CoinMarketCap fear and greed latest sentiment.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      }
      if (rpc.method === "tools/call") {
        const name = rpc.params?.name;
        const requestedSymbol = String(rpc.params?.arguments?.symbol || rpc.params?.arguments?.parameters?.symbol || "BTC").toUpperCase();
        const assetName = requestedSymbol === "SOL" ? "Solana" : requestedSymbol === "ETH" ? "Ethereum" : "Bitcoin";
        const assetPrice = requestedSymbol === "SOL" ? 150 : requestedSymbol === "ETH" ? 3400 : 65000;
        const calledAt = now();
        if (name === "find_skill") {
          return send({
            content: [{
              type: "text",
              text: JSON.stringify({
                candidates: [{
                  uniqueName: "daily_market_overview",
                  skillDescription: "Daily crypto market overview evidence pack.",
                  inputSchema: { type: "object", additionalProperties: false, properties: { preview: { type: "boolean", enum: [true] } }, required: ["preview"] },
                }],
              }),
            }],
          });
        }
        if (name === "execute_skill") {
          const uniqueName = String(rpc.params?.arguments?.unique_name || "daily_market_overview");
          if (options.emptyEvidence) {
            return send({
              content: [{
                type: "text",
                text: JSON.stringify({
                  raw_output: JSON.stringify({
                    schemaVersion: "cmc-skill-hub-normalized-v2",
                    provider: "mcpProvider",
                    skill: uniqueName,
                    status: "ok",
                    observedAt: calledAt,
                    generatedAt: calledAt,
                    expiresAt: new Date(Date.now() + 900000).toISOString(),
                    freshness: "fresh",
                    watchlist: [],
                  }),
                }),
              }],
            });
          }
          return send({
            content: [{
              type: "text",
              text: JSON.stringify({
                raw_output: JSON.stringify({
                  schemaVersion: "cmc-skill-hub-normalized-v2",
                  provider: "mcpProvider",
                  skill: uniqueName,
                  status: "ok",
                  observedAt: calledAt,
                  generatedAt: calledAt,
                  expiresAt: new Date(Date.now() + 900000).toISOString(),
                  freshness: "fresh",
                  watchlist: [{ symbol: requestedSymbol, name: assetName, priceUSD: assetPrice, percentChange24h: 1.5, volume24hUSD: 123456789, marketCapUSD: 1200000000000, observedAt: calledAt }],
                  market_read: { summary: "fake Skill Hub evidence" },
                  action_guidance: ["research only"],
                  source_attribution: ["fake CoinMarketCap Skill Hub MCP"],
                }),
              }),
            }],
          });
        }
        if (name === "cryptocurrency_quotes_latest") {
          return send({
            content: [{
              type: "text",
              text: JSON.stringify({
                data: {
                  [requestedSymbol]: {
                    symbol: requestedSymbol,
                    name: assetName,
                    last_updated: calledAt,
                    quote: { USD: { price: assetPrice, percent_change_24h: 1.5, volume_24h: 123456789, market_cap: 1200000000000, last_updated: calledAt } },
                  },
                },
              }),
            }],
          });
        }
        if (name === "global_metrics_quotes_latest") {
          return send({ content: [{ type: "text", text: JSON.stringify({ data: { quote: { USD: { total_market_cap: 2400000000000 } } } }) }] });
        }
        if (name === "fear_and_greed_latest") {
          return send({ content: [{ type: "text", text: JSON.stringify({ data: { value: 62, value_classification: "Greed" } }) }] });
        }
      }
      return send({ error: "unknown_method" }, 404);
    });
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  const previousEndpoint = process.env.CMC_MCP_ENDPOINT;
  const previousKey = process.env.CMC_MCP_API_KEY;
  process.env.CMC_MCP_ENDPOINT = `http://127.0.0.1:${address.port}`;
  process.env.CMC_MCP_API_KEY = "test_cmc_mcp_key";
  try {
    return await callback();
  } finally {
    if (previousEndpoint === undefined) delete process.env.CMC_MCP_ENDPOINT; else process.env.CMC_MCP_ENDPOINT = previousEndpoint;
    if (previousKey === undefined) delete process.env.CMC_MCP_API_KEY; else process.env.CMC_MCP_API_KEY = previousKey;
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

async function securitySmokeCheck() {
  ensureDirs();
  await ensureMongoReady();
  process.env.CMC_PRO_API_KEY = "";
  process.env.COINMARKETCAP_API_KEY = "";
  const token = expectedAuthToken();
  const localURL = new URL(`http://${host}:${port}/capabilities`);
  const missing = authFailure({ method: "GET", headers: { host: `127.0.0.1:${port}` } }, localURL);
  const badHost = authFailure({ method: "GET", headers: { host: `0.0.0.0:${port}`, authorization: `Bearer ${token}` } }, localURL);
  const ok = authFailure({ method: "GET", headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } }, localURL);
  if (missing?.status !== 401) throw new Error("security_smoke_expected_unauthorized");
  if (badHost?.status !== 403) throw new Error("security_smoke_expected_bad_host");
  if (ok !== null) throw new Error("security_smoke_expected_authorized");
  if (policyForTool("wechat_cli.live_command") !== "blocked") throw new Error("security_smoke_wechat_live_must_be_blocked");
  if (policyForTool("cmc.live_market_refresh") !== "pass") throw new Error("security_smoke_cmc_live_must_pass");
  if (policyForTool("office.document.draft") !== "pass" || policyForTool("office.meeting_minutes.draft") !== "pass" || policyForTool("office.cloud_asr.transcribe") !== "pass") {
    throw new Error("security_smoke_office_draft_must_pass");
  }
  if (policyForTool("markets.equity_research.draft") !== "pass" || policyForTool("markets.provider.drillr_deferred") !== "pass") {
    throw new Error("security_smoke_markets_research_must_pass_local_artifacts");
  }
  for (const blockedTool of ["channel.feishu.publish_live", "channel.feishu.reply_live", "office.document.delete", "office.document.overwrite_live"]) {
    if (policyForTool(blockedTool) !== "blocked") throw new Error(`security_smoke_sensitive_office_channel_must_be_blocked:${blockedTool}`);
  }
  const unifiedRegistry = readJSON(registryPath, null);
  const unifiedCapabilityIDs = new Set((unifiedRegistry?.capabilities || []).map((item) => item.capabilityId));
  for (const capabilityID of ["runtime-harness", "office.meeting-minutes", "office.document-generation", "office.document-revision", "channel.feishu-agent-bridge", "markets.equity-research", "markets.dispatcher", "markets.drillr-provider-deferred"]) {
    if (!unifiedCapabilityIDs.has(capabilityID)) throw new Error(`security_smoke_unified_capability_missing:${capabilityID}`);
  }
  if (unifiedRegistry?.channelCapabilityMatrix?.feishu?.publish_customer_visible !== "blocked_until_QA_Policy_channel_ready") {
    throw new Error("security_smoke_feishu_channel_matrix_missing");
  }
  const macroPreferred = preferredCMCTool("帮我复核 BTC 宏观 thesis：ETF 流、跨资产相关性和反证", ["social-price-divergence"]);
  if (macroPreferred !== "cmc.crypto_macro_overview") {
    throw new Error(`security_smoke_macro_prompt_should_override_social_tool:${macroPreferred}`);
  }
  writeJSON(join(projectRoot, "runtime", "market", "latest-market-snapshot.json"), {
    sourceName: "CMC Skill Hub normalizedFileProvider",
    status: "degraded",
    freshness: "fresh",
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    assets: [{ symbol: "BTC", name: "Bitcoin", priceUSD: 1, isLive: true }],
  });
  const badGate = cmcFreshnessGate();
  if (badGate.allowConcretePrices !== false || !badGate.integrityReasons?.includes("schema_missing_or_unsupported") || !badGate.integrityReasons?.includes("provider_missing")) {
    throw new Error(`security_smoke_bad_snapshot_must_not_be_fresh:${JSON.stringify(badGate)}`);
  }
  const guardedMissingObservations = guardFinalOutput({
    text: "若 BTC 能站稳 82,800 可视为短线结构转强信号。",
    prompt: "扫描 BTC alpha",
    tools: ["cmc.live_market_refresh"],
    toolObservations: null,
  });
  if (guardedMissingObservations.outputGuard.status !== "rewritten" || /82,?800/.test(guardedMissingObservations.text)) {
    throw new Error(`security_smoke_expected_output_rewrite:${JSON.stringify(guardedMissingObservations.outputGuard)}`);
  }
  const guardedRawToolMarkup = guardFinalOutput({
    text: "已读取数据。\n<looloomi-tool-calls><callname=\"market.read_snapshot\" parameters=\"{\\\"symbol\\\":\\\"BTC\\\"}\"/></looloomi-tool-calls>\nruntime/agent/runs/run-test/tool-calls.json",
    prompt: "复核本地情报",
    tools: ["market.read_snapshot"],
    toolObservations: { cmcFreshnessGate: { status: "pass", allowConcretePrices: true, reason: "ok" } },
  });
  if (guardedRawToolMarkup.outputGuard.status !== "rewritten" || /looloomi-tool|runtime\/agent|parameters=|tool-calls\.json/.test(guardedRawToolMarkup.text)) {
    throw new Error(`security_smoke_expected_raw_tool_markup_removed:${JSON.stringify(guardedRawToolMarkup)}`);
  }
  const rawFunctionCallMarkup = "正在处理。\n<function_calls><invoke invokename=\"cmc.live_market_refresh\"><parametername=\"symbol\">SOL</parameter></invoke></function_calls>";
  const guardedFunctionCallMarkup = guardFinalOutput({
    text: rawFunctionCallMarkup,
    prompt: "复核 SOL 永续持仓",
    tools: ["cmc.live_market_refresh"],
    toolObservations: { cmcFreshnessGate: { status: "pass", allowConcretePrices: true, reason: "ok" } },
  });
  if (
    guardedFunctionCallMarkup.outputGuard.status !== "rewritten"
    || /function_calls|invoke|invokename|parametername|<parameter/i.test(guardedFunctionCallMarkup.text)
  ) {
    throw new Error(`security_smoke_expected_function_call_markup_removed:${JSON.stringify(guardedFunctionCallMarkup)}`);
  }
  const streamVisible = safeStreamVisibleText(rawFunctionCallMarkup);
  if (/function_calls|invoke|invokename|parametername|<parameter/i.test(streamVisible)) {
    throw new Error(`security_smoke_expected_stream_markup_removed:${streamVisible}`);
  }
  const cmc = await refreshCMCLive({ symbols: ["BTC"], providerOrder: ["fixture"] });
  if (cmc.status !== "degraded" || cmc.provider !== "fixtureProvider" || !cmc.artifact) {
    throw new Error(`security_smoke_expected_cmc_degraded:${JSON.stringify(cmc)}`);
  }
  const gate = cmcFreshnessGate();
  if (gate.allowConcretePrices !== false || gate.provider === "cmcRestProvider" || gate.provider === "mcpProvider") {
    throw new Error(`security_smoke_fixture_must_not_be_live:${JSON.stringify(gate)}`);
  }
  const bridgeScriptPath = join(opsRoot, "cmc-bridge-smoke.mjs");
  writeFileSync(bridgeScriptPath, `
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const req = JSON.parse(input || "{}");
  const now = new Date().toISOString();
  process.stdout.write(JSON.stringify({
    status: "ok",
    data: {
      schemaVersion: "cmc-skill-hub-normalized-v2",
      provider: "mcpProvider",
      skill: req.skill || "daily_market_overview",
      status: "ok",
      observedAt: now,
      generatedAt: now,
      expiresAt: new Date(Date.now() + 900000).toISOString(),
      freshness: "fresh",
      watchlist: [{ symbol: "BTC", name: "Bitcoin", priceUSD: 1, percentChange24h: 2, volume24hUSD: 3, marketCapUSD: 4, observedAt: now }],
      market_read: { summary: "bridge smoke evidence" },
      action_guidance: ["research only"],
      source_attribution: ["smoke bridge"]
    }
  }));
});
`, { encoding: "utf8", mode: 0o700 });
  process.env.CMC_SKILL_HUB_BRIDGE_CMD = `${process.execPath} ${bridgeScriptPath}`;
  const bridge = await refreshCMCLive({ symbols: ["BTC"], providerOrder: ["mcp_bridge"], runID: "security-smoke" });
  const bridgeGate = cmcFreshnessGate();
  if (bridge.status !== "ok" || bridge.provider !== "mcpProvider" || bridgeGate.allowConcretePrices !== true) {
    throw new Error(`security_smoke_expected_bridge_live:${JSON.stringify({ bridge, bridgeGate })}`);
  }
  await withFakeCMCMcpServer(async () => {
    const mcp = await refreshCMCLive({ symbols: ["BTC"], providerOrder: ["mcp_http"], runID: "security-smoke-mcp-http" });
    const mcpGate = cmcFreshnessGate();
    if (mcp.status !== "ok" || mcp.provider !== "mcpProvider" || mcp.providerType !== "mcpHttpProvider" || mcpGate.allowConcretePrices !== true) {
      throw new Error(`security_smoke_expected_mcp_http_live:${JSON.stringify({ mcp, mcpGate })}`);
    }
  });
  await withFakeCMCMcpServer(async () => {
    const mcp = await refreshCMCLive({ symbols: ["BTC"], providerOrder: ["mcp_http"], runID: "security-smoke-mcp-http-empty" });
    const splitGate = buildSplitCMCGate(cmcFreshnessGate(), [mcp.skillHubResult].filter(Boolean));
    if (
      mcp.status !== "ok"
      || splitGate.allowSkillHubResultDisplay !== true
      || splitGate.allowResearchConclusion !== true
      || splitGate.allowConcretePrices !== false
      || splitGate.skillHubDisplayStatus !== "usable"
      || splitGate.parserEvidenceStatus !== "empty"
    ) {
      throw new Error(`security_smoke_expected_empty_skill_hub_displayable_generic_summary:${JSON.stringify({ mcp, splitGate })}`);
    }
    const emptyFinal = degradedMarketFinalText({
      prompt: "分析 BTC 宏观 thesis",
      tools: ["cmc.crypto_macro_overview"],
      toolObservations: { cmcFreshnessGate: splitGate, cmcSkillHub: { available: true, observations: [mcp.skillHubResult].filter(Boolean) } },
      reason: "empty_evidence",
    });
    if (
      !emptyFinal.includes("返回通用结果摘要")
      || !emptyFinal.includes("未获得 App 可引用价格快照")
      || emptyFinal.includes("不能把这次结果当作有效实时研究结论")
    ) {
      throw new Error(`security_smoke_expected_displayable_generic_summary_copy:${emptyFinal}`);
    }
  }, { emptyEvidence: true });
  const noDisplaySkillHubObservation = {
    status: "ok",
    skill: "crypto_macro_overview",
    summary: "",
    readableEvidence: [],
    readableEvidenceCount: 0,
  };
  const noDisplaySplitGate = buildSplitCMCGate({
    status: "pass",
    provider: "mcpProvider",
    freshness: "fresh",
    allowLiveResearch: true,
    allowConcretePrices: false,
    assetCount: 0,
    reason: "fresh_live_research_snapshot_no_concrete_prices",
    integrityReasons: [],
  }, [noDisplaySkillHubObservation]);
  if (
    noDisplaySplitGate.status !== "degraded"
    || noDisplaySplitGate.reason !== "skill_hub_transport_ok_no_displayable_content"
    || noDisplaySplitGate.allowSkillHubResultDisplay !== false
    || noDisplaySplitGate.allowResearchConclusion !== false
  ) {
    throw new Error(`security_smoke_expected_empty_skill_hub_no_displayable_content:${JSON.stringify(noDisplaySplitGate)}`);
  }
  const noDisplayFinal = degradedMarketFinalText({
    prompt: "分析 BTC 宏观 thesis",
    tools: ["cmc.crypto_macro_overview"],
    toolObservations: { cmcFreshnessGate: noDisplaySplitGate, cmcSkillHub: { available: true, observations: [noDisplaySkillHubObservation] } },
    reason: "empty_evidence",
  });
  if (!noDisplayFinal.includes("CMC Skill Hub transport 成功，但本轮未返回可展示 summary、conclusion 或 readable evidence")) {
    throw new Error(`security_smoke_expected_empty_no_displayable_copy:${noDisplayFinal}`);
  }
  const genericSkillHubObservation = {
    status: "ok",
    skill: "crypto_macro_overview",
    confidence: "medium",
    summary: "crypto_macro_overview returned CMC Skill Hub evidence.",
    readableEvidence: [],
    readableEvidenceCount: 0,
  };
  const displayableSplitGate = buildSplitCMCGate({
    status: "pass",
    provider: "mcpProvider",
    freshness: "fresh",
    allowLiveResearch: true,
    allowConcretePrices: false,
    assetCount: 0,
    reason: "fresh_live_research_snapshot_no_concrete_prices",
    integrityReasons: [],
  }, [genericSkillHubObservation]);
  if (
    displayableSplitGate.allowSkillHubResultDisplay !== true
    || displayableSplitGate.allowResearchConclusion !== true
    || displayableSplitGate.allowConcretePrices !== false
    || displayableSplitGate.skillHubDisplayStatus !== "usable"
    || displayableSplitGate.parserEvidenceStatus !== "empty"
  ) {
    throw new Error(`security_smoke_expected_displayable_skill_hub_result:${JSON.stringify(displayableSplitGate)}`);
  }
  const displayableCapabilitySummary = buildCMCCapabilitySummary({
    runID: "security-smoke-render",
    toolObservations: { cmcFreshnessGate: displayableSplitGate, cmcSkillHub: { available: true, observations: [genericSkillHubObservation] } },
    tools: ["cmc.crypto_macro_overview"],
    selectedExtensionIDs: ["cmc-skill-hub"],
  });
  if (
    displayableCapabilitySummary.renderSchemaVersion !== "cmc-render-result-v1"
    || !Array.isArray(displayableCapabilitySummary.renderBlocks)
    || displayableCapabilitySummary.renderBlocks.length < 1
    || displayableCapabilitySummary.diagnostics?.parserEvidenceStatus !== "empty"
    || displayableCapabilitySummary.diagnostics?.priceSnapshotStatus !== "empty"
    || displayableCapabilitySummary.claimPolicy?.appMayAddConcretePrices !== false
  ) {
    throw new Error(`security_smoke_expected_cmc_render_contract:${JSON.stringify(displayableCapabilitySummary)}`);
  }
  const displayableFinal = degradedMarketFinalText({
    prompt: "分析 BTC 宏观 thesis",
    tools: ["cmc.crypto_macro_overview"],
    toolObservations: { cmcFreshnessGate: displayableSplitGate, cmcSkillHub: { available: true, observations: [genericSkillHubObservation] } },
    reason: "displayable_summary_no_price_snapshot",
  });
  if (
    !displayableFinal.includes("返回通用结果摘要")
    || !displayableFinal.includes("未获得 App 可引用价格快照")
    || displayableFinal.includes("不能把这次结果当作有效实时研究结论")
  ) {
    throw new Error(`security_smoke_expected_displayable_summary_without_prices:${displayableFinal}`);
  }
  const pricedSkillHubObservation = {
    status: "ok",
    skill: "crypto_macro_overview",
    confidence: "medium",
    summary: "BTC price is near 69,000 while macro liquidity remains mixed.",
    conclusion: "Keep BTC on research watch near 69,000.",
    marketRead: { summary: "BTC price is near 69,000 in the returned CMC Skill Hub text." },
    readableEvidence: [],
    readableEvidenceCount: 0,
  };
  const pricedSplitGate = buildSplitCMCGate({
    status: "pass",
    provider: "mcpProvider",
    freshness: "fresh",
    allowLiveResearch: true,
    allowConcretePrices: false,
    assetCount: 0,
    reason: "fresh_live_research_snapshot_no_concrete_prices",
    integrityReasons: [],
  }, [pricedSkillHubObservation]);
  if (
    pricedSplitGate.allowSkillHubResultDisplay !== true
    || pricedSplitGate.allowSkillHubReturnedPrices !== true
    || Number(pricedSplitGate.skillHubReturnedPriceTokenCount || 0) < 1
    || pricedSplitGate.allowConcretePrices !== false
  ) {
    throw new Error(`security_smoke_expected_skill_hub_returned_price_metadata:${JSON.stringify(pricedSplitGate)}`);
  }
  const guardedSkillHubReturnedPrice = guardFinalOutput({
    text: "## 结论\nCMC Skill Hub 返回：BTC price is near 69,000 while macro liquidity remains mixed.\n\n## 数据说明\n该价格来自 CMC Skill Hub 返回内容；App 本轮未获得独立结构化价格快照。",
    prompt: "复核 BTC 宏观 thesis",
    tools: ["cmc.crypto_macro_overview"],
    toolObservations: { cmcFreshnessGate: pricedSplitGate, cmcSkillHub: { available: true, observations: [pricedSkillHubObservation] } },
  });
  if (
    guardedSkillHubReturnedPrice.outputGuard.status !== "passed"
    || !guardedSkillHubReturnedPrice.text.includes("69,000")
    || !guardedSkillHubReturnedPrice.text.includes("CMC Skill Hub 返回")
  ) {
    throw new Error(`security_smoke_expected_skill_hub_price_preserved:${JSON.stringify(guardedSkillHubReturnedPrice)}`);
  }
  const guardedGeneratedLevels = guardFinalOutput({
    text: "## 结论\nCMC Skill Hub 返回：BTC price is near 69,000 while macro liquidity remains mixed.\nBTC 支撑 67,200，阻力 70,500。\n\n## 数据说明\nApp 本轮未获得独立结构化价格快照。",
    prompt: "复核 BTC 宏观 thesis",
    tools: ["cmc.crypto_macro_overview"],
    toolObservations: { cmcFreshnessGate: pricedSplitGate, cmcSkillHub: { available: true, observations: [pricedSkillHubObservation] } },
  });
  if (
    guardedGeneratedLevels.outputGuard.status !== "rewritten"
    || !guardedGeneratedLevels.text.includes("69,000")
    || /67,?200|70,?500/.test(guardedGeneratedLevels.text)
  ) {
    throw new Error(`security_smoke_expected_generated_levels_removed:${JSON.stringify(guardedGeneratedLevels)}`);
  }
  refreshCMCFromFixture({}, ["security_smoke_cleanup"]);
  console.log("security_smoke=pass");
}

function assertBusinessRunArtifacts(result, { expectLiveCMC, caseID }) {
  const runDir = join(runsRoot, result.runID);
  const finalPath = join(runDir, "final-output.md");
  const observationsPath = join(runDir, "tool-observations.json");
  const manifestPath = join(runDir, "run-manifest.json");
  const finalReadModelPath = join(runDir, "agent-final-read-model.json");
  const coreRoutePlanPath = join(runDir, "core-route-plan.json");
  const cmcCapabilitySummaryPath = join(runDir, "cmc-capability-summary.json");
  const modelRoutePath = join(runDir, "model-route.json");
  const finalText = readFileSync(finalPath, "utf8");
  const observations = readJSON(observationsPath, null);
  const manifest = readJSON(manifestPath, null);
  const finalReadModel = readJSON(finalReadModelPath, null);
  const coreRoutePlan = readJSON(coreRoutePlanPath, null);
  const cmcCapabilitySummary = readJSON(cmcCapabilitySummaryPath, null);
  const modelRoute = readJSON(modelRoutePath, null);
  if (result.task?.status !== "completed") throw new Error(`business_qa_${caseID}_task_not_completed`);
  if (manifest?.status !== "completed") throw new Error(`business_qa_${caseID}_manifest_not_completed`);
  if (!observations?.schemaVersion || !Array.isArray(observations.observations)) throw new Error(`business_qa_${caseID}_missing_tool_observations`);
  if (coreRoutePlan?.schemaVersion !== "core-route-plan-v1" || !Array.isArray(coreRoutePlan.tools)) throw new Error(`business_qa_${caseID}_missing_core_route_plan`);
  if (!observations.cmcFreshnessGate?.researchEvidence || !observations.cmcFreshnessGate?.priceSnapshot) throw new Error(`business_qa_${caseID}_missing_split_cmc_gate`);
  if (!finalReadModel?.schemaVersion || finalReadModel.finalText !== finalText.trim()) throw new Error(`business_qa_${caseID}_missing_or_mismatched_final_read_model`);
  if (modelRoute?.schemaVersion !== "agent-model-route-v3" || !Array.isArray(modelRoute.attempts) || !modelRoute.fallbackPolicy?.deterministicOnlyAfterModelsExhausted) {
    throw new Error(`business_qa_${caseID}_missing_model_route_v3:${JSON.stringify(modelRoute)}`);
  }
  assertRunContextArtifacts(result.runID);
  assertRunLoopArtifacts(result.runID);
  assertRunHarnessArtifacts(result.runID);
  assertRunCapabilityLoopArtifacts(
    result.runID,
    caseID === "btc_macro" ? "crypto_market_loop" : caseID.startsWith("office_meeting") ? "office_work_loop" : caseID === "markets_equity_draft" ? "markets_research_loop" : null
  );
  if (!finalText.includes("## 结论") || !finalText.includes("## 关键证据")) throw new Error(`business_qa_${caseID}_final_not_structured`);
  if (internalSurfaceViolations(finalText).length) throw new Error(`business_qa_${caseID}_raw_internal_surface:${internalSurfaceViolations(finalText).join(",")}`);
  const isCMCRun = result.task?.selectedExtensionIDs?.includes("cmc-skill-hub")
    || result.task?.selectedSkillIDs?.some((item) => /cmc|market|social-price/i.test(String(item)))
    || result.task?.selectedToolNames?.some((item) => String(item).startsWith("cmc.") || item === "market.read_snapshot");
  if (isCMCRun) {
    if (!cmcCapabilitySummary?.schemaVersion) throw new Error(`business_qa_${caseID}_missing_cmc_capability_summary`);
    if (cmcCapabilitySummary.schemaVersion !== "cmc-capability-summary-v1" || cmcCapabilitySummary.capabilityID !== "cmc-skill-hub") {
      throw new Error(`business_qa_${caseID}_invalid_cmc_capability_summary:${JSON.stringify(cmcCapabilitySummary)}`);
    }
    if (cmcCapabilitySummary.renderSchemaVersion !== "cmc-render-result-v1" || !Array.isArray(cmcCapabilitySummary.renderBlocks)) {
      throw new Error(`business_qa_${caseID}_missing_cmc_render_contract:${JSON.stringify(cmcCapabilitySummary)}`);
    }
    if (observations.cmcSkillHub?.available && Number(cmcCapabilitySummary.sourceObservationCount || 0) < 1) {
      throw new Error(`business_qa_${caseID}_cmc_summary_missing_real_observation:${JSON.stringify(cmcCapabilitySummary)}`);
    }
    if (observations.cmcSkillHub?.available && !["usable", "empty", "failed"].includes(String(cmcCapabilitySummary.skillHubDisplayStatus || ""))) {
      throw new Error(`business_qa_${caseID}_cmc_summary_missing_display_status:${JSON.stringify(cmcCapabilitySummary)}`);
    }
    if (observations.cmcSkillHub?.available && observations.cmcSkillHub?.observations?.[0]?.summary && cmcCapabilitySummary.allowSkillHubResultDisplay !== true) {
      throw new Error(`business_qa_${caseID}_cmc_summary_summary_should_be_displayable:${JSON.stringify(cmcCapabilitySummary)}`);
    }
    if (Number(cmcCapabilitySummary.readableEvidenceCount || 0) === 0 && cmcCapabilitySummary.researchEvidenceStatus === "usable") {
      throw new Error(`business_qa_${caseID}_cmc_summary_empty_evidence_marked_usable:${JSON.stringify(cmcCapabilitySummary)}`);
    }
    if (observations.cmcSkillHub?.observations?.[0]?.summary && !cmcCapabilitySummary.summary) {
      throw new Error(`business_qa_${caseID}_cmc_summary_missing_skillhub_result_summary`);
    }
    if (finalText.includes("不能把这次结果当作有效实时研究结论")) {
      throw new Error(`business_qa_${caseID}_final_uses_superseded_empty_evidence_copy`);
    }
  }
  if (caseID === "btc_macro" && observations.toolSelectionDiagnostic?.preferredTool !== "cmc.crypto_macro_overview") {
    throw new Error(`business_qa_${caseID}_macro_tool_selection_mismatch:${JSON.stringify(observations.toolSelectionDiagnostic)}`);
  }
  if (caseID === "office_meeting_draft" || caseID === "office_meeting_cloud_asr") {
    const officeArtifacts = [
      "office-meeting-minutes-draft.json",
      "office-document-draft.json",
      "office-document-revision-draft.json",
      "feishu-channel-dry-run.json",
    ];
    for (const name of officeArtifacts) {
      if (!existsSync(join(runDir, name))) throw new Error(`business_qa_${caseID}_missing_office_artifact:${name}`);
    }
    const feishuDryRun = readJSON(join(runDir, "feishu-channel-dry-run.json"), null);
    if (feishuDryRun?.liveActionsExecuted !== false || feishuDryRun?.larkCliCalled !== false || feishuDryRun?.policy?.livePublishBlocked !== true) {
      throw new Error(`business_qa_${caseID}_feishu_dry_run_boundary_failed:${JSON.stringify(feishuDryRun)}`);
    }
    if (/office\.|channel\.feishu|tool-observations|tool-calls|lark-cli/i.test(finalText)) {
      throw new Error(`business_qa_${caseID}_final_exposes_internal_tools`);
    }
    if (caseID === "office_meeting_cloud_asr") {
      for (const name of ["cloud-asr-summary.json", "cloud-asr-transcript.json", "meeting-source-pack.json"]) {
        if (!existsSync(join(runDir, name))) throw new Error(`business_qa_${caseID}_missing_cloud_asr_artifact:${name}`);
      }
      const asrSummary = readJSON(join(runDir, "cloud-asr-summary.json"), null);
      const asrTranscript = readJSON(join(runDir, "cloud-asr-transcript.json"), null);
      if (asrSummary?.cloudASRStatus !== "completed" || asrSummary?.cloudUpload !== true || asrSummary?.rawProviderRequestIncluded !== false || asrSummary?.secretsIncluded !== false) {
        throw new Error(`business_qa_${caseID}_invalid_cloud_asr_summary:${JSON.stringify(asrSummary)}`);
      }
      if (asrTranscript?.rawAudioStored !== false || !Array.isArray(asrTranscript?.segments) || asrTranscript.segments.length < 1) {
        throw new Error(`business_qa_${caseID}_invalid_cloud_asr_transcript:${JSON.stringify(asrTranscript)}`);
      }
      if (observations.cloudASR?.gate?.cloudUpload !== true || observations.modelUsePolicy?.cloudASRStatus !== "completed") {
        throw new Error(`business_qa_${caseID}_missing_cloud_asr_observation:${JSON.stringify(observations.cloudASR)}`);
      }
    }
  }
  if (caseID === "markets_equity_draft") {
    if (!coreRoutePlan.resolvedCapabilityIDs?.includes("markets-research") || coreRoutePlan.compatibilityMode !== "capability_catalog_v1") {
      throw new Error(`business_qa_${caseID}_capability_catalog_not_authoritative:${JSON.stringify(coreRoutePlan)}`);
    }
    const marketsArtifacts = [
      "markets-capability-summary.json",
      "markets-dispatcher-plan.json",
      "equity-evidence-pack.json",
      "equity-research-draft.json",
      "markets-provider-deferred.json",
    ];
    for (const name of marketsArtifacts) {
      if (!existsSync(join(runDir, name))) throw new Error(`business_qa_${caseID}_missing_markets_artifact:${name}`);
    }
    const marketsSummary = readJSON(join(runDir, "markets-capability-summary.json"), null);
    if (marketsSummary?.schemaVersion !== "markets-capability-summary-v1" || marketsSummary?.capabilityID !== "markets-research") {
      throw new Error(`business_qa_${caseID}_invalid_markets_summary:${JSON.stringify(marketsSummary)}`);
    }
    if (marketsSummary.allowConcretePrices !== false || marketsSummary.allowBuyHoldSellAction !== false || marketsSummary.transportStatus !== "provider_deferred") {
      throw new Error(`business_qa_${caseID}_markets_gate_boundary_failed:${JSON.stringify(marketsSummary)}`);
    }
    if (!observations.marketsResearch?.gate || observations.marketsResearch.gate.allowConcretePrices !== false) {
      throw new Error(`business_qa_${caseID}_missing_markets_gate:${JSON.stringify(observations.marketsResearch)}`);
    }
    if (/markets\.|drillr|cc-equity-research|InvestSkill|slash command|BUY\s*\/\s*HOLD\s*\/\s*SELL/i.test(finalText)) {
      throw new Error(`business_qa_${caseID}_final_exposes_markets_internal_surface`);
    }
  }
  if (expectLiveCMC === true) {
    if (observations.cmcFreshnessGate?.allowConcretePrices !== true || observations.cmcFreshnessGate?.provider !== "mcpProvider") {
      throw new Error(`business_qa_${caseID}_expected_live_cmc:${JSON.stringify(observations.cmcFreshnessGate)}`);
    }
  } else if (expectLiveCMC === false && observations.cmcFreshnessGate?.allowConcretePrices !== false) {
    throw new Error(`business_qa_${caseID}_expected_degraded_cmc:${JSON.stringify(observations.cmcFreshnessGate)}`);
  }
  const assistantFinal = result.session?.messages?.filter((message) => message.role === "assistant").at(-1);
  if (!assistantFinal || assistantFinal.runID !== result.runID || !assistantFinal.plainText && !assistantFinal.content?.[0]?.text) {
    throw new Error(`business_qa_${caseID}_missing_authoritative_session_final`);
  }
  return {
    caseID,
    runID: result.runID,
    taskID: result.task.taskID,
    gate: observations.cmcFreshnessGate,
    finalBytes: Buffer.byteLength(finalText, "utf8"),
    toolCount: observations.observations.length,
  };
}

async function runBusinessCase({ caseID, title, prompt, selectedCapabilityIDs = [], selectedSkillIDs, selectedExtensionIDs, attachments = [], expectLiveCMC }) {
  const session = await createSession({ title: `business-qa-${caseID}-${title}` });
  const result = await postMessage(session.sessionID, {
    prompt,
    selectedCapabilityIDs,
    selectedSkillIDs,
    selectedExtensionIDs,
    attachments,
    contextRefs: [],
  });
  return assertBusinessRunArtifacts(result, { expectLiveCMC, caseID });
}

async function businessQACheck() {
  ensureDirs();
  process.env.WECHAT_AGENT_MOCK_PROVIDER = "1";
  await ensureMongoReady();
  if (process.env.WECHAT_AGENT_TEST_MODE === "1") await mongoStore.resetAll();
  await piKernel.ensure();
  const summaries = [];

  await withFakeCMCMcpServer(async () => {
    summaries.push(await runBusinessCase({
      caseID: "btc_macro",
      title: "BTC macro thesis",
      prompt: "帮我复核 BTC 宏观 thesis：ETF 流、跨资产相关性和反证是否支持继续观察空头逻辑，只做决策支持和监控项。",
      selectedSkillIDs: ["cmc-market-radar", "market-regime-review", "wechat-onchain-intelligence"],
      selectedExtensionIDs: ["cmc-skill-hub", "wechat-cli-export-bridge"],
      expectLiveCMC: true,
    }));
    summaries.push(await runBusinessCase({
      caseID: "sol_signal",
      title: "SOL 24h discussion",
      prompt: "接下来 24 小时帮我盯 SOL 相关讨论和异常链上信号，结合 CMC 市场数据给出观察重点。",
      selectedSkillIDs: ["cmc-market-radar", "social-price-divergence", "wechat-onchain-intelligence"],
      selectedExtensionIDs: ["cmc-skill-hub", "wechat-cli-export-bridge"],
      expectLiveCMC: true,
    }));
    summaries.push(await runBusinessCase({
      caseID: "alpha_scanner",
      title: "Alpha scanner",
      prompt: "帮我用 CMC 能力包扫描今天值得进一步研究的 alpha 候选，只输出研究候选、关键证据、反证和后续观察条件。",
      selectedSkillIDs: ["cmc-market-radar", "market-regime-review", "social-price-divergence"],
      selectedExtensionIDs: ["cmc-skill-hub"],
      expectLiveCMC: true,
    }));
    summaries.push(await runBusinessCase({
      caseID: "image_market",
      title: "Image plus market",
      prompt: "结合这张图和 BTC 市场状态，判断是否只是情绪噪音，给出风险边界。",
      selectedSkillIDs: ["image-analysis", "cmc-market-radar"],
      selectedExtensionIDs: ["cmc-skill-hub"],
      attachments: [{ attachmentID: "qa-image-1", fileName: "qa-market-screenshot.png", mimeType: "image/png", artifactPath: "runtime/agent/attachments/qa-market-screenshot.png", status: "recorded" }],
      expectLiveCMC: true,
    }));
  });

  summaries.push(await runBusinessCase({
    caseID: "office_meeting_draft",
    title: "Office meeting draft",
    prompt: "请基于这段会议上下文起草会议纪要、PRD 文档骨架和修订检查清单，并为飞书发布做 dry-run 预演；不要真实回复、发布或覆盖云文档。",
    selectedSkillIDs: ["meeting-minutes", "document-generation", "document-revision", "feishu-agent-bridge"],
    selectedExtensionIDs: ["office-meeting-agent"],
    expectLiveCMC: null,
  }));

  const previousMockCloudASR = process.env.WECHAT_AGENT_MOCK_CLOUD_ASR;
  process.env.WECHAT_AGENT_MOCK_CLOUD_ASR = "1";
  try {
    summaries.push(await runBusinessCase({
      caseID: "office_meeting_cloud_asr",
      title: "Office meeting cloud ASR",
      prompt: "请把我拖入的会议录音做云端转写，再生成会议纪要、文档骨架和飞书 dry-run 预览；不要真实发布。",
      selectedSkillIDs: ["meeting-cloud-asr", "meeting-minutes", "document-generation", "document-revision", "feishu-agent-bridge"],
      selectedExtensionIDs: ["office-meeting-agent"],
      attachments: [{
        attachmentID: "qa-audio-1",
        fileName: "meeting.m4a",
        mimeType: "audio/mp4",
        artifactPath: "runtime/agent/attachments/qa-audio-1/original.m4a",
        originalPath: "runtime/agent/attachments/qa-audio-1/original.m4a",
        status: "ready_for_cloud_asr",
      }],
      expectLiveCMC: null,
    }));
  } finally {
    if (previousMockCloudASR === undefined) {
      delete process.env.WECHAT_AGENT_MOCK_CLOUD_ASR;
    } else {
      process.env.WECHAT_AGENT_MOCK_CLOUD_ASR = previousMockCloudASR;
    }
  }

  summaries.push(await runBusinessCase({
    caseID: "markets_equity_draft",
    title: "Markets equity research draft",
    prompt: "帮我对 NVDA 做 company deep dive 和 earnings review，结合 AI infra sector read-through，输出研究草稿、证据缺口、反证和下一轮复核任务；不要输出 BUY/HOLD/SELL、仓位或交易价位。",
    selectedCapabilityIDs: ["markets-research"],
    selectedSkillIDs: [],
    selectedExtensionIDs: [],
    expectLiveCMC: null,
  }));

  const previousMcpKey = process.env.CMC_MCP_API_KEY;
  const previousMcpKeys = process.env.CMC_MCP_API_KEYS;
  const previousProKey = process.env.CMC_PRO_API_KEY;
  const previousCoinKey = process.env.COINMARKETCAP_API_KEY;
  const previousBridge = process.env.CMC_SKILL_HUB_BRIDGE_CMD;
  delete process.env.CMC_MCP_API_KEY;
  delete process.env.CMC_MCP_API_KEYS;
  delete process.env.CMC_PRO_API_KEY;
  delete process.env.COINMARKETCAP_API_KEY;
  delete process.env.CMC_SKILL_HUB_BRIDGE_CMD;
  try {
    summaries.push(await runBusinessCase({
      caseID: "cmc_degraded",
      title: "CMC degraded",
      prompt: "在没有可用 CMC provider 的情况下复核 BTC 行情，只允许输出数据缺口和定性结论。",
      selectedSkillIDs: ["cmc-market-radar"],
      selectedExtensionIDs: ["cmc-skill-hub"],
      expectLiveCMC: false,
    }));
  } finally {
    if (previousMcpKey === undefined) delete process.env.CMC_MCP_API_KEY; else process.env.CMC_MCP_API_KEY = previousMcpKey;
    if (previousMcpKeys === undefined) delete process.env.CMC_MCP_API_KEYS; else process.env.CMC_MCP_API_KEYS = previousMcpKeys;
    if (previousProKey === undefined) delete process.env.CMC_PRO_API_KEY; else process.env.CMC_PRO_API_KEY = previousProKey;
    if (previousCoinKey === undefined) delete process.env.COINMARKETCAP_API_KEY; else process.env.COINMARKETCAP_API_KEY = previousCoinKey;
    if (previousBridge === undefined) delete process.env.CMC_SKILL_HUB_BRIDGE_CMD; else process.env.CMC_SKILL_HUB_BRIDGE_CMD = previousBridge;
  }

  if (summaries.length !== 8) throw new Error(`business_qa_expected_8_cases:${summaries.length}`);
  writeJSON(join(opsRoot, "business-qa-summary.json"), {
    schemaVersion: "agent-business-qa-summary-v1",
    generatedAt: now(),
    status: "pass",
    caseCount: summaries.length,
    summaries,
  });
  console.log("business_qa=pass");
  for (const summary of summaries) {
    console.log(`${summary.caseID}=pass runID=${summary.runID} gate=${summary.gate.status}/${summary.gate.provider}/${summary.gate.freshness}`);
  }
}

async function mongoRepositorySmokeCheck() {
  ensureDirs();
  await ensureMongoReady();
  await mongoStore.resetAll();
  const session = await createSession({ title: "mongo-repository-smoke" });
  const fetched = await getSession(session.sessionID);
  if (!fetched || fetched.sessionID !== session.sessionID) throw new Error("mongo_session_roundtrip_failed");
  const task = {
    taskID: safeId("task"),
    sessionID: session.sessionID,
    runID: safeId("run"),
    prompt: "mongo repository smoke",
    status: "completed",
    selectedToolNames: [],
    selectedSkillIDs: [],
    selectedExtensionIDs: [],
    attachmentIDs: [],
    artifactPath: "runtime/agent/runs/mongo-smoke",
    createdAt: now(),
    updatedAt: now(),
    isTest: true,
  };
  await mongoStore.saveTask(task);
  await mongoStore.appendEvent({ type: "run.completed", runID: task.runID, taskID: task.taskID, sessionID: session.sessionID, status: "completed", timestamp: now() });
  await mongoStore.saveToolCalls(task.runID, [{ id: "tool-smoke", toolName: "cmc.live_market_refresh", status: "completed", createdAt: now() }]);
  await mongoStore.saveFinalOutput(task.runID, "## 结论\n- Mongo repository smoke final。", { sessionID: session.sessionID, taskID: task.taskID });
  if ((await mongoStore.listSessions({ includeTest: true })).length !== 1) throw new Error("mongo_session_list_failed");
  if ((await mongoStore.listTasks({ includeTest: true })).length !== 1) throw new Error("mongo_task_list_failed");
  if ((await mongoStore.listEvents(task.runID)).length !== 1) throw new Error("mongo_event_list_failed");
  await deleteSession(session.sessionID);
  if ((await mongoStore.listSessions({ includeTest: true })).length !== 0) throw new Error("mongo_delete_session_failed");
  console.log("mongo_repository_smoke=pass");
}

async function mongoTestCleanup() {
  await ensureMongoReady();
  if (process.env.WECHAT_AGENT_TEST_MODE === "1" || /test$/i.test(mongoStore.dbName)) {
    await mongoStore.dropDatabase();
    console.log("mongo_test_cleanup=pass");
    return;
  }
  throw new Error("refusing_to_drop_non_test_database");
}

function reapStaleRuns() {
  ensureDirs();
  const maxAgeMs = Number(process.env.WECHAT_AGENT_RUN_REAPER_MS || `${6 * 60 * 60 * 1000}`);
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDirPath = join(runsRoot, entry.name);
    const manifestPath = join(runDirPath, "run-manifest.json");
    const manifest = readJSON(manifestPath, null);
    if (!manifest || !["running", "paused"].includes(manifest.status)) continue;
    const updatedAt = Date.parse(manifest.updatedAt || manifest.startedAt || "");
    const fallbackMtime = statSync(runDirPath).mtimeMs;
    if ((Number.isFinite(updatedAt) ? updatedAt : fallbackMtime) > cutoff) continue;
    const taskID = manifest.taskID || null;
    writeRunManifest(runDirPath, {
      ...manifest,
      status: "failed",
      currentStage: "reaped",
      completedAt: now(),
      errorPreview: "Run was marked failed by local stale-run reaper.",
    });
    appendEvent(runDirPath, { type: "run.failed", runID: manifest.runID || entry.name, taskID, stage: "reaped", status: "failed", reason: "stale_run_reaper" });
  }
}

async function startServer() {
  ensureDirs();
  loadOrCreateAuthToken();
  await ensureMongoReady();
  reapStaleRuns();
  try {
    await piKernel.ensure();
  } catch (error) {
    console.error(`pi_runtime_init_degraded=${redact(error?.message || error)}`);
  }
  const server = createServer(handle);
  server.listen(port, host, () => {
    writeJSON(join(runtimeRoot, "daemon.pid"), { pid: process.pid, host, port, startedAt: daemonStartedAt, piRuntime: piKernel.status() });
    if (hostPolicyWarning) console.error(hostPolicyWarning);
    console.log(`wechat-agent-daemon listening on http://${host}:${port}`);
  });
}

const daemonStartedAt = now();
ensureDirs();
loadOrCreateAuthToken();

function runCLI(command) {
  command()
    .then(async () => {
      await flushMongoPersists();
      await mongoStore.close();
    })
    .catch(async (error) => {
      console.error(redact(error?.stack || error));
      try {
        await flushMongoPersists();
        await mongoStore.close();
      } catch {
        // Ignore shutdown cleanup failures.
      }
      process.exit(1);
    });
}

if (process.argv.includes("--wechat-live-refresh")) {
  const result = refreshWechatLive({});
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "ok" || result.status === "empty" ? 0 : 1);
} else if (process.argv.includes("--async-smoke-check")) {
  runCLI(asyncSmokeCheck);
} else if (process.argv.includes("--security-smoke-check")) {
  runCLI(securitySmokeCheck);
} else if (process.argv.includes("--business-qa-check")) {
  runCLI(businessQACheck);
} else if (process.argv.includes("--mongo-smoke-check")) {
  runCLI(mongoRepositorySmokeCheck);
} else if (process.argv.includes("--mongo-test-cleanup")) {
  runCLI(mongoTestCleanup);
} else if (process.argv.includes("--admin-runtime-reset")) {
  runCLI(async () => {
    await ensureMongoReady();
    await resetRuntimeData();
    console.log("admin_runtime_reset=pass");
  });
} else if (process.argv.includes("--smoke-check")) {
  runCLI(smokeCheck);
} else {
  startServer().catch((error) => {
    console.error(redact(error?.stack || error));
    process.exit(1);
  });
}
