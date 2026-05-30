#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  VERSION as PI_SDK_VERSION,
} from "@earendil-works/pi-coding-agent";
import { buildControlPlane } from "../control-plane/index.mjs";

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
const publicSurfacePath = join(agentRuntimeRoot, "runtime", "public-surface.json");
const providersPath = join(agentRuntimeRoot, "runtime", "model-providers.json");
const host = process.env.WECHAT_AGENT_DAEMON_HOST || "127.0.0.1";
const port = Number(process.env.WECHAT_AGENT_DAEMON_PORT || "8797");

const blockedActions = new Set(["run_live_wechat_cli", "read_live_wechat", "trade", "send_message", "publish_external"]);
const localPassTools = new Set([
  "wechat.read_normalized_messages",
  "token.resolve_entities",
  "market.read_snapshot",
  "onchain.read_snapshot",
  "crystal.create_or_update",
  "proposal.create",
  "memory.save",
  "handoff.write",
  "image.analyze_with_kimi",
  "wechat_cli.import_export_file",
  "wechat_cli.live_command",
  "cmc.read_market_evidence",
  "cmc.detect_market_regime",
  "cmc.track_social_price_divergence",
  "cmc.request_mcp_refresh",
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
  "cmc.read_market_evidence",
  "cmc.detect_market_regime",
  "cmc.track_social_price_divergence",
  "cmc.request_mcp_refresh",
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

class PiBackedAgentRuntime {
  constructor() {
    this.session = null;
    this.extensionsResult = null;
    this.lastError = null;
    this.initializedAt = null;
  }

  async ensure() {
    if (this.session) return this;
    try {
      mkdirSync(piAgentDir, { recursive: true });
      const loader = new DefaultResourceLoader({
        cwd: projectRoot,
        agentDir: piAgentDir,
        additionalExtensionPaths: discoverExtensionPaths(),
        additionalSkillPaths: [piSkillPath],
        additionalPromptTemplatePaths: [piPromptPath],
        noContextFiles: true,
        systemPrompt: readFileSync(join(agentRuntimeRoot, "prompts", "agent-system.md"), "utf8"),
      });
      await loader.reload();
      const result = await createAgentSession({
        cwd: projectRoot,
        agentDir: piAgentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(projectRoot),
        tools: projectToolNames,
        noTools: "builtin",
        sessionStartEvent: {
          type: "session_start",
          cwd: projectRoot,
          sessionId: `wechat-agent-daemon-${process.pid}`,
        },
      });
      this.session = result.session;
      this.extensionsResult = result.extensionsResult;
      this.initializedAt = now();
      this.lastError = null;
      return this;
    } catch (error) {
      this.lastError = redact(error?.stack || error?.message || error);
      throw error;
    }
  }

  status() {
    const tools = this.session?.getAllTools?.() || [];
    const activeTools = this.session?.getActiveToolNames?.() || [];
    return {
      backedBy: "@earendil-works/pi-coding-agent",
      sdkVersion: PI_SDK_VERSION,
      nodeVersion: process.version,
      requiredNodeVersion: ">=22.19.0",
      currentNodeSatisfiesDeclaredEngine: nodeSatisfiesPiEngine(process.version),
      initialized: Boolean(this.session),
      initializedAt: this.initializedAt,
      extensionPath: relative(projectRoot, piExtensionPath),
      extensionPackages: discoverExtensionPackages().map((item) => item.id),
      skillPath: relative(projectRoot, piSkillPath),
      promptPath: relative(projectRoot, piPromptPath),
      loadedExtensionCount: this.extensionsResult?.extensions?.length || 0,
      extensionErrors: this.extensionsResult?.errors || [],
      registeredTools: tools.map((tool) => tool.name).filter((name) => projectToolNames.includes(name)),
      activeTools: activeTools.filter((name) => projectToolNames.includes(name)),
      builtInToolExposure: {
        bash: activeTools.includes("bash") ? "unexpected_active" : "disabled",
        edit: activeTools.includes("edit") ? "unexpected_active" : "disabled",
        write: activeTools.includes("write") ? "unexpected_active" : "disabled",
      },
      lastError: this.lastError,
    };
  }

  async executeTool(toolName, params) {
    await this.ensure();
    const definition = this.session.getToolDefinition(toolName);
    if (!definition || typeof definition.execute !== "function") {
      return {
        status: "degraded",
        toolName,
        outputSummary: "Pi tool definition was not available.",
        details: { reason: "pi_tool_definition_missing" },
      };
    }
    const result = await definition.execute(
      safeId("pi-tool"),
      params,
      undefined,
      undefined,
      undefined,
    );
    const text = (result?.content || [])
      .map((part) => part?.text || "")
      .filter(Boolean)
      .join("\n")
      .slice(0, 1000);
    return {
      status: result?.details?.status || "completed",
      toolName,
      outputSummary: text || `Pi tool ${toolName} completed.`,
      details: result?.details || {},
    };
  }
}

function nodeSatisfiesPiEngine(version) {
  const match = String(version || "").match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
}

const piRuntime = new PiBackedAgentRuntime();
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
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function publicSurface() {
  const fallback = { schemaVersion: "agent-public-surface-v1", skills: [], extensions: [], templates: [] };
  const surface = readJSON(publicSurfacePath, fallback);
  const packages = discoverExtensionPackages()
    .map((item) => item.manifest)
    .filter(Boolean);
  const extensionIDs = new Set((surface.extensions || []).map((item) => item.extensionID));
  const packageExtensions = packages
    .filter((manifest) => manifest.publicExtension && !extensionIDs.has(manifest.publicExtension.extensionID))
    .map((manifest) => manifest.publicExtension);
  const packageSkills = packages.flatMap((manifest) => manifest.publicSkills || []);
  const skillIDs = new Set((surface.skills || []).map((item) => item.skillID));
  return {
    ...surface,
    skills: [...(surface.skills || []), ...packageSkills.filter((skill) => !skillIDs.has(skill.skillID))],
    extensions: [...(surface.extensions || []), ...packageExtensions],
    internalToolsExposed: false,
  };
}

function appendEvent(runDir, event) {
  const full = {
    eventID: safeId("evt"),
    timestamp: now(),
    ...event,
  };
  appendFileSync(join(runDir, "events.ndjson"), `${JSON.stringify(full)}\n`, "utf8");
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

function bridgeHealth() {
  const bridgeRoot = join(projectRoot, "runtime", "bridges");
  if (!existsSync(bridgeRoot)) return [];
  return readdirSync(bridgeRoot)
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
    });
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
      sdkVersion: PI_SDK_VERSION,
      nodeVersion: process.version,
      requiredNodeVersion: ">=22.19.0",
      initialized: Boolean(piRuntime.session),
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
    piRuntime: piRuntime.status(),
    providers: providerReadiness(),
    bridges: bridgeHealth(),
    capabilities: registry.capabilities || [],
    skills: surface.skills || [],
    extensions: surface.extensions || [],
    templates: surface.templates || [],
    tools: [],
    internalToolsExposed: false,
    policy: {
      liveWechat: "blocked",
      liveWechatCLI: "blocked",
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
  const providers = providerReadiness();
  const extensionPackages = discoverExtensionPackages().map((item) => ({
    id: item.id,
    status: "available",
    packageRoot: relative(projectRoot, item.packageRoot),
    extensionPath: relative(projectRoot, item.extensionPath),
    publicSurfaceOnly: true,
  }));
  writeJSON(join(opsRoot, "provider-status.json"), {
    schemaVersion: "agent-ops-provider-status-v1",
    generatedAt,
    providers,
    extensionPackages,
    missingProviderCount: providers.filter((item) => !item.ready).length,
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
      version: PI_SDK_VERSION,
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
      liveWechat: "blocked",
      liveWechatCLI: "blocked",
      trade: "blocked",
      sendMessage: "blocked",
      publishExternal: "blocked",
      computerUse: "needs_confirmation",
    },
    sensitiveActions: ["read_live_wechat", "run_live_wechat_cli", "trade", "send_message", "publish_external"],
    defaultBoundary: "blocked_or_needs_confirmation",
  });
  return true;
}

function toolsForSkill(skillID) {
  switch (skillID) {
    case "wechat-onchain-intelligence":
      return ["wechat.read_normalized_messages", "token.resolve_entities", "market.read_snapshot", "onchain.read_snapshot", "crystal.create_or_update", "proposal.create"];
    case "cmc-market-radar":
      return ["cmc.read_market_evidence", "market.read_snapshot", "crystal.create_or_update", "proposal.create"];
    case "market-regime-review":
      return ["cmc.detect_market_regime", "market.read_snapshot", "proposal.create"];
    case "social-price-divergence":
      return ["cmc.track_social_price_divergence", "market.read_snapshot", "proposal.create"];
    case "image-analysis":
      return ["image.analyze_with_kimi", "token.resolve_entities", "proposal.create"];
    case "long-task":
      return ["wechat.read_normalized_messages", "token.resolve_entities", "onchain.read_snapshot", "memory.save", "handoff.write"];
    case "handoff-writer":
      return ["handoff.write", "memory.save"];
    default:
      return [];
  }
}

function toolsForExtension(extensionID) {
  switch (extensionID) {
    case "wechat-cli-export-bridge":
      return ["wechat_cli.import_export_file", "wechat.read_normalized_messages", "token.resolve_entities"];
    case "cmc-skill-hub":
      return ["cmc.read_market_evidence", "market.read_snapshot"];
    case "local-memory":
      return ["memory.save"];
    case "handoff-writer":
      return ["handoff.write"];
    default:
      return [];
  }
}

function inferTools(prompt, selectedToolNames = [], attachments = [], selectedSkillIDs = [], selectedExtensionIDs = []) {
  const textValue = String(prompt || "").toLowerCase();
  const selected = new Set();
  for (const skillID of selectedSkillIDs) toolsForSkill(skillID).forEach((tool) => selected.add(tool));
  for (const extensionID of selectedExtensionIDs) toolsForExtension(extensionID).forEach((tool) => selected.add(tool));
  for (const legacyTool of selectedToolNames) {
    if (projectToolNames.includes(legacyTool)) selected.add(legacyTool);
  }
  if (attachments.length > 0) selected.add("image.analyze_with_kimi");
  if (/cmc|coinmarketcap|market regime|行情|价格|市场|大盘|price|流动性/.test(textValue)) {
    selected.add("cmc.read_market_evidence");
    selected.add("market.read_snapshot");
  }
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
  if (/computer use|computer|电脑|点击|操作电脑|控制桌面|mac ui/.test(textValue)) selected.add("computer_use.request");
  if (selected.size === 0) {
    selected.add("wechat.read_normalized_messages");
    selected.add("crystal.create_or_update");
    selected.add("proposal.create");
  }
  return [...selected];
}

function policyForTool(name) {
  if (blockedActions.has(name)) return "blocked";
  if (name === "wechat_cli.live_command") return "blocked";
  if (name === "cmc.request_mcp_refresh") return "needs_confirmation";
  if (name === "computer_use.request") return "needs_confirmation";
  if (localPassTools.has(name)) return "pass";
  return "needs_confirmation";
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
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
      "do not run live WeChat or live wechat-cli",
      "do not trade, send messages, or publish externally",
      "API keys are read from environment only",
      "raw request bodies and authorization headers are not persisted",
    ],
    selectedSkills: selectedSkillIDs,
    selectedExtensions: selectedExtensionIDs,
    publicSurfaceOnly: true,
    capabilitiesNeeded: [
      { capabilityId: "planner-runtime", reason: "Build auditable task plan.", loadMode: "always_on", contextCost: "low" },
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
        temperature: 0.2,
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

async function streamProviderToEvents(providerResult, runDir, runID = null, taskID = null) {
  if (providerResult.status !== "streaming") {
    appendEvent(runDir, { type: "model.blocked", runID, taskID, stage: "model_route", status: providerResult.status, reason: providerResult.reason, provider: providerResult.provider, model: providerResult.model, errorPreview: providerResult.errorPreview });
    return "";
  }
  let finalText = "";
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
          appendEvent(runDir, { type: "assistant.delta", runID, taskID, stage: "model_stream", delta, provider: providerResult.provider, model: providerResult.model });
        }
      } catch {
        appendEvent(runDir, { type: "assistant.delta.raw", runID, taskID, stage: "model_stream", delta: redact(data), provider: providerResult.provider, model: providerResult.model });
      }
    }
  }
  return finalText;
}

function deterministicAssistantText(prompt, tools, policies, attachments, selectedSkillIDs = [], selectedExtensionIDs = []) {
  const blocked = policies.filter((item) => item.status !== "pass");
  const lines = [
    "我已通过本地 Agent Runtime Host 把这次请求整理为一个可追踪任务。",
    "",
    `目标：${prompt}`,
    `已选择 Skill：${selectedSkillIDs.length ? selectedSkillIDs.join(", ") : "自动判断"}`,
    `已选择 Extension：${selectedExtensionIDs.length ? selectedExtensionIDs.join(", ") : "自动判断"}`,
    attachments.length > 0 ? `图片附件：${attachments.length} 个，已写入本地附件 artifact；视觉分析需要 Kimi provider 配置。` : "图片附件：无。",
    blocked.length > 0 ? `需要确认/阻断：${blocked.map((item) => `${item.action}:${item.status}`).join(", ")}` : "权限：本地读写工具均可执行。",
    "",
    "下一步建议：在 Inspector 查看 policy/tool/model-route artifact，再决定是否生成 Crystal、Proposal、Memory 或 Handoff。",
  ];
  return lines.join("\n");
}

async function runAgentTask({ session, prompt, selectedToolNames = [], selectedSkillIDs = [], selectedExtensionIDs = [], attachments = [], contextRefs = [], runID = safeId("run"), taskID = safeId("task") }) {
  const runDir = safeRunDir(runID);
  writeControlState(runDir, "running");
  const inferredTools = inferTools(prompt, selectedToolNames, attachments, selectedSkillIDs, selectedExtensionIDs);
  let piStatus = { initialized: false, lastError: null };
  try {
    await piRuntime.ensure();
    piStatus = piRuntime.status();
  } catch (error) {
    piStatus = { ...piRuntime.status(), lastError: redact(error?.stack || error?.message || error) };
  }

  const controlPlane = buildControlPlane({
    projectRoot,
    runDir,
    runID,
    taskID,
    sessionID: session.sessionID,
    prompt,
    selectedSkillIDs,
    selectedExtensionIDs,
    attachments,
    contextRefs,
    tools: inferredTools,
    policyForTool,
    providerReadiness: providerReadiness(),
    piStatus,
  });
  const tools = controlPlane.tools;
  const policies = controlPlane.policyDecisions;
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
      artifactRef(runID, "control-plane-manifest.json", "control", "control"),
      artifactRef(runID, "task-intent.json", "control", "intent"),
      artifactRef(runID, "execution-profile.json", "control", "profile"),
      artifactRef(runID, "planner-envelope.json", "control", "planner"),
      artifactRef(runID, "tool-intent-plan.json", "control", "tool_plan"),
      artifactRef(runID, "context-manifest.json", "context", "context"),
      artifactRef(runID, "context-bundle.json", "context", "context"),
      artifactRef(runID, "retrieval-plan.json", "context", "context"),
      artifactRef(runID, "context-gate.json", "context", "context_gate"),
      artifactRef(runID, "policy-decisions.json", "policy", "policy"),
      artifactRef(runID, "approval-decisions.json", "approval", "approval"),
      artifactRef(runID, "model-route.json", "model", "model_route"),
      artifactRef(runID, "qa-gate.json", "qa", "qa"),
      artifactRef(runID, "runtime-metrics.json", "metrics", "metrics"),
      artifactRef(runID, "checkpoint.json", "checkpoint", "checkpoint"),
      artifactRef(runID, "retry-ledger.json", "retry", "retry"),
      artifactRef(runID, "tool-calls.json", "tool_calls", "tool_execution"),
      artifactRef(runID, "final-output.md", "final_output", "final_output"),
    ],
    redactionStatus: "summary_only",
  });

  writeJSON(join(runDir, "attachments.json"), attachments);
  appendEvent(runDir, { type: "run.started", runID, taskID, sessionID: session.sessionID, stage: "start", status: "running", artifactKind: "run_manifest", artifactPath: `runtime/agent/runs/${runID}/run-manifest.json` });
  appendEvent(runDir, { type: "control_plane.manifest.created", runID, taskID, stage: "control", status: "completed", artifactKind: "control_manifest", artifactPath: `runtime/agent/runs/${runID}/control-plane-manifest.json` });
  appendEvent(runDir, { type: "task.intent.created", runID, taskID, stage: "intent", status: controlPlane.taskIntent.taskType, artifactKind: "task_intent", artifactPath: `runtime/agent/runs/${runID}/task-intent.json` });
  appendEvent(runDir, { type: "context_plane.bundle.created", runID, taskID, stage: "context", status: controlPlane.contextGate.status, reason: controlPlane.contextGate.reason, artifactKind: "context_bundle", artifactPath: `runtime/agent/runs/${runID}/context-bundle.json`, contextSourceCount: contextSummary.sourceCount, contextChunkCount: contextSummary.chunkCount });
  appendEvent(runDir, { type: "planner.envelope.created", runID, taskID, stage: "planner", status: "completed", artifactKind: "planner", artifactPath: `runtime/agent/runs/${runID}/planner-envelope.json` });
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
    if (policy !== "pass") {
      toolCalls.push({
        ...baseCall,
        status: policy === "blocked" ? "blocked" : "waitingForApproval",
        outputSummary: policy === "blocked"
          ? `No execution performed; ${toolName} is blocked by policy.`
          : `No execution performed; ${toolName} requires confirmation.`,
      });
      appendEvent(runDir, { type: "tool.call.skipped", runID, taskID, stage: "tool_execution", action: toolName, actionIntent: policyDecision?.actionIntent, riskLevel: policyDecision?.riskLevel, toolName, status: policy, permission: policy });
      continue;
    }
    try {
      const result = await piRuntime.executeTool(toolName, {
        runID,
        sessionID: session.sessionID,
        prompt,
        idempotencyKey: `${toolName}:${runID}`,
        contextRefs,
        contextManifestRef: `runtime/agent/runs/${runID}/context-manifest.json`,
        contextBundleRef: `runtime/agent/runs/${runID}/context-bundle.json`,
      });
      const detailsArtifactPath = writeToolDetails(runDir, baseCall.id, toolName, result);
      toolCalls.push({
        ...baseCall,
        status: result.status === "blocked_missing_provider_config" ? "blocked" : result.status === "needs_confirmation" ? "waitingForApproval" : result.status || "completed",
        outputSummary: summarizeToolResult(toolName, result),
        detailsArtifactPath,
        redactionStatus: "redacted_summary_only",
      });
    } catch (error) {
      const detailsArtifactPath = writeToolDetails(runDir, baseCall.id, toolName, { status: "failed", details: { error: redact(error?.stack || error?.message || error) } });
      toolCalls.push({
        ...baseCall,
        status: "failed",
        outputSummary: redact(error?.stack || error?.message || error),
        detailsArtifactPath,
        redactionStatus: "redacted_error_summary",
      });
    }
  }
  writeJSON(join(runDir, "tool-calls.json"), toolCalls);
  for (const call of toolCalls) appendEvent(runDir, { type: "tool.call", runID, taskID, stage: "tool_execution", action: call.toolName, artifactKind: "tool_calls", ...call });

  let finalText = "";
  const shouldCallLive = process.env.WECHAT_AGENT_MOCK_PROVIDER !== "1";
  if (shouldCallLive) {
    const providerResult = await callOpenAICompatible({
      providerName: "deepseek",
      stream: true,
      messages: [
        { role: "system", content: readFileSync(join(agentRuntimeRoot, "prompts", "agent-system.md"), "utf8") },
        { role: "user", content: `User prompt:\n${prompt}\n\nSelected skills:\n${selectedSkillIDs.join(", ")}\n\nSelected extensions:\n${selectedExtensionIDs.join(", ")}\n\nContext bundle artifact:\nruntime/agent/runs/${runID}/context-bundle.json\n\nContext bundle summary:\n${String(controlPlane.contextBundle.modelContext || "").slice(0, 4000)}` },
      ],
    });
    finalText = await streamProviderToEvents(providerResult, runDir, runID, taskID);
  }
  if (!finalText.trim()) {
    finalText = deterministicAssistantText(prompt, tools, policies, attachments, selectedSkillIDs, selectedExtensionIDs);
    for (const segment of finalText.match(/.{1,80}(\s|$)/g) || [finalText]) {
      appendEvent(runDir, { type: "assistant.delta", runID, taskID, stage: "model_stream", delta: segment });
    }
  }

  writeFileSync(join(runDir, "final-output.md"), `${finalText}\n`, "utf8");
  writeJSON(join(runDir, "runtime-metrics.json"), {
    ...controlPlane.runtimeMetrics,
    completedAt: now(),
    toolCallCount: toolCalls.length,
    completedToolCallCount: toolCalls.filter((call) => call.status === "completed").length,
    blockedToolCallCount: toolCalls.filter((call) => call.status === "blocked").length,
    waitingForApprovalToolCallCount: toolCalls.filter((call) => call.status === "waitingForApproval").length,
    failedToolCallCount: toolCalls.filter((call) => call.status === "failed").length,
    finalOutputBytes: Buffer.byteLength(finalText, "utf8"),
  });
  writeJSON(join(runDir, "checkpoint.json"), {
    ...controlPlane.checkpoint,
    status: "completed",
    currentStage: "final_output",
    completedStages: controlPlane.executionProfile.requiredStages,
    remainingStages: [],
    updatedAt: now(),
  });
  writeRunManifest(runDir, {
    ...readJSON(runManifestPath(runDir), {}),
    status: "completed",
    currentStage: "final_output",
    completedAt: now(),
    finalOutputPath: `runtime/agent/runs/${runID}/final-output.md`,
    toolCallCount: toolCalls.length,
    contextSummary,
    controlSummary: {
      ...controlSummary,
      stage: "completed",
      updatedAt: now(),
    },
  });
  appendEvent(runDir, { type: "run.completed", runID, taskID, stage: "final_output", status: "completed", artifactKind: "final_output", artifactPath: `runtime/agent/runs/${runID}/final-output.md` });

  const assistantMessage = {
    id: safeId("msg"),
    role: "assistant",
    content: [{ type: "text", text: finalText }],
    runID,
    createdAt: now(),
  };
  session.messages.push(assistantMessage);
  session.activeRunID = runID;
  session.status = "completed";
  session.updatedAt = now();
  writeJSON(sessionPath(session.sessionID), session);

  const task = {
    taskID,
    sessionID: session.sessionID,
    runID,
    prompt,
    status: "completed",
    selectedToolNames: tools,
    selectedSkillIDs,
    selectedExtensionIDs,
    attachmentIDs: attachments.map((item) => item.attachmentID || item.id).filter(Boolean),
    artifactPath: `runtime/agent/runs/${runID}`,
    createdAt: envelope.createdAt,
    updatedAt: now(),
  };
  writeJSON(taskPath(taskID), task);
  writeOpsStatus(health(), {
    runID,
    taskID,
    status: "completed",
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
  };
  writeJSON(sessionPath(session.sessionID), session);
  return session;
}

async function postMessage(sessionID, body) {
  const existing = readJSON(sessionPath(sessionID));
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
  const result = await runAgentTask({
    session,
    prompt: userMessage.content[0].text,
    selectedToolNames: body.selectedToolNames || [],
    selectedSkillIDs: body.selectedSkillIDs || [],
    selectedExtensionIDs: body.selectedExtensionIDs || [],
    attachments: body.attachments || [],
    contextRefs: body.contextRefs || [],
  });
  return { ...result, message: userMessage };
}

async function postMessageAsync(sessionID, body) {
  const existing = readJSON(sessionPath(sessionID));
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
    selectedSkillIDs: body.selectedSkillIDs || [],
    selectedExtensionIDs: body.selectedExtensionIDs || [],
    attachmentIDs: (body.attachments || []).map((item) => item.attachmentID || item.id).filter(Boolean),
    artifactPath: `runtime/agent/runs/${runID}`,
    createdAt: now(),
    updatedAt: now(),
  };
  safeRunDir(runID);
  writeControlState(safeRunDir(runID), "running");
  writeJSON(taskPath(taskID), task);
  setTimeout(() => {
    runAgentTask({
      session,
      prompt: userMessage.content[0].text,
      selectedToolNames: body.selectedToolNames || [],
      selectedSkillIDs: body.selectedSkillIDs || [],
      selectedExtensionIDs: body.selectedExtensionIDs || [],
      attachments: body.attachments || [],
      contextRefs: body.contextRefs || [],
      runID,
      taskID,
    }).catch((error) => {
      const runDir = safeRunDir(runID);
      appendEvent(runDir, { type: "run.failed", runID, taskID, stage: "failed", status: "failed", errorPreview: redact(error?.stack || error?.message || error) });
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

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, health());
    if (req.method === "GET" && url.pathname === "/capabilities") {
      return json(res, 200, publicSurface());
    }
    if (req.method === "POST" && url.pathname === "/sessions") {
      return json(res, 200, await createSession(await readBody(req)));
    }
    const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessionMatch) {
      const session = readJSON(sessionPath(sessionMatch[1]));
      return session ? json(res, 200, session) : json(res, 404, { error: "session_not_found" });
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
    text(res, 404, "not found\n");
  } catch (error) {
    json(res, 500, { error: "daemon_error", message: redact(error?.message || error) });
  }
}

async function smokeCheck() {
  ensureDirs();
  process.env.WECHAT_AGENT_MOCK_PROVIDER = process.env.WECHAT_AGENT_MOCK_PROVIDER || "1";
  await piRuntime.ensure();
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
  console.log("status=completed");
}

async function asyncSmokeCheck() {
  ensureDirs();
  process.env.WECHAT_AGENT_MOCK_PROVIDER = process.env.WECHAT_AGENT_MOCK_PROVIDER || "1";
  await piRuntime.ensure();
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
  console.log(`async_smoke=pass`);
  console.log(`runID=${response.runID}`);
  console.log(`taskID=${response.taskID}`);
  console.log(`eventsURL=${response.eventsURL}`);
  console.log(`artifactPath=${response.artifactPath}`);
}

async function startServer() {
  ensureDirs();
  try {
    await piRuntime.ensure();
  } catch (error) {
    console.error(`pi_runtime_init_degraded=${redact(error?.message || error)}`);
  }
  const server = createServer(handle);
  server.listen(port, host, () => {
    writeJSON(join(runtimeRoot, "daemon.pid"), { pid: process.pid, host, port, startedAt: daemonStartedAt, piRuntime: piRuntime.status() });
    console.log(`wechat-agent-daemon listening on http://${host}:${port}`);
  });
}

const daemonStartedAt = now();
ensureDirs();

if (process.argv.includes("--async-smoke-check")) {
  asyncSmokeCheck().catch((error) => {
    console.error(redact(error?.stack || error));
    process.exit(1);
  });
} else if (process.argv.includes("--smoke-check")) {
  smokeCheck().catch((error) => {
    console.error(redact(error?.stack || error));
    process.exit(1);
  });
} else {
  startServer().catch((error) => {
    console.error(redact(error?.stack || error));
    process.exit(1);
  });
}
