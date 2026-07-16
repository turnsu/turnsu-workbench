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
    createResourceLoader = (options) => new DefaultResourceLoader(options),
    createSession = createAgentSession,
    createSessionManager = (root) => SessionManager.inMemory(root),
    model,
    thinkingLevel,
    sessionOptions = {},
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
    this.createResourceLoader = createResourceLoader;
    this.createSession = createSession;
    this.createSessionManager = createSessionManager;
    this.model = model;
    this.thinkingLevel = thinkingLevel;
    this.sessionOptions = { ...sessionOptions };
    this.resourceLoader = null;
    this.session = null;
    this.extensionsResult = null;
    this.skillsResult = { skills: [], diagnostics: [] };
    this.skillDiagnostics = this.skillsResult.diagnostics;
    this.lastError = null;
    this.initializedAt = null;
  }

  async ensure() {
    if (this.session) return this;
    try {
      mkdirSync(this.piAgentDir, { recursive: true });
      const loader = this.createResourceLoader({
        cwd: this.projectRoot,
        agentDir: this.piAgentDir,
        additionalExtensionPaths: this.discoverExtensionPaths(),
        additionalSkillPaths: [this.piSkillPath],
        additionalPromptTemplatePaths: [this.piPromptPath],
        noSkills: true,
        noContextFiles: true,
        systemPrompt: readFileSync(join(this.agentRuntimeRoot, "prompts", "agent-system.md"), "utf8"),
      });
      this.resourceLoader = loader;
      await loader.reload();
      this.skillsResult = loader.getSkills?.() || { skills: [], diagnostics: [] };
      this.skillDiagnostics = this.skillsResult.diagnostics || [];
      const result = await this.createSession({
        ...this.sessionOptions,
        cwd: this.projectRoot,
        agentDir: this.piAgentDir,
        resourceLoader: loader,
        sessionManager: this.createSessionManager(this.projectRoot),
        tools: this.projectToolNames,
        noTools: "builtin",
        ...(this.model ? { model: this.model } : {}),
        ...(this.thinkingLevel ? { thinkingLevel: this.thinkingLevel } : {}),
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
    const loadedSkills = (this.skillsResult?.skills || []).map((skill) => skill.name).filter(Boolean);
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
      extensionErrors: (this.extensionsResult?.errors || []).map((item) => ({
        error: this.safeDiagnosticText(item?.error || item),
      })),
      loadedSkillCount: loadedSkills.length,
      loadedSkills,
      skillDiagnostics: this.skillDiagnostics.map((item) => ({
        type: item?.type || "warning",
        message: this.safeDiagnosticText(item?.message || item),
      })),
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

  safeDiagnosticText(value) {
    let text = this.redact(value?.stack || value?.message || value);
    for (const path of [this.projectRoot, this.agentRuntimeRoot, this.piAgentDir]) {
      if (path) text = text.replaceAll(path, "[path]");
    }
    return String(text || "runtime diagnostic").slice(0, 800);
  }

  skillReadiness(skillID) {
    const id = String(skillID || "").trim();
    const loaded = (this.skillsResult?.skills || []).some((skill) => skill.name === id);
    const bound = Boolean(this.session && typeof this.session.prompt === "function");
    const ready = loaded && bound;
    return {
      skillID: id,
      status: ready ? "ready" : "blocked",
      ready,
      code: ready
        ? "pi_skill_loaded_and_bound"
        : !loaded
          ? "pi_skill_not_loaded"
          : "pi_skill_session_not_bound",
    };
  }

  async invokeSkill(skillOrRequest, input, options = {}) {
    const request = typeof skillOrRequest === "object" && skillOrRequest !== null
      ? skillOrRequest
      : { skillID: skillOrRequest, input, ...options };
    const skillID = String(request.skillID || "").trim();
    await this.ensure();
    const readiness = this.skillReadiness(skillID);
    if (!readiness.ready) throw new Error(`pi_skill_not_ready:${skillID || "missing"}`);
    if (this.session.isStreaming) throw new Error(`pi_skill_session_busy:${skillID}`);

    const messagesBefore = this.session.messages?.length || 0;
    const command = buildSkillCommand(skillID, request.input);
    try {
      await this.session.prompt(command, request.promptOptions);
    } catch (error) {
      this.lastError = this.safeDiagnosticText(error);
      const invocationError = new Error(`pi_skill_invocation_failed:${skillID}`);
      invocationError.cause = error;
      throw invocationError;
    }

    const output = assistantTextAfter(this.session.messages || [], messagesBefore);
    return {
      schemaVersion: "pi-skill-invocation-v1",
      skillID,
      status: "completed",
      outputSummary: this.safeInvocationOutput(output || `Skill ${skillID} completed.`),
      details: {
        executionMode: "pi_skill_session",
        loadedAndBound: true,
      },
    };
  }

  safeInvocationOutput(value) {
    let text = this.safeDiagnosticText(value)
      .replace(/(authorization|api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
    if (text.length > 2000) text = `${text.slice(0, 1999)}…`;
    return text;
  }

  async executeTool(toolName, params, options = {}) {
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
      options.signal,
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

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("pi_event_listener_required");
    if (!this.session || typeof this.session.subscribe !== "function") {
      throw new Error("pi_session_not_initialized");
    }
    return this.session.subscribe(listener);
  }

  async compact(instructions) {
    await this.ensure();
    if (typeof this.session.compact !== "function") throw new Error("pi_compaction_unavailable");
    return this.session.compact(instructions);
  }

  async abort() {
    if (!this.session || typeof this.session.abort !== "function") return;
    await this.session.abort();
  }

  async dispose() {
    const session = this.session;
    this.session = null;
    this.extensionsResult = null;
    if (!session) return;
    if (session.isStreaming && typeof session.abort === "function") await session.abort();
    await Promise.resolve(session.dispose?.());
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

  skillReadiness(skillID) {
    return this.piRuntime.skillReadiness(skillID);
  }

  async invokeSkill(skillOrRequest, input, options = {}) {
    return this.piRuntime.invokeSkill(skillOrRequest, input, options);
  }

  async executeTool(toolName, params, options = {}) {
    return this.piRuntime.executeTool(toolName, params, options);
  }

  subscribe(listener) {
    return this.piRuntime.subscribe(listener);
  }

  async compact(instructions) {
    return this.piRuntime.compact(instructions);
  }

  async abort() {
    return this.piRuntime.abort();
  }

  async dispose() {
    return this.piRuntime.dispose();
  }
}

export function nodeSatisfiesPiEngine(version) {
  const match = String(version || "").match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
}

function buildSkillCommand(skillID, input) {
  if (input === undefined || input === null || input === "") return `/skill:${skillID}`;
  const serialized = typeof input === "string" ? input : JSON.stringify(input);
  return `/skill:${skillID} ${serialized}`;
}

function assistantTextAfter(messages, startIndex) {
  return messages
    .slice(startIndex)
    .filter((message) => message?.role === "assistant")
    .flatMap((message) => Array.isArray(message.content) ? message.content : [message.content])
    .map((part) => typeof part === "string" ? part : part?.type === "text" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}
