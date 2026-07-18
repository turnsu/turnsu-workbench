import { getBuiltinAgentDefinition } from "./agent-definitions.mjs";

const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  maxSteps: 32,
  maxModelRequests: 16,
  maxChildren: 0,
  maxInputBytes: 1_000_000,
  maxOutputBytes: 1_000_000,
  maxImageCount: 0,
  maxCostUsdMicros: 10_000_000,
});

const DEFAULT_CAPABILITIES = Object.freeze({
  toolAllowlist: [],
  connectionIds: [],
  network: false,
  filesystem: "none",
  externalActions: false,
});

export class ProductAgentExecutorError extends Error {
  constructor(code, message = code, { status = "failed" } = {}) {
    super(message);
    this.name = "ProductAgentExecutorError";
    this.code = code;
    this.status = status;
    this.productSafe = true;
  }
}

export function createProductAgentExecutor({
  proposalService = null,
  resolveCapabilities = () => DEFAULT_CAPABILITIES,
  resolveLimits = () => DEFAULT_LIMITS,
} = {}) {
  if (typeof resolveCapabilities !== "function" || typeof resolveLimits !== "function") {
    throw new TypeError("product_agent_policy_resolver_invalid");
  }
  return Object.freeze({
    async execute({ session, turn, messages, runWorkers }) {
      const definition = getBuiltinAgentDefinition(session?.definitionId);
      if (!definition || typeof runWorkers !== "function") {
        throw new ProductAgentExecutorError("product_agent_context_invalid");
      }
      const request = buildWorkerRequest({
        definition,
        session,
        turn,
        messages,
        capabilities: resolveCapabilities({ definition, session, turn }),
        limits: resolveLimits({ definition, session, turn }),
      });
      const results = await runWorkers([request]);
      const worker = results?.[0];
      if (!worker || worker.status !== "completed") {
        return {
          status: "blocked",
          response: safeWorkerSummary(worker),
        };
      }
      if (worker.requestedModelRevisionId !== turn.requestedModelRevisionId
        || worker.actualModelRevisionId !== turn.requestedModelRevisionId) {
        throw new ProductAgentExecutorError("product_agent_model_route_unverified");
      }
      const output = validateWorkerOutput(worker.output, definition.kind);
      const routing = {
        requestedModelRevisionId: worker.requestedModelRevisionId,
        actualModelRevisionId: worker.actualModelRevisionId,
        artifactRefs: safeArtifactRefs(worker.artifactRefs),
      };
      if (definition.kind === "main") return { response: output.response, ...routing };
      if (!proposalService || typeof proposalService.createFromAgent !== "function") {
        return {
          status: "blocked",
          response: "Agent proposal storage is unavailable.",
        };
      }
      const saved = await proposalService.createFromAgent({
        session: structuredClone(session),
        turn: structuredClone(turn),
        proposal: output.proposal,
      });
      return {
        response: output.response,
        proposalId: saved.proposalId,
        ...routing,
        ...(output.handoff ? { handoff: output.handoff } : {}),
      };
    },
  });
}

function buildWorkerRequest({ definition, session, turn, messages, capabilities, limits }) {
  const moduleScope = session.scope?.kind === "module" ? session.scope : null;
  return {
    mode: "bounded_agent",
    isolation: "container",
    goal: definition.kind === "main"
      ? "Respond as the workspace Main Agent using only governed product context."
      : `Prepare a structured ${moduleScope.objectKind} proposal without modifying the canonical object.`,
    input: {
      definition: {
        definitionId: definition.definitionId,
        kind: definition.kind,
        description: definition.description,
      },
      session: {
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        scope: structuredClone(session.scope),
      },
      turn: {
        turnId: turn.turnId,
        message: turn.input.message,
      },
      transcript: boundedMessages(messages),
    },
    limits: normalizeLimits(limits),
    capabilities: normalizeCapabilities(capabilities),
    resultSchema: resultSchemaFor(definition.kind),
    evidenceRequirements: definition.kind === "module" ? [{
      requirementId: "proposal-validation",
      kind: "validation",
      required: true,
      description: "Return validation status for the proposed object changes.",
    }] : [],
    metadata: {
      definitionId: definition.definitionId,
      agentSessionId: session.sessionId,
      agentTurnId: turn.turnId,
      modelProfileRevisionId: turn.requestedModelRevisionId,
      modelCapability: turn.modelCapability ?? "tool_calling",
      fallbackModelProfileRevisionIds: [],
      ...(moduleScope ? {
        objectKind: moduleScope.objectKind,
        objectId: moduleScope.objectId,
        branchId: moduleScope.branchId,
        proposalKind: moduleScope.objectKind,
      } : {}),
    },
  };
}

function resultSchemaFor(kind) {
  const properties = {
    response: { type: "string", minLength: 1, maxLength: 20_000 },
  };
  const required = ["response"];
  if (kind === "module") {
    properties.proposal = {
      type: "object",
      properties: {
        summary: { type: "string" },
        operations: { type: "array", items: { type: "object" } },
        evidenceRefs: { type: "array", items: { type: "string" } },
        validationResult: { type: "object" },
      },
      required: ["summary", "operations", "evidenceRefs", "validationResult"],
      additionalProperties: false,
    };
    properties.handoff = { type: "object" };
    required.push("proposal");
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function validateWorkerOutput(output, kind) {
  if (!isObject(output) || typeof output.response !== "string" || !output.response.trim()) {
    throw new ProductAgentExecutorError("product_agent_output_invalid");
  }
  const result = { response: output.response.trim().slice(0, 20_000) };
  if (kind === "module") {
    if (!isObject(output.proposal)
      || typeof output.proposal.summary !== "string"
      || !Array.isArray(output.proposal.operations)
      || !Array.isArray(output.proposal.evidenceRefs)
      || !isObject(output.proposal.validationResult)) {
      throw new ProductAgentExecutorError("product_agent_proposal_invalid");
    }
    result.proposal = output.proposal;
    if (isObject(output.handoff)) result.handoff = output.handoff;
  }
  return result;
}

function boundedMessages(messages) {
  return (Array.isArray(messages) ? messages : []).slice(-100).map((message) => ({
    role: ["user", "assistant", "system"].includes(message?.role) ? message.role : "user",
    kind: typeof message?.kind === "string" ? message.kind.slice(0, 64) : "turn",
    content: String(message?.content ?? "").slice(0, 20_000),
  }));
}

function normalizeLimits(value) {
  return { ...DEFAULT_LIMITS, ...(isObject(value) ? value : {}) };
}

function normalizeCapabilities(value) {
  return {
    ...DEFAULT_CAPABILITIES,
    ...(isObject(value) ? value : {}),
    toolAllowlist: [...new Set(Array.isArray(value?.toolAllowlist) ? value.toolAllowlist : [])],
    connectionIds: [...new Set(Array.isArray(value?.connectionIds) ? value.connectionIds : [])],
  };
}

function safeWorkerSummary(worker) {
  if (typeof worker?.summary === "string" && worker.summary.trim()) return worker.summary.slice(0, 4000);
  return {
    cancelled: "Agent execution was cancelled.",
    timeout: "Agent execution timed out.",
    permission_denied: "Agent execution permission was denied.",
    sandbox_unavailable: "The required sandbox is unavailable.",
    remote_backend_unavailable: "The remote backend is unavailable.",
  }[worker?.status] ?? "Agent execution is blocked.";
}

function safeArtifactRefs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.artifactId !== "string"
      || !["image/png", "image/jpeg", "image/webp"].includes(item.mediaType)) continue;
    const key = `${item.artifactId}\u0000${item.mediaType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ artifactId: item.artifactId, mediaType: item.mediaType });
    if (result.length >= 256) break;
  }
  return result;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
