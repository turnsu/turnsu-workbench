const MODEL_CALL_CAPABILITIES = new Set([
  "chat",
  "tool_calling",
  "structured_output",
  "image_input",
  "image_generation",
]);

export function createModelCallBackend({ modelService, attachmentResolver = null } = {}) {
  const invoke = typeof modelService === "function"
    ? modelService
    : modelService?.execute?.bind(modelService);
  if (typeof invoke !== "function") throw new TypeError("model_call_service_required");

  return Object.freeze({
    // This probe verifies the local Product backend composition only. Provider
    // and credential readiness remain owned by the selectable Model Profile.
    probe() {
      return Object.freeze({ available: true, verified: true });
    },

    async execute({ request, lease, signal, emit } = {}) {
      validateModelCallRequest(request, lease);
      await emit?.("model.call.started", {
        modelProfileRevisionId: request.modelProfileRevisionId,
        capability: request.modelCapability,
      });
      const attachmentParts = request.metadata?.attachmentRefs?.length > 0
        ? await resolveAttachmentParts({
            attachmentResolver,
            request,
            signal,
          })
        : [];
      const imageCount = attachmentParts.filter((part) => part?.type === "image").length;
      if (imageCount > 0 && request.modelCapability !== "image_input") {
        throw modelCallError("model_capability_mismatch", { status: "blocked" });
      }
      if (imageCount > request.limits.maxImageCount) {
        throw modelCallError("attachment_limit_exceeded", { status: "blocked" });
      }
      const typedInput = mergeAttachmentParts(
        structuredClone(request.input),
        attachmentParts,
      );
      const governedInputBytes = byteLength(typedInput);
      if (governedInputBytes > request.limits.maxInputBytes) {
        throw modelCallError("execution_input_too_large", { status: "blocked" });
      }
      const result = await invoke({
        typedInput,
        modelProfileRevisionId: request.modelProfileRevisionId,
        fallbackModelProfileRevisionIds: structuredClone(
          request.fallbackModelProfileRevisionIds ?? [],
        ),
        capability: request.modelCapability,
        invocationId: request.invocationId,
        attemptId: request.attemptId,
        workspaceId: request.workspaceId,
        capabilityLeaseId: lease.capabilityLeaseId,
        fence: lease.fence,
        limits: structuredClone(request.limits),
        source: artifactSourceForRequest(request),
        signal,
      });
      if (!isJsonValue(result)) throw modelCallError("model_result_invalid");
      await emit?.("model.call.completed", {
        requestedModelRevisionId: result.requestedModelRevisionId,
        actualModelRevisionId: result.actualModelRevisionId,
        fallback: result.requestedModelRevisionId !== result.actualModelRevisionId,
        capability: request.modelCapability,
        usage: safeUsage(result.usage),
        artifactRefs: safeArtifactRefs(result.artifactRefs),
      });
      return {
        output: structuredClone(result),
        requestedModelRevisionId: result.requestedModelRevisionId,
        actualModelRevisionId: result.actualModelRevisionId,
        artifactRefs: safeArtifactRefs(result.artifactRefs),
        summary: result.requestedModelRevisionId === result.actualModelRevisionId
          ? "Pinned model call completed."
          : "Pinned model call completed using an approved fallback revision.",
        evidence: safeArtifactRefs(result.artifactRefs).map((artifact) => ({
          requirementId: "model-output-artifact",
          kind: "artifact",
          ref: artifact.artifactId,
        })),
        usage: {
          steps: 1,
          modelRequests: 1,
          inputBytes: governedInputBytes,
          outputBytes: byteLength(result),
          imageCount,
          costUsdMicros: Number.isInteger(result.usage?.costUsdMicros) ? result.usage.costUsdMicros : 0,
        },
      };
    },
  });
}

async function resolveAttachmentParts({ attachmentResolver, request, signal }) {
  if (typeof attachmentResolver !== "function") {
    throw modelCallError("attachment_service_unavailable");
  }
  const requestedBy = request.metadata?.requestedBy;
  if (typeof requestedBy !== "string" || requestedBy.length === 0) {
    throw modelCallError("attachment_forbidden");
  }
  return attachmentResolver({
    workspaceId: request.workspaceId,
    requestedBy,
    refs: structuredClone(request.metadata.attachmentRefs),
    signal,
  });
}

function mergeAttachmentParts(input, parts) {
  if (!Array.isArray(parts) || parts.length === 0) return input;
  if (!Array.isArray(input?.messages) || input.messages.length === 0) {
    throw modelCallError("model_call_request_invalid");
  }
  let userIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    if (input.messages[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) throw modelCallError("model_call_request_invalid");
  const current = input.messages[userIndex];
  const content = typeof current.content === "string"
    ? [{ type: "text", text: current.content }]
    : Array.isArray(current.content)
      ? current.content
      : [];
  input.messages[userIndex] = {
    ...current,
    content: [...content, ...structuredClone(parts)],
  };
  return input;
}

function artifactSourceForRequest(request) {
  if (request?.controller?.kind === "agent_turn") {
    const sessionId = request.metadata?.agentSessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    return {
      kind: "agent_turn",
      sessionId,
      turnId: request.controller.controllerId,
      invocationId: request.invocationId,
      attemptId: request.attemptId,
    };
  }
  if (request?.controller?.kind === "workflow_run") {
    const nodeId = request.metadata?.outerNodeId;
    if (typeof nodeId !== "string" || nodeId.length === 0) return null;
    return {
      kind: "workflow_run",
      runId: request.controller.controllerId,
      nodeId,
      invocationId: request.invocationId,
      attemptId: request.attemptId,
    };
  }
  return null;
}

function validateModelCallRequest(request, lease) {
  const capabilities = request?.capabilities;
  if (!request || request.mode !== "model_call" || request.isolation !== "process"
    || !lease || lease.invocationId !== request.invocationId || lease.attemptId !== request.attemptId
    || typeof request.modelProfileRevisionId !== "string"
    || !MODEL_CALL_CAPABILITIES.has(request.modelCapability)
    || !Array.isArray(request.fallbackModelProfileRevisionIds ?? [])
    || !capabilities || capabilities.toolAllowlist?.length !== 0
    || capabilities.connectionIds?.length !== 0 || capabilities.network !== false
    || capabilities.filesystem !== "none" || capabilities.externalActions !== false
    || request.limits?.maxChildren !== 0 || request.limits?.maxModelRequests < 1) {
    throw modelCallError("model_call_request_invalid");
  }
  if (request.modelCapability === "image_generation"
    && request.fallbackModelProfileRevisionIds?.length > 0) {
    throw modelCallError("model_image_fallback_forbidden");
  }
}

function modelCallError(code, { status = "failed" } = {}) {
  const error = new Error(code);
  error.name = "ModelCallBackendError";
  error.code = code;
  error.status = status;
  error.productSafe = true;
  return error;
}

function safeArtifactRefs(value) {
  return Array.isArray(value)
    ? value.filter((item) => isPlainObject(item)
      && typeof item.artifactId === "string" && item.artifactId.length > 0 && item.artifactId.length <= 256
      && ["image/png", "image/jpeg", "image/webp"].includes(item.mediaType))
      .slice(0, 16).map((item) => ({ artifactId: item.artifactId, mediaType: item.mediaType }))
    : [];
}

function safeUsage(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)
      && Number.isFinite(item) && item >= 0));
}

function byteLength(value) {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}
