#!/usr/bin/env node
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
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

// Live WeChat read (run_live_wechat_cli / read_live_wechat) is user-authorized on this device
// via the local wechat-cli (read-only). Trade / send / external-publish stay blocked.
const blockedActions = new Set(["trade", "send_message", "publish_external"]);
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
      liveWechat: "local",
      liveWechatCLI: "local",
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
      liveWechat: "local",
      liveWechatCLI: "local",
      trade: "blocked",
      sendMessage: "blocked",
      publishExternal: "blocked",
      computerUse: "needs_confirmation",
    },
    sensitiveActions: ["trade", "send_message", "publish_external"],
    defaultBoundary: "local_read_or_needs_confirmation",
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
  // Live WeChat read via local wechat-cli is user-authorized (read-only, on-device).
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
      "live WeChat read via local wechat-cli is permitted (user-authorized, read-only, on-device)",
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
  const liveWechat = maybeRefreshLiveWechatForRun(tools);
  const strategyTaskType = maybeWriteStrategyResult(runDir, runID, prompt, selectedSkillIDs);
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
        { role: "user", content: `User prompt:\n${prompt}\n\nSelected skills:\n${selectedSkillIDs.join(", ")}\n\nSelected extensions:\n${selectedExtensionIDs.join(", ")}\n\nContext bundle artifact:\nruntime/agent/runs/${runID}/context-bundle.json\n\nContext bundle summary:\n${String(controlPlane.contextBundle.modelContext || "").slice(0, 4000)}${liveWechat?.contextText || ""}` },
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
  const { cmd, baseArgs } = resolveWechatCliCommand();
  let res;
  try {
    res = spawnSync(cmd, [...baseArgs, ...args, "--format", "json"], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
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

// When an agent run reads WeChat and live is enabled, pull fresh local messages and return a
// compact, read-only context block to inject into the model prompt (so the agent reasons over
// real recent WeChat data). Falls back silently to fixtures when not initialized/disabled.
function maybeRefreshLiveWechatForRun(tools) {
  if (!wechatLiveEnabled()) return null;
  if (!Array.isArray(tools) || !tools.includes("wechat.read_normalized_messages")) return null;
  const result = refreshWechatLive({ sessionLimit: 8, perChatLimit: 12 });
  if (result.status !== "ok") {
    return { status: result.status, summary: `实时微信未读取（${result.reason || result.status}）；使用本地样例数据。`, contextText: "" };
  }
  try {
    const livePath = join(projectRoot, "runtime", "wechat", "messages.live.json");
    const data = JSON.parse(readFileSync(livePath, "utf8"));
    const msgs = (data.messages || []).slice(-40);
    const lines = msgs.map((m) => `- [${m.groupName}] ${m.sender}: ${String(m.excerpt || m.title || "").slice(0, 120)}`);
    const contextText = lines.length
      ? `\n\n实时微信消息（本机 wechat-cli 只读，最近 ${lines.length} 条）:\n${lines.join("\n")}`
      : "";
    return { status: "ok", count: msgs.length, summary: `已读取实时微信 ${result.messages} 条消息 / ${result.sessions} 个会话。`, contextText };
  } catch (error) {
    return { status: "read_failed", summary: "实时微信文件读取失败；使用本地样例数据。", contextText: "" };
  }
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

function maybeWriteStrategyResult(runDir, runID, prompt, selectedSkillIDs) {
  const taskType = detectStrategistTaskType(prompt, selectedSkillIDs);
  if (!taskType) return null;
  const model = STRATEGIST_FIXTURES[taskType];
  if (!model) return null;
  const withRun = JSON.parse(JSON.stringify(model).replaceAll("{runID}", runID));
  writeJSON(join(runDir, "cmc-strategist-result.json"), {
    schemaVersion: "cmc-skill-hub-result-v1",
    runID,
    provider: "fixtureProvider",
    skillName: taskType,
    strategyReadModel: withRun,
    generatedAt: now(),
  });
  return taskType;
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${host}:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, health());
    if (req.method === "GET" && url.pathname === "/capabilities") {
      return json(res, 200, publicSurface());
    }
    if (req.method === "POST" && url.pathname === "/wechat/live/refresh") {
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, refreshWechatLive(body || {}));
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

if (process.argv.includes("--wechat-live-refresh")) {
  const result = refreshWechatLive({});
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === "ok" || result.status === "empty" ? 0 : 1);
} else if (process.argv.includes("--async-smoke-check")) {
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
