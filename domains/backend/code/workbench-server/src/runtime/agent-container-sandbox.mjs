import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildContainerIsolationArguments,
  DIGEST_PINNED_CONTAINER_IMAGE,
} from "./container-sandbox-policy.mjs";
import {
  createProductExecutionGrant,
  productToolEffectMap,
} from "./product-execution-grant.mjs";

export const AGENT_SANDBOX_RUNTIME_VERSIONS = Object.freeze({
  pi: "0.85.1",
  subagent: "0.4.8",
  workflow: "0.10.1",
});
export const AGENT_SANDBOX_OWNER_LABEL = "com.looloomi.workbench.agent-sandbox";
export const AGENT_SANDBOX_OWNER_VALUE = "v1";
export const AGENT_SANDBOX_INVOCATION_LABEL = "com.looloomi.workbench.agent-invocation";

const DEFAULT_LIMITS = Object.freeze({
  pids: 128,
  memoryBytes: 512 * 1024 * 1024,
  cpus: 1,
  tmpfsBytes: 64 * 1024 * 1024,
  maxStdoutBytes: 64 * 1024 * 1024,
  maxStderrBytes: 128 * 1024,
  maxArtifactFiles: 64,
});

export class AgentContainerSandboxError extends Error {
  constructor(code, message = "The required Agent sandbox is unavailable.", { status = "sandbox_unavailable" } = {}) {
    super(message);
    this.name = "AgentContainerSandboxError";
    this.code = code;
    this.status = status;
    this.productSafe = true;
  }
}

export class AgentContainerSandbox {
  #image;
  #gatewayServer;
  #approvalServer;
  #dockerBinary;
  #dockerEnvironment;
  #spawnProcess;
  #dockerControl;
  #tempRoot;
  #limits;
  #transcriptArtifactService;
  #requireTranscriptArtifact;

  constructor({
    image,
    gatewayServer,
    approvalServer = null,
    dockerBinary = "docker",
    dockerEnvironment = defaultDockerEnvironment(),
    spawnProcess = spawn,
    dockerControl,
    tempRoot = join(tmpdir(), "looloomi-agent-sandbox"),
    limits = {},
    transcriptArtifactService = null,
    requireTranscriptArtifact = false,
  } = {}) {
    if (!DIGEST_PINNED_CONTAINER_IMAGE.test(image || "")) throw new TypeError("agent_sandbox_digest_pinned_image_required");
    if (!gatewayServer?.open || typeof spawnProcess !== "function" || typeof tempRoot !== "string"
      || (approvalServer !== null && typeof approvalServer?.open !== "function")) {
      throw new TypeError("agent_sandbox_dependencies_invalid");
    }
    if (transcriptArtifactService !== null && typeof transcriptArtifactService?.commit !== "function") {
      throw new TypeError("worker_transcript_artifact_service_invalid");
    }
    if (typeof requireTranscriptArtifact !== "boolean") throw new TypeError("worker_transcript_requirement_invalid");
    this.#image = image;
    this.#gatewayServer = gatewayServer;
    this.#approvalServer = approvalServer;
    this.#dockerBinary = dockerBinary;
    this.#dockerEnvironment = Object.freeze({ ...dockerEnvironment });
    this.#spawnProcess = spawnProcess;
    this.#dockerControl = dockerControl ?? ((args) => runControl({
      dockerBinary,
      dockerEnvironment: this.#dockerEnvironment,
      spawnProcess,
      args,
    }));
    this.#tempRoot = tempRoot;
    this.#limits = validateLimits({ ...DEFAULT_LIMITS, ...limits });
    this.#transcriptArtifactService = transcriptArtifactService;
    this.#requireTranscriptArtifact = requireTranscriptArtifact;
  }

  async probe() {
    if (this.#requireTranscriptArtifact && !this.#transcriptArtifactService) {
      throw new AgentContainerSandboxError(
        "worker_transcript_storage_unavailable",
        "Governed Worker transcript storage is unavailable.",
        { status: "blocked" },
      );
    }
    try {
      const result = await this.#dockerControl([
        "image", "inspect", "--format", "{{json .Config.Labels}}", this.#image,
      ]);
      if (result?.code !== 0) throw new Error("image_missing");
      const labels = JSON.parse(result.stdout.trim());
      if (labels?.["com.looloomi.pi.version"] !== AGENT_SANDBOX_RUNTIME_VERSIONS.pi
        || labels?.["com.looloomi.pi-subagent.version"] !== AGENT_SANDBOX_RUNTIME_VERSIONS.subagent
        || labels?.["com.looloomi.pi-workflow.version"] !== AGENT_SANDBOX_RUNTIME_VERSIONS.workflow) {
        throw new Error("image_version_mismatch");
      }
      return { available: true, runtimeVersions: AGENT_SANDBOX_RUNTIME_VERSIONS };
    } catch {
      throw unavailable();
    }
  }

  async run({ request, lease, signal, emit, checkpoint, reportChild }) {
    validateRequest(request, lease);
    await this.probe();
    let root = null;
    let endpoint = null;
    const gatewaySessions = new Map();
    const approvalSessions = new Map();
    let containerName = null;
    try {
      await mkdir(this.#tempRoot, { recursive: true, mode: 0o700 });
      root = await mkdtemp(join(this.#tempRoot, "execution-"));
      const outputRoot = join(root, "output");
      await mkdir(outputRoot, { mode: 0o777 });
      endpoint = await this.#gatewayServer.open({
        invocationId: request.invocationId,
        attemptId: request.attemptId,
        capabilityLeaseId: lease.capabilityLeaseId,
      });
      if (!endpoint || typeof endpoint.handle !== "function" || typeof endpoint.close !== "function") {
        throw new AgentContainerSandboxError("agent_gateway_session_invalid", "Agent gateway session is invalid.", { status: "blocked" });
      }
      gatewaySessions.set(lease.capabilityLeaseId, endpoint);
      if (this.#approvalServer) {
        const approvalEndpoint = await this.#approvalServer.open({
          invocationId: request.invocationId,
          attemptId: request.attemptId,
          capabilityLeaseId: lease.capabilityLeaseId,
        });
        if (!approvalEndpoint || typeof approvalEndpoint.handle !== "function" || typeof approvalEndpoint.close !== "function") {
          throw new AgentContainerSandboxError("agent_approval_session_invalid", "Agent approval session is invalid.", { status: "blocked" });
        }
        approvalSessions.set(lease.capabilityLeaseId, approvalEndpoint);
      }
      const payload = containerPayload(request, lease);
      containerName = containerNameFor(request.invocationId, request.attemptId);
      const args = buildAgentContainerArguments({
        image: this.#image,
        containerName,
        invocationId: request.invocationId,
        outputRoot,
        limits: { ...this.#limits, timeoutMs: request.limits.timeoutMs, maxOutputBytes: request.limits.maxOutputBytes },
      });
      const result = await executeAgentContainer({
        dockerBinary: this.#dockerBinary,
        dockerEnvironment: this.#dockerEnvironment,
        spawnProcess: this.#spawnProcess,
        dockerControl: this.#dockerControl,
        args,
        containerName,
        invocationId: request.invocationId,
        payload,
        gatewaySessions,
        approvalSessions,
        openChildGateway: async (binding) => {
          validateGatewayBinding(binding);
          const existing = gatewaySessions.get(binding.capabilityLeaseId);
          if (existing) return existing;
          const childEndpoint = await this.#gatewayServer.open(binding);
          if (!childEndpoint || typeof childEndpoint.handle !== "function" || typeof childEndpoint.close !== "function") {
            throw new AgentContainerSandboxError("agent_gateway_session_invalid", "Agent gateway session is invalid.", { status: "blocked" });
          }
          gatewaySessions.set(binding.capabilityLeaseId, childEndpoint);
          if (this.#approvalServer) {
            const childApprovalEndpoint = await this.#approvalServer.open(binding);
            if (!childApprovalEndpoint || typeof childApprovalEndpoint.handle !== "function" || typeof childApprovalEndpoint.close !== "function") {
              throw new AgentContainerSandboxError("agent_approval_session_invalid", "Agent approval session is invalid.", { status: "blocked" });
            }
            approvalSessions.set(binding.capabilityLeaseId, childApprovalEndpoint);
          }
          return childEndpoint;
        },
        emit: (type, payload) => {
          if (request.metadata?.agentKind === "builder_proposal"
            && request.metadata?.objectKind === "staged_loop"
            && type === "agent.kernel.model_visible") {
            const session = payload?.modelVisibleEvent?.session;
            if (session?.sessionId !== request.lineage?.sessionId || session?.branchId !== null) {
              throw new AgentContainerSandboxError("builder_worker_session_mismatch", "The proposal Worker returned an unrelated session event.", { status: "permission_denied" });
            }
            // Standalone proposals retain their events on the execution that owns
            // them. Only actual Agent Session events enter the chat projection.
            return emit?.("agent.builder.model_visible", payload);
          }
          return emit?.(type, payload);
        },
        checkpoint,
        reportChild,
        signal,
        timeoutMs: request.limits.timeoutMs,
        maxStdoutBytes: this.#limits.maxStdoutBytes,
        maxStderrBytes: this.#limits.maxStderrBytes,
      });
      await verifyArtifactOutput(outputRoot, {
        maxBytes: request.limits.maxOutputBytes,
        maxFiles: this.#limits.maxArtifactFiles,
      });
      const transcriptRef = await persistWorkerTranscript({
        service: this.#transcriptArtifactService,
        request,
        transcript: result.workerTranscript,
        signal,
      });
      const route = aggregateModelRoute(gatewaySessions.values());
      return sanitizeBackendResult({
        ...result,
        ...(transcriptRef ? {
          evidence: [
            ...(Array.isArray(result.evidence) ? result.evidence : []),
            { kind: "worker_transcript", ref: `worker-transcript:${transcriptRef.transcriptArtifactId}` },
          ],
        } : {}),
        requestedModelRevisionId: route.requestedModelRevisionId ?? null,
        actualModelRevisionId: route.actualModelRevisionId ?? null,
        usage: {
          ...result.usage,
          ...route.usage,
          // Local Worker steps can exceed remote gateway calls.
          steps: Math.max(result.usage?.steps ?? 0, route.usage.steps),
        },
      });
    } finally {
      if (containerName) await cleanupContainer(this.#dockerControl, containerName, request.invocationId).catch(() => {});
      await Promise.allSettled([...gatewaySessions.values()].map((session) => session.close()));
      await Promise.allSettled([...approvalSessions.values()].map((session) => session.close()));
      if (root) {
        await chmod(join(root, "output"), 0o700).catch(() => {});
        await rm(root, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async scavenge() {
    try {
      const listed = await this.#dockerControl([
        "container", "ls", "--all",
        "--filter", `label=${AGENT_SANDBOX_OWNER_LABEL}=${AGENT_SANDBOX_OWNER_VALUE}`,
        "--format", "{{.Names}}",
      ]);
      if (listed?.code !== 0) return { available: false, containersRemoved: 0, directoriesRemoved: 0 };
      let containersRemoved = 0;
      for (const name of listed.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        if (!name.startsWith("looloomi-agent-")) continue;
        if (await cleanupContainer(this.#dockerControl, name)) containersRemoved += 1;
      }
      let directoriesRemoved = 0;
      let entries = [];
      try { entries = await readdir(this.#tempRoot, { withFileTypes: true }); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("execution-")) continue;
        await rm(join(this.#tempRoot, entry.name), { recursive: true, force: true });
        directoriesRemoved += 1;
      }
      return { available: true, containersRemoved, directoriesRemoved };
    } catch {
      return { available: false, containersRemoved: 0, directoriesRemoved: 0 };
    }
  }
}

export function createAgentContainerBackend({ sandbox } = {}) {
  if (!sandbox?.run) throw new TypeError("agent_container_sandbox_required");
  return Object.freeze({
    async probe() {
      if (typeof sandbox.probe !== "function") {
        return { available: true, verified: false };
      }
      return sandbox.probe();
    },
    execute({ request, lease, signal, emit, checkpoint, reportChild }) {
      return sandbox.run({ request, lease, signal, emit, checkpoint, reportChild });
    },
  });
}

export function buildAgentContainerArguments({
  image,
  containerName,
  invocationId,
  outputRoot,
  limits,
} = {}) {
  if (!DIGEST_PINNED_CONTAINER_IMAGE.test(image || "")
    || ![outputRoot, invocationId].every((value) => typeof value === "string" && value.length > 0)) {
    throw new TypeError("agent_container_arguments_invalid");
  }
  const checked = validateLimits({ ...DEFAULT_LIMITS, ...limits });
  return [
    ...buildContainerIsolationArguments({
      containerName,
      labels: [
        `${AGENT_SANDBOX_OWNER_LABEL}=${AGENT_SANDBOX_OWNER_VALUE}`,
        `${AGENT_SANDBOX_INVOCATION_LABEL}=${invocationId}`,
      ],
      limits: checked,
      tmpfsBytes: checked.tmpfsBytes,
      fileSizeBytes: checked.maxOutputBytes,
      interactive: true,
    }),
    "--env", "HOME=/tmp",
    "--env", "HTTP_PROXY=",
    "--env", "HTTPS_PROXY=",
    "--env", "NO_PROXY=",
    "--env", "http_proxy=",
    "--env", "https_proxy=",
    "--env", "no_proxy=",
    "--mount", `type=bind,src=${outputRoot},dst=/work/output`,
    "--workdir", "/work/output",
    image,
    "node", "/opt/looloomi-agent/worker/worker.mjs",
  ];
}

function containerPayload(request, lease) {
  const safeMetadataKeys = new Set([
    "outerNodeId", "definitionId", "responseFormat", "agentSessionId", "agentTurnId",
    "objectKind", "objectId", "branchId", "proposalKind", "toolApprovalResume",
  ]);
  return {
    schemaVersion: request.schemaVersion,
    invocationId: request.invocationId,
    attemptId: request.attemptId,
    mode: request.mode,
    goal: request.goal,
    input: structuredClone(request.input),
    limits: structuredClone(request.limits),
    capabilities: structuredClone(request.capabilities),
    resultSchema: structuredClone(request.resultSchema),
    evidenceRequirements: structuredClone(request.evidenceRequirements),
    metadata: Object.fromEntries(Object.entries(request.metadata ?? {}).filter(([key]) => safeMetadataKeys.has(key))),
    ...(request.mode === "bounded_agent" ? {
      agentKernel: {
        profileId: "product-pi",
        profileRevision: "product-pi-first-party-v1",
      },
    } : {}),
    runtimeVersions: AGENT_SANDBOX_RUNTIME_VERSIONS,
    gateway: {
      transport: "stdio-jsonl-v1",
      capabilityLeaseId: lease.capabilityLeaseId,
    },
    executionGrant: createProductExecutionGrant({
      invocationId: request.invocationId,
      capabilityLeaseId: lease.capabilityLeaseId,
      expiresAt: lease.expiresAt,
      capabilities: request.capabilities,
      maxToolCalls: request.limits.maxSteps,
      scopeRef: request.lineage?.sessionId ?? request.invocationId,
    }),
    toolEffects: productToolEffectMap(request.capabilities),
  };
}

const MAX_PROTOCOL_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;

async function executeAgentContainer({
  dockerBinary, dockerEnvironment, spawnProcess, dockerControl, args, containerName, invocationId,
  payload, gatewaySessions, approvalSessions, openChildGateway, emit, checkpoint, reportChild, signal, timeoutMs, maxStdoutBytes, maxStderrBytes,
}) {
  let child;
  try {
    child = spawnProcess(dockerBinary, args, { env: dockerEnvironment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch {
    throw unavailable();
  }
  if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.once !== "function") throw unavailable();
  let stdoutBuffer = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminalError = null;
  let terminalResult = null;
  let transcriptDraft = null;
  let terminalTranscript = null;
  let writeChain = Promise.resolve();
  const pending = new Set();
  const terminate = (error) => {
    if (terminalError) return;
    terminalError = error;
    child.kill?.("SIGKILL");
    void cleanupContainer(dockerControl, containerName, invocationId).catch(() => {});
  };
  const send = (frame) => {
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (bytes.byteLength > MAX_PROTOCOL_FRAME_BYTES) return Promise.reject(protocolError());
    writeChain = writeChain.then(() => writeStream(child.stdin, bytes));
    return writeChain;
  };
  const track = (operation) => {
    pending.add(operation);
    operation.finally(() => pending.delete(operation));
  };
  const handleFrame = (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { throw protocolError(); }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw protocolError();
    if (frame.kind === "rpc_request") {
      if (terminalResult || typeof frame.id !== "string" || frame.id.length < 1 || frame.id.length > 128
        || !frame.message || typeof frame.message !== "object" || Array.isArray(frame.message)) {
        throw protocolError();
      }
      const endpoint = frame.message.operation === "approval"
        ? approvalSessions.get(frame.message.capabilityLeaseId)
        : gatewaySessions.get(frame.message.capabilityLeaseId);
      const operation = Promise.resolve(endpoint
        ? endpoint.handle(frame.message)
        : Promise.reject(frame.message.operation === "approval" ? approvalSessionMissing() : gatewaySessionMissing()))
        .then(
          (result) => send({ kind: "rpc_response", id: frame.id, ok: true, result }),
          (error) => send({
            kind: "rpc_response",
            id: frame.id,
            ok: false,
            error: {
              code: typeof error?.code === "string" ? error.code : "gateway_request_invalid",
              status: typeof error?.status === "string" ? error.status : "failed",
              message: error?.productSafe === true ? error.message : "Gateway request is invalid.",
            },
          }),
        )
        .then(() => emit?.("agent.gateway.responded", { operation: frame.message.operation }))
        .catch(terminate);
      track(operation);
      return;
    }
    if (frame.kind === "event") {
      if (typeof frame.type !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(frame.type)
        || !isPlainObject(frame.payload ?? {})) throw protocolError();
      if (typeof emit === "function") track(Promise.resolve(emit(`agent.${frame.type}`, structuredClone(frame.payload ?? {}))).catch(terminate));
      return;
    }
    if (frame.kind === "checkpoint") {
      if (!isPlainObject(frame.state) || typeof checkpoint !== "function") throw protocolError();
      track(Promise.resolve(checkpoint(structuredClone(frame.state))).catch(terminate));
      return;
    }
    if (frame.kind === "child_request") {
      if (terminalResult || typeof frame.id !== "string" || frame.id.length < 1 || frame.id.length > 128
        || !isPlainObject(frame.update) || typeof reportChild !== "function" || typeof openChildGateway !== "function") {
        throw protocolError();
      }
      const update = structuredClone(frame.update);
      const operation = Promise.resolve(reportChild(update))
        .then(async (binding) => {
          validateGatewayBinding(binding);
          if (!isTerminalChildStatus(update.status)) await openChildGateway(binding);
          await send({ kind: "child_response", id: frame.id, ok: true, result: binding });
          if (isTerminalChildStatus(update.status)) {
            const session = gatewaySessions.get(binding.capabilityLeaseId);
            await session?.close();
            const approvalSession = approvalSessions.get(binding.capabilityLeaseId);
            await approvalSession?.close();
          }
        }, (error) => send({
          kind: "child_response",
          id: frame.id,
          ok: false,
          error: {
            code: typeof error?.code === "string" ? error.code : "orchestrator_child_update_invalid",
            status: typeof error?.status === "string" ? error.status : "failed",
            message: error?.productSafe === true ? error.message : "Child update is invalid.",
          },
        }))
        .catch(terminate);
      track(operation);
      return;
    }
    if (frame.kind === "transcript_start") {
      if (terminalResult || transcriptDraft || terminalTranscript
        || !["application/json", "application/x-ndjson", "text/plain"].includes(frame.mediaType)
        || !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 1 || frame.byteLength > MAX_TRANSCRIPT_BYTES
        || typeof frame.contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(frame.contentHash)) {
        throw protocolError();
      }
      transcriptDraft = {
        mediaType: frame.mediaType,
        byteLength: frame.byteLength,
        contentHash: frame.contentHash,
        chunks: [],
        bytes: 0,
      };
      return;
    }
    if (frame.kind === "transcript_chunk") {
      if (!transcriptDraft || terminalResult
        || frame.sequence !== transcriptDraft.chunks.length + 1
        || typeof frame.bytesBase64 !== "string") throw protocolError();
      const chunk = Buffer.from(frame.bytesBase64, "base64");
      if (chunk.byteLength < 1 || chunk.toString("base64") !== frame.bytesBase64
        || transcriptDraft.bytes + chunk.byteLength > transcriptDraft.byteLength
        || transcriptDraft.bytes + chunk.byteLength > MAX_TRANSCRIPT_BYTES) throw protocolError();
      transcriptDraft.chunks.push(chunk);
      transcriptDraft.bytes += chunk.byteLength;
      return;
    }
    if (frame.kind === "transcript_end") {
      if (!transcriptDraft || terminalResult || terminalTranscript
        || frame.chunks !== transcriptDraft.chunks.length
        || transcriptDraft.bytes !== transcriptDraft.byteLength) throw protocolError();
      const content = Buffer.concat(transcriptDraft.chunks, transcriptDraft.bytes);
      if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== transcriptDraft.contentHash) {
        throw protocolError();
      }
      terminalTranscript = { mediaType: transcriptDraft.mediaType, content };
      transcriptDraft = null;
      return;
    }
    if (frame.kind === "result") {
      if (terminalResult || transcriptDraft || !isPlainObject(frame.result)) throw protocolError();
      terminalResult = structuredClone(frame.result);
      return;
    }
    throw protocolError();
  };
  child.stdout.on("data", (chunk) => {
    const bytes = Buffer.from(chunk);
    stdoutBytes += bytes.byteLength;
    if (stdoutBytes > maxStdoutBytes) terminate(limitError());
    else {
      stdoutBuffer = Buffer.concat([stdoutBuffer, bytes]);
      if (stdoutBuffer.byteLength > MAX_PROTOCOL_FRAME_BYTES && stdoutBuffer.indexOf(10) < 0) {
        terminate(protocolError());
        return;
      }
      while (!terminalError) {
        const newline = stdoutBuffer.indexOf(10);
        if (newline < 0) break;
        const lineBytes = stdoutBuffer.subarray(0, newline);
        stdoutBuffer = stdoutBuffer.subarray(newline + 1);
        if (lineBytes.byteLength > MAX_PROTOCOL_FRAME_BYTES || lineBytes.byteLength === 0) {
          terminate(protocolError());
          break;
        }
        try { handleFrame(lineBytes.toString("utf8")); } catch (error) { terminate(error); }
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > maxStderrBytes) terminate(limitError());
  });
  const timer = setTimeout(() => terminate(new AgentContainerSandboxError("agent_sandbox_timeout", "Agent sandbox timed out.", { status: "timeout" })), timeoutMs);
  const onAbort = () => terminate(new AgentContainerSandboxError("agent_sandbox_cancelled", "Agent sandbox was cancelled.", { status: "cancelled" }));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  await send({ kind: "start", payload }).catch(terminate);
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code) => resolve({ code }));
  });
  clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);
  await Promise.allSettled([...pending]);
  await writeChain.catch(() => {});
  if (terminalError) throw terminalError;
  if (outcome.error || outcome.code !== 0) throw unavailable();
  if (stdoutBuffer.toString("utf8").trim().length > 0 || !terminalResult) throw protocolError();
  return {
    ...terminalResult,
    ...(terminalTranscript ? { workerTranscript: terminalTranscript } : {}),
  };
}

function writeStream(stream, bytes) {
  return new Promise((resolve, reject) => {
    stream.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

async function verifyArtifactOutput(root, { maxBytes, maxFiles }) {
  let files = 0;
  let bytes = 0;
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw limitError();
      if (info.isDirectory()) await walk(path);
      else {
        files += 1;
        bytes += info.size;
        if (files > maxFiles || bytes > maxBytes) throw limitError();
        await readFile(path);
      }
    }
  };
  await walk(root);
  return { files, bytes };
}

function sanitizeBackendResult(value) {
  const result = structuredClone(value);
  for (const key of ["image", "imageDigest", "hostPath", "socketPath", "gatewaySocket", "containerName", "workerTranscript"]) delete result[key];
  return result;
}

async function persistWorkerTranscript({ service, request, transcript, signal }) {
  if (!transcript) {
    if (service) {
      throw new AgentContainerSandboxError(
        "worker_transcript_missing",
        "The Agent Worker did not provide its governed transcript.",
        { status: "failed" },
      );
    }
    return null;
  }
  if (!service) {
    throw new AgentContainerSandboxError(
      "worker_transcript_storage_unavailable",
      "Governed Worker transcript storage is unavailable.",
      { status: "blocked" },
    );
  }
  const ownerUserId = request.actor?.userId;
  if (typeof ownerUserId !== "string" || ownerUserId.length === 0) {
    throw new AgentContainerSandboxError(
      "worker_transcript_owner_missing",
      "The Agent Worker transcript has no governed owner.",
      { status: "blocked" },
    );
  }
  const objectScope = request.metadata?.agentKind === "builder_proposal"
    && request.metadata?.objectKind === "staged_loop" && request.metadata?.objectId
    ? { objectKind: "builder_proposal", objectId: request.metadata.objectId }
    : request.lineage?.sessionId
      ? { objectKind: "agent_session", objectId: request.lineage.sessionId }
      : { objectKind: request.controller.kind, objectId: request.controller.controllerId };
  try {
    return await service.commit({
      workspaceId: request.workspaceId,
      ownerUserId,
      objectScope,
      invocationId: request.invocationId,
      attemptId: request.attemptId,
      content: transcript.content,
      mediaType: transcript.mediaType,
      signal,
    });
  } catch (error) {
    throw new AgentContainerSandboxError(
      typeof error?.code === "string" ? error.code : "worker_transcript_write_failed",
      error?.productSafe === true ? error.message : "The Agent Worker transcript could not be retained.",
      { status: "blocked" },
    );
  }
}

function aggregateModelRoute(sessions) {
  const requested = new Set();
  const actual = new Set();
  const seen = new Set();
  const usage = { steps: 0, modelRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, imageCount: 0, costUsdMicros: 0 };
  for (const session of sessions) {
    // Several lease endpoints can expose the same invocation accounting.
    const key = session.binding ? `${session.binding.invocationId}:${session.binding.attemptId}` : session;
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshot = session.snapshot?.() ?? {};
    if (typeof snapshot.requestedModelRevisionId === "string") requested.add(snapshot.requestedModelRevisionId);
    if (typeof snapshot.actualModelRevisionId === "string") actual.add(snapshot.actualModelRevisionId);
    for (const name of Object.keys(usage)) usage[name] += snapshot.usage?.[name] ?? 0;
  }
  return {
    requestedModelRevisionId: requested.size === 1 ? [...requested][0] : null,
    actualModelRevisionId: actual.size === 1 ? [...actual][0] : null,
    usage,
  };
}

async function cleanupContainer(dockerControl, containerName, expectedInvocationId = null) {
  const inspect = await dockerControl([
    "container", "inspect", "--format",
    "{{json .Config.Labels}} {{json .State.Running}}",
    containerName,
  ]);
  if (inspect?.code !== 0) return false;
  const match = inspect.stdout.trim().match(/^(\{.*\})\s+(true|false)$/);
  if (!match) throw new Error("agent_container_identity_invalid");
  const labels = JSON.parse(match[1]);
  if (labels?.[AGENT_SANDBOX_OWNER_LABEL] !== AGENT_SANDBOX_OWNER_VALUE
    || (expectedInvocationId && labels?.[AGENT_SANDBOX_INVOCATION_LABEL] !== expectedInvocationId)) {
    throw new Error("agent_container_identity_invalid");
  }
  if (match[2] === "true") await dockerControl(["container", "kill", containerName]);
  await dockerControl(["container", "rm", "--force", containerName]);
  return true;
}

function validateRequest(request, lease) {
  if (!request || !["bounded_agent", "agent_orchestrator"].includes(request.mode)
    || request.isolation !== "container"
    || lease?.invocationId !== request.invocationId
    || lease?.attemptId !== request.attemptId) {
    throw new AgentContainerSandboxError("agent_sandbox_request_invalid", "Agent sandbox request is invalid.", { status: "blocked" });
  }
}

function validateGatewayBinding(binding) {
  if (!isPlainObject(binding)
    || ![binding.invocationId, binding.attemptId, binding.capabilityLeaseId]
      .every((value) => typeof value === "string" && value.length > 0)) {
    throw protocolError();
  }
}

function isTerminalChildStatus(status) {
  return [
    "completed", "failed", "cancelled", "blocked", "partial", "timeout",
    "permission_denied", "sandbox_unavailable", "remote_backend_unavailable",
    "interrupted", "skipped",
  ].includes(status);
}

function validateLimits(limits) {
  for (const key of ["pids", "memoryBytes", "tmpfsBytes", "maxStdoutBytes", "maxStderrBytes", "maxArtifactFiles"]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new TypeError("agent_sandbox_limits_invalid");
  }
  if (!Number.isSafeInteger(limits.maxOutputBytes ?? 1) || (limits.maxOutputBytes ?? 1) < 1
    || typeof limits.cpus !== "number" || !Number.isFinite(limits.cpus) || limits.cpus <= 0) {
    throw new TypeError("agent_sandbox_limits_invalid");
  }
  return Object.freeze({ ...limits, maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_LIMITS.maxStdoutBytes });
}

function containerNameFor(invocationId, attemptId) {
  const suffix = `${invocationId}-${attemptId}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 150);
  return `looloomi-agent-${suffix}`;
}

function defaultDockerEnvironment() {
  return Object.fromEntries(["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]
    .filter((key) => typeof process.env[key] === "string").map((key) => [key, process.env[key]]));
}

async function runControl({ dockerBinary, dockerEnvironment, spawnProcess, args }) {
  let child;
  try { child = spawnProcess(dockerBinary, args, { env: dockerEnvironment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
  catch { throw unavailable(); }
  if (!child?.stdout || !child?.stderr || typeof child.once !== "function") throw unavailable();
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code) => resolve({ code }));
  });
  if (outcome.error) throw unavailable();
  return { code: outcome.code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

function unavailable() {
  return new AgentContainerSandboxError("sandbox_unavailable");
}

function protocolError() {
  return new AgentContainerSandboxError("agent_sandbox_protocol_invalid", "Agent sandbox protocol is invalid.", { status: "failed" });
}

function gatewaySessionMissing() {
  return new AgentContainerSandboxError("gateway_capability_lease_invalid", "Gateway request is not permitted.", { status: "permission_denied" });
}

function approvalSessionMissing() {
  return new AgentContainerSandboxError("agent_tool_approval_unavailable", "Product Tool approval is unavailable.", { status: "blocked" });
}

function limitError() {
  return new AgentContainerSandboxError("agent_sandbox_output_limit", "Agent sandbox output exceeded its limit.", { status: "failed" });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
