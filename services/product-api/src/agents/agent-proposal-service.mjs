import { Check, AgentObjectProposalSchema } from "@turnsu/workbench-contracts";

const SCHEMA_VERSION = "workbench-v1";

export class AgentProposalServiceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "AgentProposalServiceError";
    this.code = code;
    this.productSafe = true;
  }
}

export class ProductAgentProposalService {
  constructor({ clock = () => new Date().toISOString(), idFactory } = {}) {
    if (typeof clock !== "function" || typeof idFactory !== "function") {
      throw new TypeError("agent_proposal_service_dependencies_required");
    }
    this.clock = clock;
    this.idFactory = idFactory;
  }

  prepareFromAgent({ session, turn, proposal }) {
    if (session?.scope?.kind !== "module" || turn?.sessionId !== session.sessionId) {
      throw new AgentProposalServiceError("agent_proposal_context_invalid");
    }
    const normalized = normalizeProposal(proposal);
    if (normalized.validationResult.status !== "passed") {
      throw new AgentProposalServiceError("agent_proposal_validation_failed");
    }
    const now = this.clock();
    const record = {
      schemaVersion: SCHEMA_VERSION,
      proposalId: this.idFactory("agent-proposal"),
      workspaceId: session.workspaceId,
      userId: session.userId,
      sessionId: session.sessionId,
      turnId: turn.turnId,
      definitionId: session.definitionId,
      objectKind: session.scope.objectKind,
      objectId: session.scope.objectId,
      branchId: session.scope.branchId,
      baseVersionId: session.scope.baseVersionId,
      summary: normalized.summary,
      operations: normalized.operations,
      evidenceRefs: normalized.evidenceRefs,
      validationResult: normalized.validationResult,
      status: "proposed",
      createdBy: session.userId,
      createdAt: now,
      decidedAt: null,
    };
    if (!Check(AgentObjectProposalSchema, record)) {
      throw new AgentProposalServiceError("agent_proposal_invalid");
    }
    return structuredClone(record);
  }
}

function normalizeProposal(value) {
  if (!isObject(value) || typeof value.summary !== "string" || !value.summary.trim()) {
    throw new AgentProposalServiceError("agent_proposal_invalid");
  }
  const operations = (Array.isArray(value.operations) ? value.operations : []).map((operation) => {
    if (!isObject(operation)
      || !["add", "replace", "remove"].includes(operation.op)
      || typeof operation.path !== "string"
      || !operation.path.startsWith("/")
      || operation.path.length > 1000
      || operation.path.includes("__proto__")
      || operation.path.includes("constructor")) {
      throw new AgentProposalServiceError("agent_proposal_operation_invalid");
    }
    if (operation.op !== "remove" && !Object.hasOwn(operation, "value")) {
      throw new AgentProposalServiceError("agent_proposal_operation_invalid");
    }
    return {
      op: operation.op,
      path: operation.path,
      ...(operation.op === "remove" ? {} : { value: structuredClone(operation.value) }),
    };
  });
  if (operations.length === 0 || operations.length > 256) {
    throw new AgentProposalServiceError("agent_proposal_operation_invalid");
  }
  const validation = value.validationResult;
  if (!isObject(validation)
    || !["passed", "failed", "not_run"].includes(validation.status)
    || !Array.isArray(validation.diagnostics)) {
    throw new AgentProposalServiceError("agent_proposal_validation_invalid");
  }
  return {
    summary: value.summary.trim().slice(0, 4000),
    operations,
    evidenceRefs: [...new Set((Array.isArray(value.evidenceRefs) ? value.evidenceRefs : [])
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim().slice(0, 256)))].slice(0, 256),
    validationResult: {
      status: validation.status,
      diagnostics: validation.diagnostics.filter(isObject).map((item) => structuredClone(item)).slice(0, 128),
    },
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
