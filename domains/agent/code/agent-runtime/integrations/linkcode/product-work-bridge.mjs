import { createHash, randomUUID } from "node:crypto";

import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const LINKCODE_PI_HOST_COMPATIBILITY = Object.freeze({
  schemaVersion: "linkcode-product-host-v1",
  linkCodeRelease: "v0.30.0",
  linkCodeCommitPrefix: "da9c0673",
  piVersion: "0.85.1",
  provider: "pi",
  mcp: false,
});

const WORK_ITEM_STATUSES = new Set([
  "draft",
  "ready",
  "active",
  "waiting_review",
  "completed",
  "blocked",
  "cancelled",
]);
const WORK_ITEM_PRIORITIES = new Set(["low", "medium", "high", "urgent"]);
const PATCH_FIELDS = new Set([
  "status",
  "priority",
  "dueAt",
  "blockedReason",
  "nextAction",
]);

export class LinkCodeProductBridgeError extends Error {
  constructor(code, message = code, { status = 0, retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LinkCodeProductBridgeError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.productSafe = true;
  }
}

/**
 * Fail-closed compatibility boundary for the internal LinkCode host slice.
 * LinkCode remains a presentation/session host. Product API and PostgreSQL
 * remain authoritative for identity, ACL, approvals, commands and Work state.
 */
export function assertLinkCodePiHostCompatibility({
  linkCodeRelease = LINKCODE_PI_HOST_COMPATIBILITY.linkCodeRelease,
  linkCodeCommit = LINKCODE_PI_HOST_COMPATIBILITY.linkCodeCommitPrefix,
  provider = "pi",
  mcpServers = [],
} = {}) {
  if (linkCodeRelease !== LINKCODE_PI_HOST_COMPATIBILITY.linkCodeRelease
    || typeof linkCodeCommit !== "string"
    || !linkCodeCommit.startsWith(LINKCODE_PI_HOST_COMPATIBILITY.linkCodeCommitPrefix)
    || provider !== "pi"
    || PI_VERSION !== LINKCODE_PI_HOST_COMPATIBILITY.piVersion) {
    throw new LinkCodeProductBridgeError("linkcode_pi_host_version_unsupported");
  }
  if (!Array.isArray(mcpServers) || mcpServers.length !== 0) {
    throw new LinkCodeProductBridgeError("linkcode_pi_mcp_unsupported");
  }
  return LINKCODE_PI_HOST_COMPATIBILITY;
}

/**
 * Native-client Product API transport. Access tokens are resolved per request
 * so rotation remains Product-owned and no credential is persisted in
 * LinkCode's local session database.
 */
export function createLinkCodeProductApiClient({
  baseUrl,
  accessToken,
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  const apiBase = normalizeProductApiBase(baseUrl);
  if (typeof accessToken !== "function" || typeof fetchImpl !== "function") {
    throw new TypeError("linkcode_product_api_dependencies_required");
  }

  async function request(path, { method = "GET", data, ifMatch, idempotencyKey, signal } = {}) {
    if (signal?.aborted) throw aborted(signal.reason);
    const token = await accessToken();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) {
      throw new LinkCodeProductBridgeError("linkcode_product_access_token_invalid");
    }
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
    let body;
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      headers["Idempotency-Key"] = requiredText(idempotencyKey, 255, "linkcode_product_idempotency_key_required");
      if (ifMatch !== undefined) headers["If-Match"] = requiredText(ifMatch, 256, "linkcode_product_etag_required");
      body = JSON.stringify({ schemaVersion: "workbench-api-v1", data: structuredClone(data ?? {}) });
    }
    let response;
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method,
        headers,
        body,
        signal,
        cache: "no-store",
        redirect: "error",
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw aborted(signal?.reason ?? error);
      throw new LinkCodeProductBridgeError("linkcode_product_unreachable", "Product API is unavailable.", {
        retryable: true,
        cause: error,
      });
    }
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      throw new LinkCodeProductBridgeError(
        safeCode(payload?.code, "linkcode_product_request_failed"),
        safeMessage(payload?.message, "Product API rejected the request."),
        { status: response.status, retryable: Boolean(payload?.retryable) },
      );
    }
    if (!isPlainObject(payload) || !Object.hasOwn(payload, "data")) {
      throw new LinkCodeProductBridgeError("linkcode_product_response_invalid");
    }
    return Object.freeze({
      data: structuredClone(payload.data),
      etag: response.headers.get("etag"),
      requestId: typeof payload.requestId === "string" ? payload.requestId : null,
    });
  }

  return Object.freeze({
    getProject({ projectId, signal } = {}) {
      return request(`/projects/${encodedId(projectId, "linkcode_project_id_required")}`, { signal });
    },
    getWorkItem({ workItemId, signal } = {}) {
      return request(`/work-items/${encodedId(workItemId, "linkcode_work_item_id_required")}`, { signal });
    },
    updateWorkItem({ workItemId, patch, ifMatch, idempotencyKey, signal } = {}) {
      return request(`/work-items/${encodedId(workItemId, "linkcode_work_item_id_required")}`, {
        method: "PATCH",
        data: normalizeWorkItemPatch(patch),
        ifMatch,
        idempotencyKey,
        signal,
      });
    },
  });
}

export function createLinkCodeProductWorkBridge({
  productClient,
  idFactory = () => `linkcode-proposal-${randomUUID()}`,
  now = () => new Date().toISOString(),
} = {}) {
  if (!productClient
    || typeof productClient.getProject !== "function"
    || typeof productClient.getWorkItem !== "function"
    || typeof productClient.updateWorkItem !== "function"
    || typeof idFactory !== "function"
    || typeof now !== "function") {
    throw new TypeError("linkcode_product_work_bridge_dependencies_required");
  }
  const proposals = new Map();
  const settled = new Map();
  const applying = new Map();

  async function readContext({ projectId, workItemId, signal } = {}) {
    const normalizedProjectId = stableId(projectId, "linkcode_project_id_required");
    const normalizedWorkItemId = stableId(workItemId, "linkcode_work_item_id_required");
    const [project, work] = await Promise.all([
      productClient.getProject({ projectId: normalizedProjectId, signal }),
      productClient.getWorkItem({ workItemId: normalizedWorkItemId, signal }),
    ]);
    const workItem = work?.data?.workItem ?? work?.data;
    if (!isPlainObject(project?.data) || !isPlainObject(workItem) || typeof work?.etag !== "string") {
      throw new LinkCodeProductBridgeError("linkcode_product_work_context_invalid");
    }
    if (workItem.projectId !== normalizedProjectId) {
      throw new LinkCodeProductBridgeError("linkcode_product_work_scope_mismatch");
    }
    return Object.freeze({
      project: structuredClone(project.data),
      workItem: structuredClone(workItem),
      etag: work.etag,
    });
  }

  async function proposeUpdate({ projectId, workItemId, patch, summary, signal } = {}) {
    const context = await readContext({ projectId, workItemId, signal });
    const normalizedPatch = normalizeWorkItemPatch(patch);
    const proposalId = stableId(idFactory("linkcode-product-work-proposal"), "linkcode_proposal_id_invalid");
    if (proposals.has(proposalId) || settled.has(proposalId)) {
      throw new LinkCodeProductBridgeError("linkcode_proposal_id_conflict");
    }
    const proposal = Object.freeze({
      schemaVersion: "linkcode-product-work-proposal-v1",
      proposalId,
      projectId: context.project.projectId,
      workItemId: context.workItem.workItemId,
      baseEtag: context.etag,
      summary: requiredText(summary, 2_000, "linkcode_proposal_summary_invalid"),
      patch: normalizedPatch,
      digest: proposalDigest({
        projectId: context.project.projectId,
        workItemId: context.workItem.workItemId,
        baseEtag: context.etag,
        patch: normalizedPatch,
      }),
      status: "pending_approval",
      createdAt: timestamp(now()),
    });
    proposals.set(proposalId, proposal);
    return structuredClone(proposal);
  }

  async function approveUpdate({ proposalId, signal } = {}) {
    const id = stableId(proposalId, "linkcode_proposal_id_required");
    if (settled.has(id)) {
      const receipt = settled.get(id);
      if (receipt.status !== "applied") throw new LinkCodeProductBridgeError("linkcode_proposal_not_pending");
      return structuredClone(receipt);
    }
    if (applying.has(id)) return structuredClone(await applying.get(id));
    const proposal = proposals.get(id);
    if (!proposal) throw new LinkCodeProductBridgeError("linkcode_proposal_not_found");
    if (signal?.aborted) throw aborted(signal.reason);
    const operation = (async () => {
      const result = await productClient.updateWorkItem({
        workItemId: proposal.workItemId,
        patch: proposal.patch,
        ifMatch: proposal.baseEtag,
        idempotencyKey: `linkcode-apply-${proposal.proposalId}`,
        signal,
      });
      const receipt = Object.freeze({
        schemaVersion: "linkcode-product-work-receipt-v1",
        proposalId: proposal.proposalId,
        workItemId: proposal.workItemId,
        digest: proposal.digest,
        status: "applied",
        product: {
          workItem: structuredClone(result.data),
          etag: result.etag,
          requestId: result.requestId ?? null,
        },
        appliedAt: timestamp(now()),
      });
      proposals.delete(id);
      settled.set(id, receipt);
      return receipt;
    })();
    applying.set(id, operation);
    try {
      return structuredClone(await operation);
    } finally {
      if (applying.get(id) === operation) applying.delete(id);
    }
  }

  function rejectUpdate({ proposalId, reason = "Rejected by the user." } = {}) {
    const id = stableId(proposalId, "linkcode_proposal_id_required");
    if (settled.has(id)) return structuredClone(settled.get(id));
    if (applying.has(id)) throw new LinkCodeProductBridgeError("linkcode_proposal_applying");
    const proposal = proposals.get(id);
    if (!proposal) throw new LinkCodeProductBridgeError("linkcode_proposal_not_found");
    const receipt = Object.freeze({
      schemaVersion: "linkcode-product-work-receipt-v1",
      proposalId: proposal.proposalId,
      workItemId: proposal.workItemId,
      digest: proposal.digest,
      status: "rejected",
      reason: requiredText(reason, 2_000, "linkcode_proposal_rejection_invalid"),
      rejectedAt: timestamp(now()),
    });
    proposals.delete(id);
    settled.set(id, receipt);
    return structuredClone(receipt);
  }

  function getProposal(proposalId) {
    const id = stableId(proposalId, "linkcode_proposal_id_required");
    const value = proposals.get(id) ?? settled.get(id);
    return value ? structuredClone(value) : null;
  }

  return Object.freeze({ readContext, proposeUpdate, approveUpdate, rejectUpdate, getProposal });
}

/**
 * Pi extension factory for LinkCode's native Pi adapter. The model receives
 * read and proposal tools only. Approval is deliberately a user command so a
 * model cannot approve its own Product mutation.
 */
export function createLinkCodeProductWorkExtension({ bridge, projectId, workItemId } = {}) {
  if (!bridge
    || typeof bridge.readContext !== "function"
    || typeof bridge.proposeUpdate !== "function"
    || typeof bridge.approveUpdate !== "function"
    || typeof bridge.rejectUpdate !== "function") {
    throw new TypeError("linkcode_product_work_extension_bridge_required");
  }
  const scope = Object.freeze({
    projectId: stableId(projectId, "linkcode_project_id_required"),
    workItemId: stableId(workItemId, "linkcode_work_item_id_required"),
  });
  return function linkCodeProductWorkExtension(pi) {
    pi.registerTool({
      name: "product_work_context_read",
      label: "Read authorized Product work",
      description: "Read the authorized Project and Work Item from the Product API. Private Pi or LinkCode session data is never shared.",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => toolResult(await bridge.readContext(scope)),
    });
    pi.registerTool({
      name: "product_work_propose_update",
      label: "Propose a Product work update",
      description: "Stage a bounded Work Item update for explicit user approval. This tool never mutates Product state.",
      parameters: Type.Object({
        summary: Type.String({ minLength: 1, maxLength: 2_000 }),
        patch: Type.Object({
          status: Type.Optional(Type.Union([...WORK_ITEM_STATUSES].map((value) => Type.Literal(value)))),
          priority: Type.Optional(Type.Union([...WORK_ITEM_PRIORITIES].map((value) => Type.Literal(value)))),
          dueAt: Type.Optional(Type.Union([Type.String({ format: "date-time", pattern: "Z$" }), Type.Null()])),
          blockedReason: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 2_000 }), Type.Null()])),
          nextAction: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 2_000 }), Type.Null()])),
        }, { additionalProperties: false, minProperties: 1 }),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, input) => toolResult(await bridge.proposeUpdate({ ...scope, ...input })),
    });
    pi.registerCommand("product-approve", {
      description: "Approve one pending Product Work proposal by ID.",
      handler: async (args, context) => {
        const proposalId = stableId(args.trim(), "linkcode_proposal_id_required");
        const proposal = bridge.getProposal(proposalId);
        if (!proposal || proposal.status !== "pending_approval") {
          context.ui.notify("The Product Work proposal is no longer pending.", "warning");
          return;
        }
        const confirmed = await context.ui.confirm(
          "Apply Product Work update?",
          `${proposal.summary}\n\n${JSON.stringify(proposal.patch, null, 2)}`,
        );
        if (!confirmed) return;
        const receipt = await bridge.approveUpdate({ proposalId });
        pi.sendMessage({
          customType: "linkcode-product-work-receipt",
          content: `Product Work update applied (${receipt.product.etag}).`,
          display: true,
          details: receipt,
        }, { triggerTurn: false });
      },
    });
    pi.registerCommand("product-reject", {
      description: "Reject one pending Product Work proposal by ID.",
      handler: async (args, context) => {
        const proposalId = stableId(args.trim(), "linkcode_proposal_id_required");
        const proposal = bridge.getProposal(proposalId);
        if (!proposal || proposal.status !== "pending_approval") {
          context.ui.notify("The Product Work proposal is no longer pending.", "warning");
          return;
        }
        bridge.rejectUpdate({ proposalId });
        context.ui.notify("Product Work proposal rejected.", "info");
      },
    });
  };
}

function normalizeProductApiBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("linkcode_product_api_base_url_invalid"); }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("linkcode_product_api_transport_insecure");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function normalizeWorkItemPatch(value) {
  if (!isPlainObject(value)) throw new LinkCodeProductBridgeError("linkcode_work_patch_invalid");
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([key]) => !PATCH_FIELDS.has(key))) {
    throw new LinkCodeProductBridgeError("linkcode_work_patch_invalid");
  }
  const patch = {};
  if (Object.hasOwn(value, "status")) {
    if (!WORK_ITEM_STATUSES.has(value.status)) throw new LinkCodeProductBridgeError("linkcode_work_patch_invalid");
    patch.status = value.status;
  }
  if (Object.hasOwn(value, "priority")) {
    if (!WORK_ITEM_PRIORITIES.has(value.priority)) throw new LinkCodeProductBridgeError("linkcode_work_patch_invalid");
    patch.priority = value.priority;
  }
  for (const field of ["blockedReason", "nextAction"]) {
    if (Object.hasOwn(value, field)) {
      patch[field] = value[field] === null
        ? null
        : requiredText(value[field], 2_000, "linkcode_work_patch_invalid");
    }
  }
  if (Object.hasOwn(value, "dueAt")) {
    if (value.dueAt === null) patch.dueAt = null;
    else patch.dueAt = timestamp(value.dueAt, "linkcode_work_patch_invalid");
  }
  return Object.freeze(patch);
}

function proposalDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: { status: "completed" },
  };
}

function encodedId(value, code) { return encodeURIComponent(stableId(value, code)); }

function stableId(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new LinkCodeProductBridgeError(code);
  }
  return value;
}

function requiredText(value, maximum, code) {
  if (typeof value !== "string") throw new LinkCodeProductBridgeError(code);
  const text = value.trim();
  if (!text || text.length > maximum) throw new LinkCodeProductBridgeError(code);
  return text;
}

function timestamp(value, code = "linkcode_timestamp_invalid") {
  if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw new LinkCodeProductBridgeError(code);
  }
  return value;
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : fallback;
}

function safeMessage(value, fallback) {
  return typeof value === "string" && value.length > 0 && value.length <= 2_000 ? value : fallback;
}

function aborted(reason) {
  return new LinkCodeProductBridgeError("linkcode_operation_cancelled", "Operation cancelled.", { cause: reason });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
