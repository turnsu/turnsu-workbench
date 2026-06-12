import { mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  VERSION as PI_SDK_VERSION,
} from "@earendil-works/pi-coding-agent";

export const PI_KERNEL_SDK_VERSION = PI_SDK_VERSION;

export function createPiBackedAgentRuntime(options = {}) {
  return new PiBackedAgentRuntime(options);
}

export function createPiKernelAdapter(piRuntime) {
  return new PiKernelAdapter(piRuntime);
}

export class PiBackedAgentRuntime {
  constructor({
    projectRoot,
    agentRuntimeRoot,
    piAgentDir,
    piExtensionPath,
    piSkillPath,
    piPromptPath,
    projectToolNames = [],
    discoverExtensionPaths = () => [],
    discoverExtensionPackages = () => [],
    now = () => new Date().toISOString(),
    redact = (value) => String(value || ""),
    safeId = (prefix) => `${prefix}-${Date.now()}`,
  } = {}) {
    this.projectRoot = projectRoot;
    this.agentRuntimeRoot = agentRuntimeRoot;
    this.piAgentDir = piAgentDir;
    this.piExtensionPath = piExtensionPath;
    this.piSkillPath = piSkillPath;
    this.piPromptPath = piPromptPath;
    this.projectToolNames = projectToolNames;
    this.discoverExtensionPaths = discoverExtensionPaths;
    this.discoverExtensionPackages = discoverExtensionPackages;
    this.now = now;
    this.redact = redact;
    this.safeId = safeId;
    this.session = null;
    this.extensionsResult = null;
    this.lastError = null;
    this.initializedAt = null;
  }

  async ensure() {
    if (this.session) return this;
    try {
      mkdirSync(this.piAgentDir, { recursive: true });
      const loader = new DefaultResourceLoader({
        cwd: this.projectRoot,
        agentDir: this.piAgentDir,
        additionalExtensionPaths: this.discoverExtensionPaths(),
        additionalSkillPaths: [this.piSkillPath],
        additionalPromptTemplatePaths: [this.piPromptPath],
        noContextFiles: true,
        systemPrompt: readFileSync(join(this.agentRuntimeRoot, "prompts", "agent-system.md"), "utf8"),
      });
      await loader.reload();
      const result = await createAgentSession({
        cwd: this.projectRoot,
        agentDir: this.piAgentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(this.projectRoot),
        tools: this.projectToolNames,
        noTools: "builtin",
        sessionStartEvent: {
          type: "session_start",
          cwd: this.projectRoot,
          sessionId: `wechat-agent-daemon-${process.pid}`,
        },
      });
      this.session = result.session;
      this.extensionsResult = result.extensionsResult;
      this.initializedAt = this.now();
      this.lastError = null;
      return this;
    } catch (error) {
      this.lastError = this.redact(error?.stack || error?.message || error);
      throw error;
    }
  }

  status() {
    const tools = this.session?.getAllTools?.() || [];
    const activeTools = this.session?.getActiveToolNames?.() || [];
    const projectToolSet = new Set(this.projectToolNames);
    return {
      backedBy: "@earendil-works/pi-coding-agent",
      sdkVersion: PI_SDK_VERSION,
      nodeVersion: process.version,
      requiredNodeVersion: ">=22.19.0",
      currentNodeSatisfiesDeclaredEngine: nodeSatisfiesPiEngine(process.version),
      initialized: Boolean(this.session),
      initializedAt: this.initializedAt,
      extensionPath: relative(this.projectRoot, this.piExtensionPath),
      extensionPackages: this.discoverExtensionPackages().map((item) => item.id),
      skillPath: relative(this.projectRoot, this.piSkillPath),
      promptPath: relative(this.projectRoot, this.piPromptPath),
      loadedExtensionCount: this.extensionsResult?.extensions?.length || 0,
      extensionErrors: this.extensionsResult?.errors || [],
      registeredTools: tools.map((tool) => tool.name).filter((name) => projectToolSet.has(name)),
      activeTools: activeTools.filter((name) => projectToolSet.has(name)),
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
      this.safeId("pi-tool"),
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

export class PiKernelAdapter {
  constructor(piRuntime) {
    if (!piRuntime) throw new Error("pi_kernel_missing_runtime");
    this.piRuntime = piRuntime;
  }

  async ensure() {
    return this.piRuntime.ensure();
  }

  status() {
    return {
      kernel: "pi",
      contractOwner: "Agent Runtime Core",
      ...this.piRuntime.status(),
    };
  }

  async executeTool(toolName, params) {
    return this.piRuntime.executeTool(toolName, params);
  }
}

export function nodeSatisfiesPiEngine(version) {
  const match = String(version || "").match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
}
