import {
  AgentKernelError,
  assertIdentifier,
  assertVersion,
  cloneValue,
  freeze,
} from "./contracts.mjs";

const CONTENT_HASH = /^sha256:[a-f0-9]{64}$/;
const PROPOSAL_STATUSES = new Set(["proposed", "approved", "rejected"]);

/**
 * Data-only governance for the T4 -> proposal -> signed T3 promotion path.
 * It neither evaluates source code nor installs a plugin. Product may persist
 * these records through its own authority later; the Kernel keeps no Product
 * repository, workspace role, or signature private key.
 */
export class PluginProposalRegistry {
  #idFactory;
  #clock;
  #signatureIssuer;
  #records = new Map();

  constructor({
    idFactory = (kind) => `${kind}-${crypto.randomUUID()}`,
    clock = () => new Date().toISOString(),
    signatureIssuer,
  } = {}) {
    if (typeof idFactory !== "function" || typeof clock !== "function" || typeof signatureIssuer !== "function") {
      throw new AgentKernelError("plugin_proposal_dependencies_invalid");
    }
    this.#idFactory = idFactory;
    this.#clock = clock;
    this.#signatureIssuer = signatureIssuer;
  }

  propose({ proposalId = this.#idFactory("plugin-proposal"), candidate, evidenceRefs = [], authorRef } = {}) {
    const id = assertIdentifier(proposalId, "plugin_proposal_invalid");
    if (this.#records.has(id)) throw new AgentKernelError("plugin_proposal_duplicate");
    const record = freeze({
      schemaVersion: "agent-plugin-proposal-v1",
      proposalId: id,
      status: "proposed",
      candidate: normalizeCandidate(candidate),
      evidenceRefs: normalizeEvidenceRefs(evidenceRefs),
      authorRef: assertIdentifier(authorRef, "plugin_proposal_invalid"),
      reviewerRef: null,
      decisionAt: null,
      release: null,
      createdAt: timestamp(this.#clock()),
    });
    this.#records.set(id, record);
    return copy(record);
  }

  get(proposalId) {
    const record = this.#records.get(assertIdentifier(proposalId, "plugin_proposal_invalid"));
    return record ? copy(record) : null;
  }

  async approve({ proposalId, reviewerRef, approvedCapabilities } = {}) {
    const record = this.#requireProposed(proposalId);
    const reviewer = assertIdentifier(reviewerRef, "plugin_proposal_approval_invalid");
    const capabilities = normalizeCapabilities(approvedCapabilities, "plugin_proposal_approval_invalid");
    if (capabilities.some((capability) => !record.candidate.requestedCapabilities.includes(capability))) {
      throw new AgentKernelError("plugin_proposal_capability_expansion_forbidden");
    }
    const unsignedRelease = freeze({
      schemaVersion: "agent-workspace-plugin-release-v1",
      pluginId: record.candidate.pluginId,
      version: record.candidate.version,
      contentHash: record.candidate.contentHash,
      trust: "T3",
      allowedCapabilities: capabilities,
      sourceProposalId: record.proposalId,
    });
    const release = freeze({
      ...unsignedRelease,
      signature: normalizeSignature(await this.#signatureIssuer(copy(unsignedRelease))),
    });
    const next = freeze({
      ...record,
      status: "approved",
      reviewerRef: reviewer,
      decisionAt: timestamp(this.#clock()),
      release,
    });
    this.#records.set(record.proposalId, next);
    return copy(next);
  }

  reject({ proposalId, reviewerRef, reason } = {}) {
    const record = this.#requireProposed(proposalId);
    const next = freeze({
      ...record,
      status: "rejected",
      reviewerRef: assertIdentifier(reviewerRef, "plugin_proposal_rejection_invalid"),
      decisionAt: timestamp(this.#clock()),
      release: null,
      rejection: boundedText(reason, 1_000, "plugin_proposal_rejection_invalid"),
    });
    this.#records.set(record.proposalId, next);
    return copy(next);
  }

  createPluginSetRevision({ revisionId = this.#idFactory("plugin-set"), proposalIds } = {}) {
    const id = assertIdentifier(revisionId, "plugin_set_revision_invalid");
    if (!Array.isArray(proposalIds) || proposalIds.length === 0 || proposalIds.length > 128) {
      throw new AgentKernelError("plugin_set_revision_invalid");
    }
    const entries = proposalIds.map((proposalId) => {
      const record = this.#records.get(assertIdentifier(proposalId, "plugin_set_revision_invalid"));
      if (!record || record.status !== "approved" || !record.release) {
        throw new AgentKernelError("plugin_set_revision_unapproved_proposal");
      }
      return record.release;
    });
    const seen = new Set();
    for (const entry of entries) {
      if (seen.has(entry.pluginId)) throw new AgentKernelError("plugin_set_revision_duplicate_plugin");
      seen.add(entry.pluginId);
    }
    return freeze({
      schemaVersion: "agent-plugin-set-revision-v1",
      revisionId: id,
      entries: entries.map(copy),
      createdAt: timestamp(this.#clock()),
      activation: "requires_profile_resolver_and_sandbox",
    });
  }

  #requireProposed(proposalId) {
    const id = assertIdentifier(proposalId, "plugin_proposal_invalid");
    const record = this.#records.get(id);
    if (!record) throw new AgentKernelError("plugin_proposal_not_found");
    if (!PROPOSAL_STATUSES.has(record.status) || record.status !== "proposed") {
      throw new AgentKernelError("plugin_proposal_already_decided");
    }
    return record;
  }
}

export function createPluginProposalRegistry(options = {}) {
  return new PluginProposalRegistry(options);
}

function normalizeCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentKernelError("plugin_proposal_invalid");
  }
  const contentHash = String(value.contentHash || "");
  if (!CONTENT_HASH.test(contentHash) || value.origin !== "sandbox_ephemeral") {
    throw new AgentKernelError("plugin_proposal_invalid");
  }
  return freeze({
    pluginId: assertIdentifier(value.pluginId, "plugin_proposal_invalid"),
    version: assertVersion(value.version, "plugin_proposal_invalid"),
    contentHash,
    requestedCapabilities: normalizeCapabilities(value.requestedCapabilities, "plugin_proposal_invalid"),
    origin: "sandbox_ephemeral",
  });
}

function normalizeEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length > 128) throw new AgentKernelError("plugin_proposal_invalid");
  return freeze([...new Set(value.map((item) => assertIdentifier(item, "plugin_proposal_invalid")))]);
}

function normalizeCapabilities(value, code) {
  if (!Array.isArray(value) || value.length > 128) throw new AgentKernelError(code);
  return freeze([...new Set(value.map((item) => assertIdentifier(item, code)))]);
}

function normalizeSignature(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentKernelError("plugin_proposal_signature_invalid");
  }
  const keyId = assertIdentifier(value.keyId, "plugin_proposal_signature_invalid");
  if (typeof value.value !== "string" || !/^[A-Za-z0-9_-]{16,4096}$/.test(value.value)) {
    throw new AgentKernelError("plugin_proposal_signature_invalid");
  }
  return freeze({ keyId, value: value.value });
}

function timestamp(value) {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new AgentKernelError("plugin_proposal_clock_invalid");
  return result.toISOString();
}

function boundedText(value, limit, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    throw new AgentKernelError(code);
  }
  return value;
}

function copy(value) {
  return freeze(cloneValue(value, "plugin_proposal_value_invalid"));
}
